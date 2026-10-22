import { CreativeOperation, InsufficientCreditsError, commitCreativeCredits, releaseCreativeCredits, reserveCreativeCredits } from '../creative-credits';

/**
 * Punto de integración de IA para Creative. HOY NO HAY NINGÚN PROVEEDOR
 * ACTIVO: `providerFromEnv()` devuelve null y las funciones responden
 * "no disponible". El producto funciona completo sin esto.
 *
 * Reglas para cuando se conecte un proveedor:
 *  - La IA solo recibe datos ya calculados por código (hechos de la
 *    oportunidad, datos confirmados de la marca); nunca accede a APIs ni
 *    ejecuta acciones.
 *  - Su salida se valida con un esquema antes de mostrarse; si no cumple,
 *    se descarta y se liberan los créditos.
 *  - Todo pasa por el libro de créditos: reservar → consumir o liberar,
 *    con una clave idempotente (un reintento no cobra dos veces).
 */

export type AssistTask = 'EXPLAIN_OPPORTUNITY' | 'COPY_VARIANTS';

export interface AssistProvider {
  readonly name: string;
  readonly model: string;
  complete(task: AssistTask, input: Record<string, unknown>): Promise<{ output: unknown; costUsd?: number }>;
}

/** Esquemas mínimos de salida (se rechaza lo que no cumpla). */
export function validateOutput(task: AssistTask, out: unknown): string[] | { text: string } | null {
  if (task === 'EXPLAIN_OPPORTUNITY') {
    const t = (out as any)?.text;
    return typeof t === 'string' && t.trim().length >= 20 && t.length <= 1200 ? { text: t.trim() } : null;
  }
  const v = (out as any)?.variants;
  if (!Array.isArray(v)) return null;
  const clean = v.filter((x) => typeof x === 'string' && x.trim().length >= 5 && x.length <= 400).map((x: string) => x.trim());
  // Variantes repetidas no cuentan (no se cobra por duplicados)
  const unique = [...new Set(clean.map((x) => x.toLowerCase()))].map((k) => clean.find((x) => x.toLowerCase() === k)!);
  return unique.length >= 2 ? unique.slice(0, 5) : null;
}

/** Sin variables de un proveedor configurado, no hay IA (no se asume ninguna credencial). */
export function providerFromEnv(): AssistProvider | null {
  return null;
}

export const OPERATION: Record<AssistTask, CreativeOperation> = { EXPLAIN_OPPORTUNITY: 'TEXT', COPY_VARIANTS: 'TEXT' };

export async function runAssist(
  prisma: any,
  provider: AssistProvider | null,
  input: { company: { id: string; addonsJson?: string | null }; task: AssistTask; key: string; userId?: string | null; payload: Record<string, unknown> },
): Promise<{ ok: true; result: unknown; reused?: boolean } | { ok: false; reason: 'NOT_CONFIGURED' | 'NO_CREDITS' | 'INVALID_OUTPUT' | 'PROVIDER_ERROR'; message: string }> {
  if (!provider) return { ok: false, reason: 'NOT_CONFIGURED', message: 'La ayuda con IA todavía no está activada. Todo lo demás funciona sin ella.' };
  let reserve;
  try {
    reserve = await reserveCreativeCredits(prisma, { company: input.company, operation: OPERATION[input.task], key: input.key, userId: input.userId, resourceType: input.task });
  } catch (e) {
    if (e instanceof InsufficientCreditsError) return { ok: false, reason: 'NO_CREDITS', message: 'No te quedan créditos para esto este mes.' };
    throw e;
  }
  if (reserve.reused) return { ok: false, reason: 'PROVIDER_ERROR', message: 'Esta solicitud ya se procesó.' };
  try {
    const res = await provider.complete(input.task, input.payload);
    const valid = validateOutput(input.task, res.output);
    if (!valid) {
      await releaseCreativeCredits(prisma, input.key, 'Salida inválida del proveedor');
      return { ok: false, reason: 'INVALID_OUTPUT', message: 'La respuesta no cumplió el formato esperado; no se cobró.' };
    }
    await commitCreativeCredits(prisma, input.key, { provider: provider.name, model: provider.model, costUsd: res.costUsd });
    return { ok: true, result: valid };
  } catch {
    await releaseCreativeCredits(prisma, input.key, 'Falla técnica del proveedor');
    return { ok: false, reason: 'PROVIDER_ERROR', message: 'El servicio de IA falló; no se cobró. Intenta más tarde.' };
  }
}
