import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { extractJson, type ChatMessage } from './types';
import { OpenRouterPool } from './openrouter-pool';

/**
 * IA GENÉRICA del registro por la web y del acompañamiento (no es de ninguna
 * empresa). Es una CADENA de modelos que se recorre en orden hasta que uno
 * responde; el orden se cambia en Dev Tools → IA del registro:
 *  - GEMINI: llaves de Google (GEMINI_API_KEYS) que rotan solas. Tope propio por
 *    llave y día (GEMINI_DAILY_LIMIT); 429 / cuota → llave agotada hasta mañana;
 *    401/403 → llave apartada 1 h; 404/400 → ese modelo no existe para esa llave.
 *  - OPENROUTER: modelos gratuitos (OPENROUTER_API_KEY), ver openrouter-pool.ts.
 * Cada llamada deja estadísticas por modelo (éxitos, fallas, tiempo) y Dev Tools
 * puede correr una prueba que puntúa calidad y velocidad de cada uno.
 * Si ningún modelo responde lanza AI_UNAVAILABLE y quien llama usa su plan B
 * sin IA (el registro nunca se bloquea).
 * Las llaves viven solo en el .env; en la base se guarda una huella, nunca la llave.
 */

export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';

export function isAiUnavailable(err: unknown): boolean {
  const res: any = (err as any)?.getResponse?.();
  return !!res && typeof res === 'object' && res.code === AI_UNAVAILABLE;
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// Del más rápido al más lento (medido oct 2026): 2.5-flash <1 s, 3.5-flash-lite ~7 s, 3.5-flash ~15 s
const DEFAULT_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];
const TIMEOUT_MS = 20_000;
const SLOW_COOLDOWN_MS = 10 * 60e3; // un modelo que se colgó se aparta 10 min
const CHAIN_KEY = 'SIGNUP_AI_CHAIN';
const STATS_KEY = 'SIGNUP_AI_STATS';

export type AiProviderName = 'GEMINI' | 'OPENROUTER';

export interface ChainEntry {
  provider: AiProviderName;
  model: string;
  enabled: boolean;
}

export interface ModelStats {
  ok: number;
  fail: number;
  totalMs: number;
  lastMs: number | null;
  lastError: string | null;
  lastAt: string | null;
  /** Última prueba de Dev Tools: puntaje 0-100 y segundos */
  bench?: { at: string; score: number; seconds: number; checks: Record<string, boolean>; error?: string };
}

export interface PoolChatResult {
  content: string;
  model: string;
  keyLabel: string;
  tokens: number;
  provider: AiProviderName;
}

export type ChatOpts = { messages: ChatMessage[]; json?: boolean; maxTokens?: number; temperature?: number; timeoutMs?: number };
type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

export function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export const maskKey = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

export const chainId = (e: Pick<ChainEntry, 'provider' | 'model'>) => `${e.provider}:${e.model}`;

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

/** Cadena guardada, validada (sin repetidos, proveedores conocidos). */
export function sanitizeChain(raw: unknown): ChainEntry[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : [])
    .map((e: any) => ({
      provider: e?.provider === 'OPENROUTER' ? 'OPENROUTER' as const : e?.provider === 'GEMINI' ? 'GEMINI' as const : null,
      model: typeof e?.model === 'string' ? e.model.trim().slice(0, 120) : '',
      enabled: e?.enabled !== false,
    }))
    .filter((e): e is ChainEntry => !!e.provider && /^[\w.:/@-]+$/.test(e.model) && !seen.has(chainId(e as ChainEntry)) && !!seen.add(chainId(e as ChainEntry)))
    .slice(0, 40);
}

export class GeminiPool {
  private readonly logger = new Logger('SetupAI');
  /** Enfriamientos en memoria: llave apartada / modelo inexistente por llave */
  private readonly cooldown = new Map<string, number>();
  readonly backup: OpenRouterPool;

