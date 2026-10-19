import { Logger } from '@nestjs/common';
import type { ChatMessage } from './types';
import { fingerprint } from './gemini-pool';

/**
 * Respaldo GRATIS de la IA de registro: modelos gratuitos de OpenRouter (los
 * ids que terminan en ":free").
 *  - La llave vive solo en el .env (OPENROUTER_API_KEY, varias separadas por coma).
 *  - El orden de los modelos lo decide la cadena de Dev Tools (gemini-pool.ts);
 *    aquí solo se llama un modelo con las llaves disponibles.
 *  - Muchos gratuitos "piensan" antes de responder: se les da margen de tokens
 *    y se pide que no devuelvan el razonamiento.
 *  - Límites: tope por minuto por modelo (429 → descansa 1 min) y tope diario
 *    por cuenta (la llave queda agotada hasta mañana). 404/403 → el modelo se
 *    aparta 6 h (retirado, política de datos o solo para agentes).
 */

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CATALOG_TTL_MS = 6 * 3600e3;

/** Familias que respondieron bien en español y JSON en las pruebas (oct 2026). */
const PREFERENCE = [
  /minimax/i, /nemotron-3-ultra/i, /gemma-4-31b/i, /gemma-4/i, /xing/i, /nemotron-3-super/i, /dots/i,
  /deepseek/i, /qwen/i, /llama/i, /mistral/i, /nemotron/i,
];
/** Nunca para esto: visión/audio/música, moderación, código, solo-agentes o modelos de "decisiones". */
const EXCLUDE = /(vision|-vl\b|-vl:|omni|embed|guard|safety|moderation|audio|tts|whisper|lyria|code|coder|inkling|decide|lfm-2\.5-2\.6b|laguna-xs)/i;

export interface CatalogModel {
  id: string;
  name: string;
  context: number;
  free: boolean;
  description: string;
}

