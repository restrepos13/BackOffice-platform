import { ProviderErrorKind, addDays } from './provider';

/**
 * Política de sincronización de cuentas publicitarias: cuándo reintentar,
 * en qué estado queda la cuenta y cómo partir el rango de fechas.
 *
 *  - AUTH (token vencido o revocado): la cuenta queda EXPIRED y no se
 *    reintenta sola; hace falta reconectar.
 *  - PERMISSION: faltan permisos; un reintento diario (alguien puede
 *    concederlos en la plataforma).
 *  - RATE_LIMIT / errores temporales: espera creciente desde 1 h.
 *  - INCOMPLETE / PROVIDER: espera creciente desde 30 min.
 * La espera máxima es de 12 h, y una sincronización correcta vuelve al ciclo
 * normal de 6 h.
 */

export const SYNC_EVERY_H = 6;
export const SYNC_LOCK_MS = 15 * 60e3;
/** Días por consulta de métricas: rangos más cortos evitan el "reduce the amount of data" de Meta. */
export const INSIGHTS_CHUNK_DAYS = 15;

export function nextAttempt(kind: ProviderErrorKind | null, failures: number, now: Date): Date | null {
  if (kind === null) return new Date(now.getTime() + SYNC_EVERY_H * 36e5);
  if (kind === 'AUTH' || kind === 'NOT_CONFIGURED') return null;
  if (kind === 'PERMISSION') return new Date(now.getTime() + 24 * 36e5);
  const base = kind === 'RATE_LIMIT' ? 60 : 30;
  const minutes = Math.min(base * 2 ** Math.max(0, failures - 1), 12 * 60);
  return new Date(now.getTime() + minutes * 60e3);
}

/** Estado de la conexión según el tipo de error (un límite temporal no rompe la conexión). */
export function accountStatusAfter(kind: ProviderErrorKind | null, current: string): string {
  if (kind === 'AUTH') return 'EXPIRED';
  if (kind === 'PERMISSION' || kind === 'NOT_CONFIGURED') return 'ERROR';
  return current === 'DISCONNECTED' ? current : 'CONNECTED';
}

/** Mensaje para la persona: qué pasó y qué hacer. */
export const KIND_LABEL: Record<string, string> = {
  AUTH: 'La conexión venció o fue revocada: vuelve a conectar la cuenta.',
  PERMISSION: 'Faltan permisos en la plataforma para leer esta cuenta.',
  RATE_LIMIT: 'La plataforma pidió esperar (límite o falla temporal). Se reintenta sola.',
  INCOMPLETE: 'La plataforma devolvió más datos de los que se pudieron leer: la sincronización quedó incompleta.',
  NOT_FOUND: 'La cuenta o un elemento ya no existe en la plataforma.',
  NOT_CONFIGURED: 'La plataforma aún no está habilitada en BackOffice.',
  PROVIDER: 'La plataforma respondió con un error.',
};

/** Parte [since, until] en tramos de `size` días (ambos extremos incluidos). */
export function chunks(since: string, until: string, size = INSIGHTS_CHUNK_DAYS): Array<{ since: string; until: string }> {
  const out: Array<{ since: string; until: string }> = [];
  for (let from = since; from <= until; from = addDays(from, size)) {
    const to = addDays(from, size - 1);
    out.push({ since: from, until: to < until ? to : until });
  }
  return out;
}
