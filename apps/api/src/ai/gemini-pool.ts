import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { extractJson, type ChatMessage } from './types';
import { OpenRouterPool } from './openrouter-pool';
import { FetchLike, KEYED_PROVIDERS, KeyedProvider, KeyedProviderName, PROVIDER_CONFIG, fingerprint, maskKey } from './openai-compat';
import { sanitizeMessages } from './generic-privacy';

/**
 * IA GENÉRICA del registro por la web y del acompañamiento (no es de ninguna
 * empresa). Es una CADENA de modelos que se recorre en orden hasta que uno
 * responde; el orden se cambia en Dev Tools → IA del registro:
 *  - GEMINI, GROQ y CEREBRAS: llaves genéricas del .env (GEMINI_API_KEYS,
 *    GROQ_API_KEYS, CEREBRAS_API_KEY) que rotan solas, con tope propio por
 *    llave y día. Comparten el mismo manejo (openai-compat.ts): 429 / cuota →
 *    llave agotada hasta mañana; 401/403 → apartada 1 h; 404/400 → ese modelo
 *    no existe para esa llave; cuelgue → el modelo descansa 10 min.
 *  - OPENROUTER: modelos gratuitos (OPENROUTER_API_KEY), ver openrouter-pool.ts.
 * Orden automático: el primer modelo de Gemini (2.5 Flash) → Groq → Cerebras →
 * el resto de Gemini → OpenRouter. Groq y Cerebras solo entran con llave y con
 * un modelo que exista en su GET /models.
 * Cada llamada deja estadísticas por modelo (éxitos, fallas, tiempo) y Dev Tools
 * puede correr una prueba que puntúa calidad y velocidad de cada uno.
 * Si ningún modelo responde lanza AI_UNAVAILABLE y quien llama usa su plan B
 * sin IA (el registro nunca se bloquea).
 * PRIVACIDAD: todo mensaje pasa por sanitizeForGenericAi (generic-privacy.ts).
 * Las llaves viven solo en el .env; en la base se guarda una huella, nunca la llave.
 */

export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';

export function isAiUnavailable(err: unknown): boolean {
  const res: any = (err as any)?.getResponse?.();
  return !!res && typeof res === 'object' && res.code === AI_UNAVAILABLE;
}

export { fingerprint, maskKey };

// Del más rápido al más lento (medido oct 2026): 2.5-flash <1 s, 3.5-flash-lite ~7 s, 3.5-flash ~15 s
const DEFAULT_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];
const CHAIN_KEY = 'SIGNUP_AI_CHAIN';
const STATS_KEY = 'SIGNUP_AI_STATS';

export type AiProviderName = KeyedProviderName | 'OPENROUTER';
export const CHAIN_PROVIDERS: AiProviderName[] = [...KEYED_PROVIDERS, 'OPENROUTER'];

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

export type ChatOpts = {
  messages: ChatMessage[]; json?: boolean; maxTokens?: number; temperature?: number; timeoutMs?: number;
  /** Sin razonamiento en Gemini Flash (ver CompatChatOpts.noThinking) */
  noThinking?: boolean;
  /** Tiempo máximo de TODA la cadena: al vencerse se da por no disponible (y el registro pasa al plan B) */
  deadlineMs?: number;
  /** Nombres de contactos conocidos que el sanitizador debe quitar */
  knownNames?: string[];
};

export const chainId = (e: Pick<ChainEntry, 'provider' | 'model'>) => `${e.provider}:${e.model}`;

/** Cadena guardada, validada (sin repetidos, proveedores conocidos). */
export function sanitizeChain(raw: unknown): ChainEntry[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : [])
    .map((e: any) => ({
      provider: (CHAIN_PROVIDERS as string[]).includes(e?.provider) ? (e.provider as AiProviderName) : null,
      model: typeof e?.model === 'string' ? e.model.trim().slice(0, 120) : '',
      enabled: e?.enabled !== false,
    }))
    .filter((e): e is ChainEntry => !!e.provider && /^[\w.:/@-]+$/.test(e.model) && !seen.has(chainId(e as ChainEntry)) && !!seen.add(chainId(e as ChainEntry)))
    .slice(0, 40);
}

