import { toMinor, currencyOffset } from './provider';
import { LIMITS, parseAmount, slugify, zoneOffset, Gender } from './launch';

/**
 * Anuncio completo de un CLIENTE en su propia cuenta de Meta: campaña →
 * conjunto → creativo → anuncio, todo en PAUSA. Activar es otra decisión
 * (gasta dinero) y la toma una persona. A diferencia del lanzador del equipo,
 * el destino es el WhatsApp del negocio o SU web (reservas, pedidos).
 */

export type ClientGoal = 'WHATSAPP' | 'WEBSITE';

export const CLIENT_GOALS: Record<ClientGoal, { label: string; objective: string; optimization: string; destination: string; resultLabel: string }> = {
  WHATSAPP: { label: 'Mensajes por WhatsApp', objective: 'OUTCOME_ENGAGEMENT', optimization: 'CONVERSATIONS', destination: 'WHATSAPP', resultLabel: 'conversaciones' },
  WEBSITE: { label: 'Visitas a tu web (reservas o pedidos)', objective: 'OUTCOME_TRAFFIC', optimization: 'LINK_CLICKS', destination: 'WEBSITE', resultLabel: 'clics al enlace' },
};

/** Botones para anuncios que llevan a la web. */
export const CLIENT_CTAS: Record<string, string> = {
  ORDER_NOW: 'Pedir ahora',
  LEARN_MORE: 'Más información',
  SHOP_NOW: 'Comprar',
  CONTACT_US: 'Contáctanos',
  SIGN_UP: 'Registrarte',
};

export interface ClientDraft {
  name: string;
  goal: ClientGoal;
  websiteUrl?: string;
  dailyBudget: number;
  startDate?: string;
  endDate?: string;
  countries: string[];
  advantageAudience: boolean;
  ageMin: number;
  ageMax: number;
  gender: Gender;
  primaryText: string;
  headline: string;
  description?: string;
  cta: string;
}

export interface ClientContext {
  currency: string;
  timezone?: string | null;
  pageId?: string | null;
  instagramUserId?: string | null;
  maxDailyBudget?: number | null;
  today: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

export function clientDraftFrom(dto: any, currency = 'COP'): ClientDraft {
  const goal: ClientGoal = dto?.goal === 'WEBSITE' ? 'WEBSITE' : 'WHATSAPP';
  const countries = (Array.isArray(dto?.countries) ? dto.countries : String(dto?.countries ?? 'CO').split(','))
    .map((c: unknown) => String(c).trim().toUpperCase())
    .filter((c: string) => /^[A-Z]{2}$/.test(c));
  return {
    name: clip(dto?.name, LIMITS.name),
    goal,
    websiteUrl: goal === 'WEBSITE' ? clip(dto?.websiteUrl, 500) || undefined : undefined,
    dailyBudget: currencyOffset(currency) === 1 ? Math.round(parseAmount(dto?.dailyBudget, currency)) : parseAmount(dto?.dailyBudget, currency),
    startDate: DAY.test(String(dto?.startDate ?? '')) ? String(dto.startDate) : undefined,
    endDate: DAY.test(String(dto?.endDate ?? '')) ? String(dto.endDate) : undefined,
    countries: [...new Set<string>(countries)],
    advantageAudience: dto?.advantageAudience !== false,
    ageMin: Math.trunc(Number(dto?.ageMin ?? 18)),
    ageMax: Math.trunc(Number(dto?.ageMax ?? 65)),
    gender: ['MALE', 'FEMALE'].includes(dto?.gender) ? dto.gender : 'ALL',
    primaryText: clip(dto?.primaryText, LIMITS.primaryText + 1),
    headline: clip(dto?.headline, LIMITS.headline + 1),
    description: clip(dto?.description, LIMITS.description + 1) || undefined,
    cta: goal === 'WHATSAPP' ? 'WHATSAPP_MESSAGE' : String(dto?.cta ?? 'ORDER_NOW') in CLIENT_CTAS ? String(dto?.cta ?? 'ORDER_NOW') : '',
  };
}

/** Enlace de la web con UTM (para saber en Analytics qué vino de este anuncio). */
export function websiteLink(url: string, utmCampaign: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.searchParams.set('utm_source', 'meta');
    u.searchParams.set('utm_medium', 'paid');
    u.searchParams.set('utm_campaign', utmCampaign);
    return u.toString();
  } catch {
    return null;
  }
}

