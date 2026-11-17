/**
 * Mensajes de UNA empresa sin recorrer los de las demás.
 *
 * `Message` no guarda `companyId`: pertenece a la empresa de su conversación.
 * Filtrar con `where: { conversation: { companyId } }` en MongoDB obliga a
 * cruzar CADA mensaje de la plataforma con su conversación antes de filtrar
 * (auditoría 17-nov-2026: los reportes de una empresa con 10 mensajes pasaban
 * de 0,6 s a 11-17 s cuando otra empresa sumaba 300.000 mensajes).
 *
 * En dos pasos, cada uno por índice:
 *  1. ids de las conversaciones de la empresa  → índice [companyId, …] de Conversation
 *  2. mensajes de esas conversaciones          → índice [conversationId, createdAt] de Message
 *
 * El paso 2 va en consulta nativa (`$in`): Prisma traduce `in` a un `$or` con
 * una rama por id, y con 50.000 conversaciones MongoDB tardaba más de 5
 * minutos en planificarlo; el `$in` nativo lo resuelve en ~0,3 s (medido).
 * Listas muy grandes se parten para no pasar el tope de 16 MB por consulta.
 *
 * Mismo conjunto de mensajes que antes. No se acota por `lastMessageAt`: no
 * todas las rutas que crean mensajes lo actualizan.
 * Reemplazo definitivo: `companyId` en Message (ver docs de la auditoría).
 */

/** Ids por consulta (≈1,5 MB de lista): muy por debajo del tope de 16 MB de MongoDB. */
const CHUNK = 50_000;

export async function companyConversationIds(prisma: any, companyId: string): Promise<string[]> {
  const rows = await prisma.conversation.findMany({ where: { companyId }, select: { id: true } });
  return rows.map((r: { id: string }) => r.id);
}

/** Condición en formato de MongoDB (`$gte`, `$lt`, `$ne`, `$gt`…). Las fechas van como Date. */
export type MessageFilter = Record<string, unknown>;

/** Fechas al formato extendido que espera la consulta nativa de Prisma. */
function toRaw(v: unknown): unknown {
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(toRaw);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toRaw(x)]));
  return v;
}

/** De vuelta: `_id` → `id` y `{$date}` → Date. */
function fromRaw(doc: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(doc ?? {})) {
    const key = k === '_id' ? 'id' : k;
    out[key] = v && typeof v === 'object' && '$date' in (v as any) ? new Date((v as any).$date) : v instanceof Date ? v : v;
  }
  return out;
}

const chunks = (ids: string[]) => Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));

/** Mensajes de la empresa que cumplen `filter`, con solo los campos pedidos (y `id`). */
export async function companyMessages<T = any>(
  prisma: any, companyId: string, filter: MessageFilter, fields: string[], opts: { limit?: number } = {},
): Promise<T[]> {
  const ids = await companyConversationIds(prisma, companyId);
  const out: T[] = [];
  for (const part of chunks(ids)) {
    const left = opts.limit ? opts.limit - out.length : undefined;
    if (left !== undefined && left <= 0) break;
    const rows = await prisma.message.aggregateRaw({
      pipeline: [
        { $match: { conversationId: { $in: part }, ...(toRaw(filter) as object) } },
        { $project: Object.fromEntries(fields.map((f) => [f, 1])) },
        ...(left !== undefined ? [{ $limit: left }] : []),
      ],
    });
    // Sin `push(...filas)`: con cientos de miles de filas desborda la pila
    for (const row of rows as any[]) out.push(fromRaw(row));
  }
  return out;
}

/** Cuántos mensajes de la empresa cumplen `filter`. */
export async function countCompanyMessages(prisma: any, companyId: string, filter: MessageFilter): Promise<number> {
  const ids = await companyConversationIds(prisma, companyId);
  let total = 0;
  for (const part of chunks(ids)) {
    const rows = await prisma.message.aggregateRaw({
      pipeline: [{ $match: { conversationId: { $in: part }, ...(toRaw(filter) as object) } }, { $count: 'n' }],
    });
    total += Number((rows as any[])[0]?.n ?? 0);
  }
  return total;
}
