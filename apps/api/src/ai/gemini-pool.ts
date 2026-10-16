import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { ChatMessage } from './types';

/**
 * Llaves GENÉRICAS de Gemini para el registro por la web y el acompañamiento
 * (no son de ninguna empresa). Se usan en orden y rotan solas:
 *  - tope propio por llave y por día (GEMINI_DAILY_LIMIT) → siguiente llave;
 *  - Google responde 429 / cuota agotada → esa llave queda agotada hasta mañana;
 *  - 401/403 → la llave se aparta una hora; 404 → ese modelo no existe para esa
 *    llave (se prueba el siguiente); 5xx / saturado → siguiente modelo.
 * Las llaves viven solo en el .env; en la base se guarda una huella, nunca la llave.
 */

const URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// Del más rápido al más lento (medido oct 2026): 2.5-flash <1 s, 3.5-flash-lite ~7 s, 3.5-flash ~15 s
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];
const TIMEOUT_MS = 20_000;
const SLOW_COOLDOWN_MS = 10 * 60e3; // un modelo que se colgó se aparta 10 min

export interface PoolChatResult {
  content: string;
  model: string;
  keyLabel: string;
  tokens: number;
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

export function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export const maskKey = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

export class GeminiPool {
  private readonly logger = new Logger('GeminiPool');
  /** Enfriamientos en memoria: llave apartada / modelo inexistente por llave */
  private readonly cooldown = new Map<string, number>();

  constructor(
    private readonly prisma: any,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
  ) {}

  private async config() {
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['GEMINI_MODELS', 'GEMINI_DAILY_LIMIT'] } },
    });
    const setting = (k: string) => rows.find((r: any) => r.key === k)?.value?.trim();
    const keys = String(process.env.GEMINI_API_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
    const models = String(setting('GEMINI_MODELS') || process.env.GEMINI_MODELS || '')
      .split(',').map((m) => m.trim()).filter(Boolean);
    const limit = Number(setting('GEMINI_DAILY_LIMIT') || process.env.GEMINI_DAILY_LIMIT || 80);
    return { keys, models: models.length ? models : DEFAULT_MODELS, limit: Number.isFinite(limit) && limit > 0 ? limit : 80 };
  }

  private async usage(fp: string, day: string) {
    return this.prisma.aiKeyUsage.findFirst({ where: { provider: 'GEMINI', fingerprint: fp, day } });
  }

  private async bump(fp: string, day: string, data: { requests?: number; tokens?: number; exhausted?: boolean; error?: string }) {
    const existing = await this.usage(fp, day);
    if (existing) {
      await this.prisma.aiKeyUsage.update({
        where: { id: existing.id },
        data: {
          requests: existing.requests + (data.requests ?? 0),
          tokens: existing.tokens + (data.tokens ?? 0),
          ...(data.exhausted ? { exhaustedAt: new Date() } : {}),
          ...(data.error !== undefined ? { lastError: data.error.slice(0, 200) } : {}),
        },
      });
    } else {
      await this.prisma.aiKeyUsage.create({
        data: {
          provider: 'GEMINI', fingerprint: fp, day,
          requests: data.requests ?? 0, tokens: data.tokens ?? 0,
          ...(data.exhausted ? { exhaustedAt: new Date() } : {}),
          ...(data.error ? { lastError: data.error.slice(0, 200) } : {}),
        },
      });
    }
  }

  /** Estado para Dev Tools (sin exponer llaves). */
  async status() {
    const { keys, models, limit } = await this.config();
    const day = today();
    const out: Array<{ label: string; requestsToday: number; limit: number; exhausted: boolean; lastError: string | null }> = [];
    for (const [i, key] of keys.entries()) {
      const u = await this.usage(fingerprint(key), day);
      out.push({
        label: `Llave ${i + 1} (${maskKey(key)})`,
        requestsToday: u?.requests ?? 0,
        limit,
        exhausted: !!u?.exhaustedAt || (u?.requests ?? 0) >= limit,
        lastError: u?.lastError ?? null,
      });
    }
    return { models, keys: out };
  }

  async chat(opts: { messages: ChatMessage[]; json?: boolean; maxTokens?: number; temperature?: number }): Promise<PoolChatResult> {
    const { keys, models, limit } = await this.config();
    if (!keys.length) throw new ServiceUnavailableException('La IA de configuración no tiene llaves (GEMINI_API_KEYS)');
    const day = today();
    const now = Date.now();
    let lastError = 'sin respuesta';
    for (const [i, key] of keys.entries()) {
      const fp = fingerprint(key);
      if ((this.cooldown.get(fp) ?? 0) > now) continue;
      const u = await this.usage(fp, day);
      if (u?.exhaustedAt || (u?.requests ?? 0) >= limit) continue; // agotada hoy → siguiente
      for (const model of models) {
        const comboKey = `${fp}:${model}`;
        if ((this.cooldown.get(comboKey) ?? 0) > now) continue;
        let res;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
          res = await this.fetchImpl(URL, {
            method: 'POST',
            signal: controller.signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: opts.messages,
              temperature: opts.temperature ?? 0.3,
              ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
              ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
            }),
          }).finally(() => clearTimeout(timer));
        } catch (err: any) {
          lastError = err?.name === 'AbortError' ? `${model} tiempo agotado` : String(err?.message ?? err);
          if (err?.name === 'AbortError') this.cooldown.set(comboKey, Date.now() + SLOW_COOLDOWN_MS);
          continue; // red o timeout → siguiente modelo
        }
        if (res.ok) {
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content ?? '';
          const tokens = Number(data?.usage?.total_tokens ?? 0);
          await this.bump(fp, day, { requests: 1, tokens, error: '' });
          if (content) return { content, model, keyLabel: `llave ${i + 1}`, tokens };
          lastError = 'respuesta vacía';
          continue;
        }
        const body = await res.text().catch(() => '');
        lastError = `${model} ${res.status}`;
        if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(body)) {
          // Cuota de Google agotada: esta llave no sirve más hoy
          await this.bump(fp, day, { exhausted: true, error: `429 ${body.slice(0, 120)}` });
          this.logger.warn(`llave ${i + 1} agotada (${model}); paso a la siguiente`);
          break;
        }
        if (res.status === 401 || res.status === 403) {
          this.cooldown.set(fp, now + 3600e3);
          await this.bump(fp, day, { error: `${res.status} rechazada` });
          this.logger.warn(`llave ${i + 1} rechazada (${res.status})`);
          break;
        }
        if (res.status === 404 || res.status === 400) {
          this.cooldown.set(comboKey, now + 6 * 3600e3); // ese modelo no existe para esta llave
          continue;
        }
        // 5xx / saturado: se aparta un rato y se prueba el siguiente modelo
        if (res.status >= 500) this.cooldown.set(comboKey, Date.now() + 2 * 60e3);
      }
    }
    this.logger.error(`ninguna llave respondió: ${lastError}`);
    throw new ServiceUnavailableException('La IA está ocupada en este momento. Intenta de nuevo en unos minutos.');
  }
}
