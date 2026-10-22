import { addDays } from './provider';

/**
 * Agregación de métricas reportadas por las plataformas. Todo es cálculo
 * determinista sobre filas diarias; nada se inventa: si un dato no está, la
 * métrica derivada queda en null (no en 0).
 */

export interface InsightLike {
  externalId: string;
  campaignExternalId?: string | null;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  conversations: number;
  purchases: number;
  purchaseValue: number;
}

export interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  conversations: number;
  purchases: number;
  purchaseValue: number;
  /** leads + conversaciones + compras (lo que la plataforma reporta como resultado) */
  results: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  costPerResult: number | null;
  costPerLead: number | null;
  /** ROAS reportado por la plataforma (valor de compras que ella atribuye / gasto) */
  platformRoas: number | null;
  days: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function totals(rows: InsightLike[]): Totals {
  const t = rows.reduce(
    (a, r) => {
      a.spend += r.spend; a.impressions += r.impressions; a.clicks += r.clicks; a.linkClicks += r.linkClicks;
      a.leads += r.leads; a.conversations += r.conversations; a.purchases += r.purchases; a.purchaseValue += r.purchaseValue;
      a.dates.add(r.date);
      return a;
    },
    { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0, dates: new Set<string>() },
  );
  const results = t.leads + t.conversations + t.purchases;
  return {
    spend: r2(t.spend), impressions: t.impressions, clicks: t.clicks, linkClicks: t.linkClicks,
    leads: t.leads, conversations: t.conversations, purchases: t.purchases, purchaseValue: r2(t.purchaseValue), results,
    ctr: t.impressions ? r2((t.clicks / t.impressions) * 100) : null,
    cpc: t.clicks ? r2(t.spend / t.clicks) : null,
    cpm: t.impressions ? r2((t.spend / t.impressions) * 1000) : null,
    costPerResult: results ? r2(t.spend / results) : null,
    costPerLead: t.leads + t.conversations ? r2(t.spend / (t.leads + t.conversations)) : null,
    platformRoas: t.spend && t.purchaseValue ? r2(t.purchaseValue / t.spend) : null,
    days: t.dates.size,
  };
}

/** Periodo actual y el anterior de igual duración, terminando en `until` (incluido). */
export function periods(until: string, days: number) {
  const curSince = addDays(until, -(days - 1));
  return {
    current: { since: curSince, until },
    previous: { since: addDays(curSince, -days), until: addDays(curSince, -1) },
  };
}

export const inRange = (d: string, p: { since: string; until: string }) => d >= p.since && d <= p.until;

export function groupBy<T>(rows: T[], key: (r: T) => string | null | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Variación porcentual; null si no hay base para comparar. */
export const delta = (cur: number | null, prev: number | null) => (cur === null || prev === null || prev === 0 ? null : r2(((cur - prev) / prev) * 100));

/** Serie diaria (para gráficas) con todos los días del rango, aunque no haya datos. */
export function daily(rows: InsightLike[], p: { since: string; until: string }) {
  const by = groupBy(rows, (r) => r.date);
  const out: Array<{ date: string; spend: number; results: number; clicks: number; impressions: number }> = [];
  for (let d = p.since; d <= p.until; d = addDays(d, 1)) {
    const t = totals(by.get(d) ?? []);
    out.push({ date: d, spend: t.spend, results: t.results, clicks: t.clicks, impressions: t.impressions });
  }
  return out;
}
