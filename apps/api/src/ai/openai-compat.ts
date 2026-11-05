import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { ChatMessage } from './types';

/**
 * Proveedores con llaves GENÉRICAS de BackOffice y API compatible con OpenAI
 * (chat/completions y GET /models): Gemini, Groq y Cerebras. Todos se manejan
 * igual —el comportamiento es el que Gemini ya tenía—:
 *  - Las llaves viven solo en el .env y rotan en orden; en la base va la huella.
 *  - Tope propio por llave y día (hora de Bogotá).
 *  - 429 / cuota → llave agotada hasta mañana; 401/403 → apartada 1 h;
 *    404/400 → ese modelo no existe para esa llave (6 h); cuelgue → el modelo
 *    descansa 10 min; 5xx → descansa 2 min y la cadena sigue con otro modelo.
 *  - Los modelos que se ofrecen salen del GET /models de cada proveedor (no de
 *    listas de internet); el catálogo se guarda en la base para todo el API.
 * OpenRouter tiene su propio manejo (openrouter-pool.ts).
 */

export type KeyedProviderName = 'GEMINI' | 'GROQ' | 'CEREBRAS';
export const KEYED_PROVIDERS: KeyedProviderName[] = ['GEMINI', 'GROQ', 'CEREBRAS'];

export interface KeyedProviderConfig {
  name: KeyedProviderName;
  label: string;
  chatUrl: string;
  modelsUrl: string;
  /** Variables del .env con las llaves (separadas por coma); se usa la primera que exista */
  keysEnv: string[];
  limitKey: string;
  defaultLimit: number;
  /** Modelo preferido configurable (setting o .env); se valida contra el catálogo */
  modelKey: string;
  /** Del modelo más recomendado al menos, para elegir el de por defecto dentro del catálogo real */
  preference: RegExp[];
  /** Si el proveedor rechaza response_format, reintenta sin JSON estricto (Gemini nunca lo necesitó) */
  jsonFallback: boolean;
  /** Algunos modelos piensan en voz alta (<think>): se limpia la respuesta */
  cleanText: boolean;
}

export const PROVIDER_CONFIG: Record<KeyedProviderName, KeyedProviderConfig> = {
  GEMINI: {
    name: 'GEMINI', label: 'Gemini',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    keysEnv: ['GEMINI_API_KEYS'], limitKey: 'GEMINI_DAILY_LIMIT', defaultLimit: 80, modelKey: 'GEMINI_MODEL',
    preference: [/^gemini-2\.5-flash$/, /flash/], jsonFallback: false, cleanText: false,
  },
  GROQ: {
    name: 'GROQ', label: 'Groq',
    chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    keysEnv: ['GROQ_API_KEYS', 'GROQ_API_KEY'], limitKey: 'GROQ_DAILY_LIMIT', defaultLimit: 500, modelKey: 'GROQ_MODEL',
    preference: [/^llama-3\.3-70b/, /gpt-oss-120b/, /llama-4-maverick/, /qwen3?-32b/, /gpt-oss/, /llama/, /qwen/],
    jsonFallback: true, cleanText: true,
  },
  CEREBRAS: {
    name: 'CEREBRAS', label: 'Cerebras',
    chatUrl: 'https://api.cerebras.ai/v1/chat/completions',
    modelsUrl: 'https://api.cerebras.ai/v1/models',
    keysEnv: ['CEREBRAS_API_KEY', 'CEREBRAS_API_KEYS'], limitKey: 'CEREBRAS_DAILY_LIMIT', defaultLimit: 500, modelKey: 'CEREBRAS_MODEL',
    preference: [/gpt-oss-120b/, /^llama-3\.3-70b/, /qwen-3-235b/, /llama/, /qwen/, /gpt-oss/],
    jsonFallback: true, cleanText: true,
  },
};

/** Nunca para la IA de texto: audio, voz, imágenes, moderación, embeddings o agentes con herramientas. */
const NOT_FOR_TEXT = /(whisper|tts|speech|audio|guard|safety|moderation|embed|vision|-vl\b|image|imagen|veo|aqa|live|native-audio|compound|playai|orpheus|distil-whisper|prompt-guard)/i;

