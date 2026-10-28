import { currencyOffset, toMinor } from './provider';

/**
 * Lanzamiento de campañas de BackOffice en Meta (solo equipo). Determinista:
 * valida el borrador y arma exactamente lo que se envía a Graph, siempre en
 * PAUSA. Activar es una decisión aparte (gasta dinero).
 *
 * Estructura que se crea: campaña → un conjunto → un creativo → un anuncio.
 * Parámetros verificados en la documentación de Meta (oct. 2026):
 *  - Registros: OUTCOME_TRAFFIC, destino WEBSITE, optimiza LINK_CLICKS.
 *  - WhatsApp: OUTCOME_ENGAGEMENT, destino WHATSAPP, optimiza CONVERSATIONS,
 *    promoted_object.page_id y CTA WHATSAPP_MESSAGE (la página debe estar
 *    vinculada al número de WhatsApp Business en el Business Manager).
 *  - Desde v23, targeting_automation.advantage_audience es obligatorio al
 *    crear; con Advantage+ la edad mínima va de 18 a 25 y la máxima es 65.
 */

export type LaunchGoal = 'SIGNUPS' | 'WHATSAPP';
export type Gender = 'ALL' | 'MALE' | 'FEMALE';

export const GOALS: Record<LaunchGoal, { label: string; objective: string; optimization: string; destination: string }> = {
  SIGNUPS: { label: 'Registros en la web', objective: 'OUTCOME_TRAFFIC', optimization: 'LINK_CLICKS', destination: 'WEBSITE' },
  WHATSAPP: { label: 'Conversaciones por WhatsApp', objective: 'OUTCOME_ENGAGEMENT', optimization: 'CONVERSATIONS', destination: 'WHATSAPP' },
};

/** Botones permitidos para anuncios que llevan a la web. */
export const WEB_CTAS: Record<string, string> = {
  SIGN_UP: 'Registrarte',
  LEARN_MORE: 'Más información',
  GET_QUOTE: 'Pedir cotización',
  CONTACT_US: 'Contáctanos',
};

export const LIMITS = { name: 120, primaryText: 600, headline: 100, description: 120, countries: 10 };

export interface LaunchDraft {
  name: string;
  goal: LaunchGoal;
  /** En unidades de la moneda de la cuenta (COP sin decimales). */
  dailyBudget: number;
  /** YYYY-MM-DD; vacío = arranca cuando se active. */
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
  imageHash: string;
}

