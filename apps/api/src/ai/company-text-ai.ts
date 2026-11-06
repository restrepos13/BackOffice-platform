import { HttpException, HttpStatus } from '@nestjs/common';
import { NOT_DELETED } from '../common/constants';
import { AiTrial, activeAiTrial } from '../common/ai-trial';
import { AiBilling, AiSession, recordAiUsage, resolveAiAccess } from './ai-access';
import { GeminiPool } from './gemini-pool';
import { bogotaDay } from './openai-compat';
import type { AiProvider, ChatMessage } from './types';

/**
 * IA para una EMPRESA en Creative, Ads y reportes. Decide el proveedor con un
 * solo criterio:
 *  1. Si la empresa tiene IA propia (BYOK o revendida por BackOffice) se usa
 *     esa, por DeepInfra, y queda en AiUsageEvent como cualquier otro consumo.
 *  2. Si no, y un dev le autorizó la IA de PRUEBA (common/ai-trial.ts), va a la
 *     cadena genérica con nuestras llaves: texto sanitizado, sin cobro y con el
 *     tope diario de esa autorización.
 *  3. Si no hay ninguna, NINGUNA: quien llama sigue con el motor (sin IA).
 * La cadena genérica solo recibe datos del negocio, productos, métricas
 * agregadas y textos o imágenes de marketing: jamás conversaciones ni datos de
 * clientes.
 */

/** Fila de AiKeyUsage que cuenta los pedidos de cada empresa a la cadena de prueba (fingerprint = id de la empresa). */
const TRIAL_USAGE_PROVIDER = 'GENERIC_COMPANY';
const DEFAULT_COMPANY_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

export const GENERIC_AI_LIMIT = 'GENERIC_AI_LIMIT';

