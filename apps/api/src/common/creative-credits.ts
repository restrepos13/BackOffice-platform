import { deterministicId } from './automation/run-signals';
/**
 * Créditos de BackOffice Creative. Dos bolsas:
 *  - MONTHLY: el cupo del plan (complemento "Redes sociales con IA"), contador
 *    atómico por mes en SocialUsage (reserveCredits/refundCredits existentes).
 *  - EXTRA: paquetes adicionales o regalos (CreativeWallet), se usan cuando el
 *    cupo del mes se acabó.
 * Flujo: reservar → (operación) → confirmar o liberar. Cada paso queda en
 * CreativeCreditMove con una llave única: un reintento con la misma llave NO
 * cobra otra vez, y nunca hay saldo negativo (el descuento es condicional).
 */
import { CREDIT_COST, refundCredits, reserveCredits, socialAddon } from './social-addon';

/** Tarifas internas en créditos (centralizadas; editar aquí o volverlas configurables por plataforma). */
export const CREATIVE_COSTS = { TEXT: 0, IMAGE: CREDIT_COST.image, VIDEO: CREDIT_COST.video } as const;
export type CreativeOperation = keyof typeof CREATIVE_COSTS;

export class InsufficientCreditsError extends Error {
  constructor() {
    super('No te quedan créditos. Se renuevan el 1 del mes; si necesitas más ahora, pide un paquete adicional en Mi plan.');
  }
}

async function moveByKey(prisma: any, key: string) {
  return prisma.creativeCreditMove.findUnique({ where: { idempotencyKey: key } });
}

/**
 * Crea el movimiento; si otro proceso ya lo creó, devuelve false. El _id sale
 * de la llave de idempotencia: aunque Atlas no tenga el índice único de
 * idempotencyKey, dos movimientos con la misma llave chocan en _id.
 */
async function record(prisma: any, data: Record<string, any>): Promise<boolean> {
  try {
    await prisma.creativeCreditMove.create({ data: { id: deterministicId('ccm', String(data.idempotencyKey)), ...data } });
    return true;
  } catch (err: any) {
    if (err?.code === 'P2002') return false;
    throw err;
  }
}

/**
 * Reserva créditos para una operación. Con la misma llave devuelve la reserva
 * existente (no descuenta dos veces). Lanza InsufficientCreditsError si no alcanza.
 */
export async function reserveCreativeCredits(
  prisma: any,
  input: { company: { id: string; addonsJson?: string | null }; operation: CreativeOperation; key: string; userId?: string | null; resourceType?: string; resourceId?: string },
): Promise<{ bucket: 'MONTHLY' | 'EXTRA' | 'FREE'; credits: number; reused: boolean }> {
  const cost = CREATIVE_COSTS[input.operation];
  const existing = await moveByKey(prisma, input.key);
  if (existing) return { bucket: existing.bucket, credits: existing.credits, reused: true };
  if (cost <= 0) {
    await record(prisma, { companyId: input.company.id, userId: input.userId ?? null, kind: 'RESERVE', operation: input.operation, credits: 0, bucket: 'MONTHLY', idempotencyKey: input.key, resourceType: input.resourceType, resourceId: input.resourceId });
    return { bucket: 'FREE', credits: 0, reused: false };
  }
  const monthlyLimit = socialAddon(input.company).credits;
  let bucket: 'MONTHLY' | 'EXTRA' | null = null;
  const kind = input.operation === 'VIDEO' ? 'video' : 'image';
  if (await reserveCredits(prisma, input.company.id, monthlyLimit, kind)) bucket = 'MONTHLY';
  else {
    // Descuento condicional: solo si hay saldo suficiente (jamás queda negativo)
    const res = await prisma.creativeWallet.updateMany({
      where: { companyId: input.company.id, extraCredits: { gte: cost } },
      data: { extraCredits: { decrement: cost }, updatedAt: new Date() },
    });
    if (res.count > 0) bucket = 'EXTRA';
  }
  if (!bucket) throw new InsufficientCreditsError();
  const created = await record(prisma, {
    companyId: input.company.id, userId: input.userId ?? null, kind: 'RESERVE', operation: input.operation, credits: cost, bucket,
    idempotencyKey: input.key, resourceType: input.resourceType, resourceId: input.resourceId,
  });
  if (!created) {
    // Carrera: otra petición con la misma llave reservó primero → devolvemos lo nuestro
    await giveBack(prisma, input.company.id, bucket, input.operation, cost);
    const winner = await moveByKey(prisma, input.key);
    return { bucket: winner.bucket, credits: winner.credits, reused: true };
  }
  return { bucket, credits: cost, reused: false };
}

async function giveBack(prisma: any, companyId: string, bucket: string, operation: CreativeOperation, credits: number) {
  if (credits <= 0) return;
  if (bucket === 'MONTHLY') await refundCredits(prisma, companyId, operation === 'VIDEO' ? 'video' : 'image');
  else if (bucket === 'EXTRA') await prisma.creativeWallet.updateMany({ where: { companyId }, data: { extraCredits: { increment: credits }, updatedAt: new Date() } });
}

/** Confirma el consumo (operación terminada bien). Idempotente. */
export async function commitCreativeCredits(prisma: any, key: string, meta: { provider?: string; model?: string; costUsd?: number; resourceId?: string } = {}) {
  const reserve = await moveByKey(prisma, key);
  if (!reserve) return false;
  if (await moveByKey(prisma, `${key}:release`)) return false; // ya se liberó: no se puede confirmar
  return record(prisma, {
    companyId: reserve.companyId, userId: reserve.userId, kind: 'COMMIT', operation: reserve.operation, credits: reserve.credits, bucket: reserve.bucket,
    idempotencyKey: `${key}:commit`, provider: meta.provider, model: meta.model, costUsd: meta.costUsd, resourceType: reserve.resourceType, resourceId: meta.resourceId ?? reserve.resourceId,
  });
}

/** Libera la reserva (error técnico). Idempotente; no libera lo ya confirmado. */
export async function releaseCreativeCredits(prisma: any, key: string, note?: string) {
  const reserve = await moveByKey(prisma, key);
  if (!reserve) return false;
  if (await moveByKey(prisma, `${key}:commit`)) return false;
  const created = await record(prisma, {
    companyId: reserve.companyId, userId: reserve.userId, kind: 'RELEASE', operation: reserve.operation, credits: reserve.credits, bucket: reserve.bucket,
    idempotencyKey: `${key}:release`, resourceType: reserve.resourceType, resourceId: reserve.resourceId, note: note?.slice(0, 200),
  });
  if (created) await giveBack(prisma, reserve.companyId, reserve.bucket, reserve.operation, reserve.credits);
  return created;
}

/** Regalo o paquete adicional (plataforma). */
export async function grantExtraCredits(prisma: any, companyId: string, credits: number, key: string, note?: string) {
  if (!(credits > 0)) return false;
  const created = await record(prisma, { companyId, kind: 'GRANT', operation: 'EXTRA', credits, bucket: 'EXTRA', idempotencyKey: key, note: note?.slice(0, 200) });
  if (!created) return false;
  const wallet = await prisma.creativeWallet.findUnique({ where: { companyId } });
  if (wallet) await prisma.creativeWallet.updateMany({ where: { companyId }, data: { extraCredits: { increment: credits }, updatedAt: new Date() } });
  else await prisma.creativeWallet.create({ data: { companyId, extraCredits: credits, updatedAt: new Date() } });
  return true;
}