  constructor(
    private readonly prisma: any,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
  ) {
    this.backup = new OpenRouterPool(prisma, fetchImpl as any);
  }

  /* ── Configuración ─────────────────────────────────────────────── */

  private async setting(key: string): Promise<string | undefined> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } }).catch(() => null);
    return row?.value?.trim() || undefined;
  }

  private async saveSetting(key: string, value: string) {
    const existing = await this.prisma.platformSetting.findUnique({ where: { key } });
    if (existing) await this.prisma.platformSetting.update({ where: { key }, data: { value } });
    else await this.prisma.platformSetting.create({ data: { key, value } });
  }

  private async geminiConfig() {
    const models = String((await this.setting('GEMINI_MODELS')) || process.env.GEMINI_MODELS || '')
      .split(',').map((m) => m.trim()).filter(Boolean);
    const limit = Number((await this.setting('GEMINI_DAILY_LIMIT')) || process.env.GEMINI_DAILY_LIMIT || 80);
    return {
      keys: String(process.env.GEMINI_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
      models: models.length ? models : DEFAULT_GEMINI_MODELS,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 80,
    };
  }

  /** Orden guardado en Dev Tools; sin guardar: Gemini primero y luego los gratuitos de OpenRouter. */
  async chain(): Promise<{ entries: ChainEntry[]; custom: boolean }> {
    const saved = await this.setting(CHAIN_KEY);
    if (saved) {
      try {
        const entries = sanitizeChain(JSON.parse(saved));
        if (entries.length) return { entries, custom: true };
      } catch {
        /* cadena dañada → la de siempre */
      }
    }
    const { models } = await this.geminiConfig();
    const entries: ChainEntry[] = models.map((model) => ({ provider: 'GEMINI', model, enabled: true }));
    if (this.backup.configured()) {
      const fixed = String((await this.setting('OPENROUTER_MODELS')) || process.env.OPENROUTER_MODELS || '')
        .split(',').map((m) => m.trim()).filter(Boolean);
      const orModels = fixed.length ? fixed : (await this.backup.catalog()).ranked.slice(0, 8);
      entries.push(...orModels.map((model) => ({ provider: 'OPENROUTER' as const, model, enabled: true })));
    }
    return { entries, custom: false };
  }

  async saveChain(raw: unknown): Promise<ChainEntry[]> {
    const entries = sanitizeChain(raw);
    if (!entries.length) {
      await this.prisma.platformSetting.deleteMany({ where: { key: CHAIN_KEY } });
      return (await this.chain()).entries;
    }
    await this.saveSetting(CHAIN_KEY, JSON.stringify(entries));
    return entries;
  }

  /* ── Estadísticas ──────────────────────────────────────────────── */

  async stats(): Promise<Record<string, ModelStats>> {
    try {
      return JSON.parse((await this.setting(STATS_KEY)) ?? '{}');
    } catch {
      return {};
    }
  }

  private writes: Promise<void> = Promise.resolve();

  /** Una escritura a la vez (las pruebas corren en paralelo y no deben pisarse). */
  record(id: string, patch: (s: ModelStats) => ModelStats): Promise<void> {
    this.writes = this.writes.then(async () => {
      try {
        const all = await this.stats();
        const base: ModelStats = all[id] ?? { ok: 0, fail: 0, totalMs: 0, lastMs: null, lastError: null, lastAt: null };
        all[id] = patch(base);
        await this.saveSetting(STATS_KEY, JSON.stringify(all));
      } catch {
        /* las estadísticas nunca rompen una respuesta */
      }
    });
    return this.writes;
  }

  async resetStats() {
    await this.prisma.platformSetting.deleteMany({ where: { key: STATS_KEY } });
  }

  /* ── Llaves de Gemini ──────────────────────────────────────────── */

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

  /** Un modelo de Gemini, rotando las llaves disponibles. */
  private async tryGemini(model: string, opts: ChatOpts): Promise<{ result: PoolChatResult | null; error: string }> {
    const { keys, limit } = await this.geminiConfig();
    if (!keys.length) return { result: null, error: 'sin llaves de Gemini' };
    const day = today();
    let error = 'sin llaves disponibles hoy';
    for (const [i, key] of keys.entries()) {
      const fp = fingerprint(key);
      const combo = `${fp}:${model}`;
      if ((this.cooldown.get(fp) ?? 0) > Date.now()) continue;
      if ((this.cooldown.get(combo) ?? 0) > Date.now()) { error = 'modelo descansando'; continue; }
      const u = await this.usage(fp, day);
      if (u?.exhaustedAt || (u?.requests ?? 0) >= limit) continue; // agotada hoy → siguiente llave
      let res;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
        res = await this.fetchImpl(GEMINI_URL, {
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
        error = err?.name === 'AbortError' ? 'tardó demasiado' : String(err?.message ?? err);
        if (err?.name === 'AbortError') this.cooldown.set(combo, Date.now() + SLOW_COOLDOWN_MS);
        return { result: null, error }; // red o modelo colgado → siguiente modelo
      }
      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content ?? '';
        const tokens = Number(data?.usage?.total_tokens ?? 0);
        await this.bump(fp, day, { requests: 1, tokens, error: '' });
        if (content) return { result: { content, model, keyLabel: `llave ${i + 1}`, tokens, provider: 'GEMINI' }, error: '' };
        return { result: null, error: 'respuesta vacía' };
      }
      const body = await res.text().catch(() => '');
      error = `${res.status}`;
      if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(body)) {
        // Cuota de Google agotada: esta llave no sirve más hoy → siguiente llave
        await this.bump(fp, day, { exhausted: true, error: `429 ${body.slice(0, 120)}` });
        this.logger.warn(`llave ${i + 1} de Gemini agotada (${model}); paso a la siguiente`);
        error = 'cuota agotada';
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        this.cooldown.set(fp, Date.now() + 3600e3);
        await this.bump(fp, day, { error: `${res.status} rechazada` });
        continue;
      }
      if (res.status === 404 || res.status === 400) {
        this.cooldown.set(combo, Date.now() + 6 * 3600e3); // ese modelo no existe para esta llave
        error = 'modelo no disponible para esta llave';
        continue;
      }
      // 5xx / saturado: se aparta un rato y se prueba el siguiente modelo
      if (res.status >= 500) this.cooldown.set(combo, Date.now() + 2 * 60e3);
      return { result: null, error: res.status >= 500 ? 'saturado' : error };
    }
    return { result: null, error };
  }

  /** Un eslabón de la cadena, con estadísticas. */
  async tryEntry(entry: Pick<ChainEntry, 'provider' | 'model'>, opts: ChatOpts, track = true) {
    const t = Date.now();
    const out = entry.provider === 'GEMINI'
      ? await this.tryGemini(entry.model, opts)
      : await this.backup.tryModel(entry.model, opts).then((r) => ({
          result: r.result ? { ...r.result, provider: 'OPENROUTER' as const } : null,
          error: r.error,
        }));
    const ms = Date.now() - t;
    // "sin llaves / descansando" no es culpa del modelo: no cuenta como falla
    const skipped = !out.result && /^(sin llave|sin llaves|modelo descansando|llave apartada|tope diario)/.test(out.error);
    if (track && !skipped) {
      await this.record(chainId(entry), (s) => ({
        ...s,
        ok: s.ok + (out.result ? 1 : 0),
        fail: s.fail + (out.result ? 0 : 1),
        totalMs: s.totalMs + (out.result ? ms : 0),
        lastMs: out.result ? ms : s.lastMs,
        lastError: out.result ? s.lastError : out.error,
        lastAt: new Date().toISOString(),
      }));
    }
    return { ...out, ms };
  }

  async chat(opts: ChatOpts): Promise<PoolChatResult> {
    const { entries } = await this.chain();
    const errors: string[] = [];
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const { result, error } = await this.tryEntry(entry, opts);
      if (result) return result;
      errors.push(`${entry.model}: ${error}`);
    }
    this.logger.error(`ninguna IA respondió: ${errors.slice(-4).join(' | ') || 'cadena vacía'}`);
    throw new ServiceUnavailableException({
      code: AI_UNAVAILABLE,
      message: 'La IA está ocupada en este momento. Intenta de nuevo en unos minutos.',
    });
  }

  /**
   * Como chat(), pero exige un JSON útil: si un modelo responde algo ilegible
   * (cortado, sin JSON, otro formato) se anota como falla y sigue el siguiente.
   */
  async chatJson<T = Record<string, any>>(
    opts: ChatOpts,
    accept: (raw: any) => boolean,
  ): Promise<{ raw: T; result: PoolChatResult; tokens: number; calls: number }> {
    const { entries } = await this.chain();
    const errors: string[] = [];
    let tokens = 0;
    let calls = 0;
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const { result, error } = await this.tryEntry(entry, { ...opts, json: true });
      if (!result) {
        errors.push(`${entry.model}: ${error}`);
        continue;
      }
      calls++;
      tokens += result.tokens;
      const raw = extractJson(result.content);
      if (raw && accept(raw)) return { raw: raw as T, result, tokens, calls };
      errors.push(`${entry.model}: JSON ilegible`);
      await this.record(chainId(entry), (s) => ({ ...s, ok: Math.max(0, s.ok - 1), fail: s.fail + 1, lastError: 'respondió sin el JSON pedido', lastAt: new Date().toISOString() }));
      this.logger.warn(`${entry.model} respondió sin el JSON pedido; sigo con el siguiente`);
    }
    this.logger.error(`ninguna IA dio un JSON útil: ${errors.slice(-4).join(' | ') || 'cadena vacía'}`);
    throw new ServiceUnavailableException({
      code: AI_UNAVAILABLE,
      message: 'La IA está ocupada en este momento. Intenta de nuevo en unos minutos.',
      tokens,
      calls,
    });
  }

  /* ── Estado para Dev Tools (sin exponer llaves) ────────────────── */

  async status() {
    const { keys, models, limit } = await this.geminiConfig();
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
    return { models, keys: out, backup: { keys: await this.backup.keyStatus() } };
  }

  /** ¿Puede responder este eslabón ahora? (llaves con cupo y modelo sin castigo) */
  async availability(entry: ChainEntry): Promise<{ state: 'LISTO' | 'DESCANSANDO' | 'SIN_CUPO' | 'SIN_LLAVE' | 'APAGADO'; until: string | null }> {
    if (!entry.enabled) return { state: 'APAGADO', until: null };
    if (entry.provider === 'OPENROUTER') {
      if (!this.backup.configured()) return { state: 'SIN_LLAVE', until: null };
      if (!(await this.backup.anyKeyAvailable())) return { state: 'SIN_CUPO', until: null };
      const until = this.backup.modelCooldownUntil(entry.model);
      return until > Date.now() ? { state: 'DESCANSANDO', until: new Date(until).toISOString() } : { state: 'LISTO', until: null };
    }
    const { keys, limit } = await this.geminiConfig();
    if (!keys.length) return { state: 'SIN_LLAVE', until: null };
    const day = today();
    let rest = 0;
    let usable = false;
    for (const key of keys) {
      const fp = fingerprint(key);
      if ((this.cooldown.get(fp) ?? 0) > Date.now()) continue;
      const u = await this.usage(fp, day);
      if (u?.exhaustedAt || (u?.requests ?? 0) >= limit) continue;
      const c = this.cooldown.get(`${fp}:${entry.model}`) ?? 0;
      if (c > Date.now()) rest = Math.max(rest, c);
      else usable = true;
    }
    if (usable) return { state: 'LISTO', until: null };
    return rest ? { state: 'DESCANSANDO', until: new Date(rest).toISOString() } : { state: 'SIN_CUPO', until: null };
  }
}
