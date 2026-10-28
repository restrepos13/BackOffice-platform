/**
 * Revenue Intelligence: une anuncios con contactos, etapas y ventas del CRM.
 *
 * Evidencia que se acepta (y nada más):
 *  - El ID del anuncio que Meta envía en el primer mensaje de un chat que
 *    llegó por un anuncio de clic a WhatsApp (referral.source_id). Se guarda en
 *    Contact.originJson como primer origen. Eso es "atribución directa".
 * No se usan coincidencias débiles (nombre parecido, misma hora, etc.).
 * Un contacto con origen de anuncio cuyo ID no está entre los anuncios
 * sincronizados queda como "anuncio no identificado" (no se adivina).
 */

export interface ContactLike {
  id: string;
  stage: string;
  createdAt: Date;
  originJson: string | null;
}

export interface OrderLike {
  contactId: string | null;
  total: number | null;
  paymentStatus: string | null;
  status: string | null;
  createdAt: Date;
}

export interface StageInfo {
  /** Primera etapa del embudo (los que no avanzan) */
  first: string;
  won: Set<string>;
  lost: Set<string>;
}

export interface FunnelRow {
  campaignExternalId: string | null;
  campaignName: string;
  /** Gasto reportado por la plataforma en el periodo */
  spend: number;
  /** Leads que reporta la plataforma */
  platformResults: number;
  /** Contactos del CRM con origen en un anuncio de esta campaña */
  leads: number;
  qualified: number;
  customers: number;
  lost: number;
  sales: number;
  /** Ventas confirmadas en el CRM de esos contactos (pagadas o entregadas) */
  revenue: number;
  costPerLead: number | null;
  costPerQualified: number | null;
  cac: number | null;
  roas: number | null;
}

export const isConfirmedSale = (o: OrderLike) => o.status !== 'cancelado' && (o.paymentStatus === 'PAID' || o.status === 'entregado');

export function adIdOf(contact: { originJson: string | null }): string | null {
  if (!contact.originJson) return null;
  try {
    const o = JSON.parse(contact.originJson);
    return o?.kind === 'AD' && typeof o.sourceId === 'string' && o.sourceId ? o.sourceId : null;
  } catch {
    return null;
  }
}

export function revenueFunnel(input: {
  contacts: ContactLike[];
  orders: OrderLike[];
  ads: Array<{ externalId: string; campaignExternalId: string | null }>;
  campaigns: Array<{ externalId: string; name: string }>;
  spendByCampaign: Map<string, { spend: number; results: number }>;
  stages: StageInfo;
  since: Date;
  until: Date;
}) {
  const adToCampaign = new Map(input.ads.map((a) => [a.externalId, a.campaignExternalId]));
  const campaignName = new Map(input.campaigns.map((c) => [c.externalId, c.name]));
  const ordersByContact = new Map<string, OrderLike[]>();
  for (const o of input.orders) {
    if (!o.contactId || !isConfirmedSale(o)) continue;
    const l = ordersByContact.get(o.contactId) ?? [];
    l.push(o);
    ordersByContact.set(o.contactId, l);
  }

  const rows = new Map<string, FunnelRow>();
  const row = (key: string | null, name: string) => {
    const k = key ?? '__unknown__';
    if (!rows.has(k)) {
      const s = key ? input.spendByCampaign.get(key) : undefined;
      rows.set(k, {
        campaignExternalId: key, campaignName: name, spend: s?.spend ?? 0, platformResults: s?.results ?? 0,
        leads: 0, qualified: 0, customers: 0, lost: 0, sales: 0, revenue: 0, costPerLead: null, costPerQualified: null, cac: null, roas: null,
      });
    }
    return rows.get(k)!;
  };
  for (const [id, s] of input.spendByCampaign) if (s.spend > 0) row(id, campaignName.get(id) ?? id);

  let unattributedAds = 0;
  const seen = new Set<string>();
  for (const c of input.contacts) {
    if (seen.has(c.id)) continue; // un contacto cuenta una sola vez
    seen.add(c.id);
    if (c.createdAt < input.since || c.createdAt > input.until) continue;
    const adId = adIdOf(c);
    if (!adId) continue;
    const campaign = adToCampaign.get(adId);
    if (campaign === undefined) {
      unattributedAds++;
      continue;
    }
    const r = row(campaign, campaign ? campaignName.get(campaign) ?? campaign : 'Sin campaña');
    r.leads++;
    if (input.stages.won.has(c.stage)) r.customers++;
    if (input.stages.lost.has(c.stage)) r.lost++;
    if (c.stage !== input.stages.first && !input.stages.lost.has(c.stage)) r.qualified++;
    for (const o of ordersByContact.get(c.id) ?? []) {
      if (o.createdAt < c.createdAt) continue; // ventas anteriores al anuncio no se atribuyen
      r.sales++;
      r.revenue += Number(o.total) || 0;
    }
  }

  const list = [...rows.values()].map((r) => ({
    ...r,
    revenue: Math.round(r.revenue),
    costPerLead: r.leads && r.spend ? Math.round(r.spend / r.leads) : null,
    costPerQualified: r.qualified && r.spend ? Math.round(r.spend / r.qualified) : null,
    cac: r.customers && r.spend ? Math.round(r.spend / r.customers) : null,
    roas: r.spend && r.revenue ? Math.round((r.revenue / r.spend) * 100) / 100 : null,
  }));
  const sum = (k: keyof FunnelRow) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const spend = sum('spend');
  const revenue = sum('revenue');
  return {
    campaigns: list.sort((a, b) => b.spend - a.spend),
    totals: {
      spend, leads: sum('leads'), qualified: sum('qualified'), customers: sum('customers'), sales: sum('sales'), revenue,
      costPerLead: sum('leads') && spend ? Math.round(spend / sum('leads')) : null,
      costPerQualified: sum('qualified') && spend ? Math.round(spend / sum('qualified')) : null,
      cac: sum('customers') && spend ? Math.round(spend / sum('customers')) : null,
      roas: spend && revenue ? Math.round((revenue / spend) * 100) / 100 : null,
    },
    unattributedAds,
  };
}

