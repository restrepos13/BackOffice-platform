import { HttpException, HttpStatus } from '@nestjs/common';
import { NOT_DELETED } from '../common/constants';
import { AiBilling, AiSession, recordAiUsage, resolveAiAccess } from './ai-access';
import { GeminiPool } from './gemini-pool';
import { bogotaDay } from './openai-compat';
import type { AiProvider, ChatMessage } from './types';

/**
 * Textos con IA para una EMPRESA (sugerir copys de anuncios, resumen del
 * reporte). Decide el proveedor con un solo criterio:
 *  - Si la empresa tiene IA propia (BYOK o revendida por BackOffice) se usa
 *    esa, por DeepInfra, y queda en AiUsageEvent como cualquier otro consumo.
 *  - Si no la tiene (o no está disponible: sin llave, tope o sin saldo) va a la
 *    cadena GENÉRICA gratis: texto sanitizado, SIN cobrarle a la empresa y con
 *    un tope diario por empresa (GENERIC_AI_DAILY_PER_COMPANY, 20 por defecto).
 * La cadena genérica solo recibe datos del negocio, productos, métricas
 * agregadas y textos de marketing: jamás conversaciones ni datos de clientes.
 */

export const GENERIC_DAILY_KEY = 'GENERIC_AI_DAILY_PER_COMPANY';
export const GENERIC_DAILY_DEFAULT = 20;
/** Fila de AiKeyUsage que cuenta los pedidos de cada empresa a la cadena genérica (fingerprint = id de la empresa). */
const GENERIC_USAGE_PROVIDER = 'GENERIC_COMPANY';
const DEFAULT_COMPANY_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

export const GENERIC_AI_LIMIT = 'GENERIC_AI_LIMIT';

export class GenericAiLimitError extends HttpException {
  constructor(limit: number) {
    super({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: GENERIC_AI_LIMIT,
      message: `Ya usaste los ${limit} pedidos de IA gratis de hoy. Mañana se renuevan; con IA propia (Mi plan → IA) no tienes este tope.`,
    }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export type TextAiRoute =
  | { kind: 'EMPRESA'; session: AiSession }
  | { kind: 'GENERICA'; reason: string };

export interface TextAiRequest {
  /** Para AiUsageEvent / créditos (ej. CREATIVE_COPY, REPORTE_RESUMEN) */
  purpose: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Agrupa varias llamadas de un mismo pedido en un solo crédito */
  requestId?: string;
}

export interface TextAiResult {
  content: string;
  source: 'EMPRESA' | 'GENERICA';
  model: string;
  billedTo: AiBilling | null;
}

export class CompanyTextAi {
  constructor(
    private readonly prisma: any,
    private readonly ai: AiProvider | undefined,
    readonly pool: GeminiPool,
  ) {}

  /** ¿Con qué IA se hace este pedido? */
  async route(company: any): Promise<TextAiRoute> {
    if (!this.ai) return { kind: 'GENERICA', reason: 'sin proveedor de la empresa' };
    const access = await resolveAiAccess(this.prisma, company);
    if (!access.ok) return { kind: 'GENERICA', reason: access.reason };
    return { kind: 'EMPRESA', session: new AiSession(access) };
  }

  async genericLimit(): Promise<number> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: GENERIC_DAILY_KEY } }).catch(() => null);
    const n = Number(row?.value?.trim() || process.env[GENERIC_DAILY_KEY] || GENERIC_DAILY_DEFAULT);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : GENERIC_DAILY_DEFAULT;
  }

  async genericUsage(companyId: string): Promise<{ used: number; limit: number }> {
    const row = await this.prisma.aiKeyUsage.findFirst({ where: { provider: GENERIC_USAGE_PROVIDER, fingerprint: companyId, day: bogotaDay() } });
    return { used: row?.requests ?? 0, limit: await this.genericLimit() };
  }

  /**
   * Cuenta UN pedido de la empresa a la cadena genérica (los reintentos del
   * mismo pedido no cuentan). Si ya llegó al tope lanza GenericAiLimitError.
   */
  async reserveGeneric(companyId: string): Promise<{ used: number; limit: number }> {
    const day = bogotaDay();
    const limit = await this.genericLimit();
    const row = await this.prisma.aiKeyUsage.findFirst({ where: { provider: GENERIC_USAGE_PROVIDER, fingerprint: companyId, day } });
    if ((row?.requests ?? 0) >= limit) throw new GenericAiLimitError(limit);
    if (row) await this.prisma.aiKeyUsage.update({ where: { id: row.id }, data: { requests: row.requests + 1 } });
    else await this.prisma.aiKeyUsage.create({ data: { provider: GENERIC_USAGE_PROVIDER, fingerprint: companyId, day, requests: 1, tokens: 0 } });
    return { used: (row?.requests ?? 0) + 1, limit };
  }

  /** Nombres de contactos y clientes de la empresa: el sanitizador los quita si aparecen. */
  async knownNames(companyId: string): Promise<string[]> {
    const [contacts, customers] = await Promise.all([
      this.prisma.contact.findMany({ where: { companyId }, select: { name: true }, take: 500 }).catch(() => []),
      this.prisma.customer.findMany({ where: { companyId, ...NOT_DELETED }, select: { name: true }, take: 500 }).catch(() => []),
    ]);
    return [...new Set([...contacts, ...customers].map((c: any) => String(c?.name ?? '').trim()).filter((n) => n.length >= 3))];
  }

  /** Una llamada por la ruta elegida. En la genérica puede lanzar AI_UNAVAILABLE (quien llama decide su plan B). */
  async complete(company: any, route: TextAiRoute, req: TextAiRequest, opts: { model?: string; knownNames?: string[] } = {}): Promise<TextAiResult> {
    if (route.kind === 'EMPRESA') {
      const model = opts.model ?? DEFAULT_COMPANY_MODEL;
      const ai = this.ai!;
      const { result, billedTo } = await route.session.run((apiKey) => ai.chat({
        apiKey, model, messages: req.messages, temperature: req.temperature ?? 0.4, maxTokens: req.maxTokens ?? 900, jsonMode: req.json,
      }));
      await recordAiUsage(this.prisma, {
        companyId: company.id, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        billedTo, purpose: req.purpose, conversationId: req.requestId ?? null,
      });
      return { content: result.content, source: 'EMPRESA', model: result.model, billedTo };
    }
    const r = await this.pool.chat({
      messages: req.messages, json: req.json, maxTokens: req.maxTokens, temperature: req.temperature ?? 0.4,
      knownNames: opts.knownNames ?? (await this.knownNames(company.id)),
      deadlineMs: 45_000,
    });
    return { content: r.content, source: 'GENERICA', model: r.model, billedTo: null };
  }
}
