/**
 * Límites de canales en los planes nuevos (línea WPP):
 *  - WhatsApp: hasta los números del plan (Básico 1, Intermedio 2, Max 5).
 *  - Instagram, Messenger, Telegram, chat web…: uno por cada "Canal extra".
 * Más que eso → precio a medida con un asesor. Los planes anteriores no se tocan.
 * Lo que no es un canal de conversación (publicación en redes, correo…) no cuenta.
 */
import { BadRequestException } from '@nestjs/common';
import { readAddonStates } from './addons';

const NON_CHANNEL_TYPES = ['META_SOCIAL', 'EMAIL', 'SMTP', 'WEBHOOK', 'N8N', 'ALEGRA', 'WOMPI'];

export async function assertChannelAllowed(prisma: any, companyId: string, type: string) {
  const t = String(type ?? '').toUpperCase();
  if (!t || NON_CHANNEL_TYPES.includes(t)) return;
  const company = await prisma.company.findUnique({ where: { id: companyId }, include: { plan: true } });
  if (!company?.plan || company.plan.line !== 'WPP') return;
  const integrations = await prisma.integration.findMany({ where: { companyId }, select: { type: true } });
  if (t === 'WHATSAPP') {
    const used = integrations.filter((i: any) => i.type === 'WHATSAPP').length;
    const max = company.plan.maxLines ?? 1;
    if (used >= max) {
      throw new BadRequestException(
        `Tu plan ${company.plan.name} incluye ${max} ${max === 1 ? 'número' : 'números'} de WhatsApp. Para agregar más, habla con tu asesor.`,
      );
    }
    return;
  }
  const extra = readAddonStates(company).extraChannels;
  const allowed = extra?.enabled ? Math.max(1, extra.qty ?? 1) : 0;
  const used = integrations.filter((i: any) => i.type !== 'WHATSAPP' && !NON_CHANNEL_TYPES.includes(String(i.type).toUpperCase())).length;
  if (used >= allowed) {
    throw new BadRequestException(
      allowed
        ? `Ya usas tus ${allowed} ${allowed === 1 ? 'canal extra' : 'canales extra'}. Para conectar otro, pide uno más en Mi plan.`
        : 'Tu plan atiende por WhatsApp. Para conectar Instagram, Messenger u otro canal, pide el complemento "Canal extra" en Mi plan.',
    );
  }
}
