import { slugify, zoneOffset, todayIn } from './launch';

/**
 * Pauta propia de BackOffice (panel de plataforma → Publicidad → Resultados).
 * Funciones puras: atribución de registros a campañas y anuncios de Meta,
 * embudo, métricas derivadas, ritmo de gasto, estado de entrega y alertas.
 * El servicio (meta-ads.module.ts) trae los datos de Meta y de la base y
 * llama a esto. Nada de aquí hace red ni toca la base.
 */

/* ── Fechas: siempre en la zona horaria de la cuenta ─────────────────── */

export type RangePreset = 'today' | '7' | '14' | '30' | 'custom';
export interface DateRange {
  preset: RangePreset;
  since: string;
  until: string;
  days: number;
  timezone: string;
  /** Límites en UTC para filtrar la base: [start, end) */
  start: Date;
  end: Date;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400e3);
}

/** Inicio del día `day` en la zona `tz`, como instante UTC. */
export function startOfDayIn(day: string, tz: string): Date {
  return new Date(`${day}T00:00:00${zoneOffset(tz, day)}`);
}

/** Día (YYYY-MM-DD) de un instante, en la zona `tz` (Intl, nunca toISOString). */
export function dayIn(at: Date, tz: string): string {
  return todayIn(tz, at);
}

/**
 * Rango pedido por la pantalla: hoy, 7, 14 o 30 días terminando hoy (en la
 * zona de la cuenta), o uno personalizado de hasta 90 días.
 */
export function rangeFor(q: { range?: string; since?: string; until?: string }, tz: string, now = new Date()): DateRange {
  const today = todayIn(tz, now);
  const preset = (['today', '7', '14', '30', 'custom'].includes(String(q.range)) ? q.range : '30') as RangePreset;
  let since: string;
  let until = today;
  if (preset === 'custom' && DAY.test(String(q.since)) && DAY.test(String(q.until)) && String(q.since) <= String(q.until)) {
    until = String(q.until) > today ? today : String(q.until);
    since = String(q.since);
    if (daysBetween(since, until) > 89) since = addDaysIso(until, -89);
    if (since > until) since = until;
  } else {
    since = preset === 'today' ? today : addDaysIso(today, -(Number(preset === 'custom' ? 30 : preset) - 1));
  }
  const p: RangePreset = preset === 'custom' && !(DAY.test(String(q.since)) && DAY.test(String(q.until))) ? '30' : preset;
  return { preset: p, since, until, days: daysBetween(since, until) + 1, timezone: tz, start: startOfDayIn(since, tz), end: startOfDayIn(addDaysIso(until, 1), tz) };
}

/* ── Utilidades ─────────────────────────────────────────────────────── */

/** Forma comparable de un utm o un nombre: «Prueba_3dias Registro» → «prueba-3dias-registro». */
export const norm = (s: unknown) => slugify(String(s ?? '').replace(/_/g, '-'));

/** División segura: con denominador 0 (o ausente) no hay valor, nunca Infinity ni 0. */
export function ratio(n: number, d: number, round = true): number | null {
  if (!(d > 0) || !Number.isFinite(n)) return null;
  const v = n / d;
  return round ? Math.round(v * 100) / 100 : v;
}

/** utm_* de una URL de destino (y de los parámetros extra que Meta agrega). */
export function utmFromUrl(url: unknown, urlTags?: unknown): { utmSource?: string; utmCampaign?: string; utmContent?: string; utmId?: string } {
  const out: Record<string, string> = {};
  const read = (qs: string) => {
    const p = new URLSearchParams(qs);
    for (const [k, dst] of [['utm_source', 'utmSource'], ['utm_campaign', 'utmCampaign'], ['utm_content', 'utmContent'], ['utm_id', 'utmId']] as const) {
      const v = p.get(k);
      // Los parámetros dinámicos ({{ad.name}}) no sirven para cruzar: los llena Meta en cada clic
      if (v && !/\{\{.*\}\}/.test(v) && !out[dst]) out[dst] = v;
    }
  };
  try {
    if (typeof url === 'string' && url) read(new URL(url).search);
  } catch {
    /* URL inválida: se ignora */
  }
  if (typeof urlTags === 'string' && urlTags) read(urlTags);
  return out;
}