/**
 * fetch real, salvo en las pruebas: aunque otro archivo haya cargado el .env
 * con llaves de verdad, Jest jamás llama a un proveedor real (las pruebas
 * inyectan su fetch simulado).
 */
const realFetch: FetchLike = (url, init) =>
  process.env.JEST_WORKER_ID ? Promise.reject(new Error('sin red en las pruebas')) : (fetch(url, init) as any);

/** Recorta el tiempo de espera de un intento a lo que queda del presupuesto total. */
function withBudget(opts: ChatOpts, left: number): ChatOpts {
  if (!Number.isFinite(left)) return opts;
  return { ...opts, timeoutMs: Math.max(2000, Math.min(opts.timeoutMs ?? left, left)) };
}

export class GeminiPool {
  private readonly logger = new Logger('SetupAI');
  readonly backup: OpenRouterPool;
  /** Gemini, Groq y Cerebras: mismas reglas de llaves y modelos */
  readonly keyed: Record<KeyedProviderName, KeyedProvider>;

  constructor(
    private readonly prisma: any,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {
    this.backup = new OpenRouterPool(prisma, fetchImpl as any);
    this.keyed = {
      GEMINI: new KeyedProvider(PROVIDER_CONFIG.GEMINI, prisma, fetchImpl),
      GROQ: new KeyedProvider(PROVIDER_CONFIG.GROQ, prisma, fetchImpl),
      CEREBRAS: new KeyedProvider(PROVIDER_CONFIG.CEREBRAS, prisma, fetchImpl),
    };
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

  private async geminiModels(): Promise<string[]> {
    const models = String((await this.setting('GEMINI_MODELS')) || process.env.GEMINI_MODELS || '')
      .split(',').map((m) => m.trim()).filter(Boolean);
    return models.length ? models : DEFAULT_GEMINI_MODELS;
  }

  /**
   * Orden guardado en Dev Tools; sin guardar: Gemini 2.5 Flash → Groq →
   * Cerebras → el resto de Gemini → los gratuitos de OpenRouter.
   */
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
    const [first, ...rest] = (await this.geminiModels()).map((model) => ({ provider: 'GEMINI' as const, model, enabled: true }));
    const fast: ChainEntry[] = [];
    for (const name of ['GROQ', 'CEREBRAS'] as const) {
      if (!this.keyed[name].configured()) continue;
      const model = await this.keyed[name].defaultModel();
      if (model) fast.push({ provider: name, model, enabled: true });
    }
    const entries: ChainEntry[] = [...(first ? [first] : []), ...fast, ...rest];
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

  /* ── Catálogos de modelos ──────────────────────────────────────── */

  /** GET /models de cada proveedor con llave (al arrancar y desde el botón de Dev Tools). */
  async refreshCatalogs(force = true) {
    const out: Partial<Record<AiProviderName, { count: number; error: string | null }>> = {};
    for (const name of KEYED_PROVIDERS) {
      const p = this.keyed[name];
      if (!p.configured()) continue;
      const cat = await p.refreshModels(force);
      out[name] = { count: cat?.ids.length ?? 0, error: cat?.error ?? null };
    }
    if (this.backup.configured()) {
      const cat = await this.backup.catalog(force);
      out.OPENROUTER = { count: cat.models.length, error: cat.models.length ? null : 'sin catálogo' };
    }
    return out;
  }

  /** ¿Existe este modelo en el catálogo del proveedor? null = no se sabe (sin catálogo todavía). */
  async inCatalog(entry: Pick<ChainEntry, 'provider' | 'model'>): Promise<boolean | null> {
    if (entry.provider === 'OPENROUTER') {
      if (!this.backup.configured()) return null;
      const cat = await this.backup.catalog();
      return cat.models.length ? cat.models.some((m) => m.id === entry.model) : null;
    }
    const cat = await this.keyed[entry.provider].catalog();
    return cat?.ids.length ? cat.ids.includes(entry.model) : null;
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

  /* ── Llamadas ──────────────────────────────────────────────────── */

  /** Un eslabón de la cadena, con estadísticas. El texto SIEMPRE sale sanitizado. */
  async tryEntry(entry: Pick<ChainEntry, 'provider' | 'model'>, opts: ChatOpts, track = true) {
    const safe: ChatOpts = { ...opts, messages: sanitizeMessages(opts.messages, { names: opts.knownNames }) };
    const t = Date.now();
    const out = entry.provider === 'OPENROUTER'
      ? await this.backup.tryModel(entry.model, safe).then((r) => ({
          result: r.result ? { ...r.result, provider: 'OPENROUTER' as const } : null,
          error: r.error,
        }))
      : await this.keyed[entry.provider].tryModel(entry.model, safe).then((r) => ({
          result: r.result ? { ...r.result, provider: entry.provider } : null,
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
    const until = opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity;
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const left = until - Date.now();
      if (left < 2000) { errors.push('se acabó el tiempo'); break; }
      const { result, error } = await this.tryEntry(entry, withBudget(opts, left));
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
   * Con una imagen (revisión de la pieza de un anuncio): solo los modelos de
   * Gemini de la cadena la entienden, así que solo se prueban esos. El texto se
   * sanitiza igual que siempre; la imagen es la pieza publicitaria de la
   * empresa, nunca fotos de conversaciones ni de clientes.
   */
  async chatVision(opts: ChatOpts & { imageDataUrl: string }): Promise<PoolChatResult> {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(opts.imageDataUrl)) throw new Error('Imagen inválida para la IA');
    const { entries } = await this.chain();
    const text = sanitizeMessages(opts.messages, { names: opts.knownNames });
    const lastUser = text.map((m) => m.role).lastIndexOf('user');
    const messages: ChatMessage[] = text.map((m, i) => (i === lastUser
      ? { ...m, content: [{ type: 'text', text: String(m.content) }, { type: 'image_url', image_url: { url: opts.imageDataUrl } }] }
      : m));
    const errors: string[] = [];
    const until = opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity;
    for (const entry of entries) {
      if (!entry.enabled || entry.provider !== 'GEMINI') continue;
      const left = until - Date.now();
      if (left < 2000) { errors.push('se acabó el tiempo'); break; }
      const r = await this.keyed.GEMINI.tryModel(entry.model, withBudget({ ...opts, messages }, left));
      if (r.result) return { ...r.result, provider: 'GEMINI' };
      errors.push(`${entry.model}: ${r.error}`);
    }
    this.logger.error(`ninguna IA con visión respondió: ${errors.slice(-4).join(' | ') || 'sin modelos de Gemini en la cadena'}`);
    throw new ServiceUnavailableException({
      code: AI_UNAVAILABLE,
      message: 'La IA que revisa imágenes está ocupada en este momento. Intenta de nuevo en unos minutos.',
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
    const until = opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity;
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const left = until - Date.now();
      if (left < 2000) { errors.push('se acabó el tiempo'); break; }
      const { result, error } = await this.tryEntry(entry, { ...withBudget(opts, left), json: true });
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
    return {
      models: await this.geminiModels(),
      keys: await this.keyed.GEMINI.keyStatus(),
      groq: { keys: await this.keyed.GROQ.keyStatus() },
      cerebras: { keys: await this.keyed.CEREBRAS.keyStatus() },
      backup: { keys: await this.backup.keyStatus() },
    };
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
    return this.keyed[entry.provider].availability(entry.model);
  }
}