export function validateClientDraft(d: ClientDraft, ctx: ClientContext & { hasImage: boolean }): string[] {
  const e: string[] = [];
  if (d.name.length < 3) e.push('Ponle un nombre a la campaña (mínimo 3 caracteres)');
  if (!slugify(d.name)) e.push('El nombre necesita letras o números');
  if (!ctx.pageId) e.push('Elige la página de Facebook que publica el anuncio');
  if (!ctx.maxDailyBudget || ctx.maxDailyBudget <= 0) e.push('Define primero el tope de presupuesto diario de tu empresa');
  if (!(d.dailyBudget > 0)) e.push('El presupuesto diario debe ser mayor a 0');
  else if (ctx.maxDailyBudget && d.dailyBudget > ctx.maxDailyBudget) e.push(`El presupuesto diario supera tu tope (${ctx.maxDailyBudget.toLocaleString('es-CO')} ${ctx.currency})`);
  if (d.goal === 'WEBSITE') {
    if (!d.websiteUrl) e.push('Escribe la dirección de tu web (reservas o pedidos)');
    else if (!websiteLink(d.websiteUrl, 'x') || !/^https:\/\//i.test(d.websiteUrl)) e.push('La dirección de la web debe empezar por https://');
  }
  if (d.startDate && d.startDate < ctx.today) e.push('La fecha de inicio ya pasó');
  if (d.endDate && d.endDate <= (d.startDate ?? ctx.today)) e.push('La fecha de fin debe ser al menos un día después del inicio');
  if (!d.countries.length) e.push('Elige al menos un país');
  if (d.countries.length > LIMITS.countries) e.push(`Máximo ${LIMITS.countries} países`);
  if (!Number.isInteger(d.ageMin) || d.ageMin < 18 || d.ageMin > 65) e.push('La edad mínima va de 18 a 65');
  if (d.advantageAudience) {
    if (d.ageMin > 25) e.push('Con público Advantage+ la edad mínima va de 18 a 25 (Meta amplía el resto)');
  } else if (!Number.isInteger(d.ageMax) || d.ageMax < d.ageMin || d.ageMax > 65) e.push('La edad máxima va de la mínima a 65');
  if (!d.primaryText) e.push('Escribe el texto principal del anuncio');
  else if (d.primaryText.length > LIMITS.primaryText) e.push(`El texto principal admite hasta ${LIMITS.primaryText} caracteres`);
  if (!d.headline) e.push('Escribe el título del anuncio');
  else if (d.headline.length > LIMITS.headline) e.push(`El título admite hasta ${LIMITS.headline} caracteres`);
  if (d.description && d.description.length > LIMITS.description) e.push(`La descripción admite hasta ${LIMITS.description} caracteres`);
  if (!d.cta) e.push('Elige el botón del anuncio');
  if (!ctx.hasImage) e.push('Sube la imagen del anuncio');
  return e;
}

/** Lo que se envía a Meta en cada paso (los ids anteriores los agrega quien ejecuta). */
export function buildClientLaunch(d: ClientDraft, ctx: ClientContext & { imageHash: string }) {
  const goal = CLIENT_GOALS[d.goal];
  const utmCampaign = slugify(d.name);
  const link = d.goal === 'WEBSITE' && d.websiteUrl ? websiteLink(d.websiteUrl, utmCampaign) : null;
  const offset = (day: string) => zoneOffset(ctx.timezone, day);
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: d.countries },
    age_min: d.ageMin,
    targeting_automation: { advantage_audience: d.advantageAudience ? 1 : 0 },
  };
  if (!d.advantageAudience) {
    targeting.age_max = d.ageMax;
    if (d.gender !== 'ALL') targeting.genders = [d.gender === 'MALE' ? 1 : 2];
  }
  const linkData: Record<string, unknown> = d.goal === 'WHATSAPP'
    ? {
        link: 'https://api.whatsapp.com/send', message: d.primaryText, name: d.headline,
        ...(d.description ? { description: d.description } : {}), image_hash: ctx.imageHash,
        call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
      }
    : {
        link, message: d.primaryText, name: d.headline,
        ...(d.description ? { description: d.description } : {}), image_hash: ctx.imageHash,
        call_to_action: { type: d.cta, value: { link } },
      };
  return {
    utmCampaign,
    link,
    campaign: { name: d.name, objective: goal.objective, status: 'PAUSED', special_ad_categories: '[]', is_adset_budget_sharing_enabled: 'false' } as Record<string, string>,
    adset: {
      name: `${d.name} · conjunto`,
      daily_budget: String(toMinor(d.dailyBudget, ctx.currency)),
      billing_event: 'IMPRESSIONS',
      optimization_goal: goal.optimization,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      destination_type: goal.destination,
      ...(d.goal === 'WHATSAPP' ? { promoted_object: JSON.stringify({ page_id: ctx.pageId }) } : {}),
      targeting: JSON.stringify(targeting),
      ...(d.startDate ? { start_time: `${d.startDate}T00:00:00${offset(d.startDate)}` } : {}),
      ...(d.endDate ? { end_time: `${d.endDate}T23:59:00${offset(d.endDate)}` } : {}),
      status: 'PAUSED',
    } as Record<string, string>,
    creative: {
      name: `${d.name} · creativo`,
      object_story_spec: JSON.stringify({ page_id: ctx.pageId, ...(ctx.instagramUserId ? { instagram_user_id: ctx.instagramUserId } : {}), link_data: linkData }),
    } as Record<string, string>,
    ad: { name: `${d.name} · anuncio`, status: 'PAUSED' } as Record<string, string>,
  };
}

