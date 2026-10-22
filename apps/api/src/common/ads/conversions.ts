import { createHash } from 'crypto';

/**
 * Meta Conversions API — preparación de eventos (no se envía nada si la
 * empresa no lo habilitó con su dataset y su base legal).
 * Reglas: solo los datos mínimos, normalizados y con SHA-256 (requisito de
 * Meta para datos de usuario); nada de datos de otra empresa; sin consentimiento
 * registrado, el evento no se arma.
 */

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const normalizePhone = (p: string) => p.replace(/\D/g, '');
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export interface SaleEvent {
  eventName: 'Lead' | 'Purchase';
  eventId: string;
  eventTime: Date;
  value?: number;
  currency: string;
  phone?: string | null;
  email?: string | null;
  ctwaClid?: string | null;
  consent: boolean;
}

export function buildCapiEvent(e: SaleEvent): Record<string, unknown> | null {
  if (!e.consent) return null;
  const user: Record<string, unknown> = {};
  if (e.phone) user.ph = [sha256(normalizePhone(e.phone))];
  if (e.email) user.em = [sha256(normalizeEmail(e.email))];
  if (e.ctwaClid) user.ctwa_clid = e.ctwaClid;
  if (!Object.keys(user).length) return null;
  return {
    event_name: e.eventName,
    event_time: Math.floor(e.eventTime.getTime() / 1000),
    // event_id permite a Meta descartar duplicados si se reintenta
    event_id: e.eventId,
    action_source: e.ctwaClid ? 'business_messaging' : 'system_generated',
    ...(e.ctwaClid ? { messaging_channel: 'whatsapp' } : {}),
    user_data: user,
    ...(e.eventName === 'Purchase' && e.value ? { custom_data: { value: Math.round(e.value * 100) / 100, currency: e.currency } } : {}),
  };
}
