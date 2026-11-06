import { parseJson } from './constants';

/**
 * IA de prueba de BackOffice: la cadena de modelos con NUESTRAS llaves
 * (Gemini, Groq, Cerebras, OpenRouter) para que una empresa pruebe Creative,
 * Ads y los resúmenes antes de tener su propia IA (DeepInfra u OpenRouter).
 *
 *  - NUNCA está activa por defecto: la autoriza un dev o super admin, por
 *    empresa, con vencimiento y tope diario (Company.aiTrialJson). La empresa
 *    no puede escribir ese campo.
 *  - Si la empresa tiene IA propia, se usa esa; la de prueba es el respaldo.
 *  - Vencida o desactivada, todo sigue funcionando con el motor (sin IA).
 */

export interface AiTrial {
  until: string; // ISO
  dailyLimit: number;
  authorizedBy: string;
  authorizedAt: string;
  note?: string;
}

export const AI_TRIAL_DEFAULT_DAYS = 7;
export const AI_TRIAL_DEFAULT_DAILY = 30;
export const AI_TRIAL_MAX_DAYS = 60;
export const AI_TRIAL_MAX_DAILY = 300;

/** La autorización guardada (vigente o no). */
export function readAiTrial(company: { aiTrialJson?: string | null } | null | undefined): AiTrial | null {
  const raw = parseJson<Partial<AiTrial> | null>(company?.aiTrialJson, null);
  if (!raw || typeof raw.until !== 'string' || Number.isNaN(Date.parse(raw.until))) return null;
  const limit = Math.floor(Number(raw.dailyLimit));
  return {
    until: raw.until,
    dailyLimit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, AI_TRIAL_MAX_DAILY) : AI_TRIAL_DEFAULT_DAILY,
    authorizedBy: String(raw.authorizedBy ?? ''),
    authorizedAt: String(raw.authorizedAt ?? ''),
    ...(raw.note ? { note: String(raw.note).slice(0, 200) } : {}),
  };
}

/** La autorización solo si sigue vigente. */
export function activeAiTrial(company: { aiTrialJson?: string | null } | null | undefined, now = new Date()): AiTrial | null {
  const t = readAiTrial(company);
  return t && Date.parse(t.until) > now.getTime() ? t : null;
}

/** Lo que manda el dev al autorizar, validado (días y tope con límites). */
export function aiTrialFrom(dto: any, authorizedBy: string, now = new Date()): AiTrial {
  const days = Math.floor(Number(dto?.days ?? AI_TRIAL_DEFAULT_DAYS));
  const daily = Math.floor(Number(dto?.dailyLimit ?? AI_TRIAL_DEFAULT_DAILY));
  if (!Number.isFinite(days) || days < 1 || days > AI_TRIAL_MAX_DAYS) throw new RangeError(`Los días van de 1 a ${AI_TRIAL_MAX_DAYS}`);
  if (!Number.isFinite(daily) || daily < 1 || daily > AI_TRIAL_MAX_DAILY) throw new RangeError(`El tope diario va de 1 a ${AI_TRIAL_MAX_DAILY} usos`);
  const note = typeof dto?.note === 'string' ? dto.note.trim().slice(0, 200) : '';
  return {
    until: new Date(now.getTime() + days * 864e5).toISOString(),
    dailyLimit: daily,
    authorizedBy: authorizedBy.slice(0, 80),
    authorizedAt: now.toISOString(),
    ...(note ? { note } : {}),
  };
}

/** Lo que ve la empresa mientras usa la IA de prueba. */
export const AI_TRIAL_NOTICE =
  'Estás usando la IA de prueba de BackOffice: es gratis, tiene un límite de usos por día y vence. Para responder usa modelos de Google (Gemini), Groq, Cerebras y OpenRouter: les enviamos solo los datos de tu negocio y de la pieza (catálogo, textos, imagen), nunca conversaciones ni datos de tus clientes, y quitamos teléfonos, correos y documentos. Estos proveedores pueden usar lo que reciben para mejorar sus modelos.';
