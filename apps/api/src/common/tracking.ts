import { randomBytes } from 'crypto';

/**
 * Seguimiento público de pedidos: link /t/<token> con la marca de la empresa.
 * El token es aleatorio (144 bits), no deriva del id del pedido y es lo único
 * que viaja al cliente final — sin login y sin ids internos.
 */

export function newTrackingToken(): string {
  return randomBytes(18).toString('base64url');
}

/** Código corto legible para el cliente ("tu pedido #A3F9C2"). */
export function orderCode(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

/** URL pública de la web (PUBLIC_WEB_URL → WEBHOOK_BASE_URL → localhost). */
export async function publicWebUrl(prisma: any): Promise<string> {
  const rows: Array<{ key: string; value: string }> = await prisma.platformSetting.findMany({
    where: { key: { in: ['PUBLIC_WEB_URL', 'WEBHOOK_BASE_URL'] } },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value?.trim();
  return (get('PUBLIC_WEB_URL') || get('WEBHOOK_BASE_URL') || 'http://localhost:5173').replace(/\/$/, '');
}

export function trackingUrl(base: string, token: string): string {
  return `${base}/t/${token}`;
}

/** Garantiza que el pedido tenga token y devuelve su link público. */
export async function ensureTrackingLink(prisma: any, orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { trackingToken: true },
  });
  let token = order?.trackingToken;
  if (!token) {
    token = newTrackingToken();
    await prisma.order.update({ where: { id: orderId }, data: { trackingToken: token } });
  }
  return trackingUrl(await publicWebUrl(prisma), token);
}

/** Estados internos → lo que entiende el cliente final. */
export const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  borrador: 'Armando tu pedido',
  confirmado: 'Pedido confirmado',
  programado: 'Pedido recibido',
  en_produccion: 'En preparación',
  listo: 'Listo para salir',
  empacado: 'Empacado',
  despachado: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
  requiere_atencion: 'En revisión por el equipo',
};
