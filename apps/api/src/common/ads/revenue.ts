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
