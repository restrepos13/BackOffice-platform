import { deterministicId } from '../automation/run-signals';

/**
 * Reclama un mensaje entrante ANTES de procesarlo. El _id se deriva del
 * canal + ID del proveedor: Mongo garantiza que solo uno de dos webhooks
 * iguales (aunque lleguen a la vez) logre insertarlo. No depende de índices.
 * Devuelve false si ya se había recibido.
 */
export async function claimInbound(prisma: any, companyId: string, channel: string, providerId: string): Promise<boolean> {
  try {
    await prisma.inboundReceipt.create({ data: { id: deterministicId('inb', channel, providerId), companyId, channel, providerId } });
    return true;
  } catch (err: any) {
    if (err?.code === 'P2002') return false;
    throw err;
  }
}

/** Si el procesamiento falla, se suelta el recibo para que el reintento del proveedor sí entre. */
export async function releaseInbound(prisma: any, channel: string, providerId: string) {
  await prisma.inboundReceipt.delete({ where: { id: deterministicId('inb', channel, providerId) } }).catch(() => undefined);
}
