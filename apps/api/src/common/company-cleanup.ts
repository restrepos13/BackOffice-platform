import type { PrismaClient } from '@prisma/client';

/**
 * Datos de la empresa que no cuelgan de ella por relación (sin cascada):
 * se borran a mano antes de eliminar la empresa para no dejar huérfanos.
 */
export async function deleteCompanyLooseData(prisma: PrismaClient | any, companyId: string) {
  const where = { companyId };
  await prisma.courierPing.deleteMany({ where });
  await prisma.promotion.deleteMany({ where });
  await prisma.quickReply.deleteMany({ where });
  await prisma.knowledgeChunk.deleteMany({ where });
  await prisma.knowledgeDoc.deleteMany({ where });
  await prisma.pipeline.deleteMany({ where });
  const broadcasts = await prisma.broadcast.findMany({ where, select: { id: true } });
  if (broadcasts.length) {
    await prisma.broadcastRecipient.deleteMany({ where: { broadcastId: { in: broadcasts.map((b: { id: string }) => b.id) } } });
  }
  await prisma.broadcast.deleteMany({ where });
  await prisma.billingAdjustment.deleteMany({ where });
  await prisma.aiCreditUse.deleteMany({ where });
  await prisma.aiCreditLot.deleteMany({ where });
  await prisma.inboundOrderKey.deleteMany({ where });
  await prisma.planOrder.deleteMany({ where });
  // Producciones (sin relación a Company)
  for (const m of ['workflowRun', 'productionSlotLock', 'productionAssignment', 'productionRate', 'productionResource', 'productionQuote', 'productionIssue', 'productionTask', 'productionEvent', 'productionSourceKey', 'production', 'productionCounter', 'productionSettings']) {
    await prisma[m]?.deleteMany({ where });
  }
}
