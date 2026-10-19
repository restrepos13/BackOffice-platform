import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { NOT_DELETED } from '../../common/constants';
import { WA_OUTBOUND_QUEUE } from '../../queue/queue.module';
import {
  ReactivationConfig, addonEnabled, approvedTemplates, fillText, firstName, localClock, reactivationConfig,
} from '../../common/addon-config';
import { sendToContact, whatsappLine } from './engine-support';

/**
 * Reactivación de clientes dormidos.
 *  - Dormido = no compra (o, si la empresa no usa pedidos, no escribe) hace
 *    30/60/90 días (umbrales configurables). Un mensaje por escalón.
 *  - Mensaje personal SIN gastar IA: su nombre, lo último que compró y la
 *    oferta del momento. Fuera de las 24 h va con la plantilla aprobada.
 *  - Respeta la baja, un tope diario y días mínimos entre mensajes.
 *  - Resultados: respondió (escribió después) y recuperado (volvió a comprar
 *    en 21 días, con el valor del pedido).
 * Corre cada hora y envía a la hora local que eligió la empresa.
 */

const PURCHASE_EXCLUDED = ['borrador', 'cancelado'];
const RECOVERY_WINDOW_DAYS = 21;
const DAY = 86400e3;

export interface DormantCandidate {
  contactId: string;
  name: string;
  phone: string | null;
  dormantDays: number;
  step: number;
  lastProduct: string | null;
  basis: 'compra' | 'conversación';
}

