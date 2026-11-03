import { GraphCallLog, GraphFetch, MetaGraphClient, MetaGraphError, metaGraphVersion } from './graph-client';

/**
 * OAuth de Meta (Facebook Login, flujo manual con código).
 * Comprobado contra la documentación oficial (30-oct-2026):
 *  - El código se cambia por un token de corta duración y ese por uno de
 *    larga duración (grant_type=fb_exchange_token, ~60 días, trae expires_in).
 *  - No hay refresh token: un token vencido no se puede extender; la persona
 *    tiene que autorizar de nuevo.
 *  - Si la persona cancela, Meta vuelve con error=access_denied y
 *    error_reason=user_denied.
 *  - debug_token (con token de app) dice si el token es válido, de qué app es,
 *    cuándo vence (expires_at) y qué permisos tiene.
 *  - DELETE /me/permissions quita la autorización de la app.
 */

export interface MetaAppConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export function dialogUrl(app: { appId: string; redirectUri: string }, state: string, scopes: string[], version = metaGraphVersion()) {
  const qs = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirectUri,
    state,
    scope: scopes.join(','),
    response_type: 'code',
  });
  return `https://www.facebook.com/${version}/dialog/oauth?${qs}`;
}

export interface ExchangedToken {
  accessToken: string;
  /** null = Meta no informó vencimiento */
  expiresAt: Date | null;
  longLived: boolean;
}

const expiry = (seconds: unknown, now: Date) => (Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null);

/** code → token de corta duración → token de larga duración. Todo desde el backend. */
export async function exchangeCodeForToken(
  app: MetaAppConfig,
  code: string,
  opts: { fetchImpl?: GraphFetch; onCall?: (l: GraphCallLog) => void; now?: Date } = {},
): Promise<ExchangedToken> {
  const now = opts.now ?? new Date();
  const anon = new MetaGraphClient({ token: '', fetchImpl: opts.fetchImpl, onCall: opts.onCall, retries: 0 });
  const short = await anon.get('/oauth/access_token', { client_id: app.appId, client_secret: app.appSecret, redirect_uri: app.redirectUri, code });
  if (!short?.access_token) throw new MetaGraphError('AUTH', 'Meta no devolvió un token al cambiar el código');
  try {
    const long = await anon.get('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: String(short.access_token) });
    if (long?.access_token) return { accessToken: String(long.access_token), expiresAt: expiry(long.expires_in, now), longLived: true };
  } catch {
    // Se conserva el de corta duración: sirve para probar, con su vencimiento real
  }
  return { accessToken: String(short.access_token), expiresAt: expiry(short.expires_in, now), longLived: false };
}

export interface TokenDebug {
  isValid: boolean;
  appId: string | null;
  userId: string | null;
  type: string | null;
  expiresAt: Date | null;
  dataAccessExpiresAt: Date | null;
  scopes: string[];
}

const fromUnix = (v: unknown) => (Number(v) > 0 ? new Date(Number(v) * 1000) : null);

/** Inspecciona un token con el token de la app (id|secreto). El token de app nunca sale del backend. */
export async function debugToken(app: { appId: string; appSecret: string }, inputToken: string, opts: { fetchImpl?: GraphFetch; onCall?: (l: GraphCallLog) => void } = {}): Promise<TokenDebug> {
  const client = new MetaGraphClient({ token: `${app.appId}|${app.appSecret}`, fetchImpl: opts.fetchImpl, onCall: opts.onCall });
  const d = (await client.get('/debug_token', { input_token: inputToken }))?.data ?? {};
  return {
    isValid: d.is_valid === true,
    appId: d.app_id ? String(d.app_id) : null,
    userId: d.user_id ? String(d.user_id) : null,
    type: d.type ? String(d.type) : null,
    // expires_at = 0 significa que no vence
    expiresAt: fromUnix(d.expires_at),
    dataAccessExpiresAt: fromUnix(d.data_access_expires_at),
    scopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [],
  };
}