/* ── Estado de atribución de cada contacto ──
   ATTRIBUTED: trae el ID de un anuncio que está en las cuentas sincronizadas
     (se conocen anuncio, conjunto y campaña).
   PARTIAL: hay evidencia de que vino de un anuncio, pero no alcanza para
     ubicarlo: el ID no está en las cuentas conectadas, o llegó solo el enlace
     o el identificador del clic, sin el ID del anuncio.
   UNATTRIBUTED: el origen dice "anuncio" o "publicación" sin ningún
     identificador utilizable.
   Los contactos con origen directo (o sin origen) no entran: no vinieron de
   un anuncio, así que no hay nada que atribuir. Nunca se usan fechas
   cercanas ni nombres parecidos. */

export type AttributionState = 'ATTRIBUTED' | 'PARTIAL' | 'UNATTRIBUTED';

export interface AttributionInfo {
  state: AttributionState;
  via: 'WHATSAPP_REFERRAL' | 'LEAD_FORM' | 'POST' | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  evidence: string;
}

export function attributionOf(
  contact: { originJson: string | null },
  ads: Map<string, { adsetExternalId: string | null; campaignExternalId: string | null }>,
): AttributionInfo | null {
  let o: any = null;
  try {
    o = contact.originJson ? JSON.parse(contact.originJson) : null;
  } catch {
    o = null;
  }
  if (!o || (o.kind !== 'AD' && o.kind !== 'POST')) return null;
  const via = o.via === 'LEAD_FORM' ? 'LEAD_FORM' : o.kind === 'POST' ? 'POST' : 'WHATSAPP_REFERRAL';
  const source = via === 'LEAD_FORM' ? 'formulario de Meta Lead Ads' : via === 'POST' ? 'publicación' : 'primer mensaje de WhatsApp (referral)';
  const adId = typeof o.sourceId === 'string' && o.sourceId ? o.sourceId : null;
  if (adId && ads.has(adId)) {
    const ad = ads.get(adId)!;
    return { state: 'ATTRIBUTED', via, adId, adsetId: ad.adsetExternalId, campaignId: ad.campaignExternalId, evidence: `ID del anuncio ${adId} en el ${source}, presente en la cuenta sincronizada.` };
  }
  if (adId) {
    return { state: 'PARTIAL', via, adId, adsetId: null, campaignId: null, evidence: `ID ${adId} en el ${source}, pero ese anuncio no está en las cuentas conectadas: no se sabe su campaña.` };
  }
  if (o.ctwaClid || o.sourceUrl) {
    return { state: 'PARTIAL', via, adId: null, adsetId: null, campaignId: null, evidence: `El ${source} trae ${o.ctwaClid ? 'el identificador del clic' : 'el enlace del anuncio'}, pero no el ID del anuncio.` };
  }
  return { state: 'UNATTRIBUTED', via, adId: null, adsetId: null, campaignId: null, evidence: `El origen dice ${via === 'POST' ? 'publicación' : 'anuncio'}, sin ningún identificador utilizable.` };
}
