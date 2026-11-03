/**
 * Google Ads y TikTok Ads con las plataformas simuladas (sin red): contrato de
 * cada API, conexión de punta a punta (inicio de sesión → elegir cuentas →
 * sincronizar → pausar) y que nada se cruce con Meta ni entre empresas.
 */
import { AdsService } from '../src/modules/ads.module';
import { GoogleAdsProvider, classifyGoogleError, decodeGoogleCredential, encodeGoogleCredential } from '../src/common/ads/google-ads-provider';
import { TikTokAdsProvider, classifyTikTokError } from '../src/common/ads/tiktok-ads-provider';
import { AdsProviderError } from '../src/common/ads/provider';
import { decryptSecret } from '../src/common/crypto';
import { signState } from '../src/common/meta-publish';
import { createMockPrisma } from './helpers/mock-prisma';

const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const res = (body: any, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/* ── Google simulado ── */

function fakeGoogle() {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const b = new URLSearchParams(init.body);
      if (b.get('grant_type') === 'authorization_code') return res({ access_token: 'acc', refresh_token: 'refresh-g', expires_in: 3600, scope: 'https://www.googleapis.com/auth/adwords' });
      return res({ access_token: 'acc', expires_in: 3600 });
    }
    if (url.endsWith('/customers:listAccessibleCustomers')) return res({ resourceNames: ['customers/1110001111', 'customers/9990009999'] });
    const m = /\/customers\/(\d+)\/(googleAds:search|campaigns:mutate|adGroups:mutate|adGroupAds:mutate)$/.exec(url);
    if (!m) return res({ error: { message: 'ruta inesperada' } }, 404);
    const body = JSON.parse(init.body);
    if (m[2].endsWith(':mutate')) return res({ results: [{ resourceName: body.operations[0].update.resourceName }] });
    const q: string = body.query;
    if (q.includes('FROM customer_client')) return res({ results: [{ customerClient: { id: '5550005555', descriptiveName: 'Cliente de agencia', currencyCode: 'COP', timeZone: 'America/Bogota', manager: false, status: 'ENABLED' } }] });
    if (q.includes('FROM customer')) {
      return m[1] === '9990009999'
        ? res({ results: [{ customer: { id: '9990009999', descriptiveName: 'Agencia MCC', currencyCode: 'COP', timeZone: 'America/Bogota', manager: true, status: 'ENABLED' } }] })
        : res({ results: [{ customer: { id: '1110001111', descriptiveName: 'Constructora Google', currencyCode: 'COP', timeZone: 'America/Bogota', manager: false, status: 'ENABLED' } }] });
    }
    if (q.includes('FROM campaign')) return res({ results: [{ campaign: { id: '201', name: 'Búsqueda remodelación', status: 'ENABLED', primaryStatus: 'ELIGIBLE', advertisingChannelType: 'SEARCH' }, campaignBudget: { amountMicros: '50000000000' } }] });
    if (q.includes('FROM ad_group ')) return res({ results: [{ adGroup: { id: '301', name: 'Cocinas', status: 'ENABLED' }, campaign: { id: '201' } }] });
    if (q.includes('segments.date')) {
      // Dos páginas, para probar que se leen todas
      if (!body.pageToken) return res({ results: [{ segments: { date: '2026-10-20' }, adGroupAd: { ad: { id: '401' } }, adGroup: { id: '301' }, campaign: { id: '201' }, metrics: { costMicros: '12500000000', impressions: '1000', clicks: '40', conversions: 3.4, conversionsValue: 0 } }], nextPageToken: 'p2' });
      return res({ results: [{ segments: { date: '2026-10-21' }, adGroupAd: { ad: { id: '401' } }, adGroup: { id: '301' }, campaign: { id: '201' }, metrics: { costMicros: '7500000000', impressions: '500', clicks: '10', conversions: 1, conversionsValue: 0 } }] });
    }
    if (q.includes('FROM ad_group_ad')) return res({ results: [{ adGroupAd: { ad: { id: '401', name: 'Cocina moderna' }, status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED' } }, adGroup: { id: '301' }, campaign: { id: '201' } }] });
    return res({ results: [] });
  };
  return { fn: fn as any, calls };
}

const GOOGLE_CFG = async () => ({ clientId: 'cid', clientSecret: 'csecret', developerToken: 'dev-token', version: 'v26' });

describe('Google Ads · contrato (API v26 simulada)', () => {
  it('lista cuentas directas y las de una administradora (guardando por cuál se entra)', async () => {
    const g = fakeGoogle();
    const p = new GoogleAdsProvider(GOOGLE_CFG, g.fn);
    const accounts: any[] = await p.listAccounts(encodeGoogleCredential('refresh-g'));
    expect(accounts.map((a) => [a.externalId, a.name, a.loginCustomerId])).toEqual([['1110001111', 'Constructora Google', null], ['5550005555', 'Cliente de agencia', '9990009999']]);
    // Encabezados exigidos por Google en cada llamada
    const search = g.calls.find((c) => c.url.includes('googleAds:search'))!;
    expect(search.url).toMatch(/^https:\/\/googleads\.googleapis\.com\/v26\/customers\/\d+\/googleAds:search$/);
    expect(search.init.headers).toMatchObject({ Authorization: 'Bearer acc', 'developer-token': 'dev-token' });
    const viaManager = g.calls.find((c) => c.url.includes('googleAds:search') && JSON.parse(c.init.body).query.includes('customer_client'))!;
    expect(viaManager.init.headers['login-customer-id']).toBe('9990009999');
  });

  it('trae campañas, grupos y anuncios; métricas por día con micros convertidos y todas las páginas', async () => {
    const g = fakeGoogle();
    const p = new GoogleAdsProvider(GOOGLE_CFG, g.fn);
    const cred = encodeGoogleCredential('refresh-g');
    const ref = { externalId: '1110001111', currency: 'COP' };
    const ents = await p.fetchEntities(ref, cred);
    expect(ents.map((e) => [e.level, e.externalId, e.status])).toEqual([['CAMPAIGN', '201', 'ACTIVE'], ['ADSET', '301', 'ACTIVE'], ['AD', '301~401', 'ACTIVE']]);
    expect(ents[0]).toMatchObject({ dailyBudget: 50000, objective: 'GOOGLE_SEARCH' });
    const rows = await p.fetchInsights(ref, cred, '2026-10-20', '2026-10-21');
    expect(rows).toEqual([
      expect.objectContaining({ externalId: '301~401', campaignExternalId: '201', adsetExternalId: '301', date: '2026-10-20', spend: 12500, impressions: 1000, clicks: 40, leads: 3 }),
      expect.objectContaining({ date: '2026-10-21', spend: 7500 }),
    ]);
    await expect(p.fetchInsights(ref, cred, "2026-10-20' OR '1'='1", '2026-10-21')).rejects.toThrow(/Rango de fechas/);
  });

  it('pausa y reanuda con el nombre de recurso correcto de cada nivel', async () => {
    const g = fakeGoogle();
    const p = new GoogleAdsProvider(GOOGLE_CFG, g.fn);
    const cred = encodeGoogleCredential('refresh-g', '9990009999');
    const ref = { externalId: '5550005555', currency: 'COP' };
    await p.setStatus(ref, cred, 'CAMPAIGN', '201', 'PAUSED');
    await p.setStatus(ref, cred, 'ADSET', '301', 'ACTIVE');
    await p.setStatus(ref, cred, 'AD', '301~401', 'PAUSED');
    const muts = g.calls.filter((c) => c.url.includes(':mutate'));
    expect(muts.map((c) => [c.url.split('/').pop(), JSON.parse(c.init.body).operations[0]])).toEqual([
      ['campaigns:mutate', { updateMask: 'status', update: { resourceName: 'customers/5550005555/campaigns/201', status: 'PAUSED' } }],
      ['adGroups:mutate', { updateMask: 'status', update: { resourceName: 'customers/5550005555/adGroups/301', status: 'ENABLED' } }],
      ['adGroupAds:mutate', { updateMask: 'status', update: { resourceName: 'customers/5550005555/adGroupAds/301~401', status: 'PAUSED' } }],
    ]);
    expect(muts.every((c) => c.init.headers['login-customer-id'] === '9990009999')).toBe(true);
    await expect(p.setStatus(ref, cred, 'AD', '401', 'PAUSED')).rejects.toThrow(/inválido/);
  });

  it('sin configuración no llama a Google; los errores se traducen; la credencial se lee bien', async () => {
    const g = fakeGoogle();
    const none = new GoogleAdsProvider(async () => null, g.fn);
    expect(await none.missingConfigAsync()).toHaveLength(2);
    await expect(none.listAccounts('x')).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    expect(g.calls).toHaveLength(0);
    expect(classifyGoogleError({ error: { status: 'PERMISSION_DENIED', details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' } }] }] } }, 403).kind).toBe('NOT_CONFIGURED');
    expect(classifyGoogleError({ error: { status: 'UNAUTHENTICATED' } }, 401).kind).toBe('AUTH');
    expect(classifyGoogleError({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429).kind).toBe('RATE_LIMIT');
    expect(decodeGoogleCredential(encodeGoogleCredential('r1', '123'))).toEqual({ refresh: 'r1', login: '123' });
    expect(decodeGoogleCredential('solo-refresh')).toEqual({ refresh: 'solo-refresh', login: null });
  });
});

/* ── TikTok simulado ── */

function fakeTikTok() {
  const calls: Array<{ url: string; init: any }> = [];
  const ok = (data: any) => res({ code: 0, message: 'OK', data });
  const fn = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const path = u.pathname.replace('/open_api/v1.3', '');
    if (path === '/oauth2/access_token/') return ok({ access_token: 'tt-token', advertiser_ids: ['7001'] });
    if (path === '/oauth2/advertiser/get/') return ok({ list: [{ advertiser_id: '7001', advertiser_name: 'Constructora TikTok' }] });
    if (path === '/advertiser/info/') return ok({ list: [{ advertiser_id: '7001', name: 'Constructora TikTok', currency: 'COP', display_timezone: 'America/Bogota', status: 'STATUS_ENABLE' }] });
    if (path === '/campaign/get/') return ok({ list: [{ campaign_id: '801', campaign_name: 'Remodela tu baño', operation_status: 'ENABLE', objective_type: 'LEAD_GENERATION', budget_mode: 'BUDGET_MODE_DAY', budget: 40000 }], page_info: { page: 1, total_page: 1 } });
    if (path === '/adgroup/get/') return ok({ list: [{ adgroup_id: '802', adgroup_name: 'Medellín', campaign_id: '801', operation_status: 'DISABLE' }], page_info: { page: 1, total_page: 1 } });
    if (path === '/ad/get/') return ok({ list: [{ ad_id: '803', ad_name: 'Video baño', adgroup_id: '802', campaign_id: '801', operation_status: 'ENABLE', secondary_status: 'AD_STATUS_DELIVERY_OK' }], page_info: { page: 1, total_page: 1 } });
    if (path === '/report/integrated/get/') {
      const page = Number(u.searchParams.get('page'));
      const row = (d: string, spend: string) => ({ dimensions: { ad_id: '803', stat_time_day: `${d} 00:00:00` }, metrics: { campaign_id: '801', adgroup_id: '802', spend, impressions: '2000', clicks: '30', reach: '1500', conversion: '4' } });
      return ok({ list: page === 1 ? [row('2026-10-20', '15000.5')] : [row('2026-10-21', '5000')], page_info: { page, total_page: 2 } });
    }
    if (/\/(campaign|adgroup|ad)\/status\/update\/$/.test(path)) return ok({});
    return res({ code: 40002, message: 'ruta inesperada' });
  };
  return { fn: fn as any, calls };
}

const TIKTOK_CFG = async () => ({ appId: 'app1', secret: 'tsecret' });

describe('TikTok Ads · contrato (Marketing API v1.3 simulada)', () => {
  it('cambia el código por el token, lista anunciantes con su moneda y zona horaria', async () => {
    const t = fakeTikTok();
    const p = new TikTokAdsProvider(TIKTOK_CFG, t.fn);
    expect(await p.exchangeCode('code-1')).toEqual({ accessToken: 'tt-token', advertiserIds: ['7001'] });
    expect(JSON.parse(t.calls[0].init.body)).toEqual({ app_id: 'app1', secret: 'tsecret', auth_code: 'code-1' });
    const accounts = await p.listAccounts('tt-token');
    expect(accounts).toEqual([{ externalId: '7001', name: 'Constructora TikTok', currency: 'COP', timezone: 'America/Bogota', active: true }]);
    expect(t.calls.filter((c) => c.url.includes('/advertiser/')).every((c) => c.init.headers['Access-Token'] === 'tt-token')).toBe(true);
  });

  it('trae campañas, grupos y anuncios con su estado y el reporte por día (todas las páginas)', async () => {
    const t = fakeTikTok();
    const p = new TikTokAdsProvider(TIKTOK_CFG, t.fn);
    const ref = { externalId: '7001', currency: 'COP' };
    const ents = await p.fetchEntities(ref, 'tt-token');
    expect(ents.map((e) => [e.level, e.externalId, e.status])).toEqual([['CAMPAIGN', '801', 'ACTIVE'], ['ADSET', '802', 'PAUSED'], ['AD', '803', 'ACTIVE']]);
    expect(ents[0]).toMatchObject({ dailyBudget: 40000, objective: 'TIKTOK_LEAD_GENERATION' });
    const rows = await p.fetchInsights(ref, 'tt-token', '2026-10-20', '2026-10-21');
    expect(rows).toEqual([
      expect.objectContaining({ externalId: '803', campaignExternalId: '801', adsetExternalId: '802', date: '2026-10-20', spend: 15000.5, reach: 1500, leads: 4 }),
      expect.objectContaining({ date: '2026-10-21', spend: 5000 }),
    ]);
    const report = new URL(t.calls.find((c) => c.url.includes('/report/integrated/get/'))!.url);
    expect(report.searchParams.get('report_type')).toBe('BASIC');
    expect(report.searchParams.get('data_level')).toBe('AUCTION_AD');
    expect(JSON.parse(report.searchParams.get('dimensions')!)).toEqual(['ad_id', 'stat_time_day']);
  });

  it('pausa y reanuda con la ruta y el cuerpo de cada nivel', async () => {
    const t = fakeTikTok();
    const p = new TikTokAdsProvider(TIKTOK_CFG, t.fn);
    const ref = { externalId: '7001', currency: 'COP' };
    await p.setStatus(ref, 'tt-token', 'CAMPAIGN', '801', 'PAUSED');
    await p.setStatus(ref, 'tt-token', 'ADSET', '802', 'ACTIVE');
    await p.setStatus(ref, 'tt-token', 'AD', '803', 'PAUSED');
    const ups = t.calls.filter((c) => c.url.includes('/status/update/'));
    expect(ups.map((c) => [new URL(c.url).pathname.replace('/open_api/v1.3', ''), JSON.parse(c.init.body)])).toEqual([
      ['/campaign/status/update/', { advertiser_id: '7001', campaign_ids: ['801'], operation_status: 'DISABLE' }],
      ['/adgroup/status/update/', { advertiser_id: '7001', adgroup_ids: ['802'], operation_status: 'ENABLE' }],
      ['/ad/status/update/', { advertiser_id: '7001', ad_ids: ['803'], operation_status: 'DISABLE' }],
    ]);
    expect(ups.every((c) => c.init.method === 'POST')).toBe(true);
  });

  it('sin configuración no llama; los errores con code ≠ 0 se traducen', async () => {
    const t = fakeTikTok();
    const none = new TikTokAdsProvider(async () => null, t.fn);
    expect(await none.missingConfigAsync()).toHaveLength(1);
    await expect(none.exchangeCode('x')).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    expect(t.calls).toHaveLength(0);
    expect(classifyTikTokError(40105, 'Access token is incorrect or has been revoked.').kind).toBe('AUTH');
    expect(classifyTikTokError(40100, 'Too many requests').kind).toBe('RATE_LIMIT');
    expect(classifyTikTokError(40001, 'No permission to operate advertiser').kind).toBe('PERMISSION');
    const bad = new TikTokAdsProvider(TIKTOK_CFG, (async () => res({ code: 40105, message: 'Access token is incorrect' })) as any);
    await expect(bad.listAccounts('t')).rejects.toBeInstanceOf(AdsProviderError);
  });
});

/* ── De punta a punta en BackOffice ── */

function world(fetchImpl: any, settings: Record<string, string>) {
  const { prisma, db } = createMockPrisma();
  db.company.push({ id: 'coA', name: 'Obras', planId: 'p1', currency: 'COP' }, { id: 'coB', name: 'Otra', planId: 'p1', currency: 'COP' });
  for (const [key, value] of Object.entries(settings)) db.platformSetting.push({ key, value });
  const svc = new AdsService(prisma as any, { log: jest.fn(async () => undefined) } as any);
  svc.fetchImpl = fetchImpl;
  return { svc, db };
}

describe('Ads · conectar Google Ads y TikTok Ads de punta a punta', () => {
  // Las credenciales reales del .env local no deben cambiar lo que se prueba
  const ENV_KEYS = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_API_VERSION', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TIKTOK_APP_ID', 'TIKTOK_APP_SECRET'];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterAll(() => { for (const k of ENV_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k]; });

  it('Google: sin habilitar lo dice; habilitado conecta, elige cuentas, sincroniza y pausa con confirmación', async () => {
    const off = world(fakeGoogle().fn, {});
    await expect(off.svc.oauthStartFor(A, 'GOOGLE')).rejects.toThrow(/todavía no está habilitado/);
    expect((await off.svc.providers(A)).find((p: any) => p.key === 'GOOGLE')).toMatchObject({ oauth: false, missing: expect.arrayContaining([expect.stringMatching(/Developer token/)]) });

    const g = fakeGoogle();
    const { svc, db } = world(g.fn, { GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_WEB_URL: 'https://app.test' });
    expect((await svc.providers(A)).find((p: any) => p.key === 'GOOGLE')).toMatchObject({ oauth: true, missing: [] });
    const start = await svc.oauthStartFor(A, 'GOOGLE');
    expect(start.url).toContain(encodeURIComponent('https://www.googleapis.com/auth/adwords'));
    // Vuelve de Google: las cuentas quedan por elegir y la credencial nunca va en la URL
    const back = await svc.oauthCallbackFor('GOOGLE', 'code-g', signState({ c: 'coA', u: 'uA', k: 'ads-google' }, process.env.JWT_SECRET ?? 'dev'));
    expect(back).toMatch(/\/app\/ads\?tab=cuentas&google=elegir$/);
    expect(back).not.toContain('refresh');
    expect((await svc.pending(A, undefined, 'GOOGLE')).map((a: any) => a.externalId)).toEqual(['1110001111', '5550005555']);
    // Otra empresa no ve lo pendiente de esta
    expect(await svc.pending(B, undefined, 'GOOGLE')).toEqual([]);
    const saved = await svc.selectPending(A, { externalIds: ['5550005555'] }, undefined, 'GOOGLE');
    expect(saved).toEqual([expect.objectContaining({ provider: 'GOOGLE', externalId: '5550005555', credential: 'Guardada cifrada · no se muestra' })]);
    const acc: any = db.adAccount.find((a: any) => a.provider === 'GOOGLE');
    expect(decodeGoogleCredential(decryptSecret(acc.tokenEnc))).toEqual({ refresh: 'refresh-g', login: '9990009999' });
    expect(JSON.stringify(saved)).not.toContain('refresh-g');

    const sync: any = await svc.syncNow(A, acc.id);
    expect(sync).toMatchObject({ ok: true, status: 'OK' });
    expect(db.adEntity.filter((e: any) => e.accountId === acc.id).map((e: any) => e.externalId).sort()).toEqual(['201', '301', '301~401']);
    expect(db.adInsightDaily.filter((r: any) => r.accountId === acc.id).length).toBeGreaterThan(0);

    const campaign: any = db.adEntity.find((e: any) => e.accountId === acc.id && e.level === 'CAMPAIGN');
    await expect(svc.setEntityStatus(A, campaign.id, { status: 'PAUSED' })).rejects.toThrow(/Confirma/);
    await svc.setEntityStatus(A, campaign.id, { status: 'PAUSED', confirm: true });
    expect(g.calls.some((c) => c.url.endsWith('/customers/5550005555/campaigns:mutate'))).toBe(true);
  });

  it('TikTok: estado firmado para otra plataforma no conecta; el correcto conecta y sincroniza', async () => {
    const t = fakeTikTok();
    const { svc, db } = world(t.fn, { TIKTOK_APP_ID: 'app1', TIKTOK_APP_SECRET: 'tsecret', PUBLIC_WEB_URL: 'https://app.test' });
    const start = await svc.oauthStartFor(A, 'TIKTOK');
    expect(start.url).toMatch(/^https:\/\/business-api\.tiktok\.com\/portal\/auth\?app_id=app1&state=.+&redirect_uri=/);
    expect(await svc.oauthCallbackFor('TIKTOK', 'c', signState({ c: 'coA', u: 'uA', k: 'ads-google' }, process.env.JWT_SECRET ?? 'dev'))).toMatch(/tiktok=error/);
    expect(await svc.oauthCallbackFor('TIKTOK', 'c', signState({ c: 'coA', u: 'uA', k: 'ads-tiktok' }, process.env.JWT_SECRET ?? 'dev'))).toMatch(/tiktok=elegir$/);
    await svc.selectPending(A, { externalIds: ['7001'] }, undefined, 'TIKTOK');
    const acc: any = db.adAccount.find((a: any) => a.provider === 'TIKTOK');
    expect(decryptSecret(acc.tokenEnc)).toBe('tt-token');
    await expect(svc.syncNow(A, acc.id)).resolves.toMatchObject({ ok: true });
    expect(db.adEntity.filter((e: any) => e.accountId === acc.id)).toHaveLength(3);
  });
});
