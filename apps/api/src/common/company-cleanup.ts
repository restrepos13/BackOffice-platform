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
  for (const m of ['workflowRun', 'automationVersion', 'productionSlotLock', 'productionAssignment', 'productionRate', 'productionResource', 'productionQuote', 'productionIssue', 'productionTask', 'productionEvent', 'productionSourceKey', 'production', 'productionCounter', 'productionSettings']) {
    await prisma[m]?.deleteMany({ where });
  }
}

/* ─── Inventario de datos por empresa (para el plan de borrado y retención) ───
   Clasificación de TODOS los modelos con companyId. Una prueba lee el esquema
   y falla si aparece un modelo nuevo sin clasificar. No cambia lo que hace
   el borrado actual: solo lo hace visible (ver docs/nucleo/BORRADO_DE_EMPRESAS.md). */

/** Se borran solos al borrar la empresa (relación con onDelete: Cascade). */
export const CASCADE_MODELS = [
  'user', 'bot', 'integration', 'personaTemplate', 'contact', 'conversation', 'customer', 'product', 'productionArea', 'order',
  'orderItem', 'orderStatusHistory', 'reminder', 'feedback', 'marketingCampaign', 'contentPiece', 'videoJob', 'dailyReport',
  'appointment', 'followUp', 'mediaAsset', 'aiUsageEvent', 'automation', 'usageRecord', 'invoice', 'payment', 'auditLog', 'apiKey', 'branch',
] as const;

/** Sin relación: los borra deleteCompanyLooseData. */
export const CLEANED_MODELS = [
  'courierPing', 'promotion', 'quickReply', 'knowledgeChunk', 'knowledgeDoc', 'pipeline', 'broadcast', 'broadcastRecipient',
  'billingAdjustment', 'aiCreditUse', 'aiCreditLot', 'inboundOrderKey', 'planOrder',
  'workflowRun', 'automationVersion', 'productionSlotLock', 'productionAssignment', 'productionRate', 'productionResource', 'productionQuote', 'productionIssue',
  'productionTask', 'productionEvent', 'productionSourceKey', 'production', 'productionCounter', 'productionSettings',
] as const;

/** Sin relación y SIN limpieza hoy: quedan huérfanos al borrar la empresa. */
export const ORPHANED_MODELS = [
  'bookingLock', 'bookingNotice', 'addonTouch', 'receivable', 'salesAudit', 'incident', 'signupSession', 'socialUsage', 'storedFile',
  'agentCall', 'brandProfile', 'brandAsset', 'adAssetLink', 'creativeDesign', 'creativeDesignVersion', 'creativeCreditMove', 'creativeWallet',
  'adAccount', 'adEntity', 'adInsightDaily', 'adSyncRun', 'opportunity', 'companyContext', 'adSettings', 'adRule', 'adActionLog', 'adBrief', 'adLead', 'adLaunch',
  'creativeEvent', 'calendarConnection', 'calendarEventLink', 'authToken', 'conversationNote', 'inboundReceipt', 'subscriptionEvent', 'aiIncludedCounter',
] as const;

/** El correo enviado conserva el registro (companyId pasa a null: onDelete SetNull). */
export const SET_NULL_MODELS = ['emailMessage'] as const;

/**
 * Cuántos registros tiene una empresa en cada colección, separados por lo
 * que les pasaría al borrarla. Solo lee.
 */
export async function companyDataFootprint(prisma: PrismaClient | any, companyId: string) {
  const count = async (m: string) => {
    try {
      return await prisma[m].count({ where: { companyId } });
    } catch {
      return null; // colección que todavía no existe en esa base
    }
  };
  const group = async (models: readonly string[]) => {
    const rows = await Promise.all(models.map(async (m) => [m, await count(m)] as const));
    return Object.fromEntries(rows.filter(([, n]) => n !== 0));
  };
  const [cascade, cleaned, orphaned, setNull] = await Promise.all([group(CASCADE_MODELS), group(CLEANED_MODELS), group(ORPHANED_MODELS), group(SET_NULL_MODELS)]);
  const total = (o: Record<string, number | null>) => Object.values(o).reduce<number>((a, n) => a + (n ?? 0), 0);
  return {
    companyId,
    deletedByCascade: cascade,
    deletedByCleanup: cleaned,
    wouldBeOrphaned: orphaned,
    keptWithoutCompany: setNull,
    totals: { cascade: total(cascade), cleanup: total(cleaned), orphaned: total(orphaned), keptWithoutCompany: total(setNull) },
    warnings: [
      ...((cascade.invoice ?? 0) || (cascade.payment ?? 0) ? ['Se borrarían facturas y pagos: revisar la obligación de conservarlos antes de borrar.'] : []),
      ...((cascade.auditLog ?? 0) ? ['Se borraría el registro de auditoría de la empresa.'] : []),
      ...(total(orphaned) ? ['Quedarían datos sin empresa (tokens cifrados, archivos, publicidad, Creative…).'] : []),
    ],
  };
}
