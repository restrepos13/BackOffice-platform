/**
 * Cliente mínimo de Google Calendar API v3 y OAuth 2.0 (REST + fetch, sin
 * dependencias). Solo lo que usa BackOffice:
 *  - OAuth: URL de autorización, intercambio de código, renovación y revocación.
 *  - calendarList.list (elegir calendario), events.list incremental (syncToken),
 *    events.insert / patch (If-Match) / delete, events.watch y channels.stop.
 * Los errores se clasifican para decidir: reintentar, reconectar o conflicto.
 * Docs: https://developers.google.com/calendar/api/v3/reference
 */

export const GOOGLE_SCOPES = [
  // Elegir en qué calendario sincronizar (solo lectura de la lista)
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  // Leer los eventos del calendario elegido y crear/cambiar/borrar los de BackOffice
  'https://www.googleapis.com/auth/calendar.events',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/**
 * AUTH: credencial inválida o revocada (hay que reconectar) · GONE: syncToken vencido (resincronizar)
 * NOT_FOUND: el evento ya no existe · PRECONDITION: alguien lo cambió antes (etag) · RATE/SERVER/NETWORK: reintentar
 */
export type GoogleErrorKind = 'AUTH' | 'GONE' | 'NOT_FOUND' | 'PRECONDITION' | 'RATE' | 'SERVER' | 'NETWORK' | 'BAD_REQUEST' | 'NOT_CONFIGURED';

export class GoogleApiError extends Error {
  constructor(readonly kind: GoogleErrorKind, message: string, readonly status?: number) {
    super(message);
  }
  get retryable() {
    return ['RATE', 'SERVER', 'NETWORK'].includes(this.kind);
  }
}

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  updated?: string;
  summary?: string;
  transparency?: 'opaque' | 'transparent';
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as any) as any;

async function call(fetchImpl: FetchLike, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<any> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, init);
  } catch (err: any) {
    throw new GoogleApiError('NETWORK', `No hubo conexión con Google: ${err?.message ?? 'error de red'}`);
  }
  if (res.ok) {
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  let body: any = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = null;
  }
  // Nunca se registra el cuerpo completo (puede traer datos): solo el motivo
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? body?.error ?? '').slice(0, 80);
  const message = String(body?.error?.message ?? body?.error_description ?? `Google respondió ${res.status}`).slice(0, 200);
  if (res.status === 401 || reason === 'invalid_grant' || reason === 'unauthorized_client') throw new GoogleApiError('AUTH', message, res.status);
  if (res.status === 403 && /rateLimit|userRateLimit|quota/i.test(reason)) throw new GoogleApiError('RATE', message, res.status);
  if (res.status === 403) throw new GoogleApiError('AUTH', message, res.status);
  if (res.status === 404) throw new GoogleApiError('NOT_FOUND', message, res.status);
  if (res.status === 410) throw new GoogleApiError(url.includes('/events') && url.includes('syncToken') ? 'GONE' : 'NOT_FOUND', message, res.status);
  if (res.status === 412) throw new GoogleApiError('PRECONDITION', message, res.status);
  if (res.status === 429) throw new GoogleApiError('RATE', message, res.status);
  if (res.status >= 500) throw new GoogleApiError('SERVER', message, res.status);
  throw new GoogleApiError('BAD_REQUEST', message, res.status);
}

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

