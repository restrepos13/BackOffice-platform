import { createHmac } from 'crypto';
import { AdsProviderError, ProviderErrorKind } from '../ads/provider';
import { classifyMetaError } from '../ads/meta-ads-provider';

/**
 * Cliente de Graph API para LEER datos de Meta (Marketing API).
 * Pensado para reutilizarse cuando la integración pase a ser multiempresa:
 * no conoce empresas ni la base, solo un token y opciones.
 *
 *  - Versión explícita (META_GRAPH_API_VERSION, por defecto v25.0).
 *  - Solo GET. La única escritura permitida es revocar el permiso de la app
 *    (DELETE /me/permissions), que no toca campañas ni presupuestos.
 *  - Timeout por llamada, reintentos con espera creciente solo para fallas
 *    transitorias (red, 5xx, límite de solicitudes) y paginación por cursor.
 *  - appsecret_proof en cada llamada cuando se conoce el App Secret.
 *  - Cada llamada queda registrada SIN credenciales (onCall).
 */

export const DEFAULT_GRAPH_VERSION = 'v25.0';

export function metaGraphVersion(): string {
  const v = String(process.env.META_GRAPH_API_VERSION ?? '').trim();
  return /^v\d{2}\.\d$/.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

export type GraphFetch = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  headers?: { get(name: string): string | null };
}>;

export interface GraphCallLog {
  at: string;
  method: 'GET' | 'DELETE';
  /** Ruta y parámetros, sin token ni secretos */
  request: string;
  status: number | null;
  ms: number;
  attempt: number;
  rows?: number;
  errorKind?: ProviderErrorKind;
  errorCode?: number | string;
  errorSubcode?: number | string;
  error?: string;
  /** Uso de cuota que Meta informa en los encabezados (x-app-usage, x-business-use-case-usage…) */
  usage?: string;
}

/** Error de Graph con los códigos de Meta (para saber si venció o fue revocado). */
export class MetaGraphError extends AdsProviderError {
  constructor(
    kind: ProviderErrorKind,
    message: string,
    code?: number | string,
    public readonly subcode?: number | string,
    public readonly status?: number,
    public readonly fbtraceId?: string,
  ) {
    super(kind, message, code);
  }
}

const SECRET_PARAMS = ['access_token', 'appsecret_proof', 'client_secret', 'fb_exchange_token', 'code', 'input_token'];

/** Quita credenciales de una URL o texto antes de mostrarlo o registrarlo. */
export function redact(text: string): string {
  let out = String(text ?? '');
  // En URLs (?x=) y también sueltos en mensajes de error ("… code=XYZ")
  for (const p of SECRET_PARAMS) out = out.replace(new RegExp(`((?:^|[?&\\s"'(])${p}=)[^&\\s"')]*`, 'g'), '$1[oculto]');
  // Tokens de Meta (EAA…) y tokens de app (id|secreto) que aparezcan sueltos
  return out.replace(/EAA[A-Za-z0-9]{20,}/g, '[token oculto]').replace(/\b\d{6,20}\|[A-Za-z0-9_-]{16,}/g, '[token de app oculto]');
}

