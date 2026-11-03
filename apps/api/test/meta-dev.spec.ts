import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../src/modules/audit.module';
import {
  META_DEV_COOKIE, MetaDevCallbackController, MetaDevController, MetaDevGuard, MetaDevService, devConfig, metaDevEnabled, validateRedirectUri,
} from '../src/modules/meta-dev.module';
import { MetaGraphClient, MetaGraphError, redact } from '../src/common/meta/graph-client';
import { decryptSecret, encryptSecret } from '../src/common/crypto';
import { createMockPrisma } from './helpers/mock-prisma';

/*
 * Pruebas SIMULADAS de la integración interna de Meta Ads: Graph API es un
 * doble en memoria (fakeMeta). Ninguna de estas pruebas habla con Meta de
 * verdad; la verificación real contra la app de desarrollo es aparte.
 */

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const APP_ID = '1000000000000001';
const ACT = 'act_1000000000000002';
const SHORT = `EAAshort${'x'.repeat(30)}`;
const LONG = `EAAlong${'y'.repeat(40)}`;
const NOW = new Date('2026-10-30T15:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

const DEV = { id: 'dev1', role: 'DEV', name: 'Santi Dev', email: 'dev@backoffice.dev', companyId: null } as any;
const ADMIN = { id: 'adm1', role: 'COMPANY_ADMIN', name: 'Cliente', email: 'c@cliente.co', companyId: 'c1' } as any;
const SUPER = { id: 'sa1', role: 'SUPER_ADMIN', name: 'Plataforma', email: 'p@backoffice.dev', companyId: null } as any;

type Reply = { status?: number; body: any };
type Handler = (params: URLSearchParams) => Reply;

const DEFAULTS: Record<string, Handler> = {
  'GET /oauth/access_token': (p) => (p.has('code') ? { body: { access_token: SHORT, token_type: 'bearer', expires_in: 3600 } } : { body: { access_token: LONG, token_type: 'bearer', expires_in: 5183944 } }),
  'GET /debug_token': () => ({ body: { data: { app_id: APP_ID, is_valid: true, user_id: '999', type: 'USER', expires_at: nowSec + 5183944, data_access_expires_at: nowSec + 90 * 86400, scopes: ['ads_read', 'business_management', 'public_profile'] } } }),
  'GET /me': () => ({ body: { id: '999', name: 'Dev Santi' } }),
  'GET /me/permissions': () => ({ body: { data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'business_management', status: 'granted' }, { permission: 'public_profile', status: 'granted' }] } }),
  'GET /me/adaccounts': () => ({ body: { data: [{ id: ACT, account_id: '1000000000000002', name: 'Cuenta de pruebas', account_status: 1, currency: 'COP', timezone_name: 'America/Bogota' }] } }),
  [`GET /${ACT}/campaigns`]: () => ({ body: { data: [{ id: '120001', name: 'Campaña A', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', effective_status: 'PAUSED' }] } }),
  [`GET /${ACT}/adsets`]: () => ({ body: { data: [{ id: '130001', name: 'Conjunto A', campaign_id: '120001', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED' }] } }),
  [`GET /${ACT}/ads`]: () => ({ body: { data: [{ id: '140001', name: 'Anuncio A', adset_id: '130001', campaign_id: '120001', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED' }] } }),
  // Lo que devolvió la cuenta real en Graph API Explorer: aceptado, sin filas
  [`GET /${ACT}/insights`]: () => ({ body: { data: [] } }),
  'DELETE /me/permissions': () => ({ body: { success: true } }),
};

function fakeMeta(over: Record<string, Handler> = {}) {
  const calls: Array<{ method: string; path: string; params: URLSearchParams; url: string; version: string }> = [];
  const fetchImpl = async (url: string, init?: any) => {
    const u = new URL(url);
    const version = u.pathname.split('/')[1];
    const path = u.pathname.replace(/^\/v\d+\.\d+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, params: u.searchParams, url, version });
    const h = over[`${method} ${path}`] ?? DEFAULTS[`${method} ${path}`];
    const r: Reply = h ? h(u.searchParams) : { status: 400, body: { error: { code: 100, message: 'Unknown path components' } } };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body, headers: { get: (n: string) => (n === 'x-app-usage' ? '{"call_count":2}' : null) } };
  };
  return { calls, fetchImpl };
}

const ENV_KEYS = ['META_DEV_ENABLED', 'META_DEV_APP_ID', 'META_DEV_APP_SECRET', 'META_DEV_REDIRECT_URI', 'META_DEV_SCOPES', 'META_DEV_SYNC_DAYS', 'META_GRAPH_API_VERSION', 'NODE_ENV', 'RENDER', 'VERCEL'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: 'test', META_DEV_ENABLED: '1', META_DEV_APP_ID: APP_ID, META_DEV_APP_SECRET: 'secreto-de-app-de-prueba-123456',
    META_DEV_REDIRECT_URI: 'http://localhost:5173/api/dev/meta-ads/callback',
  });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setup(over: Record<string, Handler> = {}) {
  const { prisma, db } = createMockPrisma();
  db.user.push({ ...DEV }, { ...ADMIN }, { ...SUPER });
  const svc = new MetaDevService(prisma as any, new AuditService(prisma as any));
  const meta = fakeMeta(over);
  svc.fetchImpl = meta.fetchImpl as any;
  svc.sleep = async () => undefined;
  svc.now = () => new Date(NOW);
  return { svc, db, meta };
}

async function connected(over: Record<string, Handler> = {}) {
  const s = setup(over);
  const r = await s.svc.connect(DEV);
  const to = await s.svc.callback({ code: 'CODIGO-OAUTH-1', state: r.nonce }, r.nonce);
  expect(to).toBe('http://localhost:5173/dev/meta-ads?r=conectado');
  return s;
}

async function withAccount(over: Record<string, Handler> = {}) {
  const s = await connected(over);
  await s.svc.select(DEV, { accountId: ACT });
  return s;
}

const ctx = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
const dump = (db: any) => JSON.stringify(db);

describe('acceso: solo desarrolladores, solo local', () => {
  const guard = new MetaDevGuard();

  it('rol DEV con META_DEV_ENABLED=1 entra', () => {
    expect(guard.canActivate(ctx(DEV))).toBe(true);
  });

  it('roles de empresa, SUPER_ADMIN y sin sesión reciben 404 (la ruta no existe para ellos)', () => {
    for (const u of [ADMIN, SUPER, undefined, { ...ADMIN, role: 'COMPANY_VIEWER' }]) expect(() => guard.canActivate(ctx(u))).toThrow(NotFoundException);
  });

  it('apagada sin la variable, en producción o en Render/Vercel aunque la variable esté', () => {
    delete process.env.META_DEV_ENABLED;
    expect(() => guard.canActivate(ctx(DEV))).toThrow(NotFoundException);
    process.env.META_DEV_ENABLED = '1';
    for (const extra of [{ NODE_ENV: 'production' }, { RENDER: 'true' }, { VERCEL: '1' }]) {
      expect(metaDevEnabled({ ...process.env, ...extra })).toBe(false);
    }
  });

  it('la vuelta de Meta también es 404 si la integración está apagada', async () => {
    delete process.env.META_DEV_ENABLED;
    const ctrl = new MetaDevCallbackController(setup().svc);
    await expect(ctrl.callback({ code: 'x', state: 'y' }, { headers: {} } as any, {} as any)).rejects.toThrow(NotFoundException);
  });
});

describe('configuración local', () => {
  it('URI de redirección exacta y local', () => {
    expect(validateRedirectUri('http://localhost:5173/api/dev/meta-ads/callback')).toBe('http://localhost:5173/api/dev/meta-ads/callback');
    for (const bad of [
      'https://www.backoffice.store/api/dev/meta-ads/callback',
      'http://localhost:5173/api/dev/meta-ads/callback?next=https://evil.co',
      'http://localhost:5173/api/public/ads/meta/callback',
      'http://evil.localhost.co/api/dev/meta-ads/callback',
      'javascript:alert(1)',
    ]) expect(() => validateRedirectUri(bad)).toThrow();
  });

  it('por defecto pide solo permisos de lectura y usa una versión vigente de Graph', () => {
    const cfg = devConfig();
    expect(cfg.scopes).toEqual(['ads_read', 'business_management']);
    expect(cfg.version).toBe('v25.0');
    expect(cfg.missing).toEqual([]);
    expect(devConfig({ ...process.env, META_DEV_SCOPES: 'ads_read,pages_manage_posts' }).scopes).toEqual(['ads_read']);
  });

  it('sin App Secret no arranca OAuth y dice qué falta', async () => {
    delete process.env.META_DEV_APP_SECRET;
    expect(devConfig().missing).toEqual(['META_DEV_APP_SECRET']);
    await expect(setup().svc.connect(DEV)).rejects.toThrow(/META_DEV_APP_SECRET/);
  });
});

describe('OAuth', () => {
  it('inicio: URL del diálogo de Meta con la app, la URI exacta, permisos de lectura y state aleatorio', async () => {
    const { svc, db } = setup();
    const r = await svc.connect(DEV);
    const u = new URL(r.url);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v25.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe(APP_ID);
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/dev/meta-ads/callback');
    expect(u.searchParams.get('scope')).toBe('ads_read,business_management');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe(r.nonce);
    expect(r.nonce.length).toBeGreaterThanOrEqual(40);
    expect(r.url).not.toContain('secreto-de-app');
    // En la base queda solo el hash del state, nunca el valor
    expect(db.metaDevOAuthState).toHaveLength(1);
    expect(dump(db.metaDevOAuthState)).not.toContain(r.nonce);
    expect(db.metaDevOAuthState[0]).toMatchObject({ userId: 'dev1', usedAt: null });
  });

  it('el controlador ata el state al navegador con una cookie httpOnly', async () => {
    const ctrl = new MetaDevController(setup().svc);
    const res = { cookie: jest.fn() };
    const out = await ctrl.connect(DEV, res as any);
    expect(out).not.toHaveProperty('nonce');
    expect(res.cookie).toHaveBeenCalledWith(META_DEV_COOKIE, expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/api/dev/meta-ads' }));
  });

  it('vuelta correcta: código → token corto → token largo, verificado con debug_token y guardado cifrado', async () => {
    const { db, meta } = await connected();
    const exchange = meta.calls.filter((c) => c.path === '/oauth/access_token');
    expect(exchange).toHaveLength(2);
    expect(exchange[0].params.get('code')).toBe('CODIGO-OAUTH-1');
    expect(exchange[0].params.get('redirect_uri')).toBe('http://localhost:5173/api/dev/meta-ads/callback');
    expect(exchange[1].params.get('grant_type')).toBe('fb_exchange_token');
    const conn = db.metaDevConnection[0];
    expect(conn.status).toBe('CONNECTED');
    expect(conn.longLived).toBe(true);
    expect(decryptSecret(conn.tokenEnc)).toBe(LONG);
    // Ningún token en claro en ninguna colección
    expect(dump(db)).not.toContain(LONG);
    expect(dump(db)).not.toContain(SHORT);
    expect(new Date(conn.tokenExpiresAt).getTime()).toBe((nowSec + 5183944) * 1000);
    expect(JSON.parse(conn.scopesJson)).toEqual(['ads_read', 'business_management', 'public_profile']);
    expect(conn).not.toHaveProperty('companyId');
    expect(db.auditLog.some((a: any) => a.action === 'meta_dev.connect')).toBe(true);
    expect(dump(db.auditLog)).not.toContain('EAA');
  });

  it('el state es de un solo uso: repetir la vuelta falla y no cambia el token', async () => {
    const { svc } = setup();
    const r = await svc.connect(DEV);
    expect(await svc.callback({ code: 'C1', state: r.nonce }, r.nonce)).toContain('r=conectado');
    expect(await svc.callback({ code: 'C2', state: r.nonce }, r.nonce)).toBe('http://localhost:5173/dev/meta-ads?r=error&motivo=state');
  });

  it('sin la cookie del navegador que inició, o con otra, se rechaza sin cambiar el código', async () => {
    const { svc, meta, db } = setup();
    const r = await svc.connect(DEV);
    expect(await svc.callback({ code: 'C1', state: r.nonce }, null)).toContain('motivo=state');
    expect(await svc.callback({ code: 'C1', state: r.nonce }, 'otra-cookie')).toContain('motivo=state');
    expect(await svc.callback({ code: 'C1', state: 'inventado' }, 'inventado')).toContain('motivo=state');
    expect(meta.calls).toHaveLength(0);
    expect(db.metaDevConnection).toHaveLength(0);
  });

  it('state vencido (más de 10 minutos) se rechaza', async () => {
    const { svc } = setup();
    const r = await svc.connect(DEV);
    svc.now = () => new Date(NOW.getTime() + 11 * 60e3);
    expect(await svc.callback({ code: 'C1', state: r.nonce }, r.nonce)).toContain('motivo=state');
  });

  it('autorización denegada en Facebook: vuelve como cancelado, sin intercambio', async () => {
    const { svc, meta, db } = setup();
    const r = await svc.connect(DEV);
    const to = await svc.callback({ state: r.nonce, error: 'access_denied', error_reason: 'user_denied' }, r.nonce);
    expect(to).toBe('http://localhost:5173/dev/meta-ads?r=cancelado');
    expect(meta.calls).toHaveLength(0);
    expect(db.metaDevConnection).toHaveLength(0);
    expect(db.auditLog.some((a: any) => a.action === 'meta_dev.oauth_cancelled')).toBe(true);
  });

  it('un usuario que dejó de ser DEV no puede completar la conexión', async () => {
    const { svc, db } = setup();
    const r = await svc.connect(DEV);
    db.user[0].role = 'COMPANY_ADMIN';
    expect(await svc.callback({ code: 'C1', state: r.nonce }, r.nonce)).toContain('motivo=usuario');
  });

  it('token de otra app o inválido según debug_token: no se guarda', async () => {
    const { svc, db } = setup({ 'GET /debug_token': () => ({ body: { data: { app_id: '555', is_valid: true } } }) });
    const r = await svc.connect(DEV);
    expect(await svc.callback({ code: 'C1', state: r.nonce }, r.nonce)).toContain('motivo=token');
    expect(db.metaDevConnection).toHaveLength(0);
  });

  it('código rechazado por Meta: error controlado, sin token en la URL ni en los registros', async () => {
    const { svc, db } = setup({ 'GET /oauth/access_token': () => ({ status: 400, body: { error: { code: 100, message: 'This authorization code has expired. code=CODIGO-SECRETO' } } }) });
    const r = await svc.connect(DEV);
    const to = await svc.callback({ code: 'CODIGO-SECRETO', state: r.nonce }, r.nonce);
    expect(to).toContain('motivo=intercambio');
    expect(to).not.toContain('CODIGO');
    expect(dump(db.auditLog)).not.toContain('CODIGO-SECRETO');
  });

  it('la redirección del controlador limpia la cookie y no filtra el Referer', async () => {
    const { svc } = setup();
    const r = await svc.connect(DEV);
    const res = { clearCookie: jest.fn(), setHeader: jest.fn(), redirect: jest.fn() };
    await new MetaDevCallbackController(svc).callback({ code: 'C1', state: r.nonce }, { headers: { cookie: `otra=1; ${META_DEV_COOKIE}=${r.nonce}` } } as any, res as any);
    expect(res.redirect).toHaveBeenCalledWith(302, 'http://localhost:5173/dev/meta-ads?r=conectado');
    expect(res.clearCookie).toHaveBeenCalledWith(META_DEV_COOKIE, { path: '/api/dev/meta-ads' });
    expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });
});

describe('cifrado de la credencial', () => {
  it('ida y vuelta AES-256-GCM; alterar el texto cifrado lo invalida', () => {
    const enc = encryptSecret(LONG);
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc).not.toContain(LONG);
    expect(decryptSecret(enc)).toBe(LONG);
    const parts = enc.split(':');
    parts[4] = Buffer.from('otra-cosa').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
    expect(() => decryptSecret(LONG)).toThrow();
  });

  it('la revisión de la credencial no devuelve el token', async () => {
    const { svc } = await connected();
    const c = await svc.credential(true);
    expect(c).toMatchObject({ stored: true, encrypted: true, decryptsWithCurrentKey: true, exposedByApi: false, live: { isValid: true, appIdMatches: true } });
    expect(JSON.stringify(c)).not.toContain('EAA');
    const status = await svc.status();
    expect(JSON.stringify(status)).not.toContain('EAA');
    expect(JSON.stringify(status)).not.toContain('secreto-de-app');
  });

  it('un token guardado que no se puede descifrar (otra llave) pide reconectar', async () => {
    const { svc, db } = await connected();
    db.metaDevConnection[0].tokenEnc = 'enc:v1:AAAA:BBBB:CCCC';
    await expect(svc.accounts()).rejects.toMatchObject({ response: { code: 'TOKEN_UNREADABLE' } });
  });
});

describe('vencimiento y revocación', () => {
  it('token con fecha vencida: no llama a Meta y queda EXPIRED', async () => {
    const { svc, db, meta } = await connected();
    const before = meta.calls.length;
    svc.now = () => new Date((nowSec + 5183944 + 60) * 1000);
    await expect(svc.accounts()).rejects.toMatchObject({ response: { code: 'AUTH_EXPIRED' } });
    expect(meta.calls.length).toBe(before);
    expect(db.metaDevConnection[0].status).toBe('EXPIRED');
  });

  it('Meta responde 190/463 (vencido) → EXPIRED; 190/460 (revocado o cambio de contraseña) → REVOKED', async () => {
    for (const [sub, state] of [[463, 'EXPIRED'], [460, 'REVOKED']] as const) {
      const { svc, db } = await connected({ 'GET /me/adaccounts': () => ({ status: 400, body: { error: { code: 190, error_subcode: sub, message: 'Error validating access token' } } }) });
      const err = await svc.accounts().catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: `AUTH_${state}` });
      expect(db.metaDevConnection[0].status).toBe(state);
      // Ya no se intenta más hasta reconectar
      await expect(svc.accounts()).rejects.toMatchObject({ response: { code: `AUTH_${state}` } });
    }
  });
});

describe('cuentas publicitarias', () => {
  it('lista las cuentas autorizadas y permite elegir solo una de ellas', async () => {
    const { svc, db } = await connected();
    const list = await svc.accounts();
    expect(list).toEqual([{ id: ACT, name: 'Cuenta de pruebas', status: 'ACTIVE', currency: 'COP', timezone: 'America/Bogota', selected: false }]);
    await expect(svc.select(DEV, { accountId: 'act_9999999999' })).rejects.toThrow(ForbiddenException);
    await expect(svc.select(DEV, { accountId: '1000000000000002; DROP' })).rejects.toThrow(/act_/);
    await svc.select(DEV, { accountId: ACT });
    expect(db.metaDevConnection[0]).toMatchObject({ selectedAccountId: ACT, accountCurrency: 'COP', accountTimezone: 'America/Bogota' });
  });

  it('sin conexión no hay lecturas', async () => {
    await expect(setup().svc.accounts()).rejects.toMatchObject({ response: { code: 'NOT_CONNECTED' } });
  });
});

describe('sincronización manual', () => {
  it('campañas, conjuntos y anuncios; Insights con data: [] es un resultado válido sin inventar métricas', async () => {
    const { svc, db } = await withAccount();
    const r = await svc.sync(DEV, {});
    expect(r.status).toBe('OK');
    expect(r).toMatchObject({ days: 30, since: '2026-10-01', until: '2026-10-30' });
    expect(r.counts.CAMPAIGN).toEqual({ created: 1, updated: 0, unchanged: 0, total: 1 });
    expect(r.counts.ADSET).toEqual({ created: 1, updated: 0, unchanged: 0, total: 1 });
    expect(r.counts.AD).toEqual({ created: 1, updated: 0, unchanged: 0, total: 1 });
    expect(r.counts.INSIGHT).toEqual({ created: 0, updated: 0, unchanged: 0, total: 0 });
    expect(r.warnings.join(' ')).toMatch(/data: \[\]/);
    expect(db.metaDevInsight).toHaveLength(0);
    expect(db.metaDevConnection[0]).toMatchObject({ lastSyncStatus: 'OK', syncLockUntil: null });
    const ins = await svc.insights();
    expect(ins.rows).toEqual([]);
    expect((await svc.objects('AD'))[0]).toMatchObject({ id: '140001', adsetId: '130001', campaignId: '120001' });
  });

  it('Insights con resultados: guarda lo que Meta informó y deja en null lo que no vino', async () => {
    const { svc, db, meta } = await withAccount({
      [`GET /${ACT}/insights`]: () => ({ body: { data: [
        { campaign_id: '120001', campaign_name: 'Campaña A', impressions: '1500', clicks: '42', spend: '35000', cpc: '833.33', cpm: '23333.33', ctr: '2.8', reach: '1200', actions: [{ action_type: 'link_click', value: '30' }], date_start: '2026-10-28', date_stop: '2026-10-28' },
        { campaign_id: '120001', campaign_name: 'Campaña A', impressions: '0', spend: '0', date_start: '2026-10-29', date_stop: '2026-10-29' },
      ] } }),
    });
    const r = await svc.sync(DEV, { days: 60 });
    expect(r).toMatchObject({ status: 'OK', days: 60, since: '2026-09-01' });
    const call = meta.calls.find((c) => c.path === `/${ACT}/insights`)!;
    expect(call.params.get('level')).toBe('campaign');
    expect(call.params.get('time_increment')).toBe('1');
    expect(JSON.parse(call.params.get('time_range')!)).toEqual({ since: '2026-09-01', until: '2026-10-30' });
    expect(call.params.get('fields')).toBe('campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,actions,date_start,date_stop');
    expect(db.metaDevInsight).toHaveLength(2);
    const day28 = db.metaDevInsight.find((x: any) => x.dateStart === '2026-10-28');
    expect(day28).toMatchObject({ impressions: 1500, clicks: 42, spend: 35000, cpc: 833.33, ctr: 2.8, reach: 1200, currency: 'COP' });
    const day29 = db.metaDevInsight.find((x: any) => x.dateStart === '2026-10-29');
    expect(day29).toMatchObject({ impressions: 0, spend: 0, clicks: null, cpc: null, cpm: null, ctr: null, reach: null });
    const out = await svc.insights();
    expect(out.totals[0]).toMatchObject({ campaignId: '120001', days: 2, impressions: 1500, clicks: 42, spend: 35000 });
  });

  it('sin duplicados: repetir da «sin cambios»; si Meta cambia algo, «actualizado»', async () => {
    let name = 'Campaña A';
    const { svc, db } = await withAccount({ [`GET /${ACT}/campaigns`]: () => ({ body: { data: [{ id: '120001', name, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', effective_status: 'PAUSED' }] } }) });
    await svc.sync(DEV, {});
    const second = await svc.sync(DEV, {});
    expect(second.counts.CAMPAIGN).toEqual({ created: 0, updated: 0, unchanged: 1, total: 1 });
    name = 'Campaña A (renombrada)';
    const third = await svc.sync(DEV, {});
    expect(third.counts.CAMPAIGN).toEqual({ created: 0, updated: 1, unchanged: 0, total: 1 });
    expect(db.metaDevObject.filter((o: any) => o.level === 'CAMPAIGN')).toHaveLength(1);
    expect(db.metaDevObject.find((o: any) => o.level === 'CAMPAIGN')!.name).toBe('Campaña A (renombrada)');
  });

  it('paginación por cursor: trae todas las páginas', async () => {
    const { svc, meta } = await withAccount({
      [`GET /${ACT}/campaigns`]: (p) => (p.get('after') === 'CUR2'
        ? { body: { data: [{ id: '120002', name: 'B', status: 'ACTIVE' }] } }
        : { body: { data: [{ id: '120001', name: 'A', status: 'PAUSED' }], paging: { cursors: { after: 'CUR2' }, next: `https://graph.facebook.com/v25.0/${ACT}/campaigns?after=CUR2&access_token=${LONG}` } } }),
    });
    const r = await svc.sync(DEV, {});
    expect(r.counts.CAMPAIGN.total).toBe(2);
    expect(meta.calls.filter((c) => c.path === `/${ACT}/campaigns`)).toHaveLength(2);
  });

  it('sin permiso para anuncios: guarda lo demás y queda PARCIAL con el motivo', async () => {
    const { svc } = await withAccount({ [`GET /${ACT}/ads`]: () => ({ status: 403, body: { error: { code: 200, message: 'Requires ads_read permission' } } }) });
    const r = await svc.sync(DEV, {});
    expect(r.status).toBe('PARTIAL');
    expect(r.counts.CAMPAIGN.created).toBe(1);
    expect(r.counts.AD).toBeUndefined();
    expect(r.warnings[0]).toMatch(/^Anuncios: Permisos insuficientes/);
  });

  it('límite de Meta: reintenta con espera; si sigue, la corrida queda en error y libera el candado', async () => {
    let n = 0;
    const once = await withAccount({ [`GET /${ACT}/campaigns`]: () => (++n === 1 ? { status: 400, body: { error: { code: 17, message: 'User request limit reached' } } } : DEFAULTS[`GET /${ACT}/campaigns`](new URLSearchParams())) });
    const slept: number[] = [];
    once.svc.sleep = async (ms) => { slept.push(ms); };
    expect((await once.svc.sync(DEV, {})).status).toBe('OK');
    expect(slept).toHaveLength(1);

    const always = await withAccount({ [`GET /${ACT}/campaigns`]: () => ({ status: 400, body: { error: { code: 80004, message: 'There have been too many calls to this ad-account' } } }) });
    const r = await always.svc.sync(DEV, {});
    expect(r).toMatchObject({ status: 'ERROR', errorKind: 'RATE_LIMIT' });
    expect(always.meta.calls.filter((c) => c.path === `/${ACT}/campaigns`)).toHaveLength(3);
    expect(always.db.metaDevConnection[0]).toMatchObject({ syncLockUntil: null, lastSyncStatus: 'ERROR', status: 'CONNECTED' });
  });

  it('token revocado a mitad de la sincronización: la conexión queda REVOKED', async () => {
    const { svc, db } = await withAccount({ [`GET /${ACT}/campaigns`]: () => ({ status: 400, body: { error: { code: 190, error_subcode: 458, message: 'The user has not authorized application' } } }) });
    const r = await svc.sync(DEV, {});
    expect(r).toMatchObject({ status: 'ERROR', errorKind: 'AUTH_REVOKED' });
    expect(db.metaDevConnection[0].status).toBe('REVOKED');
  });

  it('una sola sincronización a la vez', async () => {
    const { svc, db } = await withAccount();
    db.metaDevConnection[0].syncLockUntil = new Date(NOW.getTime() + 60e3);
    await expect(svc.sync(DEV, {})).rejects.toMatchObject({ response: { code: 'SYNC_RUNNING' } });
  });

  it('el registro de llamadas a Meta no tiene credenciales', async () => {
    const { svc, db } = await withAccount();
    await svc.sync(DEV, {});
    const runs = await svc.runs();
    const calls = (runs[0] as any).calls as any[];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls[0]).toMatchObject({ method: 'GET', status: 200, usage: 'x-app-usage: {"call_count":2}' });
    const text = JSON.stringify(runs) + dump(db.metaDevSyncRun) + dump(db.metaDevObject);
    expect(text).not.toContain('EAA');
    expect(text).not.toContain('appsecret_proof=');
    expect(text).not.toContain('access_token=');
  });
});

describe('solo lectura y aislamiento', () => {
  it('nunca escribe en Meta: todas las llamadas son GET salvo revocar el permiso al desconectar', async () => {
    const { svc, meta } = await withAccount();
    await svc.sync(DEV, {});
    for (const k of ['me', 'permissions', 'accounts', 'campaigns', 'adsets', 'ads', 'insights']) await svc.raw(k);
    expect(meta.calls.every((c) => c.method === 'GET')).toBe(true);
    await svc.disconnect(DEV, { revoke: true });
    const writes = meta.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /me/permissions']);
  });

  it('cada llamada lleva appsecret_proof y la versión explícita de Graph', async () => {
    const { svc, meta } = await withAccount();
    await svc.sync(DEV, {});
    const withToken = meta.calls.filter((c) => c.params.get('access_token') === LONG);
    expect(withToken.length).toBeGreaterThan(3);
    expect(withToken.every((c) => /^[a-f0-9]{64}$/.test(c.params.get('appsecret_proof') ?? ''))).toBe(true);
    expect(meta.calls.every((c) => c.version === 'v25.0')).toBe(true);
  });

  it('los datos de la cuenta de pruebas no tocan nada de las empresas', async () => {
    const { svc, db } = await withAccount({
      [`GET /${ACT}/insights`]: () => ({ body: { data: [{ campaign_id: '120001', campaign_name: 'A', impressions: '10', date_start: '2026-10-29', date_stop: '2026-10-29' }] } }),
    });
    await svc.sync(DEV, {});
    for (const tenant of ['adAccount', 'adEntity', 'adInsightDaily', 'adSyncRun', 'opportunity', 'company', 'platformSetting']) expect(db[tenant as keyof typeof db]).toHaveLength(0);
    for (const coll of ['metaDevObject', 'metaDevInsight', 'metaDevSyncRun'] as const) {
      expect(db[coll].length).toBeGreaterThan(0);
      for (const doc of db[coll]) {
        expect(doc.scope).toBe('DEV_INTERNAL');
        expect(doc).not.toHaveProperty('companyId');
      }
    }
  });

  it('una empresa no puede leer la cuenta de pruebas ni por la API (404 antes de llegar al servicio)', async () => {
    const guard = new MetaDevGuard();
    expect(() => guard.canActivate(ctx({ ...ADMIN, companyId: 'c1' }))).toThrow(NotFoundException);
    expect(() => guard.canActivate(ctx({ id: 'x', role: 'COMPANY_ADMIN', companyId: 'c2' }))).toThrow(NotFoundException);
  });

  it('respuesta cruda para revisar: sin token y con el error de Meta cuando falla', async () => {
    const { svc } = await withAccount({ [`GET /${ACT}/adsets`]: () => ({ status: 400, body: { error: { code: 100, message: 'Invalid parameter', fbtrace_id: 'Abc' } } }) });
    const ok = await svc.raw('accounts');
    expect(ok).toMatchObject({ ok: true, kind: 'accounts' });
    expect(JSON.stringify(ok)).not.toContain('EAA');
    const bad = await svc.raw('adsets');
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain('Invalid parameter');
    await expect(svc.raw('../../me/feed')).rejects.toThrow(/no permitida/);
  });
});

describe('desconexión', () => {
  it('revoca en Meta, borra el token y conserva los datos internos salvo que se pida borrarlos', async () => {
    const { svc, db } = await withAccount();
    await svc.sync(DEV, {});
    const r = await svc.disconnect(DEV, { revoke: true });
    expect(r).toMatchObject({ revoked: 'OK', purged: 0 });
    expect(db.metaDevConnection[0]).toMatchObject({ tokenEnc: null, status: 'DISCONNECTED' });
    expect(db.metaDevObject.length).toBeGreaterThan(0);
    await expect(svc.accounts()).rejects.toMatchObject({ response: { code: 'NOT_CONNECTED' } });
    const p = await svc.disconnect(DEV, { revoke: false, purge: true });
    expect(p.purged).toBeGreaterThan(0);
    expect(db.metaDevObject).toHaveLength(0);
    expect(db.metaDevSyncRun).toHaveLength(0);
    expect(db.metaDevConnection[0].selectedAccountId).toBeNull();
  });

  it('si Meta no deja revocar (token ya vencido), igual se borra aquí y se informa', async () => {
    const { svc, db } = await connected({ 'DELETE /me/permissions': () => ({ status: 400, body: { error: { code: 190, error_subcode: 463, message: 'Session has expired' } } }) });
    const r = await svc.disconnect(DEV, { revoke: true });
    expect(r.revoked).toBe('FAILED');
    expect(db.metaDevConnection[0].tokenEnc).toBeNull();
  });
});

describe('cliente de Graph', () => {
  const client = (fetchImpl: any, extra: object = {}) => new MetaGraphClient({ token: LONG, appSecret: 's', fetchImpl, sleep: async () => undefined, ...extra });

  it('tope de páginas: si Meta sigue teniendo más, falla como INCOMPLETA en vez de guardar una parte', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 1 }], paging: { cursors: { after: 'X' }, next: 'https://graph.facebook.com/next' } }) });
    await expect(client(fetchImpl, { maxPages: 3 }).all('/act_123456/campaigns')).rejects.toMatchObject({ kind: 'INCOMPLETE' });
  });

  it('timeout y red caída: reintenta y termina en error claro', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n++;
      const e: any = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    };
    const err = await client(fetchImpl, { timeoutMs: 5 }).get('/me').catch((e) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err.message).toMatch(/no respondió/);
    expect(n).toBe(3);
  });

  it('los errores de permisos no se reintentan', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return { ok: false, status: 403, json: async () => ({ error: { code: 10, message: 'Permission denied' } }) }; };
    await expect(client(fetchImpl).get('/me')).rejects.toMatchObject({ kind: 'PERMISSION' });
    expect(n).toBe(1);
  });

  it('rutas raras se rechazan antes de llamar', async () => {
    const fetchImpl = jest.fn();
    await expect(client(fetchImpl).get('/me?access_token=otro')).rejects.toBeInstanceOf(MetaGraphError);
    await expect(client(fetchImpl).get('https://evil.co/x')).rejects.toBeInstanceOf(MetaGraphError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redact oculta tokens, secretos y códigos', () => {
    const s = redact(`GET /me?access_token=${LONG}&appsecret_proof=abc&client_secret=sss&code=CCC&fields=id 123456789|abcdefghijklmnopqrstu ${LONG}`);
    expect(s).not.toMatch(/EAA|abc&|sss|CCC|abcdefghijklmnop/);
    expect(s).toContain('fields=id');
  });

  it('HttpException correcta para errores de Meta (nunca 401, que cerraría la sesión del panel)', async () => {
    const { svc } = await connected({ 'GET /me/adaccounts': () => ({ status: 400, body: { error: { code: 17, message: 'User request limit reached' } } }) });
    const err = await svc.accounts().catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
  });
});

describe('consulta en vivo (Respuestas de Meta)', () => {
  const rangeOf = (meta: ReturnType<typeof fakeMeta>) => JSON.parse(meta.calls.filter((c) => c.path === `/${ACT}/insights`).pop()!.params.get('time_range')!);

  it('30 días: envía a Meta exactamente 2026-10-01 → 2026-10-30 y lo devuelve', async () => {
    const { svc, meta } = await withAccount();
    const r = await svc.raw('insights', '30');
    expect(rangeOf(meta)).toEqual({ since: '2026-10-01', until: '2026-10-30' });
    expect(r).toMatchObject({ ok: true, live: true, saved: false, maxRows: 25, range: { days: 30, since: '2026-10-01', until: '2026-10-30' } });
    expect(meta.calls.pop()!.params.get('limit')).toBe('25');
  });

  it('60 días: envía 2026-09-01 → 2026-10-30', async () => {
    const { svc, meta } = await withAccount();
    const r = await svc.raw('insights', '60');
    expect(rangeOf(meta)).toEqual({ since: '2026-09-01', until: '2026-10-30' });
    expect(r.range).toEqual({ days: 60, since: '2026-09-01', until: '2026-10-30' });
  });

  it('cualquier otro valor se rechaza en el backend sin llamar a Meta', async () => {
    const { svc, meta } = await withAccount();
    const before = meta.calls.length;
    for (const bad of ['45', '0', '90', 'abc', '30;DROP', '-30', '30.0']) {
      await expect(svc.raw('insights', bad)).rejects.toMatchObject({ response: { code: 'INVALID_DAYS' } });
    }
    expect(meta.calls.length).toBe(before);
  });

  it('sin parámetro usa META_DEV_SYNC_DAYS (30 por defecto; 60 si así está configurado)', async () => {
    const a = await withAccount();
    expect((await a.svc.raw('insights')).range).toMatchObject({ days: 30, since: '2026-10-01' });
    expect((await a.svc.raw('insights', '')).range).toMatchObject({ days: 30 });
    process.env.META_DEV_SYNC_DAYS = '60';
    const b = await withAccount();
    expect((await b.svc.raw('insights')).range).toMatchObject({ days: 60, since: '2026-09-01' });
  });

  it('consultas sin fechas no informan rango', async () => {
    const { svc } = await withAccount();
    expect((await svc.raw('campaigns', '60')).range).toBeNull();
  });

  it('data: [] queda registrado como 0 filas', async () => {
    const { svc } = await withAccount();
    const r = await svc.raw('insights', '60');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ status: 200, rows: 0 });
    expect(r.calls[0].error).toBeUndefined();
    expect((r as any).body).toEqual({ data: [] });
  });

  it('error de Meta: estado HTTP y error, sin cantidad de filas', async () => {
    const { svc } = await withAccount({ [`GET /${ACT}/insights`]: () => ({ status: 400, body: { error: { code: 100, message: 'Invalid parameter', error_subcode: 1487534 } } }) });
    const r = await svc.raw('insights', '30');
    expect(r.ok).toBe(false);
    expect(r.calls[0]).toMatchObject({ status: 400, errorCode: 100 });
    expect(r.calls[0].rows).toBeUndefined();
    expect(r.calls[0].error).toMatch(/rango de fechas más corto/);
  });

  it('no se guarda: no crea corridas, ni filas, ni cambia la conexión', async () => {
    const { svc, db } = await withAccount();
    const conn = { ...db.metaDevConnection[0] };
    await svc.raw('insights', '60');
    await svc.raw('campaigns');
    expect(db.metaDevSyncRun).toHaveLength(0);
    expect(db.metaDevInsight).toHaveLength(0);
    expect(db.metaDevObject.filter((o: any) => o.level !== 'ACCOUNT')).toHaveLength(0);
    expect(db.metaDevConnection[0]).toEqual(conn);
  });

  it('las sincronizaciones de 30 y 60 días siguen enviando su propio rango', async () => {
    const { svc, meta } = await withAccount();
    await svc.raw('insights', '60');
    const r30 = await svc.sync(DEV, { days: 30 });
    expect(r30).toMatchObject({ status: 'OK', days: 30, since: '2026-10-01', until: '2026-10-30' });
    expect(rangeOf(meta)).toEqual({ since: '2026-10-01', until: '2026-10-30' });
    const r60 = await svc.sync(DEV, { days: 60 });
    expect(r60).toMatchObject({ status: 'OK', days: 60, since: '2026-09-01', until: '2026-10-30' });
    expect(rangeOf(meta)).toEqual({ since: '2026-09-01', until: '2026-10-30' });
    // La sincronización sigue paginando de a 500 (no hereda el límite de la consulta en vivo)
    expect(meta.calls.filter((c) => c.path === `/${ACT}/insights`).pop()!.params.get('limit')).toBe('500');
  });
});
