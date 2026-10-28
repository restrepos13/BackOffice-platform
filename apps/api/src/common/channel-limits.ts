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

/**
 * ¿Cabe un canal más? Con `afterCreate` se cuenta ya el recién creado (uso > límite).
 * Concurrencia: además de revisar antes, se vuelve a contar DESPUÉS de crear
 * (verifyChannelAllowed); si dos solicitudes simultáneas pasaron, la que sobra se deshace.
 */
export async function assertChannelAllowed(prisma: any, companyId: string, type: string, opts: { afterCreate?: boolean } = {}) {
  const over = (used: number, max: number) => (opts.afterCreate ? used > max : used >= max);
  const t = String(type ?? '').toUpperCase();
  if (!t || NON_CHANNEL_TYPES.includes(t)) return;
  const company = await prisma.company.findUnique({ where: { id: companyId }, include: { plan: true } });
  if (!company?.plan || company.plan.line !== 'WPP') return;
  const integrations = await prisma.integration.findMany({ where: { companyId }, select: { type: true } });
  if (t === 'WHATSAPP') {
    const used = integrations.filter((i: any) => i.type === 'WHATSAPP').length;
    const max = company.plan.maxLines ?? 1;
    if (over(used, max)) {
      throw new BadRequestException(
        `Tu plan ${company.plan.name} incluye ${max} ${max === 1 ? 'número' : 'números'} de WhatsApp. Para agregar más, habla con tu asesor.`,
      );
    }
    return;
  }
  const extra = readAddonStates(company).extraChannels;
  const allowed = extra?.enabled ? Math.max(1, extra.qty ?? 1) : 0;
  const used = integrations.filter((i: any) => i.type !== 'WHATSAPP' && !NON_CHANNEL_TYPES.includes(String(i.type).toUpperCase())).length;
  if (over(used, allowed)) {
    throw new BadRequestException(
      allowed
        ? `Ya usas tus ${allowed} ${allowed === 1 ? 'canal extra' : 'canales extra'}. Para conectar otro, pide uno más en Mi plan.`
        : 'Tu plan atiende por WhatsApp. Para conectar Instagram, Messenger u otro canal, pide el complemento "Canal extra" en Mi plan.',
    );
  }
}

/**
 * Después de crear: si dos altas simultáneas pasaron el límite, se conservan
 * las primeras (por orden de creación) y se deshace solo la que sobra.
 */
export async function verifyChannelAllowed(prisma: any, companyId: string, type: string, createdId: string, undo: () => Promise<unknown>) {
  try {
    await assertChannelAllowed(prisma, companyId, type, { afterCreate: true });
  } catch (err) {
    const t = String(type ?? '').toUpperCase();
    const company = await prisma.company.findUnique({ where: { id: companyId }, include: { plan: true } });
    const same = (i: any) => (t === 'WHATSAPP' ? i.type === 'WHATSAPP' : i.type !== 'WHATSAPP' && !NON_CHANNEL_TYPES.includes(String(i.type).toUpperCase()));
    const all = (await prisma.integration.findMany({ where: { companyId }, select: { id: true, type: true, createdAt: true } }))
      .filter(same)
      .sort((a: any, b: any) => (+new Date(a.createdAt) - +new Date(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    const max = t === 'WHATSAPP' ? company?.plan?.maxLines ?? 1 : Math.max(0, readAddonStates(company).extraChannels?.enabled ? readAddonStates(company).extraChannels.qty ?? 1 : 0);
    if (all.findIndex((i: any) => i.id === createdId) >= max) {
      await undo();
      throw err;
    }
  }
}
