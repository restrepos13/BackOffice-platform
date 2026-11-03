import { AccountRef, AdLevel, AdsProvider, AdsProviderError, FetchLike, RemoteAccount, RemoteEntity, RemoteInsight } from './provider';

/**
 * TikTok Ads (Marketing API v1.3; rutas y métodos verificados contra el SDK
 * oficial tiktok/tiktok-business-api-sdk, oct-2026). Encabezado Access-Token.
 *  - GET  /oauth2/advertiser/get/        anunciantes autorizados
 *  - GET  /advertiser/info/              moneda y zona horaria
 *  - GET  /campaign/get/, /adgroup/get/, /ad/get/   (paginado)
 *  - GET  /report/integrated/get/        reporte BASIC por anuncio y día
 *  - POST /campaign|adgroup|ad/status/update/       ENABLE / DISABLE
 * Toda respuesta viene como { code, message, data }; code 0 = bien.
 *
 * La credencial guardada es el access token del anunciante (cifrado).
 * Solo lectura y pausar/reanudar. Crear campañas no está implementado.
 */

export interface TikTokAdsConfig { appId: string; secret: string }

export const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';
export const TIKTOK_AUTH_URL = 'https://business-api.tiktok.com/portal/auth';

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** ENABLE → ACTIVE (como el resto de BackOffice); DISABLE → PAUSED. */
const status = (s: unknown) => (s === 'ENABLE' ? 'ACTIVE' : s === 'DISABLE' ? 'PAUSED' : s ? String(s) : null);

export function classifyTikTokError(code: number, message: string): AdsProviderError {
  const m = String(message ?? '').slice(0, 300) || `TikTok respondió el código ${code}`;
  if (/access[_ ]?token|token (is )?(invalid|expired)|unauthori[sz]ed|auth_code/i.test(m)) return new AdsProviderError('AUTH', 'La autorización de TikTok venció o fue retirada: vuelve a conectar la cuenta.', code);
  if (/permission|no access|not authorized|scope/i.test(m)) return new AdsProviderError('PERMISSION', 'Tu usuario de TikTok no tiene permiso suficiente en esa cuenta publicitaria.', code);
  if (/too many|rate|frequency|qps|limit exceeded/i.test(m)) return new AdsProviderError('RATE_LIMIT', 'TikTok pidió esperar un momento (límite de consultas).', code);
  return new AdsProviderError('PROVIDER', m, code);
}

export class TikTokAdsProvider implements AdsProvider {
  readonly key = 'TIKTOK' as const;
  readonly label = 'TikTok Ads';
  readonly demo = false;
  readonly capabilities = { read: true, insights: true, pause: true, resume: true, createCampaign: false, setBudget: false, conversions: true };

  constructor(private readonly config: () => Promise<TikTokAdsConfig | null>, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as any) {}

  missingConfig(): string[] {
    return [];
  }

  async missingConfigAsync(): Promise<string[]> {
    const c = await this.config();
    return c?.appId && c?.secret ? [] : ['App de TikTok for Business con acceso a la Marketing API (TIKTOK_APP_ID / TIKTOK_APP_SECRET)'];
  }

  private async cfg() {
    const c = await this.config();
    if (!c?.appId || !c?.secret) throw new AdsProviderError('NOT_CONFIGURED', 'TikTok Ads todavía no está habilitado en BackOffice.');
    return c;
  }