/* ── Atribución ─────────────────────────────────────────────────────── */

export const META_SOURCES = ['facebook', 'instagram', 'fb', 'ig', 'meta', 'messenger'];

export interface SessionLite {
  id: string;
  createdAt: Date | string;
  step?: string | null;
  answers?: number | null;
  companyId?: string | null;
  businessName?: string | null;
  rubro?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmId?: string | null;
  fbclid?: string | null;
}

export function isFromMeta(s: SessionLite): boolean {
  return META_SOURCES.includes(String(s.utmSource ?? '').toLowerCase())
    || !!s.fbclid
    || /facebook\.com|fb\.com|instagram\.com|l\.instagram|lm\.facebook/i.test(String(s.referrer ?? ''));
}

export interface AttributionContext {
  campaigns: Array<{ id: string; name: string }>;
  ads: Array<{ id: string; name: string; campaignId: string; utmCampaign?: string; utmContent?: string }>;
  /** utm_campaign de los lanzamientos hechos desde el panel → id de campaña en Meta */
  launches: Array<{ campaignId: string; utmCampaign: string }>;
  /** Mapeo manual editable: id de campaña → utm_campaign que le pertenecen */
  mappings: Record<string, string[]>;
}

export type AttributionVia = 'UTM_ID' | 'LAUNCH' | 'MAPPING' | 'AD_LINK' | 'NAME';
export const VIA_LABEL: Record<AttributionVia, string> = {
  UTM_ID: 'utm_id = ID de la campaña',
  LAUNCH: 'lanzada desde el panel',
  MAPPING: 'asignación manual',
  AD_LINK: 'utm del enlace del anuncio en Meta',
  NAME: 'nombre de la campaña',
};

export interface Attribution {
  campaignId: string | null;
  adId: string | null;
  via: AttributionVia | null;
}

/**
 * A qué campaña (y anuncio) pertenece un registro. Orden, del más seguro al
 * menos:
 *  1. utm_id igual al ID de la campaña en Meta.
 *  2. utm_campaign de un lanzamiento hecho desde el panel.
 *  3. Asignación manual (campaña ↔ utm_campaign) guardada en Configuración.
 *  4. utm_campaign que trae el enlace de destino de un anuncio de esa campaña
 *     (leído de Meta): cubre las campañas creadas fuera del panel.
 *  5. utm_campaign igual al nombre de la campaña (normalizado).
 * Un utm_campaign que apunta a dos campañas distintas en el mismo paso no se
 * asigna a ninguna: queda «Sin atribuir» para que alguien lo decida.
 * El anuncio sale de utm_content: ID del anuncio, su nombre o el utm_content
 * de su enlace, siempre dentro de la campaña ya elegida.
 */
export function attributionResolver(ctx: AttributionContext) {
  const campaignIds = new Set(ctx.campaigns.map((c) => c.id));
  const index = (pairs: Array<[string, string]>) => {
    const m = new Map<string, Set<string>>();
    for (const [utm, id] of pairs) {
      const k = norm(utm);
      if (!k || !campaignIds.has(id)) continue;
      m.set(k, (m.get(k) ?? new Set()).add(id));
    }
    return m;
  };
  const steps: Array<[AttributionVia, Map<string, Set<string>>]> = [
    ['LAUNCH', index(ctx.launches.map((l) => [l.utmCampaign, l.campaignId]))],
    ['MAPPING', index(Object.entries(ctx.mappings).flatMap(([id, utms]) => (utms ?? []).map((u) => [u, id] as [string, string])))],
    ['AD_LINK', index(ctx.ads.filter((a) => a.utmCampaign).map((a) => [a.utmCampaign!, a.campaignId]))],
    ['NAME', index(ctx.campaigns.map((c) => [c.name, c.id]))],
  ];
  const adsOf = new Map<string, AttributionContext['ads']>();
  for (const a of ctx.ads) adsOf.set(a.campaignId, [...(adsOf.get(a.campaignId) ?? []), a]);

  const adFor = (campaignId: string, s: SessionLite): string | null => {
    const content = String(s.utmContent ?? '').trim();
    if (!content) return null;
    const list = adsOf.get(campaignId) ?? [];
    const byId = list.find((a) => a.id === content);
    if (byId) return byId.id;
    const k = norm(content);
    const hits = list.filter((a) => norm(a.name) === k || (a.utmContent && norm(a.utmContent) === k));
    return hits.length === 1 ? hits[0].id : null;
  };

  return (s: SessionLite): Attribution => {
    const utmId = String(s.utmId ?? '').trim();
    let campaignId: string | null = null;
    let via: AttributionVia | null = null;
    if (utmId && campaignIds.has(utmId)) {
      campaignId = utmId;
      via = 'UTM_ID';
    } else {
      const k = norm(s.utmCampaign);
      if (k) {
        for (const [step, map] of steps) {
          const ids = map.get(k);
          if (!ids) continue;
          if (ids.size === 1) {
            campaignId = [...ids][0];
            via = step;
          }
          break; // ambiguo en este paso: no se adivina con los siguientes
        }
      }
    }
    return { campaignId, adId: campaignId ? adFor(campaignId, s) : null, via };
  };
}

