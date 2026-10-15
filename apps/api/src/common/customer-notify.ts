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

/** ¿El último mensaje del cliente está dentro de la ventana de 24 h de Meta? */
export async function withinServiceWindow(prisma: any, conversationId: string, now = new Date()): Promise<boolean> {
  const lastInbound = await prisma.message.findFirst({
    where: { conversationId, direction: 'IN' },
    orderBy: { createdAt: 'desc' },
  });
  return !!lastInbound && now.getTime() - new Date(lastInbound.createdAt).getTime() < 24 * 3600e3;
}

/**
 * Deja un mensaje del negocio en la conversación y lo encola al canal real
 * (WhatsApp/Instagram/Messenger) con un retraso opcional. En el simulador
 * solo queda guardado. Devuelve el id del mensaje.
 */
export async function queueBotText(
  prisma: any,
  queue: { add: (...args: any[]) => Promise<any> } | null | undefined,
  conversation: { id: string; channel: string },
  content: string,
  opts: {
    authorName?: string; metaCategory?: string; delayMs?: number;
    contentSid?: string; contentVariables?: Record<string, string>;
  } = {},
): Promise<string> {
  const realChannel = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'].includes(conversation.channel);
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUT',
      author: 'BOT',
      authorName: opts.authorName ?? null,
      content,
      type: 'TEXT',
      deliveryStatus: realChannel ? 'QUEUED' : null,
    },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
  if (realChannel && queue) {
    await queue.add(
      'outbound',
      {
        messageId: message.id,
        metaCategory: opts.metaCategory ?? 'SERVICIO',
        ...(opts.contentSid ? { contentSid: opts.contentSid, contentVariables: opts.contentVariables ?? {} } : {}),
      },
      { delay: opts.delayMs ?? 0, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );
  }
  return message.id;
}

/** Texto de baja ("STOP", "no más mensajes"…) — corto y explícito. */
export function isOptOutText(text: string): boolean {
  const t = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!t || t.length > 60) return false;
  return /^(stop|baja|darme de baja|no mas mensajes|no quiero (recibir )?(mas )?(mensajes|promociones)|no me escriban( mas)?|cancelar suscripcion|desuscribirme|desuscribir)\.?!?$/.test(t);
}

/** Texto para volver a recibir mensajes. */
export function isOptInText(text: string): boolean {
  const t = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^(alta|suscribirme|quiero recibir (mensajes|promociones))\.?!?$/.test(t);
}

/** Variables de campaña: {{nombre}} {{empresa}}. */
export function renderCampaignText(template: string, vars: { nombre?: string | null; empresa?: string | null }): string {
  const firstName = String(vars.nombre ?? '').trim().split(/\s+/)[0] || '';
  return template
    .replace(/\{\{\s*nombre\s*\}\}/gi, firstName)
    .replace(/\{\{\s*empresa\s*\}\}/gi, vars.empresa ?? '')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

/**
 * Baja / re-alta por WhatsApp (o el simulador): "STOP" saca al contacto de
 * campañas y seguimientos y se le confirma; "ALTA" lo vuelve a incluir.
 */
export async function applyConsent(
  prisma: any,
  queue: { add: (...args: any[]) => Promise<any> } | null | undefined,
  contact: any,
  conversation: { id: string; channel: string },
  body: string,
): Promise<'OPT_OUT' | 'OPT_IN' | null> {
  if (isOptOutText(body)) {
    await prisma.contact.update({ where: { id: contact.id }, data: { optOut: true, optOutAt: new Date() } });
    await queueBotText(prisma, queue, conversation,
      'Listo, no te enviaremos más mensajes promocionales. Si necesitas algo, escríbenos cuando quieras.',
      { authorName: 'Preferencias' });
    await prisma.auditLog.create({
      data: {
        actorName: 'Sistema', companyId: contact.companyId, action: 'contact.opt_out',
        entity: 'Contact', entityId: contact.id, detail: `${contact.name}: "${body.slice(0, 40)}"`,
      },
    });
    return 'OPT_OUT';
  }
  if (contact.optOut && isOptInText(body)) {
    await prisma.contact.update({ where: { id: contact.id }, data: { optOut: false, optOutAt: null } });
    await queueBotText(prisma, queue, conversation, '¡Listo! Volverás a recibir nuestras novedades.', { authorName: 'Preferencias' });
    await prisma.auditLog.create({
      data: { actorName: 'Sistema', companyId: contact.companyId, action: 'contact.opt_in', entity: 'Contact', entityId: contact.id, detail: contact.name },
    });
    return 'OPT_IN';
  }
  return null;
}