export interface ModelCallResult {
  content: string;
  model: string;
  keyLabel: string;
  tokens: number;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

/** Algunos modelos gratis piensan en voz alta o envuelven el JSON en ```. */
export function cleanModelText(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/** Gratuitos útiles para conversar, del más recomendado al menos. */
export function rankFreeModels(catalog: Array<{ id: string; context_length?: number; pricing?: Record<string, string> }>): string[] {
  const free = catalog.filter((m) => {
    const p = m.pricing ?? {};
    const isFree = m.id.endsWith(':free') || m.id === 'openrouter/free';
    return isFree && Number(p.prompt ?? 0) === 0 && !EXCLUDE.test(m.id) && (m.context_length ?? 0) >= 16000;
  });
  const score = (id: string) => {
    const i = PREFERENCE.findIndex((re) => re.test(id));
    return i === -1 ? PREFERENCE.length : i;
  };
  return free
    .sort((a, b) => score(a.id) - score(b.id) || (b.context_length ?? 0) - (a.context_length ?? 0))
    .map((m) => m.id);
}

export class OpenRouterPool {
  private readonly logger = new Logger('OpenRouter');
  readonly cooldown = new Map<string, number>();
  private catalogCache: { at: number; models: CatalogModel[]; ranked: string[] } | null = null;

  constructor(
    private readonly prisma: any,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
  ) {}

  keys(): string[] {
    return String(process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
  }

  configured(): boolean {
    return this.keys().length > 0;
  }

  /** Catálogo público de OpenRouter (cacheado 6 h; los gratuitos cambian seguido). */
  async catalog(force = false): Promise<{ models: CatalogModel[]; ranked: string[] }> {
    if (!force && this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache;
    try {
      const res = await this.fetchImpl(MODELS_URL, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const raw = (await res.json())?.data ?? [];
        const models: CatalogModel[] = (Array.isArray(raw) ? raw : []).map((m: any) => ({
          id: String(m.id),
          name: String(m.name ?? m.id),
          context: Number(m.context_length ?? 0),
          free: String(m.id).endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0),
          description: String(m.description ?? '').slice(0, 280),
        }));
        this.catalogCache = { at: Date.now(), models, ranked: rankFreeModels(raw) };
        return this.catalogCache;
      }
    } catch (err: any) {
      this.logger.warn(`no se pudo leer el catálogo: ${err?.message ?? err}`);
    }
    return this.catalogCache ?? { models: [], ranked: [] };
  }

  /** Datos de la cuenta (tope diario de gratis: ~50 sin créditos comprados, ~1000 con 10 USD o más). */
  private accountCache: { at: number; value: { freeTier: boolean | null; dailyFreeCap: number | null; limitRemaining: number | null } } | null = null;

  async account(): Promise<{ freeTier: boolean | null; dailyFreeCap: number | null; limitRemaining: number | null }> {
    const key = this.keys()[0];
    if (!key) return { freeTier: null, dailyFreeCap: null, limitRemaining: null };
    if (this.accountCache && Date.now() - this.accountCache.at < 5 * 60e3) return this.accountCache.value;
    try {
      const res = await this.fetchImpl(KEY_URL, { headers: { Authorization: `Bearer ${key}` } });
      const d = (await res.json())?.data ?? {};
      const freeTier = typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null;
      const value = {
        freeTier,
        dailyFreeCap: freeTier === null ? null : freeTier ? 50 : 1000,
        limitRemaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
      };
      this.accountCache = { at: Date.now(), value };
      return value;
    } catch {
      return { freeTier: null, dailyFreeCap: null, limitRemaining: null };
    }
  }

  private async usageRow(fp: string, day: string) {
    return this.prisma.aiKeyUsage.findFirst({ where: { provider: 'OPENROUTER', fingerprint: fp, day } });
  }

  private async bump(fp: string, day: string, data: { requests?: number; tokens?: number; exhausted?: boolean; error?: string }) {
    const row = await this.usageRow(fp, day);
    const patch = {
      ...(data.exhausted ? { exhaustedAt: new Date() } : {}),
      ...(data.error !== undefined ? { lastError: data.error.slice(0, 200) } : {}),
    };
    if (row) {
      await this.prisma.aiKeyUsage.update({
        where: { id: row.id },
        data: { requests: row.requests + (data.requests ?? 0), tokens: row.tokens + (data.tokens ?? 0), ...patch },
      });
    } else {
      await this.prisma.aiKeyUsage.create({
        data: { provider: 'OPENROUTER', fingerprint: fp, day, requests: data.requests ?? 0, tokens: data.tokens ?? 0, ...patch },
      });
    }
  }

  async keyStatus() {
    const day = today();
    const out: Array<{ label: string; requestsToday: number; exhausted: boolean; lastError: string | null }> = [];
    for (const [i, key] of this.keys().entries()) {
      const row = await this.usageRow(fingerprint(key), day);
      out.push({
        label: `OpenRouter ${i + 1} (${key.slice(0, 7)}…${key.slice(-4)})`,
        requestsToday: row?.requests ?? 0,
        exhausted: !!row?.exhaustedAt,
        lastError: row?.lastError ?? null,
      });
    }
    return out;
  }

  /** ¿Hay alguna llave usable hoy? */
  async anyKeyAvailable(): Promise<boolean> {
    const day = today();
    for (const key of this.keys()) {
      const fp = fingerprint(key);
      if ((this.cooldown.get(fp) ?? 0) > Date.now()) continue;
      if (!(await this.usageRow(fp, day))?.exhaustedAt) return true;
    }
    return false;
  }

  modelCooldownUntil(model: string): number {
    let until = 0;
    for (const key of this.keys()) until = Math.max(until, this.cooldown.get(`${fingerprint(key)}:${model}`) ?? 0);
    return until;
  }

  /**
   * Un modelo, probando las llaves disponibles. Devuelve null con el motivo si
   * no respondió (la cadena sigue con el siguiente modelo).
   */
  async tryModel(
    model: string,
    opts: { messages: ChatMessage[]; json?: boolean; maxTokens?: number; temperature?: number; timeoutMs?: number },
  ): Promise<{ result: ModelCallResult | null; error: string }> {
    const keys = this.keys();
    if (!keys.length) return { result: null, error: 'sin llave de OpenRouter' };
    const day = today();
    // Razonadores: el cupo de tokens incluye lo que piensan
    const maxTokens = Math.max(opts.maxTokens ?? 0, 4000);
    const timeoutMs = opts.timeoutMs ?? ((opts.maxTokens ?? 0) > 1500 ? 75_000 : 30_000);
    let error = 'sin respuesta';
    for (const [i, key] of keys.entries()) {
      const fp = fingerprint(key);
      const combo = `${fp}:${model}`;
      if ((this.cooldown.get(fp) ?? 0) > Date.now()) { error = 'llave apartada'; continue; }
      if ((this.cooldown.get(combo) ?? 0) > Date.now()) { error = 'modelo descansando'; continue; }
      if ((await this.usageRow(fp, day))?.exhaustedAt) { error = 'tope diario de la llave'; continue; }
      for (const strictJson of opts.json ? [true, false] : [false]) {
        let res;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          res = await this.fetchImpl(CHAT_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': process.env.PUBLIC_WEB_URL || 'https://backoffice.app',
              'X-Title': 'BackOffice',
            },
            body: JSON.stringify({
              model,
              messages: opts.messages,
              temperature: opts.temperature ?? 0.3,
              max_tokens: maxTokens,
              reasoning: { effort: 'low', exclude: true },
              ...(strictJson ? { response_format: { type: 'json_object' } } : {}),
            }),
          }).finally(() => clearTimeout(timer));
        } catch (err: any) {
          error = err?.name === 'AbortError' ? 'tardó demasiado' : 'error de red';
          if (err?.name === 'AbortError') this.cooldown.set(combo, Date.now() + 10 * 60e3);
          break;
        }
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data?.error) {
            error = String(data.error.message ?? 'error del proveedor').slice(0, 140);
            this.cooldown.set(combo, Date.now() + 2 * 60e3);
            break;
          }
          const content = cleanModelText(String(data?.choices?.[0]?.message?.content ?? ''));
          const tokens = Number(data?.usage?.total_tokens ?? 0);
          await this.bump(fp, day, { requests: 1, tokens, error: '' });
          if (content) return { result: { content, model, keyLabel: `openrouter ${i + 1}`, tokens }, error: '' };
          error = 'respuesta vacía';
          break;
        }
        const body = await res.text().catch(() => '');
        if (res.status === 400 && strictJson && /response_format|json/i.test(body)) continue; // reintento sin JSON estricto
        error = `${res.status} ${body.replace(/\s+/g, ' ').slice(0, 140)}`;
        if (res.status === 429) {
          if (/per-day|per day|daily/i.test(body)) {
            await this.bump(fp, day, { exhausted: true, error: `429 ${body.slice(0, 120)}` });
            this.logger.warn(`llave ${i + 1} llegó al tope diario de modelos gratis`);
          } else {
            this.cooldown.set(combo, Date.now() + 60e3); // tope por minuto de ese modelo
          }
          break;
        }
        if (res.status === 401) {
          this.cooldown.set(fp, Date.now() + 3600e3);
          await this.bump(fp, day, { error: '401 rechazada' });
          break;
        }
        if (res.status === 402) {
          await this.bump(fp, day, { exhausted: true, error: '402 sin saldo' });
          break;
        }
        // 400/403/404 (no es de chat, solo agentes, retirado) → 6 h; 5xx → 2 min
        this.cooldown.set(combo, Date.now() + (res.status >= 500 ? 2 * 60e3 : 6 * 3600e3));
        break;
      }
    }
    return { result: null, error };
  }
}