/** Copia profunda sin campos que puedan traer credenciales (para mostrar respuestas crudas). */
export function redactBody(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactBody(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(access_token|token|appsecret_proof|client_secret)$/i.test(k)) out[k] = '[oculto]';
      else if (k === 'paging' && v && typeof v === 'object') out[k] = { ...(v as any).cursors ? { cursors: (v as any).cursors } : {}, hasNext: !!(v as any).next };
      else out[k] = redactBody(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Clasifica el error de Graph y conserva subcódigo y estado HTTP. */
export function graphError(err: any, status: number): MetaGraphError {
  const base = classifyMetaError(err, status);
  return new MetaGraphError(base.kind, redact(base.message), err?.code, err?.error_subcode, status, err?.fbtrace_id);
}

/** Token vencido (463/467) o autorización revocada por la persona (458/460) — códigos 190 de Meta. */
export function authState(err: unknown): 'EXPIRED' | 'REVOKED' | null {
  if (!(err instanceof AdsProviderError) || err.kind !== 'AUTH') return null;
  const sub = Number((err as MetaGraphError).subcode);
  return [458, 460].includes(sub) ? 'REVOKED' : 'EXPIRED';
}

const TRANSIENT_KINDS: ProviderErrorKind[] = ['RATE_LIMIT'];
const USAGE_HEADERS = ['x-app-usage', 'x-business-use-case-usage', 'x-ad-account-usage'];

export interface GraphClientOptions {
  token: string;
  appSecret?: string;
  version?: string;
  fetchImpl?: GraphFetch;
  timeoutMs?: number;
  retries?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  onCall?: (log: GraphCallLog) => void;
}

export class MetaGraphClient {
  private readonly version: string;
  private readonly fetchImpl: GraphFetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxPages: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: GraphClientOptions) {
    this.version = opts.version ?? metaGraphVersion();
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i) as any);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
    this.maxPages = opts.maxPages ?? 25;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private proof(): Record<string, string> {
    return this.opts.appSecret && this.opts.token ? { appsecret_proof: createHmac('sha256', this.opts.appSecret).update(this.opts.token).digest('hex') } : {};
  }

  private async once(method: 'GET' | 'DELETE', path: string, params: Record<string, string>, attempt: number) {
    // Sin token (intercambio del código OAuth) no se manda access_token
    const query = new URLSearchParams({ ...params, ...(this.opts.token ? { access_token: this.opts.token } : {}), ...this.proof() });
    const url = `https://graph.facebook.com/${this.version}${path}?${query}`;
    const shown = redact(`${method} /${this.version}${path}?${new URLSearchParams(params)}`);
    const started = Date.now();
    const log: GraphCallLog = { at: new Date(started).toISOString(), method, request: shown, status: null, ms: 0, attempt };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await this.fetchImpl(url, { method, signal: ctrl.signal });
      } catch (e: any) {
        const timedOut = e?.name === 'AbortError';
        throw new MetaGraphError('PROVIDER', timedOut ? `Meta no respondió en ${Math.round(this.timeoutMs / 1000)} s` : 'No se pudo contactar a Meta (red)', timedOut ? 'TIMEOUT' : 'NETWORK');
      }
      log.status = res.status;
      const usage = USAGE_HEADERS.map((h) => [h, res.headers?.get?.(h)]).filter(([, v]) => v).map(([h, v]) => `${h}: ${v}`).join(' · ');
      if (usage) log.usage = usage.slice(0, 500);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw graphError(data?.error, res.status);
      if (Array.isArray(data?.data)) log.rows = data.data.length;
      return data;
    } catch (err: any) {
      if (err instanceof MetaGraphError) {
        log.errorKind = err.kind;
        log.errorCode = err.providerCode;
        log.errorSubcode = err.subcode;
        log.error = err.message.slice(0, 300);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      log.ms = Date.now() - started;
      this.opts.onCall?.(log);
    }
  }

  /** Reintenta solo lo transitorio; errores de permisos o token fallan de una. */
  private async call(method: 'GET' | 'DELETE', path: string, params: Record<string, string>) {
    if (!/^\/[A-Za-z0-9_/]+$/.test(path)) throw new MetaGraphError('NOT_FOUND', 'Ruta de Graph inválida');
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(method, path, params, attempt);
      } catch (err: any) {
        const transient = err instanceof MetaGraphError
          && (TRANSIENT_KINDS.includes(err.kind) || (err.kind === 'PROVIDER' && (err.status === undefined || err.status >= 500)));
        // DELETE no se reintenta a ciegas: podría haberse aplicado
        if (!transient || method !== 'GET' || attempt > this.retries) throw err;
        await this.sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
      }
    }
  }

  get(path: string, params: Record<string, string> = {}) {
    return this.call('GET', path, params);
  }

  /**
   * Todas las páginas por cursor (after). Con tope: si Meta aún tiene más,
   * falla como INCOMPLETE, para no guardar una parte como si fuera el total.
   */
  async all(path: string, params: Record<string, string> = {}): Promise<any[]> {
    const out: any[] = [];
    let after: string | undefined;
    for (let page = 1; ; page++) {
      const data = await this.get(path, after ? { ...params, after } : params);
      out.push(...(Array.isArray(data?.data) ? data.data : []));
      after = data?.paging?.next ? data?.paging?.cursors?.after : undefined;
      if (!after) return out;
      if (page >= this.maxPages) throw new MetaGraphError('INCOMPLETE', `Meta devolvió más de ${this.maxPages} páginas en ${path}: la lectura quedó incompleta.`);
    }
  }

  /** Quita la autorización de la app para esta persona: el token deja de servir. */
  revokeAppPermissions() {
    return this.call('DELETE', '/me/permissions', {});
  }
}