export function authUrl(app: GoogleApp, state: string): string {
  const qs = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // offline + consent: Google entrega el refresh token (necesario para sincronizar sin el usuario)
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${qs}`;
}

export async function exchangeCode(app: GoogleApp, code: string, fetchImpl: FetchLike = defaultFetch) {
  const r = await call(fetchImpl, TOKEN_URL, {
    method: 'POST', headers: FORM,
    body: form({ code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code' }),
  });
  if (!r?.access_token) throw new GoogleApiError('BAD_REQUEST', 'Google no devolvió el token');
  return { accessToken: String(r.access_token), refreshToken: r.refresh_token ? String(r.refresh_token) : null, expiresIn: Number(r.expires_in) || 3600, scope: String(r.scope ?? '') };
}

export async function refreshAccess(app: Pick<GoogleApp, 'clientId' | 'clientSecret'>, refreshToken: string, fetchImpl: FetchLike = defaultFetch) {
  const r = await call(fetchImpl, TOKEN_URL, {
    method: 'POST', headers: FORM,
    body: form({ refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token' }),
  });
  return { accessToken: String(r.access_token), expiresIn: Number(r.expires_in) || 3600 };
}

export async function revokeToken(token: string, fetchImpl: FetchLike = defaultFetch) {
  await call(fetchImpl, REVOKE_URL, { method: 'POST', headers: FORM, body: form({ token }) });
}

const auth = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

/** Calendarios donde se puede escribir (dueño o editor). */
export async function listWritableCalendars(token: string, fetchImpl: FetchLike = defaultFetch) {
  const out: Array<{ id: string; name: string; primary: boolean; timeZone: string | null }> = [];
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({ minAccessRole: 'writer', maxResults: '250', ...(pageToken ? { pageToken } : {}) });
    const r = await call(fetchImpl, `${API}/users/me/calendarList?${qs}`, { headers: auth(token) });
    for (const c of r?.items ?? []) out.push({ id: String(c.id), name: String(c.summaryOverride ?? c.summary ?? c.id), primary: !!c.primary, timeZone: c.timeZone ?? null });
    pageToken = r?.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return out;
}

/**
 * Cambios de eventos. Con syncToken: solo lo que cambió (incluye borrados como
 * status "cancelled"). Sin él: lectura completa desde timeMin. Devuelve el
 * nextSyncToken de la última página. 410 → GONE (hay que leer todo de nuevo).
 */
export async function listEvents(token: string, calendarId: string, opts: { syncToken?: string | null; timeMin?: string }, fetchImpl: FetchLike = defaultFetch) {
  const events: GoogleEvent[] = [];
  let pageToken = '';
  let nextSyncToken: string | null = null;
  for (let i = 0; i < 50; i++) {
    const qs = new URLSearchParams({
      singleEvents: 'true', showDeleted: 'true', maxResults: '250',
      ...(opts.syncToken ? { syncToken: opts.syncToken } : opts.timeMin ? { timeMin: opts.timeMin } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    const r = await call(fetchImpl, `${API}/calendars/${encodeURIComponent(calendarId)}/events?${qs}`, { headers: auth(token) });
    events.push(...(r?.items ?? []));
    pageToken = r?.nextPageToken ?? '';
    if (r?.nextSyncToken) nextSyncToken = String(r.nextSyncToken);
    if (!pageToken) break;
  }
  return { events, nextSyncToken };
}

export async function insertEvent(token: string, calendarId: string, body: Record<string, unknown>, fetchImpl: FetchLike = defaultFetch): Promise<GoogleEvent> {
  return call(fetchImpl, `${API}/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', headers: auth(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
}

/** Cambia un evento solo si nadie lo tocó desde nuestro etag (412 si sí). */
export async function patchEvent(token: string, calendarId: string, eventId: string, body: Record<string, unknown>, etag: string | null, fetchImpl: FetchLike = defaultFetch): Promise<GoogleEvent> {
  return call(fetchImpl, `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH', headers: auth(token, { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }), body: JSON.stringify(body),
  });
}

export async function deleteEvent(token: string, calendarId: string, eventId: string, fetchImpl: FetchLike = defaultFetch) {
  await call(fetchImpl, `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers: auth(token) });
}

/** Notificaciones push de cambios (expiran: hay que renovarlas). */
export async function watchEvents(token: string, calendarId: string, channel: { id: string; address: string; token: string; ttlSeconds: number }, fetchImpl: FetchLike = defaultFetch) {
  const r = await call(fetchImpl, `${API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: 'POST', headers: auth(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: channel.id, type: 'web_hook', address: channel.address, token: channel.token, params: { ttl: String(channel.ttlSeconds) } }),
  });
  return { resourceId: String(r?.resourceId ?? ''), expiration: r?.expiration ? new Date(Number(r.expiration)) : null };
}

export async function stopChannel(token: string, channelId: string, resourceId: string, fetchImpl: FetchLike = defaultFetch) {
  await call(fetchImpl, `${API}/channels/stop`, { method: 'POST', headers: auth(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ id: channelId, resourceId }) });
}

/** Inicio y fin de un evento en UTC; los de todo el día se ubican en la zona del calendario. */
export function eventRange(e: GoogleEvent, fallbackTz: string, localToUtc: (date: string, time: string, tz: string) => Date): { start: Date; end: Date; allDay: boolean } | null {
  if (e.start?.dateTime && e.end?.dateTime) return { start: new Date(e.start.dateTime), end: new Date(e.end.dateTime), allDay: false };
  if (e.start?.date && e.end?.date) {
    const tz = e.start.timeZone || fallbackTz;
    return { start: localToUtc(e.start.date, '00:00', tz), end: localToUtc(e.end.date, '00:00', tz), allDay: true };
  }
  return null;
}
