/**
 * Conteo con filtro nativo de MongoDB (sin el `$expr` que genera Prisma).
 *
 * Prisma sobre MongoDB arma `count`, `groupBy` e `include._count` como
 * agregaciones con `$expr`, y con eso MongoDB solo aprovecha el primer campo
 * del índice: un conteo por empresa + línea examinaba todas las conversaciones
 * de la empresa (22.000 en la prueba de carga). Con `$match` nativo usa el
 * índice completo. Solo para igualdades simples (empresa, línea, asistente).
 */
export async function nativeCount(model: any, filter: Record<string, string>): Promise<number> {
  const rows = await model.aggregateRaw({ pipeline: [{ $match: filter }, { $count: 'n' }] });
  return Number((rows as any[])[0]?.n ?? 0);
}
