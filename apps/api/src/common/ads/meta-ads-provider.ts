import {
  AccountRef, AdLevel, AdsProvider, AdsProviderError, CampaignDraft, FetchLike, RemoteAccount, RemoteEntity, RemoteInsight, fromMinor,
} from './provider';

/**
 * Meta Marketing API (cuentas publicitarias). Distinto de la conexión de
 * páginas para publicar orgánico: pide ads_read / ads_management.
 * Versión configurable (META_ADS_API_VERSION) porque Meta retira versiones.
 */

export const META_ADS_SCOPES = ['ads_read', 'ads_management', 'business_management'];
export const metaAdsVersion = () => (process.env.META_ADS_API_VERSION || 'v24.0').replace(/[^v0-9.]/g, '');
const MAX_PAGES = 25;

const OBJECTIVES: Record<CampaignDraft['objective'], string> = {
  LEADS: 'OUTCOME_LEADS',
  MESSAGES: 'OUTCOME_ENGAGEMENT',
  TRAFFIC: 'OUTCOME_TRAFFIC',
  SALES: 'OUTCOME_SALES',
  AWARENESS: 'OUTCOME_AWARENESS',
  ENGAGEMENT: 'OUTCOME_ENGAGEMENT',
};

/** Mapea los códigos de error de Graph a categorías que la app sabe manejar. */
export function classifyMetaError(err: any, status: number): AdsProviderError {
  const code = Number(err?.code);
  const msg = String(err?.message ?? `Meta respondió ${status}`).slice(0, 300);
  if (code === 190 || status === 401) return new AdsProviderError('AUTH', 'La conexión con Meta venció o fue revocada. Vuelve a conectar la cuenta.', code);
  if ([4, 17, 32, 613, 80000, 80004].includes(code) || status === 429) return new AdsProviderError('RATE_LIMIT', 'Meta pidió esperar (límite de solicitudes). Se reintentará más tarde.', code);
  if (code === 10 || code === 200 || (code >= 200 && code < 300) || status === 403) return new AdsProviderError('PERMISSION', `Permisos insuficientes en Meta: ${msg}`, code);
  if (code === 100 && /does not exist|Unknown path/i.test(msg)) return new AdsProviderError('NOT_FOUND', msg, code);
  return new AdsProviderError('PROVIDER', `Meta: ${msg}`, code);
}

