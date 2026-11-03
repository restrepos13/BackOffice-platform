import { AccountRef, AdLevel, AdsProvider, AdsProviderError, FetchLike, RemoteAccount, RemoteEntity, RemoteInsight } from './provider';

/**
 * Google Ads (API REST, verificado contra la documentación oficial v26, oct-2026):
 *  - POST /vNN/customers/{id}/googleAds:search  (GAQL, páginas con nextPageToken)
 *  - GET  /vNN/customers:listAccessibleCustomers
 *  - POST /vNN/customers/{id}/{campaigns|adGroups|adGroupAds}:mutate  (estado)
 *  - Encabezados: Authorization (OAuth), developer-token y, si se entra por una
 *    cuenta administradora, login-customer-id.
 *
 * La credencial guardada por cuenta es el refresh token de OAuth (cifrado) más
 * la cuenta administradora por la que se llega, si aplica: {"r": "...", "l": "123"}.
 * El token de acceso se renueva aquí y vive solo en memoria.
 *
 * Solo lectura y pausar/reanudar. Crear campañas en Google no está implementado.
 * Los anuncios se identifican como «adGroupId~adId» (así los nombra Google).
 */

export interface GoogleAdsConfig {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  /** Versión de la API (p. ej. v26). Google retira cada versión ~1 año después. */
  version: string;
}

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Credencial de una cuenta: refresh token + cuenta administradora por la que se accede. */
export function encodeGoogleCredential(refreshToken: string, loginCustomerId?: string | null) {
  return JSON.stringify({ r: refreshToken, ...(loginCustomerId ? { l: loginCustomerId } : {}) });
}
export function decodeGoogleCredential(raw: string): { refresh: string; login: string | null } {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.r === 'string') return { refresh: v.r, login: typeof v.l === 'string' ? v.l : null };
  } catch { /* credencial antigua: solo el refresh token */ }
  return { refresh: raw, login: null };
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const micros = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v) / 1_000_000);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** ENABLED → ACTIVE (como el resto de BackOffice); PAUSED y REMOVED se conservan. */
const status = (s: unknown) => (s === 'ENABLED' ? 'ACTIVE' : s ? String(s) : null);

export function classifyGoogleError(body: any, httpStatus: number): AdsProviderError {
  const err = body?.error ?? body?.[0]?.error ?? {};
  const message = String(err.message ?? `Google Ads respondió ${httpStatus}`).slice(0, 300);
  const details = JSON.stringify(err.details ?? '');
  const code = String(err.status ?? httpStatus);
  if (httpStatus === 401 || /UNAUTHENTICATED|invalid_grant/.test(code + details)) return new AdsProviderError('AUTH', 'La autorización de Google venció o fue retirada: vuelve a conectar la cuenta.', code);
  if (/DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED/.test(details)) return new AdsProviderError('NOT_CONFIGURED', 'El developer token de BackOffice todavía no tiene acceso a cuentas reales (pide el acceso básico en el API Center).', code);
  if (httpStatus === 403 || /PERMISSION_DENIED|USER_PERMISSION_DENIED/.test(code + details)) return new AdsProviderError('PERMISSION', 'Tu usuario de Google no tiene permiso suficiente en esa cuenta de Google Ads.', code);
  if (httpStatus === 429 || /RESOURCE_EXHAUSTED/.test(code)) return new AdsProviderError('RATE_LIMIT', 'Google Ads pidió esperar un momento (límite de consultas).', code);
  if (httpStatus === 404) return new AdsProviderError('NOT_FOUND', message, code);
  return new AdsProviderError('PROVIDER', message, code);
}

export class GoogleAdsProvider implements AdsProvider {
  readonly key = 'GOOGLE' as const;
  readonly label = 'Google Ads';
  readonly demo = false;
  readonly capabilities = { read: true, insights: true, pause: true, resume: true, createCampaign: false, setBudget: false, conversions: true };
  private static access = new Map<string, { token: string; until: number }>();

  constructor(private readonly config: () => Promise<GoogleAdsConfig | null>, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as any, private readonly now = () => Date.now()) {}

  missingConfig(): string[] {
    return [];
  }

  /** Qué falta en la plataforma para conectar cuentas reales (vacío = listo). */
  async missingConfigAsync(): Promise<string[]> {
    const c = await this.config();
    const out: string[] = [];
    if (!c?.developerToken) out.push('Developer token de Google Ads (GOOGLE_ADS_DEVELOPER_TOKEN)');
    if (!c?.clientId || !c?.clientSecret) out.push('Cliente OAuth de Google con la API de Google Ads (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET o los de Google)');
    return out;
  }