const TIMEOUT_MS = 20_000;
const SLOW_COOLDOWN_MS = 10 * 60e3; // un modelo que se colgó se aparta 10 min
const CATALOG_TTL_MS = 6 * 3600e3;

export type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

export interface CompatChatOpts {
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface KeyedCallResult {
  content: string;
  model: string;
  keyLabel: string;
  tokens: number;
}

/** Algunos modelos gratis piensan en voz alta o envuelven el JSON en ```. */
export function cleanModelText(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

export function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export const maskKey = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

/** Día en Bogotá (YYYY-MM-DD): los topes diarios se reinician a medianoche de Colombia. */
export function bogotaDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(now);
}

export type CompatResponse =
  | { kind: 'ok'; content: string; tokens: number }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string }
  | { kind: 'http'; status: number; body: string };

/**
 * Una llamada a chat/completions de cualquier proveedor compatible con OpenAI.
 * No decide nada: devuelve qué pasó para que quien llama aparte la llave o el modelo.
 */
export async function callOpenAiCompatible(
  fetchImpl: FetchLike,
  req: { url: string; key: string; model: string; opts: CompatChatOpts; timeoutMs: number; strictJson?: boolean },
): Promise<CompatResponse> {
  const { opts } = req;
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, req.timeoutMs));
    res = await fetchImpl(req.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${req.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.3,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...((req.strictJson ?? opts.json) ? { response_format: { type: 'json_object' } } : {}),
      }),
    }).finally(() => clearTimeout(timer));
  } catch (err: any) {
    return err?.name === 'AbortError' ? { kind: 'timeout' } : { kind: 'network', message: String(err?.message ?? err) };
  }
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    return { kind: 'ok', content: String(data?.choices?.[0]?.message?.content ?? ''), tokens: Number(data?.usage?.total_tokens ?? 0) };
  }
  return { kind: 'http', status: res.status, body: await res.text().catch(() => '') };
}

/** Lo que devuelve GET /models, sin modelos que no sirven para texto. */
export function textModelsFrom(raw: unknown): string[] {
  const list: any[] = Array.isArray((raw as any)?.data) ? (raw as any).data : Array.isArray((raw as any)?.models) ? (raw as any).models : [];
  const ids = list
    .filter((m) => m && m.active !== false)
    .map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, '').trim())
    .filter((id) => /^[\w.:/@-]+$/.test(id) && !NOT_FOR_TEXT.test(id));
  return [...new Set(ids)].sort();
}

/** El primero de la lista de preferencias que exista de verdad en el catálogo. */
export function pickDefaultModel(catalog: string[], preference: RegExp[], wanted?: string | null): string | null {
  if (wanted && catalog.includes(wanted)) return wanted;
  for (const re of preference) {
    const hit = catalog.find((id) => re.test(id));
    if (hit) return hit;
  }
  return catalog[0] ?? null;
}

interface StoredCatalog {
  at: string;
  ids: string[];
  error?: string;
}

/**
 * Llaves de un proveedor con API compatible con OpenAI: rotación, tope diario,
 * apartados y catálogo de modelos.
 */
export class KeyedProvider {
  private readonly logger = new Logger('SetupAI');
  /** Enfriamientos en memoria: llave apartada / modelo inexistente por llave */
  readonly cooldown = new Map<string, number>();
  private catalogCache: { at: number; value: StoredCatalog } | null = null;

  constructor(
    readonly config: KeyedProviderConfig,
    private readonly prisma: any,
    private readonly fetchImpl: FetchLike,
  ) {}

  get name(): KeyedProviderName {
    return this.config.name;
  }