/**
 * Recomendaciones por código a partir del historial de la cuenta: costo por
 * resultado del mismo tipo, resultados esperados con un presupuesto y los
 * días de la semana que mejor rinden. Sin historial suficiente lo dice.
 */
export function planHints(
  rows: Array<{ date: string; spend: number; conversations: number; linkClicks: number }>,
  goal: ClientGoal,
  budget: number | null,
): { costPerResult: number | null; expected: { low: number; high: number } | null; bestDays: string[]; basis: string } {
  const field = goal === 'WHATSAPP' ? 'conversations' : 'linkClicks';
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const results = rows.reduce((s, r) => s + r[field], 0);
  const days = new Set(rows.map((r) => r.date)).size;
  if (results < 10 || days < 14) {
    return { costPerResult: null, expected: null, bestDays: [], basis: 'Tu cuenta todavía no tiene historial suficiente de este tipo de resultado (se necesitan 2 semanas y 10 resultados). Empieza con un presupuesto moderado y revisa la primera semana.' };
  }
  const cpr = spend / results;
  const expected = budget && budget > 0 ? { low: Math.max(0, Math.floor((budget / cpr) * 0.7)), high: Math.ceil((budget / cpr) * 1.3) } : null;
  const NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const byDay = Array.from({ length: 7 }, () => ({ spend: 0, results: 0 }));
  for (const r of rows) {
    const wd = new Date(`${r.date}T12:00:00Z`).getUTCDay();
    byDay[wd].spend += r.spend;
    byDay[wd].results += r[field];
  }
  const eff = byDay.map((d, i) => ({ day: NAMES[i], cpr: d.results ? d.spend / d.results : Infinity, results: d.results }));
  const ranked = eff.filter((d) => d.results >= 3).sort((a, b) => a.cpr - b.cpr);
  const bestDays = ranked.length >= 4 && ranked[0].cpr < cpr * 0.85 ? ranked.slice(0, 2).map((d) => d.day) : [];
  return {
    costPerResult: Math.round(cpr * 100) / 100,
    expected,
    bestDays,
    basis: `Calculado con tus últimos ${days} días: ${results} ${field === 'conversations' ? 'conversaciones' : 'clics'} por ${Math.round(spend).toLocaleString('es-CO')} de gasto. Es una estimación, no una promesa: Meta decide la entrega.`,
  };
}
