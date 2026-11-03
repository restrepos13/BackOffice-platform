import { MetaGraphClient } from './graph-client';

/**
 * Lecturas de la Marketing API (sin escrituras). Normaliza lo que Meta
 * devuelve sin inventar nada: un campo ausente queda en null, no en 0.
 * `data: []` es un resultado válido (lista vacía), no un error.
 */

export const ACCOUNT_FIELDS = 'id,account_id,name,account_status,currency,timezone_name';
export const CAMPAIGN_FIELDS = 'id,name,objective,status,effective_status';
export const ADSET_FIELDS = 'id,name,campaign_id,status,effective_status';
export const AD_FIELDS = 'id,name,adset_id,campaign_id,status,effective_status';
export const INSIGHT_FIELDS = 'campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,actions,date_start,date_stop';

export type ObjectLevel = 'ACCOUNT' | 'CAMPAIGN' | 'ADSET' | 'AD';

export interface MetaObject {
  level: ObjectLevel;
  externalId: string;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  campaignId: string | null;
  adsetId: string | null;
  currency: string | null;
  timezone: string | null;
  raw: Record<string, unknown>;
}

export interface MetaInsight {
  campaignId: string;
  campaignName: string | null;
  dateStart: string;
  dateStop: string;
  impressions: number | null;
  clicks: number | null;
  spend: number | null;
  cpc: number | null;
  cpm: number | null;
  ctr: number | null;
  reach: number | null;
  actions: Array<{ action_type: string; value: string }>;
  raw: Record<string, unknown>;
}

export const ACT_ID = /^act_\d{5,25}$/;

const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
/** Número tal como lo reporta Meta; null si no vino o no es un número. */
export const metric = (v: unknown): number | null => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v: unknown) => {
  const n = metric(v);
  return n === null ? null : Math.round(n);
};

/** Estados de cuenta de Meta (account_status). */
export const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};

function object(level: ObjectLevel, r: any): MetaObject {
  return {
    level,
    externalId: level === 'ACCOUNT' ? `act_${String(r.account_id ?? r.id).replace(/^act_/, '')}` : String(r.id),
    name: String(r.name ?? r.id ?? '').slice(0, 200),
    status: level === 'ACCOUNT' ? (r.account_status !== undefined ? ACCOUNT_STATUS[Number(r.account_status)] ?? String(r.account_status) : null) : str(r.status),
    effectiveStatus: str(r.effective_status),
    objective: str(r.objective),
    campaignId: level === 'CAMPAIGN' ? String(r.id) : str(r.campaign_id),
    adsetId: level === 'ADSET' ? String(r.id) : str(r.adset_id),
    currency: str(r.currency),
    timezone: str(r.timezone_name),
    raw: { ...r },
  };
}

export function insightFrom(r: any): MetaInsight | null {
  if (!r?.campaign_id || !r?.date_start) return null;
  return {
    campaignId: String(r.campaign_id),
    campaignName: str(r.campaign_name),
    dateStart: String(r.date_start),
    dateStop: String(r.date_stop ?? r.date_start),
    impressions: int(r.impressions),
    clicks: int(r.clicks),
    spend: metric(r.spend),
    cpc: metric(r.cpc),
    cpm: metric(r.cpm),
    ctr: metric(r.ctr),
    reach: int(r.reach),
    actions: Array.isArray(r.actions) ? r.actions.filter((a: any) => a?.action_type).map((a: any) => ({ action_type: String(a.action_type), value: String(a.value ?? '') })) : [],
    raw: { ...r },
  };
}

export class MetaAdsReader {
  constructor(private readonly client: MetaGraphClient) {}

  me() {
    return this.client.get('/me', { fields: 'id,name' });
  }

  async permissions(): Promise<{ granted: string[]; declined: string[] }> {
    const rows = await this.client.all('/me/permissions');
    const by = (s: string) => rows.filter((r) => r?.status === s && typeof r?.permission === 'string').map((r) => String(r.permission));
    return { granted: by('granted'), declined: [...by('declined'), ...by('expired')] };
  }

  async adAccounts(): Promise<MetaObject[]> {
    return (await this.client.all('/me/adaccounts', { fields: ACCOUNT_FIELDS, limit: '100' })).map((r) => object('ACCOUNT', r));
  }

  private checkAct(act: string) {
    if (!ACT_ID.test(act)) throw new Error('Cuenta publicitaria inválida (act_…)');
  }

  async campaigns(act: string) {
    this.checkAct(act);
    return (await this.client.all(`/${act}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: '200' })).map((r) => object('CAMPAIGN', r));
  }

  async adsets(act: string) {
    this.checkAct(act);
    return (await this.client.all(`/${act}/adsets`, { fields: ADSET_FIELDS, limit: '200' })).map((r) => object('ADSET', r));
  }

  async ads(act: string) {
    this.checkAct(act);
    return (await this.client.all(`/${act}/ads`, { fields: AD_FIELDS, limit: '200' })).map((r) => object('AD', r));
  }

  /** Insights por campaña y por día en el rango (fechas YYYY-MM-DD en la zona de la cuenta). */
  async campaignInsights(act: string, since: string, until: string) {
    this.checkAct(act);
    const rows = await this.client.all(`/${act}/insights`, {
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since, until }),
      fields: INSIGHT_FIELDS,
      limit: '500',
    });
    return rows.map(insightFrom).filter((r): r is MetaInsight => !!r);
  }
}