export class GenericAiLimitError extends HttpException {
  constructor(limit: number) {
    super({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: GENERIC_AI_LIMIT,
      message: `Ya usaste los ${limit} pedidos de IA de prueba de hoy. Mañana se renuevan; con IA propia no tienes este tope.`,
    }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export type TextAiRoute =
  | { kind: 'EMPRESA'; session: AiSession }
  | { kind: 'GENERICA'; trial: AiTrial }
  | { kind: 'NINGUNA'; reason: string };

export interface TextAiRequest {
  /** Para AiUsageEvent / créditos (ej. CREATIVE_COPY, REPORTE_RESUMEN) */
  purpose: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Agrupa varias llamadas de un mismo pedido en un solo crédito */
  requestId?: string;
  /** Tarea de formato (JSON corto): en la IA de prueba, Gemini Flash responde sin "pensar" */
  noThinking?: boolean;
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
  async route(company: any, now = new Date()): Promise<TextAiRoute> {
    let reason = 'Sin proveedor de IA de la empresa';
    if (this.ai) {
      const access = await resolveAiAccess(this.prisma, company);
      if (access.ok) return { kind: 'EMPRESA', session: new AiSession(access) };
      reason = access.reason;
    }
    const trial = activeAiTrial(company, now);
    if (trial) return { kind: 'GENERICA', trial };
    return { kind: 'NINGUNA', reason };
  }

  async genericUsage(companyId: string, limit: number): Promise<{ used: number; limit: number }> {
    const row = await this.prisma.aiKeyUsage.findFirst({ where: { provider: TRIAL_USAGE_PROVIDER, fingerprint: companyId, day: bogotaDay() } });
    return { used: row?.requests ?? 0, limit };
  }

  /**
   * Cuenta UN pedido de la empresa a la IA de prueba, de forma atómica: con
   * varios pedidos a la vez nunca se pasa del tope. Si ya llegó, lanza
   * GenericAiLimitError. Si el pedido falla, se devuelve con releaseGeneric.
   */
  async reserveGeneric(companyId: string, limit: number): Promise<{ used: number; limit: number }> {
    const day = bogotaDay();
    const where = { provider: TRIAL_USAGE_PROVIDER, fingerprint: companyId, day };
    for (let attempt = 0; attempt < 2; attempt++) {
      // Sube el contador solo si todavía está por debajo del tope (una sola operación en la base)
      const bumped = await this.prisma.aiKeyUsage.updateMany({ where: { ...where, requests: { lt: limit } }, data: { requests: { increment: 1 } } });
      if (bumped.count === 1) return this.genericUsage(companyId, limit);
      const row = await this.prisma.aiKeyUsage.findFirst({ where });
      if (row) throw new GenericAiLimitError(limit);
      if (limit < 1) throw new GenericAiLimitError(limit);
      try {
        await this.prisma.aiKeyUsage.create({ data: { ...where, requests: 1, tokens: 0 } });
        return { used: 1, limit };
      } catch (err: any) {
        // Otro pedido creó la fila al mismo tiempo (índice único): se reintenta el incremento
        if (err?.code !== 'P2002') throw err;
      }
    }
    throw new GenericAiLimitError(limit);
  }

  /** Devuelve un pedido que no llegó a responder (no gasta cupo). */
  async releaseGeneric(companyId: string) {
    await this.prisma.aiKeyUsage.updateMany({
      where: { provider: TRIAL_USAGE_PROVIDER, fingerprint: companyId, day: bogotaDay(), requests: { gt: 0 } },
      data: { requests: { decrement: 1 } },
    }).catch(() => undefined);
  }

  /** Nombres de contactos y clientes de la empresa: el sanitizador los quita si aparecen. */
  async knownNames(companyId: string): Promise<string[]> {
    const [contacts, customers] = await Promise.all([
      this.prisma.contact.findMany({ where: { companyId }, select: { name: true }, take: 500 }).catch(() => []),
      this.prisma.customer.findMany({ where: { companyId, ...NOT_DELETED }, select: { name: true }, take: 500 }).catch(() => []),
    ]);
    return [...new Set([...contacts, ...customers].map((c: any) => String(c?.name ?? '').trim()).filter((n) => n.length >= 3))];
  }

  /** Una llamada por la ruta elegida. En la de prueba puede lanzar AI_UNAVAILABLE (quien llama decide su plan B). */
  async complete(company: any, route: TextAiRoute, req: TextAiRequest, opts: { model?: string; knownNames?: string[] } = {}): Promise<TextAiResult> {
    if (route.kind === 'NINGUNA') throw new Error(`Sin IA: ${route.reason}`);
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
      messages: req.messages, json: req.json, maxTokens: req.maxTokens, temperature: req.temperature ?? 0.4, noThinking: req.noThinking,
      knownNames: opts.knownNames ?? (await this.knownNames(company.id)),
      deadlineMs: 45_000,
    });
    return { content: r.content, source: 'GENERICA', model: r.model, billedTo: null };
  }

  /**
   * Reserva (si es la IA de prueba), llama y devuelve el cupo si falló. Para un
   * pedido de UNA llamada; los de varias llamadas reservan una vez y llaman a
   * complete() varias.
   */
  async run(company: any, route: TextAiRoute, req: TextAiRequest, opts: { model?: string; knownNames?: string[] } = {}): Promise<TextAiResult> {
    if (route.kind === 'GENERICA') await this.reserveGeneric(company.id, route.trial.dailyLimit);
    try {
      return await this.complete(company, route, req, opts);
    } catch (err) {
      if (route.kind === 'GENERICA') await this.releaseGeneric(company.id);
      throw err;
    }
  }

  /** Lo que se le muestra a la empresa: qué IA tiene y cuánto le queda de la de prueba. */
  async describe(company: any): Promise<{ source: TextAiRoute['kind']; trial: { until: string; used: number; limit: number } | null }> {
    const route = await this.route(company);
    if (route.kind !== 'GENERICA') return { source: route.kind, trial: null };
    const usage = await this.genericUsage(company.id, route.trial.dailyLimit);
    return { source: 'GENERICA', trial: { until: route.trial.until, ...usage } };
  }
}
