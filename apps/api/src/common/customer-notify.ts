import { parseJson } from './constants';
import { ensureTrackingLink, orderCode } from './tracking';

/**
 * Avisos al cliente final por el mismo chat del pedido (WhatsApp o simulador).
 * Respeta la ventana de 24 h de Meta: dentro de ella va texto libre; fuera,
 * solo con la plantilla aprobada "pedido_en_camino" (si no existe, no se
 * envía y queda auditado — jamás se rompe el flujo del domicilio).
 */

export const DEFAULT_DELIVERY_MESSAGES = {
  dispatched: 'Tu pedido #{{codigo}} ya va en camino{{con_domiciliario}}. Síguelo en vivo aquí: {{link}}',
};

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

export async function notifyOrderDispatched(
  prisma: any,
  queue: { add: (...args: any[]) => Promise<any> } | null | undefined,
  orderId: string,
): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { company: true, contact: true },
  });
  if (!order) return { sent: false, reason: 'pedido no encontrado' };

  // El chat del pedido; si no hay, el último WhatsApp del contacto
  let conversation = order.conversationId
    ? await prisma.conversation.findUnique({ where: { id: order.conversationId } })
    : null;
  if (!conversation && order.contactId) {
    conversation = await prisma.conversation.findFirst({
      where: { companyId: order.companyId, contactId: order.contactId, channel: 'WHATSAPP' },
      orderBy: { lastMessageAt: 'desc' },
    });
  }
  if (!conversation) return { sent: false, reason: 'el pedido no tiene chat asociado' };

  const cfg = parseJson<Record<string, any>>(order.company.orderConfigJson, {});
  const courier = order.courierId
    ? await prisma.user.findUnique({ where: { id: order.courierId } })
    : null;
  const link = await ensureTrackingLink(prisma, order.id);
  const vars = {
    codigo: orderCode(order.id),
    link,
    con_domiciliario: courier ? ` con ${String(courier.name).split(' ')[0]}` : '',
    empresa: order.company.name,
  };
  const content = render(cfg.deliveryMessages?.dispatched || DEFAULT_DELIVERY_MESSAGES.dispatched, vars);

  const isWhatsapp = conversation.channel === 'WHATSAPP';
  let contentSid: string | undefined;
  if (isWhatsapp) {
    const lastInbound = await prisma.message.findFirst({
      where: { conversationId: conversation.id, direction: 'IN' },
      orderBy: { createdAt: 'desc' },
    });
    const within = !!lastInbound && Date.now() - new Date(lastInbound.createdAt).getTime() < 24 * 3600e3;
    if (!within) {
      const template = parseJson<any[]>(order.company.waTemplatesJson, []).find(
        (t) => t?.key === 'pedido_en_camino' && t?.contentSid,
      );
      if (!template) {
        return { sent: false, reason: 'fuera de la ventana de 24 h y sin plantilla "pedido_en_camino"' };
      }
      contentSid = template.contentSid;
    }
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUT',
      author: 'BOT',
      authorName: 'Domicilios',
      content,
      type: 'TEXT',
      deliveryStatus: isWhatsapp ? 'QUEUED' : null,
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });
  if (isWhatsapp && queue) {
    await queue.add(
      'outbound',
      {
        messageId: message.id,
        metaCategory: 'UTILIDAD',
        ...(contentSid ? { contentSid, contentVariables: { '1': vars.codigo, '2': link } } : {}),
      },
      { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );
  }
  return { sent: true, messageId: message.id };
}
