/**
 * Google Calendar falso para pruebas: responde como la API v3 y OAuth 2.0
 * (tokens, calendarList, events con syncToken incremental, etag/If-Match,
 * 409 por id repetido, borrados como "cancelled", watch y channels.stop) y
 * permite inyectar fallos. Solo para pruebas: nada de esto se usa en producción.
 */
type Ev = Record<string, any> & { id: string; etag: string; seq: number };

export class FakeGoogle {
  calendars = [
    { id: 'dueno@gmail.com', summary: 'Dueño', primary: true, timeZone: 'America/Bogota', accessRole: 'owner' },
    { id: 'canchas@group.calendar.google.com', summary: 'Canchas', timeZone: 'America/Bogota', accessRole: 'writer' },
  ];
  events = new Map<string, Ev>();
  calls: Array<{ method: string; url: string; headers?: Record<string, string>; body?: string }> = [];
  seq = 0;
  etagN = 0;
  grantedScope = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events';
  revoked = false;
  expiredSyncTokens = new Set<string>();
  revokedTokens: string[] = [];
  channels = new Map<string, { resourceId: string; token: string; address: string }>();
  stoppedChannels: string[] = [];
  /** Fallos a inyectar: el siguiente pedido cuyo método+url coincida responde ese status */
  failures: Array<{ match: RegExp; status: number; body?: any; times: number }> = [];
  pageSize = 250;

  failNext(match: RegExp, status: number, times = 1, body?: any) {
    this.failures.push({ match, status, times, body });
  }

  private nextEtag() {
    return `"e${++this.etagN}"`;
  }

  /** Alguien crea o cambia un evento directamente en Google */
  external(ev: Record<string, any>) {
    const prev = this.events.get(ev.id);
    const e: Ev = { status: 'confirmed', ...(prev ?? {}), ...ev, etag: this.nextEtag(), seq: ++this.seq, updated: new Date().toISOString() } as Ev;
    this.events.set(e.id, e);
    return e;
  }

  remove(id: string) {
    const e = this.events.get(id);
    if (e) this.events.set(id, { ...e, status: 'cancelled', etag: this.nextEtag(), seq: ++this.seq });
  }

  private res(status: number, body?: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  }

  private view(e: Ev) {
    const { seq: _s, ...rest } = e;
    return rest;
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    this.calls.push({ method, url, headers: init.headers, body: init.body });
    const f = this.failures.find((x) => x.times > 0 && x.match.test(`${method} ${url}`));
    if (f) {
      f.times--;
      if (f.status === 0) throw new Error('ECONNRESET');
      return this.res(f.status, f.body ?? { error: { message: `fallo inyectado ${f.status}`, errors: [{ reason: f.status === 429 ? 'rateLimitExceeded' : 'backendError' }] } });
    }
    const u = new URL(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(init.body ?? '');
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'codigo-bueno') return this.res(400, { error: 'invalid_grant', error_description: 'Bad code' });
        return this.res(200, { access_token: 'acceso-1', refresh_token: 'refresco-secreto', expires_in: 3599, scope: this.grantedScope, token_type: 'Bearer' });
      }
      if (this.revoked) return this.res(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return this.res(200, { access_token: `acceso-${++this.seq}`, expires_in: 3599, token_type: 'Bearer' });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      this.revokedTokens.push(new URLSearchParams(init.body ?? '').get('token') ?? '');
      return this.res(200, {});
    }
    if (u.pathname.endsWith('/users/me/calendarList')) return this.res(200, { items: this.calendars });
    if (u.pathname === '/calendar/v3/channels/stop') {
      this.stoppedChannels.push(JSON.parse(init.body ?? '{}').id);
      return this.res(204);
    }
    const m = /\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(watch|[^/]+))?$/.exec(u.pathname);
    if (!m) return this.res(404, { error: { message: 'ruta desconocida' } });
    const tail = m[2] ? decodeURIComponent(m[2]) : null;
    if (tail === 'watch' && method === 'POST') {
      const b = JSON.parse(init.body ?? '{}');
      const resourceId = `res-${b.id.slice(0, 6)}`;
      this.channels.set(b.id, { resourceId, token: b.token, address: b.address });
      return this.res(200, { id: b.id, resourceId, expiration: String(Date.now() + 7 * 86400e3) });
    }
    if (!tail && method === 'GET') {
      const syncToken = u.searchParams.get('syncToken');
      if (syncToken && this.expiredSyncTokens.has(syncToken)) return this.res(410, { error: { message: 'Sync token is no longer valid', errors: [{ reason: 'fullSyncRequired' }] } });
      const since = syncToken ? Number(syncToken.replace('st-', '')) : 0;
      const timeMin = u.searchParams.get('timeMin');
      let list = [...this.events.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
      if (!syncToken) list = list.filter((e) => e.status !== 'cancelled' && (!timeMin || new Date(e.end?.dateTime ?? `${e.end?.date}T23:59:59Z`) >= new Date(timeMin)));
      const offset = Number(u.searchParams.get('pageToken') ?? 0);
      const page = list.slice(offset, offset + this.pageSize);
      const more = offset + this.pageSize < list.length;
      return this.res(200, { items: page.map((e) => this.view(e)), ...(more ? { nextPageToken: String(offset + this.pageSize) } : { nextSyncToken: `st-${this.seq}` }) });
    }
    if (!tail && method === 'POST') {
      const b = JSON.parse(init.body ?? '{}');
      if (this.events.has(b.id)) return this.res(409, { error: { message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } });
      const e: Ev = { status: 'confirmed', ...b, etag: this.nextEtag(), seq: ++this.seq };
      this.events.set(e.id, e);
      return this.res(200, this.view(e));
    }
    const current = tail ? this.events.get(tail) : null;
    if (method === 'PATCH') {
      if (!current) return this.res(404, { error: { message: 'Not Found' } });
      const ifMatch = init.headers?.['If-Match'];
      if (ifMatch && ifMatch !== current.etag) return this.res(412, { error: { message: 'Precondition Failed', errors: [{ reason: 'conditionNotMet' }] } });
      const b = JSON.parse(init.body ?? '{}');
      const e: Ev = { ...current, ...b, etag: this.nextEtag(), seq: ++this.seq };
      this.events.set(e.id, e);
      return this.res(200, this.view(e));
    }
    if (method === 'DELETE') {
      if (!current || current.status === 'cancelled') return this.res(410, { error: { message: 'Resource has been deleted' } });
      this.remove(current.id);
      return this.res(204);
    }
    return this.res(400, { error: { message: 'no soportado' } });
  };
}
