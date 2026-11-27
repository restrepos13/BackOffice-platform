/**
 * API de Conversiones de Meta (servidor → Meta) para el registro de la web.
 *
 * Manda los mismos eventos que el píxel del navegador (Lead al dejar el
 * contacto, CompleteRegistration al crear la empresa) con el MISMO event_id,
 * así Meta los cuenta una sola vez. Los datos de contacto van en SHA-256,
 * como pide Meta. Apagada si falta META_CAPI_PIXEL_ID o META_CAPI_TOKEN.
 *
 *   META_CAPI_PIXEL_ID   ID del píxel / conjunto de datos
 *   META_CAPI_TOKEN      token de la API de Conversiones (Administrador de eventos)
 *   META_CAPI_TEST_CODE  opcional: código de «Probar eventos» mientras se verifica
 */
import { createHash } from 'crypto';

export type CapiEventName = 'Lead' | 'CompleteRegistration';

export interface CapiEvent {
  name: CapiEventName;
  eventId: string;
  sourceUrl?: string;
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  externalId?: string | null;
  fbclid?: string | null;
  /** Momento del primer clic (para armar fbc); si no se sabe, ahora */
  clickAt?: Date | null;
  fbp?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

export function capiConfig(env: NodeJS.ProcessEnv = process.env) {
  const pixelId = env.META_CAPI_PIXEL_ID?.trim();
  const token = env.META_CAPI_TOKEN?.trim();
  if (!pixelId || !/^\d{5,20}$/.test(pixelId) || !token) return null;
  return { pixelId, token, testCode: env.META_CAPI_TEST_CODE?.trim() || undefined, version: (env.META_GRAPH_API_VERSION || env.META_ADS_API_VERSION || 'v25.0').trim() };
}

/** Celular colombiano → 57XXXXXXXXXX (como pide Meta: solo dígitos y con indicativo). */
export function normalizePhone(phone?: string | null): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('3')) return `57${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/** Cuerpo del evento para Meta (separado para probarlo sin red). */
export function capiPayload(e: CapiEvent, now = Date.now()) {
  const phone = normalizePhone(e.phone);
  const email = e.email?.trim().toLowerCase();
  const fn = e.firstName?.trim().split(/\s+/)[0]?.toLowerCase();
  const user_data: Record<string, unknown> = {
    ...(phone ? { ph: [sha(phone)] } : {}),
    ...(email ? { em: [sha(email)] } : {}),
    ...(fn ? { fn: [sha(fn)] } : {}),
    ...(e.externalId ? { external_id: [sha(e.externalId)] } : {}),
    ...(e.fbclid ? { fbc: `fb.1.${(e.clickAt ?? new Date(now)).getTime()}.${e.fbclid}` } : {}),
    ...(e.fbp && /^fb\.\d\.\d+\.\d+$/.test(e.fbp) ? { fbp: e.fbp } : {}),
    ...(e.ip ? { client_ip_address: e.ip } : {}),
    ...(e.userAgent ? { client_user_agent: e.userAgent } : {}),
    country: [sha('co')],
  };
  return {
    event_name: e.name,
    event_time: Math.floor(now / 1000),
    event_id: e.eventId,
    action_source: 'website',
    ...(e.sourceUrl ? { event_source_url: e.sourceUrl } : {}),
    user_data,
  };
}

/** Envía el evento. Nunca lanza: si Meta falla, el registro sigue. Devuelve si Meta lo aceptó. */
export async function sendCapiEvent(e: CapiEvent, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const cfg = capiConfig(env);
  if (!cfg) return false;
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${cfg.version}/${cfg.pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [capiPayload(e)], access_token: cfg.token, ...(cfg.testCode ? { test_event_code: cfg.testCode } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
