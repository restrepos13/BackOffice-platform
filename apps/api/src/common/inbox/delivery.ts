/**
 * Resultado de un intento de envío al proveedor, clasificado para decidir
 * qué hacer SIN duplicar mensajes:
 *  - REJECTED: el proveedor respondió y dijo que no (4xx). No se reintenta.
 *  - AUTH: credenciales vencidas o sin permiso. No se reintenta.
 *  - RETRYABLE: el proveedor respondió que lo intentemos luego (429). Es
 *    seguro reintentar: lo rechazó, no lo procesó.
 *  - UNCERTAIN: no hubo respuesta clara (red caída, timeout, 5xx). El
 *    mensaje PUDO haber salido: no se reenvía solo; una persona decide.
 */

export type SendOutcome = 'REJECTED' | 'AUTH' | 'RETRYABLE' | 'UNCERTAIN';

export class SendError extends Error {
  constructor(readonly outcome: SendOutcome, message: string, readonly status?: number) {
    super(message);
  }
}

/** Quita tokens, credenciales y URLs con datos sensibles de un mensaje de error. */
export function sanitizeError(raw: unknown): string {
  return String((raw as any)?.message ?? raw ?? 'Error')
    .replace(/(access_token|token|authorization|auth_token|password|secret)=[^&\s"']+/gi, '$1=[oculto]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [oculto]')
    .replace(/\b(EAA[A-Za-z0-9]{10,}|AC[0-9a-f]{32}|[0-9a-f]{32,})\b/g, '[oculto]')
    .replace(/https?:\/\/[^\s]*@[^\s]*/g, '[url oculta]')
    .slice(0, 300);
}

/** Clasifica un error de Twilio o de Meta. */
export function classifySendError(err: any): SendError {
  if (err instanceof SendError) return err;
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
  const code = Number(err?.code ?? err?.error?.code);
  const msg = sanitizeError(err);
  if (status === 401 || status === 403 || code === 190 || code === 20003) return new SendError('AUTH', `Credenciales vencidas o sin permiso: ${msg}`, status);
  if (status === 429 || code === 4 || code === 80007 || code === 130429) return new SendError('RETRYABLE', `El proveedor pidió esperar: ${msg}`, status);
  if (Number.isFinite(status) && status >= 400 && status < 500) return new SendError('REJECTED', msg, status);
  // Sin respuesta (red, timeout) o 5xx: no se sabe si el proveedor lo procesó
  return new SendError('UNCERTAIN', `Sin confirmación del proveedor: ${msg}`, Number.isFinite(status) ? status : undefined);
}

/** Orden de los estados de entrega: un aviso viejo no hace retroceder uno nuevo. */
export const DELIVERY_ORDER = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ'];

export function shouldApplyStatus(current: string | null | undefined, incoming: string): boolean {
  if (incoming === 'FAILED') return !['DELIVERED', 'READ'].includes(current ?? '');
  const a = DELIVERY_ORDER.indexOf(current ?? '');
  const b = DELIVERY_ORDER.indexOf(incoming);
  return b !== -1 && b > a;
}
