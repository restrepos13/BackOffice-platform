/**
 * Piezas comunes de los motores de complementos: elegir la línea de WhatsApp,
 * abrir (o reutilizar) la conversación y mandar respetando la regla de Meta:
 * dentro de las 24 h desde el último mensaje del cliente se puede escribir
 * libre; fuera de esa ventana solo con una plantilla aprobada.
 */
import { queueBotText, withinServiceWindow } from '../../common/customer-notify';
import type { WaTemplate } from '../../common/addon-config';

export async function whatsappLine(prisma: any, companyId: string) {
  const lines = await prisma.integration.findMany({ where: { companyId, type: 'WHATSAPP' }, orderBy: { createdAt: 'asc' } });
  return lines.find((l: any) => l.status === 'CONNECTED') ?? lines[0] ?? null;
}

export async function conversationFor(prisma: any, companyId: string, contact: any, line: any) {
  const existing = await prisma.conversation.findFirst({
    where: { companyId, contactId: contact.id, integrationId: line.id },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (existing) {
    if (['CLOSED', 'RESOLVED'].includes(existing.status)) {
      return prisma.conversation.update({ where: { id: existing.id }, data: { status: 'OPEN' } });
    }
    return existing;
  }
  return prisma.conversation.create({
    data: { companyId, contactId: contact.id, integrationId: line.id, channel: contact.channel === 'SIMULATOR' ? 'SIMULATOR' : 'WHATSAPP', status: 'OPEN' },
  });
}

export type SendResult = { sent: true; messageId: string; conversationId: string } | { sent: false; reason: string; conversationId?: string };

/** Manda el texto (o la plantilla si está fuera de las 24 h). Nunca escribe a quien pidió la baja. */
export async function sendToContact(
  prisma: any,
  queue: any,
  input: {
    companyId: string; contact: any; line: any; text: string; authorName: string;
    template: WaTemplate | null; templateVars: Record<string, string>; category: 'MARKETING' | 'UTILIDAD';
    /** Reloj del motor (la ventana de 24 h se mide contra él) */
    now?: Date;
  },
): Promise<SendResult> {
  if (input.contact.optOut) return { sent: false, reason: 'El cliente pidió no recibir mensajes' };
  if (!input.contact.phone && input.contact.channel !== 'SIMULATOR') return { sent: false, reason: 'Sin número de teléfono' };
  const conversation = await conversationFor(prisma, input.companyId, input.contact, input.line);
  const inWindow = await withinServiceWindow(prisma, conversation.id, input.now ?? new Date());
  if (!inWindow && !input.template) {
    return { sent: false, reason: 'Fuera de las 24 h y sin plantilla aprobada por Meta', conversationId: conversation.id };
  }
  const messageId = await queueBotText(prisma, queue, conversation, input.text, {
    authorName: input.authorName,
    metaCategory: inWindow ? 'SERVICIO' : input.category,
    ...(!inWindow && input.template ? { contentSid: input.template.contentSid, contentVariables: input.templateVars } : {}),
  });
  return { sent: true, messageId, conversationId: conversation.id };
}