  private async call(token: string | null, path: string, init: { method: 'GET' | 'POST'; query?: Record<string, unknown>; body?: unknown }) {
    const qs = init.query ? `?${new URLSearchParams(Object.entries(init.query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))}` : '';
    let res;
    try {
      res = await this.fetchImpl(`${TIKTOK_API}${path}${qs}`, {
        method: init.method,
        headers: { ...(token ? { 'Access-Token': token } : {}), 'Content-Type': 'application/json' },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new AdsProviderError('PROVIDER', 'No hubo conexión con TikTok.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status === 429) throw new AdsProviderError('RATE_LIMIT', 'TikTok pidió esperar un momento (límite de consultas).', 429);
    if (!res.ok || Number(body?.code) !== 0) throw classifyTikTokError(Number(body?.code ?? res.status), body?.message);
    return body.data ?? {};
  }

  /** Recorre todas las páginas de un listado de TikTok. */
  private async all(token: string, path: string, query: Record<string, unknown>) {
    const out: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const d = await this.call(token, path, { method: 'GET', query: { ...query, page, page_size: 1000 } });
      out.push(...(d?.list ?? []));
      const total = Number(d?.page_info?.total_page ?? 1);
      if (page >= total) return out;
    }
    throw new AdsProviderError('INCOMPLETE', 'TikTok devolvió más resultados de los que se pudieron leer.');
  }

  /** Cambia el código de autorización por el token del anunciante (al conectar). */
  async exchangeCode(authCode: string): Promise<{ accessToken: string; advertiserIds: string[] }> {
    const c = await this.cfg();
    const d = await this.call(null, '/oauth2/access_token/', { method: 'POST', body: { app_id: c.appId, secret: c.secret, auth_code: authCode } });
    if (!d?.access_token) throw new AdsProviderError('AUTH', 'TikTok no devolvió el token de acceso.');
    return { accessToken: String(d.access_token), advertiserIds: ((d.advertiser_ids ?? []) as unknown[]).map(String) };
  }

  async listAccounts(token: string): Promise<RemoteAccount[]> {
    const c = await this.cfg();
    const d = await this.call(token, '/oauth2/advertiser/get/', { method: 'GET', query: { app_id: c.appId, secret: c.secret } });
    const ids = ((d?.list ?? []) as any[]).map((a) => String(a.advertiser_id)).filter(Boolean).slice(0, 100);
    if (!ids.length) return [];
    const info = await this.call(token, '/advertiser/info/', { method: 'GET', query: { advertiser_ids: ids, fields: ['advertiser_id', 'name', 'currency', 'timezone', 'display_timezone', 'status'] } });
    const byId = new Map(((info?.list ?? []) as any[]).map((a) => [String(a.advertiser_id), a]));
    return ids.map((id) => {
      const a = byId.get(id) ?? {};
      return { externalId: id, name: String(a.name ?? (d.list as any[]).find((x) => String(x.advertiser_id) === id)?.advertiser_name ?? id), currency: String(a.currency ?? 'USD'), timezone: a.display_timezone ?? a.timezone ?? null, active: !a.status || /ENABLE|ACTIVE/.test(String(a.status)) };
    });
  }

  async fetchEntities(account: AccountRef, token: string): Promise<RemoteEntity[]> {
    const advertiser_id = account.externalId;
    const [campaigns, groups, ads] = await Promise.all([
      this.all(token, '/campaign/get/', { advertiser_id }),
      this.all(token, '/adgroup/get/', { advertiser_id }),
      this.all(token, '/ad/get/', { advertiser_id }),
    ]);
    const entity = (level: AdLevel, e: Partial<RemoteEntity> & { externalId: string; name: string }, raw: any): RemoteEntity => ({
      level, campaignExternalId: null, adsetExternalId: null, status: null, effectiveStatus: null, objective: null, dailyBudget: null, lifetimeBudget: null, issues: [], providerUpdatedAt: null, raw, ...e,
    });
    const budget = (r: any) => (r.budget_mode === 'BUDGET_MODE_DAY' ? { dailyBudget: money(r.budget) } : r.budget_mode === 'BUDGET_MODE_TOTAL' ? { lifetimeBudget: money(r.budget) } : {});
    return [
      ...campaigns.map((r) => entity('CAMPAIGN', {
        externalId: String(r.campaign_id), campaignExternalId: String(r.campaign_id), name: String(r.campaign_name ?? r.campaign_id).slice(0, 200),
        status: status(r.operation_status), effectiveStatus: r.secondary_status ? String(r.secondary_status) : status(r.operation_status),
        objective: r.objective_type ? `TIKTOK_${r.objective_type}` : null, providerUpdatedAt: r.modify_time ?? null, ...budget(r),
      }, r)),
      ...groups.map((r) => entity('ADSET', {
        externalId: String(r.adgroup_id), campaignExternalId: String(r.campaign_id ?? ''), adsetExternalId: String(r.adgroup_id),
        name: String(r.adgroup_name ?? r.adgroup_id).slice(0, 200), status: status(r.operation_status), effectiveStatus: r.secondary_status ? String(r.secondary_status) : status(r.operation_status),
        providerUpdatedAt: r.modify_time ?? null, ...budget(r),
      }, r)),
      ...ads.map((r) => entity('AD', {
        externalId: String(r.ad_id), campaignExternalId: String(r.campaign_id ?? ''), adsetExternalId: String(r.adgroup_id ?? ''),
        name: String(r.ad_name ?? r.ad_id).slice(0, 200), status: status(r.operation_status), effectiveStatus: r.secondary_status ? String(r.secondary_status) : status(r.operation_status),
        issues: /REJECT|NOT_APPROVED/i.test(String(r.secondary_status ?? '')) ? ['TikTok rechazó el anuncio en revisión'] : [], providerUpdatedAt: r.modify_time ?? null,
      }, r)),
    ];
  }

  async fetchInsights(account: AccountRef, token: string, since: string, until: string): Promise<RemoteInsight[]> {
    const rows = await this.all(token, '/report/integrated/get/', {
      advertiser_id: account.externalId,
      report_type: 'BASIC',
      data_level: 'AUCTION_AD',
      dimensions: ['ad_id', 'stat_time_day'],
      metrics: ['campaign_id', 'adgroup_id', 'spend', 'impressions', 'clicks', 'reach', 'conversion'],
      start_date: since,
      end_date: until,
    });
    return rows.map((r) => ({
      level: 'AD' as const,
      externalId: String(r.dimensions?.ad_id),
      campaignExternalId: r.metrics?.campaign_id ? String(r.metrics.campaign_id) : null,
      adsetExternalId: r.metrics?.adgroup_id ? String(r.metrics.adgroup_id) : null,
      date: String(r.dimensions?.stat_time_day ?? '').slice(0, 10),
      spend: num(r.metrics?.spend),
      impressions: num(r.metrics?.impressions),
      reach: num(r.metrics?.reach),
      clicks: num(r.metrics?.clicks),
      linkClicks: num(r.metrics?.clicks),
      // «conversion» = el evento de optimización configurado en TikTok (registro, mensaje, compra…)
      leads: Math.round(num(r.metrics?.conversion)),
      conversations: 0,
      purchases: 0,
      purchaseValue: 0,
      raw: { provider: 'TIKTOK' },
    })).filter((r) => r.externalId && r.externalId !== 'undefined' && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  }

  async setStatus(account: AccountRef, token: string, level: AdLevel, externalId: string, target: 'ACTIVE' | 'PAUSED') {
    if (!/^\d{3,30}$/.test(externalId)) throw new AdsProviderError('NOT_FOUND', 'Identificador de TikTok inválido');
    const operation_status = target === 'ACTIVE' ? 'ENABLE' : 'DISABLE';
    const [path, field] = level === 'CAMPAIGN' ? ['/campaign/status/update/', 'campaign_ids'] : level === 'ADSET' ? ['/adgroup/status/update/', 'adgroup_ids'] : ['/ad/status/update/', 'ad_ids'];
    const d = await this.call(token, path, { method: 'POST', body: { advertiser_id: account.externalId, [field]: [externalId], operation_status } });
    return { status: operation_status, response: d ?? {} };
  }

  async createCampaignPaused(): Promise<never> {
    throw new AdsProviderError('NOT_SUPPORTED', 'Crear campañas en TikTok desde BackOffice todavía no está disponible: créala en TikTok Ads Manager y aquí la ves y la controlas.');
  }
}