  private async cfg(): Promise<GoogleAdsConfig> {
    const c = await this.config();
    if (!c?.developerToken || !c.clientId || !c.clientSecret) throw new AdsProviderError('NOT_CONFIGURED', 'Google Ads todavía no está habilitado en BackOffice.');
    return c;
  }

  private async accessToken(refresh: string): Promise<string> {
    const hit = GoogleAdsProvider.access.get(refresh);
    if (hit && hit.until > this.now() + 60_000) return hit.token;
    const c = await this.cfg();
    let res;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: refresh, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' }).toString(),
      });
    } catch {
      throw new AdsProviderError('PROVIDER', 'No hubo conexión con Google.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.access_token) throw new AdsProviderError('AUTH', 'La autorización de Google venció o fue retirada: vuelve a conectar la cuenta.', body?.error);
    if (GoogleAdsProvider.access.size > 2000) GoogleAdsProvider.access.clear();
    GoogleAdsProvider.access.set(refresh, { token: String(body.access_token), until: this.now() + (Number(body.expires_in) || 3600) * 1000 });
    return String(body.access_token);
  }

  private async call(credential: string, path: string, init: { method: 'GET' | 'POST'; body?: unknown; login?: string | null }) {
    const c = await this.cfg();
    const { refresh, login } = decodeGoogleCredential(credential);
    const token = await this.accessToken(refresh);
    const loginId = init.login === undefined ? login : init.login;
    let res;
    try {
      res = await this.fetchImpl(`https://googleads.googleapis.com/${c.version}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${token}`, 'developer-token': c.developerToken, 'Content-Type': 'application/json', ...(loginId ? { 'login-customer-id': loginId } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new AdsProviderError('PROVIDER', 'No hubo conexión con Google Ads.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw classifyGoogleError(body, res.status);
    return body;
  }

  /** GAQL con todas sus páginas. */
  private async search(credential: string, customerId: string, query: string, login?: string | null) {
    const out: any[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await this.call(credential, `/customers/${digits(customerId)}/googleAds:search`, { method: 'POST', body: { query, ...(pageToken ? { pageToken } : {}) }, login });
      out.push(...(r?.results ?? []));
      pageToken = r?.nextPageToken;
      if (!pageToken) return out;
    }
    throw new AdsProviderError('INCOMPLETE', 'Google Ads devolvió más resultados de los que se pudieron leer.');
  }

  /**
   * Cuentas que la persona puede ver: las suyas directas y, si es una cuenta
   * administradora (agencia), las cuentas cliente debajo de ella. Cada una
   * guarda por qué administradora se entra.
   */
  async listAccounts(credential: string): Promise<RemoteAccount[]> {
    const r = await this.call(credential, '/customers:listAccessibleCustomers', { method: 'GET', login: null });
    const ids = ((r?.resourceNames ?? []) as string[]).map((n) => digits(n.split('/').pop())).filter(Boolean).slice(0, 50);
    const out = new Map<string, RemoteAccount & { loginCustomerId?: string | null }>();
    for (const id of ids) {
      let rows: any[];
      try {
        rows = await this.search(credential, id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer', null);
      } catch (e) {
        if (e instanceof AdsProviderError && (e.kind === 'PERMISSION' || e.kind === 'NOT_FOUND')) continue;
        throw e;
      }
      const cust = rows[0]?.customer;
      if (!cust) continue;
      if (!cust.manager) {
        out.set(id, { externalId: id, name: String(cust.descriptiveName ?? id), currency: String(cust.currencyCode ?? 'USD'), timezone: cust.timeZone ?? null, active: cust.status === 'ENABLED', loginCustomerId: null });
        continue;
      }
      // Administradora: sus cuentas cliente (no administradoras), entrando por ella
      const clients = await this.search(credential, id, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'", id);
      for (const row of clients) {
        const cc = row?.customerClient;
        const cid = digits(cc?.id);
        if (!cid || out.has(cid)) continue;
        out.set(cid, { externalId: cid, name: String(cc.descriptiveName ?? cid), currency: String(cc.currencyCode ?? 'USD'), timezone: cc.timeZone ?? null, active: cc.status === 'ENABLED', loginCustomerId: id });
      }
    }
    return [...out.values()];
  }

  async fetchEntities(account: AccountRef, credential: string): Promise<RemoteEntity[]> {
    const id = account.externalId;
    const [campaigns, groups, ads] = await Promise.all([
      this.search(credential, id, "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'"),
      this.search(credential, id, "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'"),
      this.search(credential, id, "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'"),
    ]);
    const entity = (level: AdLevel, e: Partial<RemoteEntity> & { externalId: string; name: string }, raw: any): RemoteEntity => ({
      level, campaignExternalId: null, adsetExternalId: null, status: null, effectiveStatus: null, objective: null, dailyBudget: null, lifetimeBudget: null, issues: [], providerUpdatedAt: null, raw, ...e,
    });
    return [
      ...campaigns.map((r) => entity('CAMPAIGN', {
        externalId: String(r.campaign.id), campaignExternalId: String(r.campaign.id), name: String(r.campaign.name ?? r.campaign.id).slice(0, 200),
        status: status(r.campaign.status), effectiveStatus: r.campaign.primaryStatus ? String(r.campaign.primaryStatus) : status(r.campaign.status),
        objective: r.campaign.advertisingChannelType ? `GOOGLE_${r.campaign.advertisingChannelType}` : null, dailyBudget: micros(r.campaignBudget?.amountMicros),
      }, r)),
      ...groups.map((r) => entity('ADSET', {
        externalId: String(r.adGroup.id), campaignExternalId: String(r.campaign?.id ?? ''), adsetExternalId: String(r.adGroup.id),
        name: String(r.adGroup.name ?? r.adGroup.id).slice(0, 200), status: status(r.adGroup.status), effectiveStatus: status(r.adGroup.status),
      }, r)),
      ...ads.map((r) => entity('AD', {
        externalId: `${r.adGroup.id}~${r.adGroupAd.ad.id}`, campaignExternalId: String(r.campaign?.id ?? ''), adsetExternalId: String(r.adGroup.id),
        name: String(r.adGroupAd.ad.name || `Anuncio ${r.adGroupAd.ad.id}`).slice(0, 200), status: status(r.adGroupAd.status), effectiveStatus: status(r.adGroupAd.status),
        issues: r.adGroupAd.policySummary?.approvalStatus === 'DISAPPROVED' ? ['Google rechazó el anuncio por sus políticas'] : [],
      }, r)),
    ];
  }

  async fetchInsights(account: AccountRef, credential: string, since: string, until: string): Promise<RemoteInsight[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new AdsProviderError('PROVIDER', 'Rango de fechas inválido');
    const rows = await this.search(credential, account.externalId,
      `SELECT segments.date, ad_group_ad.ad.id, ad_group.id, campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM ad_group_ad WHERE segments.date BETWEEN '${since}' AND '${until}'`);
    return rows.map((r) => ({
      level: 'AD' as const,
      externalId: `${r.adGroup.id}~${r.adGroupAd.ad.id}`,
      campaignExternalId: r.campaign?.id ? String(r.campaign.id) : null,
      adsetExternalId: r.adGroup?.id ? String(r.adGroup.id) : null,
      date: String(r.segments.date),
      spend: micros(r.metrics?.costMicros) ?? 0,
      impressions: num(r.metrics?.impressions),
      reach: 0,
      clicks: num(r.metrics?.clicks),
      linkClicks: num(r.metrics?.clicks),
      // Google cuenta «conversiones» según lo que la cuenta tenga configurado (registros, llamadas, compras…)
      leads: Math.round(num(r.metrics?.conversions)),
      conversations: 0,
      purchases: 0,
      purchaseValue: num(r.metrics?.conversionsValue),
      raw: { provider: 'GOOGLE', conversions: num(r.metrics?.conversions) },
    }));
  }

  async setStatus(account: AccountRef, credential: string, level: AdLevel, externalId: string, target: 'ACTIVE' | 'PAUSED') {
    const cid = digits(account.externalId);
    const s = target === 'ACTIVE' ? 'ENABLED' : 'PAUSED';
    const [collection, resource] = level === 'CAMPAIGN'
      ? ['campaigns', `customers/${cid}/campaigns/${digits(externalId)}`]
      : level === 'ADSET'
        ? ['adGroups', `customers/${cid}/adGroups/${digits(externalId)}`]
        : ['adGroupAds', `customers/${cid}/adGroupAds/${externalId.split('~').map(digits).join('~')}`];
    if (level === 'AD' && !/^\d+~\d+$/.test(resource.split('/').pop()!)) throw new AdsProviderError('NOT_FOUND', 'Identificador de anuncio de Google inválido');
    const r = await this.call(credential, `/customers/${cid}/${collection}:mutate`, { method: 'POST', body: { operations: [{ updateMask: 'status', update: { resourceName: resource, status: s } }] } });
    return { resourceName: r?.results?.[0]?.resourceName ?? resource, status: s };
  }

  async createCampaignPaused(): Promise<never> {
    throw new AdsProviderError('NOT_SUPPORTED', 'Crear campañas en Google Ads desde BackOffice todavía no está disponible: créala en Google Ads y aquí la ves y la controlas.');
  }
}