@Injectable()
export class ReactivationService {
  private readonly logger = new Logger('Reactivacion');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) private readonly queue?: Queue,
  ) {}

  /** Quiénes están dormidos hoy y en qué escalón (sin enviar nada). */
  async candidates(company: any, cfg: ReactivationConfig = reactivationConfig(company), now = new Date()): Promise<DormantCandidate[]> {
    const minDays = cfg.thresholds[0];
    const contacts = await this.prisma.contact.findMany({
      where: { companyId: company.id, optOut: false, channel: { in: ['WHATSAPP', 'SIMULATOR'] } },
      take: 5000,
    });
    if (!contacts.length) return [];
    const orders = await this.prisma.order.findMany({
      where: { companyId: company.id, contactId: { in: contacts.map((c: any) => c.id) }, status: { notIn: PURCHASE_EXCLUDED }, ...NOT_DELETED },
      orderBy: { createdAt: 'desc' },
      select: { contactId: true, createdAt: true, items: { select: { productName: true }, take: 1 } },
    });
    const lastOrder = new Map<string, any>();
    for (const o of orders) if (o.contactId && !lastOrder.has(o.contactId)) lastOrder.set(o.contactId, o);
    const touches = await this.prisma.addonTouch.findMany({
      where: { companyId: company.id, addon: 'REACTIVATION', status: { not: 'SKIPPED' }, createdAt: { gte: new Date(now.getTime() - 400 * DAY) } },
      orderBy: { createdAt: 'desc' },
    });
    const out: DormantCandidate[] = [];
    for (const c of contacts) {
      const order = lastOrder.get(c.id);
      const since = order ? new Date(order.createdAt) : new Date(c.lastActivityAt ?? c.createdAt);
      const dormantDays = Math.floor((now.getTime() - since.getTime()) / DAY);
      if (dormantDays < minDays) continue;
      const step = [...cfg.thresholds].reverse().find((t) => dormantDays >= t)!;
      const mine = touches.filter((t: any) => t.contactId === c.id);
      // Ya se le escribió en este escalón (o uno mayor) después de su última compra
      if (mine.some((t: any) => t.step >= step && new Date(t.createdAt) > since)) continue;
      // Días mínimos entre mensajes
      if (mine[0] && now.getTime() - new Date(mine[0].createdAt).getTime() < cfg.cooldownDays * DAY) continue;
      out.push({
        contactId: c.id, name: c.name, phone: c.phone ?? null, dormantDays, step,
        lastProduct: order?.items?.[0]?.productName ?? null, basis: order ? 'compra' : 'conversación',
      });
    }
    return out.sort((a, b) => a.dormantDays - b.dormantDays);
  }

  /** Envía a los dormidos de hoy (hasta el tope diario). */
  async run(company: any, opts: { now?: Date; limit?: number } = {}) {
    const now = opts.now ?? new Date();
    const cfg = reactivationConfig(company);
    const line = await whatsappLine(this.prisma, company.id);
    if (!line) return { sent: 0, skipped: 0, reason: 'La empresa no tiene una línea de WhatsApp' };
    const { day } = localClock(company.timezone, now);
    const sentToday = await this.prisma.addonTouch.count({
      where: { companyId: company.id, addon: 'REACTIVATION', status: { not: 'SKIPPED' }, createdAt: { gte: new Date(`${day}T00:00:00-05:00`) } },
    });
    const room = Math.max(0, Math.min(opts.limit ?? cfg.maxPerDay, cfg.maxPerDay - sentToday));
    const template = approvedTemplates(company, 'MARKETING').find((t) => t.key === cfg.templateKey) ?? null;
    const list = (await this.candidates(company, cfg, now)).slice(0, room);
    let sent = 0;
    let skipped = 0;
    for (const cand of list) {
      const contact = await this.prisma.contact.findUnique({ where: { id: cand.contactId } });
      if (!contact) continue;
      const vars = {
        nombre: firstName(contact.name), empresa: company.name, oferta: cfg.offer,
        producto: cand.lastProduct ? `¿Se te antoja otra vez ${cand.lastProduct}?` : '',
      };
      const text = fillText(cfg.message, vars);
      const res = await sendToContact(this.prisma, this.queue, {
        companyId: company.id, contact, line, text, authorName: 'Reactivación de clientes', template,
        templateVars: { '1': vars.nombre || 'hola', '2': cfg.offer || cand.lastProduct || company.name }, category: 'MARKETING',
      });
      await this.prisma.addonTouch.create({
        data: {
          companyId: company.id, addon: 'REACTIVATION', contactId: contact.id, conversationId: res.conversationId ?? null,
          step: cand.step, status: res.sent ? 'SENT' : 'SKIPPED', ...(res.sent ? { messageId: res.messageId } : { skipReason: res.reason }),
        },
      });
      if (res.sent) sent++;
      else skipped++;
    }
    return { sent, skipped, pending: Math.max(0, (await this.candidates(company, cfg, now)).length), reason: null };
  }

  /** Marca quién respondió y quién volvió a comprar después del mensaje. */
  async updateResults(companyId: string, now = new Date()) {
    const touches = await this.prisma.addonTouch.findMany({
      where: { companyId, addon: 'REACTIVATION', status: { in: ['SENT', 'REPLIED'] }, createdAt: { gte: new Date(now.getTime() - 45 * DAY) } },
    });
    for (const t of touches) {
      const order = t.contactId
        ? await this.prisma.order.findFirst({
            where: { companyId, contactId: t.contactId, status: { notIn: PURCHASE_EXCLUDED }, createdAt: { gt: t.createdAt, lte: new Date(t.createdAt.getTime() + RECOVERY_WINDOW_DAYS * DAY) }, ...NOT_DELETED },
            orderBy: { createdAt: 'asc' },
          })
        : null;
      if (order) {
        await this.prisma.addonTouch.update({ where: { id: t.id }, data: { status: 'RECOVERED', amount: order.total ?? 0, resultAt: order.createdAt } });
        continue;
      }
      if (t.status === 'SENT' && t.conversationId) {
        const reply = await this.prisma.message.findFirst({ where: { conversationId: t.conversationId, direction: 'IN', createdAt: { gt: t.createdAt } } });
        if (reply) await this.prisma.addonTouch.update({ where: { id: t.id }, data: { status: 'REPLIED', resultAt: reply.createdAt } });
      }
    }
  }

  async summary(company: any, now = new Date()) {
    const since = new Date(now.getTime() - 90 * DAY);
    const touches = await this.prisma.addonTouch.findMany({ where: { companyId: company.id, addon: 'REACTIVATION', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 500 });
    const sent = touches.filter((t: any) => t.status !== 'SKIPPED');
    const recovered = touches.filter((t: any) => t.status === 'RECOVERED');
    const candidates = await this.candidates(company, reactivationConfig(company), now);
    const contacts = await this.prisma.contact.findMany({ where: { id: { in: touches.slice(0, 60).map((t: any) => t.contactId).filter(Boolean) } }, select: { id: true, name: true } });
    const names = new Map(contacts.map((c: any) => [c.id, c.name]));
    return {
      config: reactivationConfig(company),
      templates: approvedTemplates(company, 'MARKETING').map((t) => ({ key: t.key, name: t.name ?? t.key, body: t.body ?? '' })),
      dormant: {
        total: candidates.length,
        byStep: reactivationConfig(company).thresholds.map((step) => ({ step, count: candidates.filter((c) => c.step === step).length })),
        sample: candidates.slice(0, 8).map((c) => ({ name: c.name, dormantDays: c.dormantDays, lastProduct: c.lastProduct, basis: c.basis })),
      },
      results: {
        sent: sent.length,
        replied: touches.filter((t: any) => t.status === 'REPLIED' || t.status === 'RECOVERED').length,
        recovered: recovered.length,
        revenue: recovered.reduce((s: number, t: any) => s + (t.amount ?? 0), 0),
        skipped: touches.filter((t: any) => t.status === 'SKIPPED').length,
      },
      recent: touches.slice(0, 60).map((t: any) => ({
        id: t.id, name: names.get(t.contactId) ?? 'Contacto', step: t.step, status: t.status, skipReason: t.skipReason ?? null,
        amount: t.amount ?? null, createdAt: t.createdAt, conversationId: t.conversationId,
      })),
    };
  }

  @Cron('5 * * * *')
  async hourly() {
    const companies = await this.prisma.company.findMany({ where: { status: 'ACTIVE', addonsJson: { contains: 'reactivation' } } }).catch(() => []);
    for (const company of companies as any[]) {
      if (!addonEnabled(company, 'reactivation')) continue;
      try {
        await this.updateResults(company.id);
        const cfg = reactivationConfig(company);
        if (localClock(company.timezone).hour !== cfg.sendHour) continue;
        const r = await this.run(company);
        if (r.sent || r.skipped) this.logger.log(`${company.name}: ${r.sent} enviados, ${r.skipped} omitidos`);
      } catch (err: any) {
        this.logger.error(`${company.name}: ${err.message}`);
      }
    }
  }
}