/* ── Embudo ─────────────────────────────────────────────────────────── */

const STEPS = ['STARTED', 'INTERVIEW', 'PREVIEW', 'ACCOUNT', 'DONE'];

export interface Funnel {
  /** Visitas a /registro (una por navegador) */
  visits: number;
  /** Empezaron a contar su negocio */
  started: number;
  /** Terminaron el registro */
  completed: number;
  /** Empresas creadas */
  companies: number;
  /** Empresas con al menos un pago aprobado */
  paying: number;
  /** Cobrado a esas empresas a la fecha (moneda de la cuenta) */
  revenue: number;
}

export const emptyFunnel = (): Funnel => ({ visits: 0, started: 0, completed: 0, companies: 0, paying: 0, revenue: 0 });

export function addToFunnel(f: Funnel, s: SessionLite, paid: Map<string, number>) {
  f.visits++;
  if (STEPS.indexOf(String(s.step ?? 'STARTED')) > 0 || (s.answers ?? 0) > 0) f.started++;
  if (s.step === 'DONE') f.completed++;
  if (s.companyId) {
    f.companies++;
    if (paid.has(s.companyId)) {
      f.paying++;
      f.revenue += paid.get(s.companyId)!;
    }
  }
}

export interface MetaNumbers {
  spend: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  linkClicks: number;
}

export function derived(spend: number, m: Pick<MetaNumbers, 'impressions' | 'linkClicks'>, f: Funnel) {
  return {
    ctr: ratio(m.linkClicks * 100, m.impressions),
    cpc: m.linkClicks > 0 ? Math.round(spend / m.linkClicks) : null,
    cpm: m.impressions > 0 ? Math.round((spend / m.impressions) * 1000) : null,
    // Sin gasto registrado no hay costo que mostrar (un «$0 por registro» engaña)
    costPerSignup: f.completed > 0 && spend > 0 ? Math.round(spend / f.completed) : null,
    cac: f.paying > 0 && spend > 0 ? Math.round(spend / f.paying) : null,
    roas: ratio(f.revenue, spend),
  };
}

/* ── Estado de entrega ──────────────────────────────────────────────── */

