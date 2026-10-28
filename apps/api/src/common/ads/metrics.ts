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

/* ── Resultado según el objetivo ──
   Cada campaña persigue un tipo de resultado. Sumar leads + chats + compras de
   campañas con objetivos distintos da un "costo por resultado" que no mide
   nada. Aquí cada campaña cuenta solo su resultado principal; si un periodo
   mezcla tipos, el costo por resultado agregado queda sin calcular (y se dice
   por qué). */

export type ResultType = 'conversations' | 'leads' | 'purchases' | 'linkClicks' | 'none' | 'reported';

export const RESULT_LABEL: Record<ResultType, string> = {
  conversations: 'conversaciones iniciadas',
  leads: 'leads',
  purchases: 'compras',
  linkClicks: 'clics en el enlace',
  none: 'sin resultado (alcance o reconocimiento)',
  reported: 'resultados reportados (leads + conversaciones + compras)',
};

/** Objetivo de Meta (OUTCOME_* o los antiguos) → tipo de resultado principal. */
export function resultTypeFor(objective: string | null | undefined): ResultType {
  const o = String(objective ?? '').toUpperCase();
  if (/ENGAGEMENT|MESSAGES/.test(o)) return 'conversations';
  // En campañas de leads a WhatsApp/Messenger Meta reporta conversaciones: cuentan ambas
  if (/LEAD/.test(o)) return 'leads';
  if (/SALES|CONVERSIONS|PRODUCT_CATALOG/.test(o)) return 'purchases';
  if (/TRAFFIC|LINK_CLICKS/.test(o)) return 'linkClicks';
  if (/AWARENESS|REACH|BRAND|VIDEO_VIEWS/.test(o)) return 'none';
  return 'reported';
}

/** Resultados del tipo pedido sobre un total ya agregado. */
export function resultsOf(t: Totals, type: ResultType): number | null {
  switch (type) {
    case 'conversations': return t.conversations;
    case 'leads': return t.leads + t.conversations;
    case 'purchases': return t.purchases;
    case 'linkClicks': return t.linkClicks;
    case 'none': return null;
    default: return t.results;
  }
}

/** Totales de un elemento con su resultado principal y el costo de ese resultado. */
export function typedTotals(rows: InsightLike[], type: ResultType) {
  const t = totals(rows);
  const results = resultsOf(t, type);
  return {
    ...t,
    resultType: type,
    results: results ?? 0,
    resultsAvailable: results !== null,
    costPerResult: results ? r2(t.spend / results) : null,
  };
}

/**
 * Agregado de varias campañas: suma sus resultados principales solo si todas
 * comparten tipo. Con tipos distintos, `results` y `costPerResult` son null.
 */
export function mixedTotals(rows: InsightLike[], typeOfCampaign: (campaignExternalId: string | null | undefined) => ResultType) {
  const t = totals(rows);
  const types = new Set<ResultType>();
  let results = 0;
  for (const [campaign, list] of groupBy(rows, (r) => r.campaignExternalId ?? '__none__')) {
    const type = typeOfCampaign(campaign === '__none__' ? null : campaign);
    if (totals(list).spend <= 0 && totals(list).impressions <= 0) continue;
    types.add(type);
    results += resultsOf(totals(list), type) ?? 0;
  }
  const single = types.size === 1 ? [...types][0] : null;
  const comparable = !!single && single !== 'none';
  return {
    ...t,
    resultTypes: [...types],
    resultType: single,
    results: comparable ? results : null,
    costPerResult: comparable && results ? r2(t.spend / results) : null,
    resultNote: types.size > 1
      ? `El periodo mezcla campañas con objetivos distintos (${[...types].map((x) => RESULT_LABEL[x]).join(', ')}): no hay un costo por resultado único. Míralo por campaña.`
      : single === 'none' ? 'Campañas de alcance o reconocimiento: no persiguen un resultado medible por costo.' : null,
  };
}

/* ── Alcance y frecuencia ──
   El alcance son personas únicas: no se puede sumar día a día. Solo se
   muestra cuando la plataforma lo reportó para ese mismo periodo. */

export interface PeriodStat { since: string; until: string; reach: number; impressions: number; frequency: number | null }

export function periodStatFor(json: string | null | undefined, p: { since: string; until: string }): PeriodStat | null {
  if (!json) return null;
  try {
    const list = JSON.parse(json) as PeriodStat[];
    return (Array.isArray(list) ? list : []).find((s) => s.since === p.since && s.until === p.until) ?? null;
  } catch {
    return null;
  }
}

/**
 * Variaciones solo entre periodos comparables: el anterior debe tener datos
 * en casi todos sus días (≥ 80 % de los del actual). Si no, null con motivo.
 */
export function comparable(now: { days: number }, before: { days: number }): { ok: boolean; reason: string | null } {
  if (before.days === 0) return { ok: false, reason: 'No hay datos del periodo anterior para comparar.' };
  if (before.days < Math.ceil(now.days * 0.8)) return { ok: false, reason: `El periodo anterior tiene datos de ${before.days} días y el actual de ${now.days}: no son comparables.` };
  return { ok: true, reason: null };
}
