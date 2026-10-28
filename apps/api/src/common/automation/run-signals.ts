/**
 * Señales que un manejador del motor (WorkflowService) puede lanzar para
 * decidir el siguiente estado de la ejecución sin tocarla directamente.
 */
import { createHash } from 'crypto';

/** Pausa la ejecución hasta `until` (estado WAITING; no consume intento). */
export class WaitUntil extends Error {
  constructor(readonly until: Date, readonly reason = 'espera programada') {
    super(reason);
    this.name = 'WaitUntil';
  }
}

/** Error que no se arregla reintentando (dato inválido, recurso ajeno o borrado). */
export class PermanentError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** Termina la ejecución como CANCELLED (p. ej. automatización pausada o archivada). */
export class CancelRun extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CancelRun';
  }
}

/**
 * _id determinista: Mongo SIEMPRE garantiza la unicidad de _id, aunque falten
 * los índices únicos declarados en el schema (Atlas no los tiene todos).
 */
export function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
}
