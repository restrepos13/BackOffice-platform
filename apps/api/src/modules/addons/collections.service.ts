import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { NOT_DELETED, parseJson } from '../../common/constants';
import { WA_OUTBOUND_QUEUE } from '../../queue/queue.module';
import {
  addonEnabled, approvedTemplates, collectionsConfig, cop, fillText, firstName, localClock,
} from '../../common/addon-config';
import { sendToContact, whatsappLine } from './engine-support';

/**
 * Cobranza humanizada.
 *  - Cuentas por cobrar: salen solas de los pedidos sin pagar (si la empresa
 *    lo deja así) y también se crean a mano (servicios, cuotas, cartera).
 *  - Recordatorios amables por WhatsApp: el primero X días después del
 *    vencimiento, luego cada N días, hasta un máximo. Con el valor, el concepto
 *    y cómo pagar (link de pago del pedido o las instrucciones de la empresa).
 *  - Se detiene sola: cuando el pedido aparece pagado (link, comprobante o a
 *    mano) la cuenta queda PAGADA y no se le vuelve a escribir.
 * Corre cada hora y envía a la hora local que eligió la empresa.
 */

const DAY = 86400e3;
const OPEN_ORDER_EXCLUDED = ['borrador', 'cancelado'];

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger('Cobranza');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) private readonly queue?: Queue,
  ) {}

  /** Pedidos sin pagar → cuentas por cobrar; pedidos pagados o cancelados → cerradas. */
  async syncFromOrders(company: any) {
    const cfg = collectionsConfig(company);
    const open = await this.prisma.receivable.findMany({ where: { companyId: company.id, status: 'PENDING', orderId: { not: null } } });
    for (const r of open) {
      const order = await this.prisma.order.findUnique({ where: { id: r.orderId! } });
      if (!order || order.deletedAt || order.status === 'cancelado') {
        await this.prisma.receivable.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
      } else if (order.paymentStatus === 'PAID') {
        await this.markPaid(r.id, order.paidAt ?? new Date());
      }
    }
    if (!cfg.autoFromOrders) return;
    const orders = await this.prisma.order.findMany({
      where: {
        companyId: company.id, contactId: { not: null }, total: { gt: 0 },
        status: { notIn: OPEN_ORDER_EXCLUDED }, paymentStatus: { in: ['NONE', 'PENDING', 'FAILED'] }, ...NOT_DELETED,
        createdAt: { gte: new Date(Date.now() - 120 * DAY) },
      },
      select: { id: true, contactId: true, total: true, deliveredAt: true, deliveryAt: true, createdAt: true },
      take: 1000,
    });
    for (const o of orders) {
      const exists = await this.prisma.receivable.findFirst({ where: { companyId: company.id, orderId: o.id } });
      if (exists) continue;
      await this.prisma.receivable.create({
        data: {
          companyId: company.id, contactId: o.contactId!, orderId: o.id, concept: `Pedido del ${new Date(o.createdAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}`,
          amount: o.total!, dueDate: o.deliveredAt ?? o.deliveryAt ?? o.createdAt, status: 'PENDING', createdBy: 'Pedidos sin pagar',
        },
      });
    }
  }

  async markPaid(receivableId: string, paidAt = new Date()) {
    const r = await this.prisma.receivable.update({ where: { id: receivableId }, data: { status: 'PAID', paidAt } });
    // El último recordatorio enviado queda como "pagó" con el valor
    const last = await this.prisma.addonTouch.findFirst({ where: { receivableId, addon: 'COLLECTIONS', status: { not: 'SKIPPED' } }, orderBy: { createdAt: 'desc' } });
    if (last) await this.prisma.addonTouch.update({ where: { id: last.id }, data: { status: 'PAID', amount: r.amount, resultAt: paidAt } });
    return r;
  }

  /** Recordatorios que tocan hoy. */
  async due(company: any, now = new Date()) {
    const cfg = collectionsConfig(company);
    const pending = await this.prisma.receivable.findMany({ where: { companyId: company.id, status: 'PENDING' }, orderBy: { dueDate: 'asc' }, take: 1000 });
    return pending.filter((r: any) => {
      if (r.remindersSent >= cfg.maxReminders) return false;
      if (new Date(r.dueDate).getTime() + cfg.firstReminderDays * DAY > now.getTime()) return false;
      if (r.lastReminderAt && now.getTime() - new Date(r.lastReminderAt).getTime() < cfg.repeatEveryDays * DAY - 3600e3) return false;
      return true;
    });
  }

  private paymentHint(company: any, order: any): string {
    if (order?.paymentLinkUrl) return `Puedes pagar aquí: ${order.paymentLinkUrl}`;
    const pay = parseJson<Record<string, any>>(company.paymentConfigJson, {});
    return pay.manualInstructions ? String(pay.manualInstructions).slice(0, 300) : '';
  }

  async run(company: any, opts: { now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const cfg = collectionsConfig(company);
    await this.syncFromOrders(company);
    const line = await whatsappLine(this.prisma, company.id);
    if (!line) return { sent: 0, skipped: 0, reason: 'La empresa no tiene una línea de WhatsApp' };
    const template = approvedTemplates(company, 'UTILIDAD').find((t) => t.key === cfg.templateKey) ?? null;
    let sent = 0;
    let skipped = 0;
    for (const r of await this.due(company, now)) {
      const contact = await this.prisma.contact.findUnique({ where: { id: r.contactId } });
      if (!contact) continue;
      const order = r.orderId ? await this.prisma.order.findUnique({ where: { id: r.orderId } }) : null;
      const vars = {
        nombre: firstName(contact.name), empresa: company.name, valor: cop(r.amount), concepto: r.concept.charAt(0).toLowerCase() + r.concept.slice(1),
        fecha: new Date(r.dueDate).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }), pago: this.paymentHint(company, order),
      };
      const res = await sendToContact(this.prisma, this.queue, {
        companyId: company.id, contact, line, text: fillText(cfg.message, vars), authorName: 'Cobranza', template,
        templateVars: { '1': vars.nombre || 'hola', '2': vars.valor, '3': vars.concepto }, category: 'UTILIDAD',
      });
      await this.prisma.addonTouch.create({
        data: {
          companyId: company.id, addon: 'COLLECTIONS', contactId: contact.id, receivableId: r.id, conversationId: res.conversationId ?? null,
          step: r.remindersSent + 1, status: res.sent ? 'SENT' : 'SKIPPED', ...(res.sent ? { messageId: res.messageId } : { skipReason: res.reason }),
        },
      });
      if (res.sent) {
        await this.prisma.receivable.update({ where: { id: r.id }, data: { remindersSent: r.remindersSent + 1, lastReminderAt: now } });
        sent++;
      } else {
        skipped++;
      }
    }
    return { sent, skipped, reason: null };
  }

  /* ── Cuentas a mano ────────────────────────────────────────────── */

  async create(companyId: string, actorName: string, dto: { contactId?: string; concept?: string; amount?: number | string; dueDate?: string; notes?: string }) {
    const contact = await this.prisma.contact.findFirst({ where: { id: String(dto?.contactId ?? ''), companyId } });
    if (!contact) throw new BadRequestException('Elige el cliente que debe');
    const amount = Number(String(dto?.amount ?? '').replace(/\D/g, ''));
    if (!(amount > 0)) throw new BadRequestException('Escribe el valor que debe');
    const concept = String(dto?.concept ?? '').trim().slice(0, 120);
    if (!concept) throw new BadRequestException('Escribe el concepto (ej. Cuota de octubre)');
    const due = new Date(String(dto?.dueDate ?? ''));
    if (Number.isNaN(due.getTime())) throw new BadRequestException('Elige la fecha de vencimiento');
    return this.prisma.receivable.create({
      data: { companyId, contactId: contact.id, concept, amount, dueDate: due, status: 'PENDING', notes: dto?.notes ? String(dto.notes).slice(0, 500) : null, createdBy: actorName },
    });
  }

  async update(companyId: string, id: string, dto: { status?: string }) {
    const r = await this.prisma.receivable.findFirst({ where: { id, companyId } });
    if (!r) throw new NotFoundException('Cuenta no encontrada');
    if (dto.status === 'PAID') return this.markPaid(id);
    if (dto.status === 'CANCELLED') return this.prisma.receivable.update({ where: { id }, data: { status: 'CANCELLED' } });
    if (dto.status === 'PENDING') return this.prisma.receivable.update({ where: { id }, data: { status: 'PENDING', paidAt: null } });
    throw new BadRequestException('Estado inválido');
  }

  async summary(company: any) {
    await this.syncFromOrders(company);
    const list = await this.prisma.receivable.findMany({ where: { companyId: company.id, status: { in: ['PENDING', 'PAID'] } }, orderBy: [{ status: 'asc' }, { dueDate: 'asc' }], take: 300 });
    const contacts = await this.prisma.contact.findMany({ where: { id: { in: [...new Set(list.map((r: any) => r.contactId))] as string[] } }, select: { id: true, name: true, phone: true, optOut: true } });
    const byId = new Map(contacts.map((c: any) => [c.id, c]));
    const pending = list.filter((r: any) => r.status === 'PENDING');
    const since = new Date(Date.now() - 90 * DAY);
    const touches = await this.prisma.addonTouch.findMany({ where: { companyId: company.id, addon: 'COLLECTIONS', createdAt: { gte: since } } });
    const recovered = touches.filter((t: any) => t.status === 'PAID');
    const now = Date.now();
    return {
      config: collectionsConfig(company),
      templates: approvedTemplates(company, 'UTILIDAD').map((t) => ({ key: t.key, name: t.name ?? t.key, body: t.body ?? '' })),
      totals: {
        pendingCount: pending.length,
        pendingAmount: pending.reduce((s: number, r: any) => s + r.amount, 0),
        overdueAmount: pending.filter((r: any) => new Date(r.dueDate).getTime() < now).reduce((s: number, r: any) => s + r.amount, 0),
        remindersSent: touches.filter((t: any) => t.status !== 'SKIPPED').length,
        recoveredAmount: recovered.reduce((s: number, t: any) => s + (t.amount ?? 0), 0),
        recoveredCount: recovered.length,
      },
      receivables: list.map((r: any) => {
        const c: any = byId.get(r.contactId);
        return {
          id: r.id, contactId: r.contactId, contactName: c?.name ?? 'Cliente', optOut: !!c?.optOut, concept: r.concept, amount: r.amount,
          dueDate: r.dueDate, status: r.status, remindersSent: r.remindersSent, lastReminderAt: r.lastReminderAt, paidAt: r.paidAt,
          fromOrder: !!r.orderId, overdueDays: Math.max(0, Math.floor((now - new Date(r.dueDate).getTime()) / DAY)),
        };
      }),
    };
  }

  @Cron('10 * * * *')
  async hourly() {
    const companies = await this.prisma.company.findMany({ where: { status: 'ACTIVE', addonsJson: { contains: 'collections' } } }).catch(() => []);
    for (const company of companies as any[]) {
      if (!addonEnabled(company, 'collections')) continue;
      try {
        await this.syncFromOrders(company);
        if (localClock(company.timezone).hour !== collectionsConfig(company).sendHour) continue;
        const r = await this.run(company);
        if (r.sent || r.skipped) this.logger.log(`${company.name}: ${r.sent} recordatorios, ${r.skipped} omitidos`);
      } catch (err: any) {
        this.logger.error(`${company.name}: ${err.message}`);
      }
    }
  }
}