export interface LaunchContext {
  currency: string;
  timezone?: string | null;
  pageId?: string | null;
  instagramUserId?: string | null;
  landingBase: string;
  maxDailyBudget?: number | null;
  /** Hoy en la zona horaria de la cuenta (YYYY-MM-DD). */
  today: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

export function slugify(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

/**
 * Monto escrito por una persona en la moneda de la cuenta. En monedas sin
 * decimales (COP) "50.000" y "50,000" son cincuenta mil; en las demás el
 * último separador es el decimal ("20.50" o "20,50").
 */
export function parseAmount(v: unknown, currency: string): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').replace(/[^\d.,]/g, '');
  if (!s) return 0;
  if (currencyOffset(currency) === 1) return Number(s.replace(/[.,]/g, '')) || 0;
  const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  const decimals = last >= 0 && s.length - last - 1 <= 2;
  const n = decimals ? `${s.slice(0, last).replace(/[.,]/g, '')}.${s.slice(last + 1)}` : s.replace(/[.,]/g, '');
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Normaliza lo que llega del navegador (nada de campos extra). */
export function draftFrom(dto: any, currency = 'COP'): LaunchDraft {
  const goal: LaunchGoal = dto?.goal === 'WHATSAPP' ? 'WHATSAPP' : 'SIGNUPS';
  const countries = (Array.isArray(dto?.countries) ? dto.countries : String(dto?.countries ?? 'CO').split(','))
    .map((c: unknown) => String(c).trim().toUpperCase())
    .filter((c: string) => /^[A-Z]{2}$/.test(c));
  const gender: Gender = ['MALE', 'FEMALE'].includes(dto?.gender) ? dto.gender : 'ALL';
  return {
    name: clip(dto?.name, LIMITS.name),
    goal,
    dailyBudget: currencyOffset(currency) === 1 ? Math.round(parseAmount(dto?.dailyBudget, currency)) : parseAmount(dto?.dailyBudget, currency),
    startDate: DAY.test(String(dto?.startDate ?? '')) ? String(dto.startDate) : undefined,
    endDate: DAY.test(String(dto?.endDate ?? '')) ? String(dto.endDate) : undefined,
    countries: [...new Set<string>(countries)],
    advantageAudience: dto?.advantageAudience !== false,
    ageMin: Math.trunc(Number(dto?.ageMin ?? 18)),
    ageMax: Math.trunc(Number(dto?.ageMax ?? 65)),
    gender,
    primaryText: clip(dto?.primaryText, LIMITS.primaryText + 1),
    headline: clip(dto?.headline, LIMITS.headline + 1),
    description: clip(dto?.description, LIMITS.description + 1) || undefined,
    cta: goal === 'WHATSAPP' ? 'WHATSAPP_MESSAGE' : String(dto?.cta ?? 'SIGN_UP') in WEB_CTAS ? String(dto?.cta ?? 'SIGN_UP') : '',
    imageHash: clip(dto?.imageHash, 80),
  };
}

export function validateLaunch(d: LaunchDraft, ctx: LaunchContext): string[] {
  const e: string[] = [];
  if (d.name.length < 3) e.push('Ponle un nombre a la campaña (mínimo 3 caracteres)');
  if (!slugify(d.name)) e.push('El nombre necesita letras o números (se usa para el enlace de seguimiento)');
  if (!ctx.pageId) e.push('Elige la página de Facebook que publica el anuncio (Configuración)');
  if (!ctx.maxDailyBudget || ctx.maxDailyBudget <= 0) e.push('Define primero el tope de presupuesto diario (Configuración)');
  if (!(d.dailyBudget > 0)) e.push('El presupuesto diario debe ser mayor a 0');
  else if (ctx.maxDailyBudget && d.dailyBudget > ctx.maxDailyBudget) e.push(`El presupuesto diario supera el tope (${ctx.maxDailyBudget.toLocaleString('es-CO')} ${ctx.currency})`);
  if (d.startDate && d.startDate < ctx.today) e.push('La fecha de inicio ya pasó');
  if (d.endDate) {
    const from = d.startDate ?? ctx.today;
    // Meta exige más de 24 h entre inicio y fin con presupuesto diario
    if (d.endDate <= from) e.push('La fecha de fin debe ser al menos un día después del inicio');
  }
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
  if (!d.imageHash) e.push('Sube la imagen del anuncio');
  return e;
}

/** Desfase de la zona horaria de la cuenta ese día, en formato +HHMM. */
export function zoneOffset(tz: string | null | undefined, day: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Bogota', timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? `${m[1]}${m[2]}${m[3]}` : '+0000';
  } catch {
    return '-0500';
  }
}

/** Hoy en la zona horaria de la cuenta. */
export function todayIn(tz: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Bogota' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function landingLink(base: string, utmCampaign: string) {
  return `${base.replace(/\/$/, '')}/registro?utm_source=meta&utm_medium=paid&utm_campaign=${utmCampaign}`;
}

/**
 * Lo que se envía a Meta en cada paso. Los ids de los pasos anteriores
 * (campaign_id, adset_id, creative_id) los agrega quien ejecuta.
 */
export function buildLaunch(d: LaunchDraft, ctx: LaunchContext) {
  const goal = GOALS[d.goal];
  const utmCampaign = slugify(d.name);
  const link = landingLink(ctx.landingBase, utmCampaign);
  const offset = (day: string) => zoneOffset(ctx.timezone, day);

  const targeting: Record<string, unknown> = {
    geo_locations: { countries: d.countries },
    age_min: d.ageMin,
    targeting_automation: { advantage_audience: d.advantageAudience ? 1 : 0 },
  };
  // Con Advantage+ Meta fija la edad máxima en 65 y trata el resto como sugerencia
  if (!d.advantageAudience) {
    targeting.age_max = d.ageMax;
    if (d.gender !== 'ALL') targeting.genders = [d.gender === 'MALE' ? 1 : 2];
  }

  const linkData: Record<string, unknown> = d.goal === 'WHATSAPP'
    ? {
        link: 'https://api.whatsapp.com/send',
        message: d.primaryText,
        name: d.headline,
        ...(d.description ? { description: d.description } : {}),
        image_hash: d.imageHash,
        call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
      }
    : {
        link,
        message: d.primaryText,
        name: d.headline,
        ...(d.description ? { description: d.description } : {}),
        image_hash: d.imageHash,
        call_to_action: { type: d.cta, value: { link } },
      };

  return {
    utmCampaign,
    link: d.goal === 'WHATSAPP' ? null : link,
    campaign: {
      name: d.name,
      objective: goal.objective,
      status: 'PAUSED',
      special_ad_categories: '[]',
      // Sin presupuesto de campaña, Meta exige decidir si los conjuntos lo comparten
      is_adset_budget_sharing_enabled: 'false',
    },
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
      object_story_spec: JSON.stringify({
        page_id: ctx.pageId,
        ...(ctx.instagramUserId ? { instagram_user_id: ctx.instagramUserId } : {}),
        link_data: linkData,
      }),
    } as Record<string, string>,
    ad: { name: `${d.name} · anuncio`, status: 'PAUSED' } as Record<string, string>,
  };
}
