import { randomInt } from 'crypto';
import { GRAPH } from '../meta';
import { sanitizeError } from '../inbox/delivery';
import { MetaApiError, metaGraph } from './meta-templates';

/**
 * Conexión del número con el registro integrado de Meta (Embedded Signup),
 * sin intermediarios. El número y la cuenta de WhatsApp Business (WABA) quedan
 * en el Business Manager DE LA EMPRESA, con su medio de pago: Meta le cobra a
 * ella. BackOffice solo recibe un permiso (token de integración de negocio)
 * que la empresa puede quitar cuando quiera desde su Business Manager.
 *
 * Pasos después de que la empresa termina la ventana de Meta:
 *  1. Cambiar el código por el token de integración.
 *  2. Leer el número (cómo se ve, nombre verificado, calidad).
 *  3. Suscribir la app de BackOffice a la WABA, con la URL de webhooks de
 *     ESTA empresa (override_callback_uri): los mensajes llegan a su bandeja.
 *  4. Registrar el número en la Cloud API (PIN de verificación en dos pasos).
 *     Si el número ya estaba registrado, se sigue: no es un error para la empresa.
 */

type Fetch = typeof fetch;

export interface SignupSettings {
  appId: string;
  appSecret: string;
  configId: string;
}

/** Qué falta configurar para ofrecer el botón (sin mostrar valores). */
export function missingSignupSettings(s: Partial<SignupSettings>): string[] {
  const missing: string[] = [];
  if (!s.appId) missing.push('META_APP_ID');
  if (!s.appSecret) missing.push('META_APP_SECRET');
  if (!s.configId) missing.push('META_WA_CONFIG_ID');
  return missing;
}

export async function exchangeSignupCode(settings: SignupSettings, code: string, fetchImpl: Fetch = fetch): Promise<string> {
  const qs = new URLSearchParams({ client_id: settings.appId, client_secret: settings.appSecret, code });
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH}/oauth/access_token?${qs.toString()}`, { method: 'GET' });
  } catch (err) {
    throw new MetaApiError(`Sin respuesta de Meta: ${sanitizeError(err)}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw new MetaApiError(sanitizeError(`Meta no aceptó el código de conexión: ${data?.error?.message ?? res.status}`), res.status);
  }
  return String(data.access_token);
}

export interface PhoneInfo {
  displayPhone: string;
  verifiedName: string | null;
  quality: string | null;
}

export async function readPhoneNumber(token: string, phoneNumberId: string, fetchImpl: Fetch = fetch): Promise<PhoneInfo> {
  const d = await metaGraph('GET', `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, token, undefined, fetchImpl);
  return {
    displayPhone: String(d?.display_phone_number ?? ''),
    verifiedName: d?.verified_name ? String(d.verified_name) : null,
    quality: d?.quality_rating ? String(d.quality_rating) : null,
  };
}

export async function subscribeApp(token: string, wabaId: string, callback: { url: string; verifyToken: string } | null, fetchImpl: Fetch = fetch) {
  await metaGraph('POST', `${wabaId}/subscribed_apps`, token, callback ? { override_callback_uri: callback.url, verify_token: callback.verifyToken } : {}, fetchImpl);
}

/** PIN de 6 dígitos para la verificación en dos pasos del número. */
export const newRegistrationPin = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export async function registerPhone(token: string, phoneNumberId: string, pin: string, fetchImpl: Fetch = fetch): Promise<{ ok: boolean; note?: string }> {
  try {
    await metaGraph('POST', `${phoneNumberId}/register`, token, { messaging_product: 'whatsapp', pin }, fetchImpl);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Ya registrado (o con PIN propio de la empresa): el número igual queda operando con el token
    return { ok: false, note: msg };
  }
}

/** Datos que el navegador recibe de Meta al terminar la ventana (evento WA_EMBEDDED_SIGNUP). */
export function readSignupSession(dto: any): { code: string; wabaId: string; phoneNumberId: string } | null {
  const code = typeof dto?.code === 'string' ? dto.code.trim() : '';
  const wabaId = String(dto?.wabaId ?? dto?.waba_id ?? '').replace(/\D/g, '');
  const phoneNumberId = String(dto?.phoneNumberId ?? dto?.phone_number_id ?? '').replace(/\D/g, '');
  if (!code || code.length > 2000 || !wabaId || !phoneNumberId) return null;
  return { code, wabaId, phoneNumberId };
}