function sumActions(list: any[] | undefined, types: string[]): number {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const hit = list.find((a) => a?.action_type === t);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

/** Convierte una fila de insights de Meta (nivel anuncio, un día) al formato común. */
export function metaInsightRow(r: any): RemoteInsight {
  return {
    level: 'AD',
    externalId: String(r.ad_id),
    campaignExternalId: r.campaign_id ? String(r.campaign_id) : null,
    adsetExternalId: r.adset_id ? String(r.adset_id) : null,
    date: String(r.date_start),
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    reach: Number(r.reach) || 0,
    clicks: Number(r.clicks) || 0,
    linkClicks: Number(r.inline_link_clicks) || 0,
    // Se toma el agregado que Meta ya consolida para no contar dos veces
    leads: sumActions(r.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']),
    conversations: sumActions(r.actions, ['onsite_conversion.messaging_conversation_started_7d']),
    purchases: sumActions(r.actions, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']),
    purchaseValue: sumActions(r.action_values, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']),
    raw: { actions: r.actions ?? [], action_values: r.action_values ?? [], account_currency: r.account_currency },
  };
}

export class MetaAdsProvider implements AdsProvider {
  readonly key = 'META' as const;
  readonly label = 'Meta Ads';
  readonly demo = false;
  readonly capabilities = { read: true, insights: true, pause: true, resume: true, createCampaign: true, setBudget: false, conversions: false };

  constructor(private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as any, private readonly appConfigured: () => boolean = () => true) {}

  missingConfig() {
    return this.appConfigured() ? [] : ['META_APP_ID y META_APP_SECRET (app de Meta con ads_read / ads_management aprobados en App Review)'];
  }

  private url(path: string) {
    return `https://graph.facebook.com/${metaAdsVersion()}${path}`;
  }

  private async call(url: string, init?: any) {
    let res;
    try {
      res = await this.fetchImpl(url, init);
    } catch (e: any) {
      throw new AdsProviderError('PROVIDER', `No se pudo contactar a Meta: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw classifyMetaError(data?.error, res.status);
    return data;
  }

  private async get(path: string, token: string, params: Record<string, string>) {
    return this.call(`${this.url(path)}?${new URLSearchParams({ ...params, access_token: token })}`);
  }

  private async post(path: string, token: string, params: Record<string, string>) {
    return this.call(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, access_token: token }).toString(),
    });
  }

  /** Recorre todas las páginas (paging.next) con tope para no colgarse. */
  private async all(path: string, token: string, params: Record<string, string>): Promise<any[]> {
    const out: any[] = [];
    let page = await this.get(path, token, params);
    for (let i = 0; i < MAX_PAGES; i++) {
      out.push(...(page?.data ?? []));
      const next = page?.paging?.next;
      if (!next || typeof next !== 'string' || !next.startsWith('https://graph.facebook.com/')) break;
      page = await this.call(next);
    }
    return out;
  }

  async listAccounts(token: string): Promise<RemoteAccount[]> {
    const rows = await this.all('/me/adaccounts', token, { fields: 'account_id,name,currency,timezone_name,account_status', limit: '100' });
    return rows.map((r) => ({
      externalId: `act_${String(r.account_id).replace(/^act_/, '')}`,
      name: String(r.name ?? r.account_id),
      currency: String(r.currency ?? 'USD'),
      timezone: r.timezone_name ?? null,
      active: Number(r.account_status) === 1,
    }));
  }

  async fetchEntities(account: AccountRef, token: string): Promise<RemoteEntity[]> {
    const act = account.externalId;
    const [campaigns, adsets, ads] = await Promise.all([
      this.all(`/${act}/campaigns`, token, { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,updated_time', limit: '200' }),
      this.all(`/${act}/adsets`, token, { fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,updated_time', limit: '200' }),
      this.all(`/${act}/ads`, token, { fields: 'id,name,campaign_id,adset_id,status,effective_status,updated_time,issues_info,ad_review_feedback', limit: '200' }),
    ]);
    const base = (r: any, level: AdLevel): RemoteEntity => ({
      level,
      externalId: String(r.id),
      campaignExternalId: level === 'CAMPAIGN' ? String(r.id) : r.campaign_id ? String(r.campaign_id) : null,
      adsetExternalId: level === 'AD' && r.adset_id ? String(r.adset_id) : level === 'ADSET' ? String(r.id) : null,
      name: String(r.name ?? r.id).slice(0, 200),
      status: r.status ?? null,
      effectiveStatus: r.effective_status ?? null,
      objective: r.objective ?? r.optimization_goal ?? null,
      dailyBudget: fromMinor(r.daily_budget, account.currency),
      lifetimeBudget: fromMinor(r.lifetime_budget, account.currency),
      issues: [
        ...(Array.isArray(r.issues_info) ? r.issues_info.map((i: any) => String(i?.error_summary ?? i?.error_message ?? 'Problema de entrega')) : []),
        ...(r.ad_review_feedback?.global ? Object.values(r.ad_review_feedback.global).map((v) => String(v)) : []),
      ].slice(0, 10),
      providerUpdatedAt: r.updated_time ?? null,
      raw: { ...r },
    });
    return [...campaigns.map((r) => base(r, 'CAMPAIGN')), ...adsets.map((r) => base(r, 'ADSET')), ...ads.map((r) => base(r, 'AD'))];
  }

  async fetchInsights(account: AccountRef, token: string, since: string, until: string): Promise<RemoteInsight[]> {
    const rows = await this.all(`/${account.externalId}/insights`, token, {
      level: 'ad',
      time_increment: '1',
      time_range: JSON.stringify({ since, until }),
      fields: 'ad_id,adset_id,campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,account_currency,date_start',
      limit: '500',
    });
    return rows.map(metaInsightRow);
  }

  async setStatus(_account: AccountRef, token: string, _level: AdLevel, externalId: string, status: 'ACTIVE' | 'PAUSED') {
    if (!/^\d{5,30}$/.test(externalId)) throw new AdsProviderError('NOT_FOUND', 'Identificador de Meta inválido');
    const res = await this.post(`/${externalId}`, token, { status });
    return { success: res?.success ?? true };
  }

  async createCampaignPaused(account: AccountRef, token: string, draft: CampaignDraft) {
    const res = await this.post(`/${account.externalId}/campaigns`, token, {
      name: draft.name.slice(0, 200),
      objective: OBJECTIVES[draft.objective],
      // Siempre en pausa: activarla es una decisión aparte (gasta dinero)
      status: 'PAUSED',
      special_ad_categories: '[]',
      // Sin presupuesto de campaña, Meta exige definir si los conjuntos comparten presupuesto
      is_adset_budget_sharing_enabled: 'false',
    });
    if (!res?.id) throw new AdsProviderError('PROVIDER', 'Meta no devolvió el ID de la campaña');
    return { externalId: String(res.id), response: { id: String(res.id) } };
  }
}
