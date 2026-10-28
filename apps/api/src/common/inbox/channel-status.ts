import { parseJson } from '../constants';
import { isEncrypted } from '../crypto';

/**
 * Estado VERIFICABLE de un canal. Que exista un adaptador o que alguien haya
 * marcado la línea como "conectada" no basta:
 *  - NOT_CONFIGURED: faltan credenciales.
 *  - SANDBOX: modo prueba; los mensajes no salen a ningún cliente real.
 *  - PENDING_VERIFICATION: hay credenciales pero nunca se verificaron.
 *  - VERIFIED: la última verificación (solo lectura) con el proveedor salió bien.
 *  - AUTH_ERROR: el proveedor rechazó las credenciales (vencidas o sin permiso).
 *  - ERROR: la verificación falló por otro motivo.
 */

export type ChannelState = 'NOT_CONFIGURED' | 'SANDBOX' | 'PENDING_VERIFICATION' | 'VERIFIED' | 'AUTH_ERROR' | 'ERROR';

export const CHANNEL_STATE_LABEL: Record<ChannelState, string> = {
  NOT_CONFIGURED: 'No configurado',
  SANDBOX: 'Modo prueba (no sale nada real)',
  PENDING_VERIFICATION: 'Pendiente de verificación',
  VERIFIED: 'Conectado y verificado',
  AUTH_ERROR: 'Credenciales vencidas o sin permiso',
  ERROR: 'Error de conexión',
};

export interface Verification { ok: boolean; at: string; kind?: 'AUTH' | 'ERROR'; message?: string }

export function channelState(integration: { type: string; configJson: string | null }): { state: ChannelState; provider: string; detail: string | null; verifiedAt: string | null } {
  const cfg = parseJson<Record<string, any>>(integration.configJson, {});
  const provider = cfg.provider === 'TWILIO' ? 'TWILIO' : cfg.provider === 'META' || ['INSTAGRAM', 'MESSENGER'].includes(integration.type) ? 'META' : 'NONE';
  const v: Verification | null = cfg.verification ?? null;
  if (cfg.sandbox === true) return { state: 'SANDBOX', provider, detail: 'Los mensajes se registran pero no se envían.', verifiedAt: null };
  const hasCreds = provider === 'TWILIO'
    ? !!cfg.accountSid && isEncrypted(cfg.authTokenEnc) && !!cfg.fromNumber
    : provider === 'META'
      ? isEncrypted(cfg.accessTokenEnc) && !!(cfg.phoneNumberId || cfg.pageId || cfg.igUserId)
      : false;
  // Twilio y Meta sin credenciales caen a modo prueba en el envío: también se dice
  if (!hasCreds) return { state: 'NOT_CONFIGURED', provider, detail: provider === 'NONE' ? 'Sin proveedor configurado.' : 'Faltan credenciales: los mensajes no saldrían (se registran como simulados).', verifiedAt: null };
  if (!v) return { state: 'PENDING_VERIFICATION', provider, detail: 'Hay credenciales guardadas, pero aún no se verificaron con el proveedor.', verifiedAt: null };
  if (v.ok) return { state: 'VERIFIED', provider, detail: null, verifiedAt: v.at };
  return { state: v.kind === 'AUTH' ? 'AUTH_ERROR' : 'ERROR', provider, detail: v.message ?? null, verifiedAt: v.at };
}