export type DeliveryCode = 'ACTIVE' | 'IN_REVIEW' | 'REJECTED' | 'NO_BUDGET' | 'ENDED' | 'PAUSED' | 'SCHEDULED' | 'ISSUES' | 'ARCHIVED';
export interface Delivery { code: DeliveryCode; label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info'; reason: string | null }

const DELIVERY: Record<DeliveryCode, [string, Delivery['tone']]> = {
  ACTIVE: ['Activa', 'ok'],
  IN_REVIEW: ['En revisión', 'info'],
  REJECTED: ['Rechazada', 'bad'],
  NO_BUDGET: ['Sin presupuesto', 'warn'],
  ENDED: ['Finalizada', 'neutral'],
  PAUSED: ['Pausada', 'neutral'],
  SCHEDULED: ['Programada', 'info'],
  ISSUES: ['Con problemas', 'warn'],
  ARCHIVED: ['Archivada', 'neutral'],
};

/** Motivo de rechazo que da Meta (ad_review_feedback / issues_info). */
export function rejectionReason(x: any): string | null {
  const fb = x?.ad_review_feedback;
  const fromFeedback = fb && typeof fb === 'object'
    ? Object.values(fb).flatMap((g: any) => (g && typeof g === 'object' ? Object.entries(g).map(([k, v]) => `${k}: ${v}`) : [])).join(' · ')
    : '';
  const issues = Array.isArray(x?.issues_info) ? x.issues_info.map((i: any) => i?.error_summary || i?.error_message).filter(Boolean).join(' · ') : '';
  const out = (fromFeedback || issues).trim();
  return out ? out.slice(0, 300) : null;
}

/**
 * Estado real de entrega a partir de effective_status, fechas y presupuesto.
 * `x` es la campaña o el anuncio tal como lo devuelve Meta.
 */
export function deliveryOf(x: any, opts: { now?: Date; endsAt?: string | null; startsAt?: string | null; budgetRemaining?: number | null } = {}): Delivery {
  const now = (opts.now ?? new Date()).getTime();
  const st = String(x?.effective_status ?? x?.status ?? '').toUpperCase();
  let code: DeliveryCode;
  if (st === 'DISAPPROVED') code = 'REJECTED';
  else if (['PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED'].includes(st)) code = 'IN_REVIEW';
  else if (st === 'PENDING_BILLING_INFO') code = 'NO_BUDGET';
  else if (['DELETED', 'ARCHIVED'].includes(st)) code = 'ARCHIVED';
  else if (st === 'WITH_ISSUES') code = 'ISSUES';
  else if (opts.endsAt && Date.parse(opts.endsAt) < now) code = 'ENDED';
  else if (['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(st)) code = 'PAUSED';
  else if (st === 'ACTIVE' && opts.budgetRemaining !== null && opts.budgetRemaining !== undefined && opts.budgetRemaining <= 0) code = 'NO_BUDGET';
  else if (st === 'ACTIVE' && opts.startsAt && Date.parse(opts.startsAt) > now) code = 'SCHEDULED';
  else if (st === 'ACTIVE') code = 'ACTIVE';
  else code = 'ISSUES';
  const [label, tone] = DELIVERY[code];
  return { code, label, tone, reason: code === 'REJECTED' || code === 'ISSUES' ? rejectionReason(x) : null };
}

/* ── Ritmo de gasto ─────────────────────────────────────────────────── */

export interface Pace {
  budgetType: 'DAILY' | 'LIFETIME' | null;
  budget: number | null;
  /** Gastado desde que empezó la campaña */
  spent: number;
  /** % del presupuesto total consumido (diario: sobre diario × días programados) */
  consumedPct: number | null;
  startDate: string | null;
  endDate: string | null;
  daysLeft: number | null;
  /** Proyección simple al cierre: gastado + promedio diario × días restantes (sin pasar el presupuesto total) */
  projected: number | null;
}

export function paceOf(input: {
  dailyBudget: number | null; lifetimeBudget: number | null; spent: number; startsAt: string | null; endsAt: string | null; tz: string; now?: Date;
}): Pace {
  const now = input.now ?? new Date();
  const today = todayIn(input.tz, now);
  const startDate = input.startsAt ? dayIn(new Date(input.startsAt), input.tz) : null;
  const endDate = input.endsAt ? dayIn(new Date(input.endsAt), input.tz) : null;
  const budgetType = input.lifetimeBudget ? 'LIFETIME' : input.dailyBudget ? 'DAILY' : null;
  const budget = input.lifetimeBudget || input.dailyBudget || null;
  const elapsed = startDate ? Math.max(1, Math.min(daysBetween(startDate, today) + 1, endDate ? daysBetween(startDate, endDate) + 1 : Infinity)) : null;
  const daysLeft = endDate ? Math.max(0, daysBetween(today, endDate) + (Date.parse(input.endsAt!) > now.getTime() ? 0 : -1)) : null;
  const total = budgetType === 'LIFETIME' ? budget
    : budgetType === 'DAILY' && startDate && endDate ? budget! * (daysBetween(startDate, endDate) + 1)
      : null;
  const avg = elapsed ? input.spent / elapsed : null;
  let projected = endDate && avg !== null ? Math.round(input.spent + avg * Math.max(0, daysLeft ?? 0)) : null;
  if (projected !== null && total) projected = Math.min(projected, Math.round(total));
  return {
    budgetType, budget, spent: Math.round(input.spent),
    consumedPct: total ? Math.round((input.spent / total) * 1000) / 10 : null,
    startDate, endDate, daysLeft: daysLeft !== null && daysLeft < 0 ? 0 : daysLeft, projected,
  };
}

/* ── Alertas ────────────────────────────────────────────────────────── */

export interface Thresholds {
  /** Gasto sin ningún registro completado (moneda de la cuenta) */
  spendWithoutSignup: number;
  maxFrequency: number;
  /** CTR del enlace mínimo, en % */
  minLinkCtr: number;
  /** Impresiones mínimas antes de juzgar el CTR */
  minImpressionsForCtr: number;
  /** Aviso cuando a la campaña le quedan menos de estas horas */
  endingHours: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { spendWithoutSignup: 50_000, maxFrequency: 3, minLinkCtr: 0.8, minImpressionsForCtr: 1000, endingHours: 24 };

export function cleanThresholds(raw: any, base: Thresholds = DEFAULT_THRESHOLDS): Thresholds {
  const num = (v: unknown, def: number, min: number, max: number) => {
    // Vacío o ausente = el valor que ya había (Number('') sería 0 y apagaría la alerta)
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return def;
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  return {
    spendWithoutSignup: Math.round(num(raw?.spendWithoutSignup, base.spendWithoutSignup, 0, 1e12)),
    maxFrequency: num(raw?.maxFrequency, base.maxFrequency, 1, 50),
    minLinkCtr: num(raw?.minLinkCtr, base.minLinkCtr, 0, 100),
    minImpressionsForCtr: Math.round(num(raw?.minImpressionsForCtr, base.minImpressionsForCtr, 0, 1e9)),
    endingHours: Math.round(num(raw?.endingHours, base.endingHours, 1, 24 * 30)),
  };
}

export interface Alert { kind: 'REJECTED' | 'SPEND_NO_SIGNUP' | 'FREQUENCY' | 'LOW_CTR' | 'ENDING'; severity: 'bad' | 'warn' | 'info'; title: string; detail: string; campaignId?: string; adId?: string }

export function alertsFor(rows: Array<{
  id: string; name: string; delivery: Delivery; spend: number; completed: number; frequency: number | null; impressions: number; ctr: number | null; endsAt: string | null; running: boolean;
  ads: Array<{ id: string; name: string; delivery: Delivery }>;
}>, t: Thresholds, money: (n: number) => string, now = new Date()): Alert[] {
  const out: Alert[] = [];
  for (const c of rows) {
    for (const a of c.ads) {
      if (a.delivery.code === 'REJECTED') {
        out.push({ kind: 'REJECTED', severity: 'bad', title: `Meta rechazó el anuncio «${a.name}»`, detail: a.delivery.reason ?? 'Revisa el anuncio en el Administrador de anuncios.', campaignId: c.id, adId: a.id });
      }
    }
    if (c.delivery.code === 'REJECTED') {
      out.push({ kind: 'REJECTED', severity: 'bad', title: `Meta rechazó la campaña «${c.name}»`, detail: c.delivery.reason ?? 'Revisa la campaña en el Administrador de anuncios.', campaignId: c.id });
    }
    if (t.spendWithoutSignup > 0 && c.spend >= t.spendWithoutSignup && c.completed === 0) {
      out.push({ kind: 'SPEND_NO_SIGNUP', severity: 'bad', title: `«${c.name}» gastó ${money(c.spend)} sin ningún registro`, detail: `El aviso salta desde ${money(t.spendWithoutSignup)} sin registros completados en el rango.`, campaignId: c.id });
    }
    if (c.frequency !== null && c.frequency > t.maxFrequency) {
      out.push({ kind: 'FREQUENCY', severity: 'warn', title: `«${c.name}»: cada persona vio el anuncio ${c.frequency.toLocaleString('es-CO', { maximumFractionDigits: 1 })} veces`, detail: `Por encima de ${t.maxFrequency}, el público se cansa y el costo sube. Considera ampliar el público o cambiar la pieza.`, campaignId: c.id });
    }
    if (c.ctr !== null && c.impressions >= t.minImpressionsForCtr && c.ctr < t.minLinkCtr) {
      out.push({ kind: 'LOW_CTR', severity: 'warn', title: `«${c.name}»: CTR del enlace de ${c.ctr.toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`, detail: `Por debajo del ${t.minLinkCtr.toLocaleString('es-CO')} % configurado: la pieza o el público no están conectando.`, campaignId: c.id });
    }
    if (c.running && c.endsAt) {
      const hours = (Date.parse(c.endsAt) - now.getTime()) / 36e5;
      if (hours > 0 && hours < t.endingHours) {
        out.push({ kind: 'ENDING', severity: 'info', title: `«${c.name}» termina en ${Math.max(1, Math.round(hours))} h`, detail: 'Si está funcionando, decide si la extiendes antes de que se apague.', campaignId: c.id });
      }
    }
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/* ── Insights de Meta ───────────────────────────────────────────────── */

const sumActions = (list: any, types: string[]) =>
  (Array.isArray(list) ? list : []).filter((a: any) => types.includes(String(a?.action_type))).reduce((s: number, a: any) => s + (Number(a?.value) || 0), 0);

/** Una fila de insights de Meta (cualquier nivel) a números. */
export function metaRow(r: any) {
  return {
    spend: Number(r?.spend) || 0,
    impressions: Number(r?.impressions) || 0,
    reach: Number(r?.reach) || 0,
    frequency: r?.frequency !== undefined && r?.frequency !== null && r?.frequency !== '' ? Math.round(Number(r.frequency) * 100) / 100 : null,
    linkClicks: Number(r?.inline_link_clicks) || sumActions(r?.actions, ['link_click']),
    video: {
      plays3s: sumActions(r?.actions, ['video_view']),
      p25: sumActions(r?.video_p25_watched_actions, ['video_view']),
      p50: sumActions(r?.video_p50_watched_actions, ['video_view']),
      p75: sumActions(r?.video_p75_watched_actions, ['video_view']),
      p100: sumActions(r?.video_p100_watched_actions, ['video_view']),
      thruplay: sumActions(r?.video_thruplay_watched_actions, ['video_view']),
    },
  };
}

export const INSIGHT_FIELDS = [
  'spend', 'impressions', 'reach', 'frequency', 'inline_link_clicks', 'actions',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions', 'video_thruplay_watched_actions',
].join(',');

/** Error de Meta en palabras: qué pasó y qué hacer. Nunca un 500. */
export function metaErrorKind(code: number, message: string): { kind: 'TOKEN' | 'PERMISSION' | 'ACCOUNT' | 'RATE_LIMIT' | 'OTHER'; message: string } {
  if (code === 190) return { kind: 'TOKEN', message: 'El token de Meta venció o fue revocado. Genera uno nuevo del usuario del sistema y vuelve a conectar la cuenta.' };
  if ([4, 17, 32, 613, 80000, 80004].includes(code)) return { kind: 'RATE_LIMIT', message: 'Meta pidió esperar unos minutos (límite de consultas). Los datos se vuelven a pedir solos.' };
  if (code === 10 || code === 200 || code === 294 || (code >= 200 && code < 300)) return { kind: 'PERMISSION', message: 'Al token le falta el permiso ads_read sobre esta cuenta publicitaria. Asígnale la cuenta al usuario del sistema y genera el token con ads_read.' };
  if (code === 100 && /does not exist|cannot be loaded|Unsupported get request|missing permissions/i.test(message)) return { kind: 'ACCOUNT', message: 'Meta no encuentra la cuenta publicitaria con este token: revisa el ID (act_…) y que el usuario del sistema tenga acceso a ella.' };
  return { kind: 'OTHER', message: `Meta respondió: ${message}`.slice(0, 300) };
}