  private async setting(key: string): Promise<string | undefined> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } }).catch(() => null);
    return row?.value?.trim() || undefined;
  }

  private async saveSetting(key: string, value: string) {
    const existing = await this.prisma.platformSetting.findUnique({ where: { key } });
    if (existing) await this.prisma.platformSetting.update({ where: { key }, data: { value } });
    else await this.prisma.platformSetting.create({ data: { key, value } });
  }

  keys(): string[] {
    for (const env of this.config.keysEnv) {
      const list = String(process.env[env] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
      if (list.length) return list;
    }
    return [];
  }

  configured(): boolean {
    return this.keys().length > 0;
  }

  async limit(): Promise<number> {
    const raw = Number((await this.setting(this.config.limitKey)) || process.env[this.config.limitKey] || this.config.defaultLimit);
    return Number.isFinite(raw) && raw > 0 ? raw : this.config.defaultLimit;
  }

  private usage(fp: string, day: string) {
    return this.prisma.aiKeyUsage.findFirst({ where: { provider: this.name, fingerprint: fp, day } });
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
          provider: this.name, fingerprint: fp, day,
          requests: data.requests ?? 0, tokens: data.tokens ?? 0,
          ...(data.exhausted ? { exhaustedAt: new Date() } : {}),
          ...(data.error ? { lastError: data.error.slice(0, 200) } : {}),
        },
      });
    }
  }

  private keyLabel(i: number) {
    return this.name === 'GEMINI' ? `llave ${i + 1}` : `${this.config.label.toLowerCase()} ${i + 1}`;
  }

  /** Un modelo, rotando las llaves disponibles. */
  async tryModel(model: string, opts: CompatChatOpts): Promise<{ result: KeyedCallResult | null; error: string }> {
    const keys = this.keys();
    if (!keys.length) return { result: null, error: `sin llaves de ${this.config.label}` };
    const limit = await this.limit();
    const day = bogotaDay();
    let error = 'sin llaves disponibles hoy';
    // El tiempo es para el modelo, no por llave: probar otra llave no lo alarga
    const end = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS);
    for (const [i, key] of keys.entries()) {
      if (end - Date.now() < 1500) { error = 'tardó demasiado'; break; }
      const fp = fingerprint(key);
      const combo = `${fp}:${model}`;
      if ((this.cooldown.get(fp) ?? 0) > Date.now()) continue;
      if ((this.cooldown.get(combo) ?? 0) > Date.now()) { error = 'modelo descansando'; continue; }
      const u = await this.usage(fp, day);
      if (u?.exhaustedAt || (u?.requests ?? 0) >= limit) continue; // agotada hoy → siguiente llave
      const call = (strictJson?: boolean) => callOpenAiCompatible(this.fetchImpl, {
        url: this.config.chatUrl, key, model, opts, timeoutMs: Math.max(1000, end - Date.now()), strictJson,
      });
      let res = await call();
      if (res.kind === 'http' && res.status === 400 && opts.json && this.config.jsonFallback && /response_format|json/i.test(res.body)) {
        res = await call(false); // el modelo no acepta JSON estricto: se pide igual en la instrucción
      }
      if (res.kind === 'timeout') {
        this.cooldown.set(combo, Date.now() + SLOW_COOLDOWN_MS);
        return { result: null, error: 'tardó demasiado' }; // modelo colgado → siguiente modelo
      }
      if (res.kind === 'network') return { result: null, error: res.message };
      if (res.kind === 'ok') {
        await this.bump(fp, day, { requests: 1, tokens: res.tokens, error: '' });
        const content = this.config.cleanText ? cleanModelText(res.content) : res.content;
        if (content) return { result: { content, model, keyLabel: this.keyLabel(i), tokens: res.tokens }, error: '' };
        return { result: null, error: 'respuesta vacía' };
      }
      const { status, body } = res;
      error = `${status}`;
      if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(body)) {
        // Cuota agotada: esta llave no sirve más hoy → siguiente llave
        await this.bump(fp, day, { exhausted: true, error: `429 ${body.slice(0, 120)}` });
        this.logger.warn(`llave ${i + 1} de ${this.config.label} agotada (${model}); paso a la siguiente`);
        error = 'cuota agotada';
        continue;
      }
      if (status === 401 || status === 403) {
        this.cooldown.set(fp, Date.now() + 3600e3);
        await this.bump(fp, day, { error: `${status} rechazada` });
        continue;
      }
      if (status === 404 || status === 400) {
        this.cooldown.set(combo, Date.now() + 6 * 3600e3); // ese modelo no existe para esta llave
        error = 'modelo no disponible para esta llave';
        continue;
      }
      // 5xx / saturado: se aparta un rato y se prueba el siguiente modelo
      if (status >= 500) this.cooldown.set(combo, Date.now() + 2 * 60e3);
      return { result: null, error: status >= 500 ? 'saturado' : error };
    }
    return { result: null, error };
  }

  /* ── Catálogo de modelos (GET /models) ──────────────────────────── */

  private catalogKey() {
    return `AI_MODELS_${this.name}`;
  }

  /** Catálogo guardado (lo comparten todas las instancias del API). */
  async catalog(): Promise<StoredCatalog | null> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 60e3) return this.catalogCache.value;
    const raw = await this.setting(this.catalogKey());
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as StoredCatalog;
      this.catalogCache = { at: Date.now(), value };
      return value;
    } catch {
      return null;
    }
  }

  /** Pide GET /models con la primera llave usable y guarda los modelos de texto que existen. */
  async refreshModels(force = true): Promise<StoredCatalog | null> {
    const keys = this.keys();
    if (!keys.length) return null;
    const current = await this.catalog();
    if (!force && current?.ids.length && Date.now() - new Date(current.at).getTime() < CATALOG_TTL_MS) return current;
    const key = keys.find((k) => (this.cooldown.get(fingerprint(k)) ?? 0) <= Date.now()) ?? keys[0];
    let value: StoredCatalog;
    try {
      const res = await this.fetchImpl(this.config.modelsUrl, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120)}`);
      const ids = textModelsFrom(await res.json());
      if (!ids.length) throw new Error('el proveedor no devolvió modelos de texto');
      value = { at: new Date().toISOString(), ids };
    } catch (err: any) {
      // Se conserva el último catálogo bueno; solo se anota el error
      value = { at: current?.at ?? new Date().toISOString(), ids: current?.ids ?? [], error: String(err?.message ?? err).slice(0, 160) };
      this.logger.warn(`no se pudo leer el catálogo de ${this.config.label}: ${value.error}`);
    }
    await this.saveSetting(this.catalogKey(), JSON.stringify(value)).catch(() => undefined);
    this.catalogCache = { at: Date.now(), value };
    return value;
  }

  /** Modelo de por defecto: el configurado o el preferido, SIEMPRE dentro del catálogo real. */
  async defaultModel(): Promise<string | null> {
    const cat = await this.catalog();
    if (!cat?.ids.length) return null;
    const wanted = (await this.setting(this.config.modelKey)) || process.env[this.config.modelKey] || null;
    return pickDefaultModel(cat.ids, this.config.preference, wanted);
  }

  /* ── Estado para Dev Tools (sin exponer llaves) ────────────────── */

  /** Gemini muestra la máscara de siempre; los nuevos solo dicen si la llave está cargada. */
  async keyStatus() {
    const limit = await this.limit();
    const day = bogotaDay();
    const out: Array<{ label: string; requestsToday: number; limit: number; exhausted: boolean; lastError: string | null }> = [];
    for (const [i, key] of this.keys().entries()) {
      const u = await this.usage(fingerprint(key), day);
      out.push({
        label: this.name === 'GEMINI' ? `Llave ${i + 1} (${maskKey(key)})` : `${this.config.label} · llave ${i + 1} cargada`,
        requestsToday: u?.requests ?? 0,
        limit,
        exhausted: !!u?.exhaustedAt || (u?.requests ?? 0) >= limit,
        lastError: u?.lastError ?? null,
      });
    }
    return out;
  }

  /** ¿Puede responder este modelo ahora? (llaves con cupo y modelo sin castigo) */
  async availability(model: string): Promise<{ state: 'LISTO' | 'DESCANSANDO' | 'SIN_CUPO' | 'SIN_LLAVE'; until: string | null }> {
    const keys = this.keys();
    if (!keys.length) return { state: 'SIN_LLAVE', until: null };
    const limit = await this.limit();
    const day = bogotaDay();
    let rest = 0;
    let usable = false;
    for (const key of keys) {
      const fp = fingerprint(key);
      if ((this.cooldown.get(fp) ?? 0) > Date.now()) continue;
      const u = await this.usage(fp, day);
      if (u?.exhaustedAt || (u?.requests ?? 0) >= limit) continue;
      const c = this.cooldown.get(`${fp}:${model}`) ?? 0;
      if (c > Date.now()) rest = Math.max(rest, c);
      else usable = true;
    }
    if (usable) return { state: 'LISTO', until: null };
    return rest ? { state: 'DESCANSANDO', until: new Date(rest).toISOString() } : { state: 'SIN_CUPO', until: null };
  }
}
