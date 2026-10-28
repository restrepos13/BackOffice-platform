import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, Param, Post, Put, Query,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import {
  BillingPolicy, SUBSCRIPTION_LABEL, SUBSCRIPTION_STATUSES, SubscriptionStatus, TO_LEGACY, accessFor, canTransition, effectiveStatus,
  periodEndFrom, readPolicy, subscriptionEventId,
} from '../common/subscription';
import { deterministicId } from '../common/automation/run-signals';
import { effectiveLimit, usage } from '../common/limits';
import { computeAiCredits } from '../ai/ai-access';
import { usdCopRate } from '../common/trm';
import { forgetSubscription } from '../auth/subscription.guard';
import { AuditModule, AuditService } from './audit.module';

/**
 * Suscripciones: ciclo de vida, historial, pagos manuales comprobados por el
 * equipo, política de cobro y vistas comerciales (plataforma y empresa).
 *
 *  - La empresa sale SIEMPRE de la sesión; solo plataforma pasa companyId.
 *  - Cada cambio de estado pasa por la máquina de estados y deja un evento
 *    cuyo _id sale de su clave de idempotencia (repetirlo no hace nada).
 *  - El cambio en la empresa es compare-and-set sobre el estado leído: dos
 *    cambios simultáneos no se pisan.
 *  - Nada aquí cobra dinero: los pagos los confirma la pasarela (webhook
 *    firmado) o una persona de plataforma con su soporte.
 */

const POLICY_KEY = 'BILLING_POLICY';
const PROBLEM_LABEL: Record<string, string> = {
  PAYMENT_FAILED: 'Último pago rechazado',
  OVERDUE_NO_POLICY: 'Factura vencida sin política de gracia definida',
  PAYMENT_PENDING: 'Pago pendiente',
  GRACE: 'En periodo de gracia',
  SUSPENDED: 'Suspendida',
  ACTIVE_WITHOUT_PLAN: 'Activa sin plan asignado',
  NO_PERIOD: 'Activa sin periodo registrado (fecha de renovación desconocida)',
  OVER_LIMIT: 'Usa más recursos que su límite',
  TRIAL_EXPIRED: 'Prueba vencida',
  CANCEL_DUE: 'Cancelación pendiente de hacerse efectiva',
};

export interface TransitionInput {
  to: SubscriptionStatus;
  type: string;
  source: 'ADMIN' | 'COMPANY' | 'PAYMENT' | 'SYSTEM';
  key: string;
  actor?: AuthUser | null;
  reason?: string | null;
  refs?: Record<string, unknown>;
  /** Campos de la empresa que cambian junto con el estado (periodo, plan…) */
  data?: Record<string, unknown>;
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger('Subscriptions');
  now: () => Date = () => new Date();
  private busy = false;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /* ── Núcleo: transición con historial idempotente ── */

  /**
   * Aplica un cambio de estado. Devuelve { applied:false, duplicate:true } si
   * ese mismo cambio (misma clave) ya se registró: webhooks y tareas repetidas
   * no producen dos movimientos.
   */
  async transition(companyId: string, t: TransitionInput) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const from = effectiveStatus(company);
    const id = subscriptionEventId(companyId, t.key);
    if (await this.prisma.subscriptionEvent.findUnique({ where: { id } })) return { applied: false, duplicate: true, status: from };
    if (from !== t.to && !canTransition(from, t.to)) {
      throw new BadRequestException(`No se puede pasar de «${SUBSCRIPTION_LABEL[from]}» a «${SUBSCRIPTION_LABEL[t.to]}»`);
    }
    // Primero se reclama el evento (el _id impide duplicarlo); luego el cambio en la empresa
    try {
      await this.prisma.subscriptionEvent.create({
        data: {
          id, companyId, type: t.type, fromStatus: from, toStatus: t.to, source: t.source, actor: t.actor?.name ?? (t.source === 'SYSTEM' ? 'Sistema' : null),
          reason: t.reason?.slice(0, 500) ?? null, refsJson: JSON.stringify(t.refs ?? {}), createdAt: this.now(),
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return { applied: false, duplicate: true, status: from };
      throw err;
    }
    const legacyMatch = company.subscriptionStatus
      ? { subscriptionStatus: company.subscriptionStatus }
      : { OR: [{ subscriptionStatus: null }, { subscriptionStatus: { isSet: false } }], status: company.status };
    const at = this.now();
    const res = await this.prisma.company.updateMany({
      where: { id: companyId, ...legacyMatch },
      data: {
        subscriptionStatus: t.to,
        status: TO_LEGACY[t.to],
        ...(t.to === 'SUSPENDED' ? { suspendedAt: at } : {}),
        ...(t.to === 'ENDED' ? { endedAt: at, cancelAtPeriodEnd: false } : {}),
        ...(t.to === 'ACTIVE' ? { suspendedAt: null, cancelAtPeriodEnd: false, canceledAt: null } : {}),
        ...(t.data ?? {}),
      },
    });
    if (res.count !== 1) {
      // Otro cambio llegó primero: se deshace el evento reclamado
      await this.prisma.subscriptionEvent.delete({ where: { id } }).catch(() => undefined);
      throw new ConflictException('La suscripción cambió mientras se procesaba: vuelve a intentarlo');
    }
    forgetSubscription(companyId);
    if (t.source === 'ADMIN' || t.source === 'COMPANY') {
      await this.audit.log({ actor: t.actor ?? null, companyId, action: `subscription.${t.type.toLowerCase()}`, entity: 'Company', entityId: companyId, detail: `${from} → ${t.to}${t.reason ? ` · ${t.reason}` : ''}` });
    }
    return { applied: true, duplicate: false, from, status: t.to };
  }

  /** Registra un hecho sin cambiar el estado (p. ej., pago rechazado). Idempotente por clave. */
  async record(companyId: string, e: { type: string; source: TransitionInput['source']; key: string; reason?: string; refs?: Record<string, unknown>; actor?: AuthUser | null }) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return null;
    const status = effectiveStatus(company);
    try {
      return await this.prisma.subscriptionEvent.create({
        data: {
          id: subscriptionEventId(companyId, e.key), companyId, type: e.type, fromStatus: status, toStatus: status, source: e.source,
          actor: e.actor?.name ?? null, reason: e.reason?.slice(0, 500) ?? null, refsJson: JSON.stringify(e.refs ?? {}), createdAt: this.now(),
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return null;
      throw err;
    }
  }

  /* ── Reglas del negocio sobre el núcleo ── */

  /** Activación tras un pago confirmado por el equipo (pedido de plan). Fija el periodo pagado. */
  async activateFromOrder(actor: AuthUser, companyId: string, order: { id: string; planId: string; billingCycle: string }) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const from = effectiveStatus(company);
    const start = this.now();
    const data = { planId: order.planId, billingCycle: order.billingCycle, currentPeriodStart: start, currentPeriodEnd: periodEndFrom(start, order.billingCycle) };
    if (from === 'ACTIVE') {
      // Cambio de plan sobre una suscripción activa: queda en el historial
      await this.record(companyId, { type: 'PLAN_CHANGE', source: 'ADMIN', key: `order:${order.id}`, actor, refs: { orderId: order.id, from: company.planId, to: order.planId } });
      await this.prisma.company.update({ where: { id: companyId }, data });
      return { applied: true, status: 'ACTIVE' as const };
    }
    return this.transition(companyId, { to: 'ACTIVE', type: 'ACTIVATE', source: 'ADMIN', key: `order:${order.id}`, actor, refs: { orderId: order.id, planId: order.planId }, data });
  }

  /** Se emitió una factura por cobrar: una suscripción activa pasa a "pago pendiente" (sin perder acceso). */
  async onInvoiceIssued(companyId: string, invoice: { id: string; period: string; totalAmount: number; status: string }) {
    if (invoice.status !== 'PENDING' || !(invoice.totalAmount > 0)) return null;
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company || effectiveStatus(company) !== 'ACTIVE') return null;
    return this.transition(companyId, { to: 'PAYMENT_PENDING', type: 'PAYMENT_PENDING', source: 'SYSTEM', key: `invoice-issued:${invoice.id}`, refs: { invoiceId: invoice.id, period: invoice.period } });
  }

  /**
   * Factura pagada (pasarela o pago manual comprobado). Si la suscripción
   * estaba pendiente, en gracia o suspendida, vuelve a ACTIVA. El periodo
   * pagado es el de la factura.
   */
  async onInvoicePaid(companyId: string, invoice: { id: string; period: string }, source: 'PAYMENT' | 'ADMIN', actor?: AuthUser | null) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return null;
    const status = effectiveStatus(company);
    const [y, m] = invoice.period.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const data = { currentPeriodStart: start, currentPeriodEnd: periodEndFrom(start, company.billingCycle) };
    if (['PAYMENT_PENDING', 'GRACE', 'SUSPENDED'].includes(status)) {
      return this.transition(companyId, { to: 'ACTIVE', type: status === 'SUSPENDED' ? 'REACTIVATE' : 'PAYMENT_APPROVED', source, actor, key: `invoice-paid:${invoice.id}`, refs: { invoiceId: invoice.id, period: invoice.period }, data });
    }
    await this.record(companyId, { type: 'PAYMENT_APPROVED', source, actor, key: `invoice-paid:${invoice.id}`, refs: { invoiceId: invoice.id, period: invoice.period } });
    if (status === 'ACTIVE' || status === 'CANCELED') await this.prisma.company.update({ where: { id: companyId }, data });
    return { applied: false, status };
  }

  /**
   * Pago manual (transferencia, QR) comprobado por plataforma: marca la
   * factura pagada una sola vez (compare-and-set) y deja el soporte anotado.
   */
  async recordManualPayment(actor: AuthUser, invoiceId: string, dto: { method?: string; note?: string; confirm?: boolean }) {
    if (dto?.confirm !== true) throw new BadRequestException('Confirma que verificaste el pago en el banco');
    const method = ['TRANSFER', 'QR', 'CASH', 'OTHER'].includes(String(dto?.method)) ? String(dto.method) : null;
    if (!method) throw new BadRequestException('Indica cómo se pagó (TRANSFER, QR, CASH u OTHER)');
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    const done = await this.prisma.invoice.updateMany({ where: { id: invoiceId, status: { not: 'PAID' } }, data: { status: 'PAID', paidAt: this.now() } });
    if (done.count !== 1) throw new ConflictException('Esa factura ya estaba pagada');
    const reference = `manual_${invoice.id}`;
    await this.prisma.payment.create({
      data: {
        id: deterministicId('pay', reference), companyId: invoice.companyId, invoiceId: invoice.id, provider: 'MANUAL', reference,
        amountUsd: invoice.currency === 'USD' ? invoice.totalAmount : 0, amountInCents: Math.round(invoice.totalAmount * 100), currency: invoice.currency,
        status: 'APPROVED', paymentMethod: method, purpose: 'INVOICE',
        metaJson: JSON.stringify({ verifiedBy: actor.name, note: String(dto?.note ?? '').slice(0, 300) }),
        eventsLog: JSON.stringify([{ at: this.now().toISOString(), status: 'APPROVED', verified: true, manual: true }]),
      },
    }).catch((err: any) => { if (err?.code !== 'P2002') throw err; });
    await this.audit.log({ actor, companyId: invoice.companyId, action: 'billing.manual_payment', entity: 'Invoice', entityId: invoice.id, detail: `${invoice.period} · ${invoice.totalAmount} ${invoice.currency} · ${method}` });
    await this.onInvoicePaid(invoice.companyId, invoice, 'ADMIN', actor);
    return { ok: true };
  }

  /* ── Acciones de plataforma ── */

  async adminTransition(actor: AuthUser, companyId: string, dto: { to?: string; reason?: string; confirm?: boolean; periodDays?: number }) {
    if (!isPlatformRole(actor.role)) throw new ForbiddenException();
    const to = String(dto?.to ?? '') as SubscriptionStatus;
    if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(to)) throw new BadRequestException('Estado inválido');
    const reason = String(dto?.reason ?? '').trim();
    if (reason.length < 5) throw new BadRequestException('Escribe el motivo (queda en el historial)');
    if (['SUSPENDED', 'ENDED', 'ACTIVE'].includes(to) && dto?.confirm !== true) throw new BadRequestException('Confirma el cambio: afecta el acceso de la empresa');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    if (to === 'ACTIVE' && !company.planId) throw new BadRequestException('Asigna un plan antes de activar');
    const type = to === 'SUSPENDED' ? 'SUSPEND' : to === 'ENDED' ? 'END' : to === 'TRIAL' ? 'TRIAL_START' : to === 'ACTIVE' ? (effectiveStatus(company) === 'PENDING_ACTIVATION' || effectiveStatus(company) === 'TRIAL' ? 'ACTIVATE' : 'REACTIVATE') : to;
    const start = this.now();
    // Activar a mano fija el periodo desde hoy solo si el equipo lo indica (no se inventa una renovación)
    const days = Number(dto?.periodDays);
    const data = to === 'ACTIVE' && Number.isInteger(days) && days > 0 && days <= 400
      ? { currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + days * 86400e3) }
      : to === 'TRIAL' && Number.isInteger(days) && days > 0 && days <= 90 ? { trialEndsAt: new Date(start.getTime() + days * 86400e3) } : undefined;
    return this.transition(companyId, { to, type, source: 'ADMIN', actor, reason, key: `admin:${type}:${randomUUID()}`, data });
  }

  /* ── Acciones de la empresa ── */

  /** Cancela la renovación: el acceso sigue hasta el fin del periodo registrado. */
  async requestCancel(user: AuthUser, dto: { confirm?: boolean; reason?: string }) {
    const companyId = this.ownCompany(user);
    if (dto?.confirm !== true) throw new BadRequestException('Confirma la cancelación');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const status = effectiveStatus(company);
    if (!['ACTIVE', 'PAYMENT_PENDING', 'GRACE'].includes(status)) throw new BadRequestException(`Con la suscripción «${SUBSCRIPTION_LABEL[status]}» no hay renovación que cancelar`);
    const at = this.now();
    return this.transition(companyId, {
      to: 'CANCELED', type: 'CANCEL_REQUEST', source: 'COMPANY', actor: user, reason: String(dto?.reason ?? '').trim() || 'Pedido por la empresa',
      key: `cancel:${randomUUID()}`, data: { cancelAtPeriodEnd: true, canceledAt: at },
    });
  }

  async undoCancel(user: AuthUser) {
    const companyId = this.ownCompany(user);
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company || effectiveStatus(company) !== 'CANCELED') throw new BadRequestException('No hay una cancelación pendiente');
    if (company.currentPeriodEnd && company.currentPeriodEnd < this.now()) throw new BadRequestException('El periodo ya terminó: para volver, escribe al equipo');
    return this.transition(companyId, { to: 'ACTIVE', type: 'CANCEL_UNDO', source: 'COMPANY', actor: user, key: `cancel-undo:${randomUUID()}` });
  }

  private ownCompany(user: AuthUser) {
    if (!user.companyId) throw new ForbiddenException('Esta acción es de la empresa');
    return user.companyId;
  }

  /* ── Política y tarea programada ── */

  async policy(): Promise<BillingPolicy> {
    return readPolicy((await this.prisma.platformSetting.findUnique({ where: { key: POLICY_KEY } }))?.value);
  }

  async savePolicy(actor: AuthUser, dto: any) {
    const p = readPolicy(JSON.stringify({ graceDays: dto?.graceDays === null || dto?.graceDays === '' ? null : Number(dto?.graceDays), dueDays: dto?.dueDays === null || dto?.dueDays === '' ? null : Number(dto?.dueDays) }));
    await this.prisma.platformSetting.upsert({ where: { key: POLICY_KEY }, update: { value: JSON.stringify(p) }, create: { key: POLICY_KEY, value: JSON.stringify(p) } });
    await this.audit.log({ actor, action: 'billing.policy', entity: 'PlatformSetting', entityId: POLICY_KEY, detail: `vence a los ${p.dueDays ?? '—'} días · gracia ${p.graceDays ?? '—'} días` });
    return p;
  }

  /**
   * Revisión diaria (idempotente: cada movimiento tiene su clave):
   *  - Cancelaciones cuyo periodo terminó → FINALIZADA.
   *  - Facturas vencidas → GRACIA → SUSPENDIDA, SOLO si la política define
   *    los días; sin política no se suspende a nadie (queda como problema).
   * No cobra nada ni envía mensajes.
   */
  async runLifecycle(now = this.now()) {
    const out = { ended: 0, grace: 0, suspended: 0, skipped: 0 };
    const policy = await this.policy();
    const canceled = await this.prisma.company.findMany({ where: { subscriptionStatus: 'CANCELED', cancelAtPeriodEnd: true, currentPeriodEnd: { lt: now } }, take: 500 });
    for (const c of canceled) {
      const r = await this.transition(c.id, { to: 'ENDED', type: 'END', source: 'SYSTEM', key: `end:${c.currentPeriodEnd!.toISOString()}`, reason: 'Terminó el periodo después de cancelar la renovación' }).catch(() => null);
      if (r?.applied) out.ended++;
    }
    if (policy.dueDays === null || policy.graceDays === null) return { ...out, policy: 'PENDIENTE' };
    const owing = await this.prisma.company.findMany({ where: { subscriptionStatus: { in: ['PAYMENT_PENDING', 'GRACE'] } }, take: 500 });
    for (const c of owing) {
      const oldest = await this.prisma.invoice.findFirst({ where: { companyId: c.id, status: 'PENDING' }, orderBy: { issuedAt: 'asc' } });
      if (!oldest) { out.skipped++; continue; }
      const due = new Date(new Date(oldest.issuedAt).getTime() + policy.dueDays * 86400e3);
      const graceEnd = new Date(due.getTime() + policy.graceDays * 86400e3);
      const status = effectiveStatus(c);
      if (status === 'PAYMENT_PENDING' && now > due) {
        const r = await this.transition(c.id, { to: 'GRACE', type: 'GRACE', source: 'SYSTEM', key: `grace:${oldest.id}`, reason: `Factura ${oldest.period} vencida`, refs: { invoiceId: oldest.id } }).catch(() => null);
        if (r?.applied) out.grace++;
      } else if (status === 'GRACE' && now > graceEnd) {
        const r = await this.transition(c.id, { to: 'SUSPENDED', type: 'SUSPEND', source: 'SYSTEM', key: `suspend:${oldest.id}`, reason: `Factura ${oldest.period} sin pagar tras ${policy.graceDays} días de gracia`, refs: { invoiceId: oldest.id } }).catch(() => null);
        if (r?.applied) out.suspended++;
      }
    }
    return { ...out, policy: 'DEFINIDA' };
  }

  @Cron('15 6 * * *')
  async tick() {
    if (this.busy || process.env.BILLING_CRON_DISABLED === '1' || process.env.JEST_WORKER_ID) return;
    this.busy = true;
    try {
      const r = await this.runLifecycle();
      this.logger.log(`Ciclo de suscripciones: ${JSON.stringify(r)}`);
    } catch (err: any) {
      this.logger.error(`Ciclo de suscripciones: ${String(err?.message ?? err).slice(0, 200)}`);
    } finally {
      this.busy = false;
    }
  }

  /* ── Vistas ── */

  private async usageOf(company: any) {
    const [usersL, botsL, usersU, botsU, lines, credits] = await Promise.all([
      effectiveLimit(this.prisma, company.id, 'users'), effectiveLimit(this.prisma, company.id, 'bots'),
      usage(this.prisma, company.id, 'users'), usage(this.prisma, company.id, 'bots'),
      this.prisma.integration.count({ where: { companyId: company.id, type: 'WHATSAPP' } }),
      computeAiCredits(this.prisma, company, this.now()),
    ]);
    const plan = company.planId ? await this.prisma.plan.findUnique({ where: { id: company.planId } }) : null;
    return {
      users: { used: usersU, max: usersL.max, source: usersL.source },
      bots: { used: botsU, max: botsL.max, source: botsL.source },
      whatsappLines: { used: lines, max: plan?.line === 'WPP' ? plan.maxLines ?? 1 : null },
      ai: {
        mode: credits.mode, period: credits.period, includedMonthly: credits.includedMonthly, includedUsed: credits.includedUsed,
        prepaidBalance: credits.balance,
      },
    };
  }

  private async problemsOf(company: any, policy: BillingPolicy, u?: Awaited<ReturnType<SubscriptionsService['usageOf']>>) {
    const status = effectiveStatus(company);
    const out: string[] = [];
    const lastPay = await this.prisma.payment.findFirst({ where: { companyId: company.id, purpose: { not: 'ORDER' } }, orderBy: { createdAt: 'desc' } });
    if (lastPay && ['DECLINED', 'ERROR', 'VOIDED'].includes(lastPay.status)) out.push('PAYMENT_FAILED');
    if (status === 'PAYMENT_PENDING') {
      out.push('PAYMENT_PENDING');
      if (policy.graceDays === null || policy.dueDays === null) out.push('OVERDUE_NO_POLICY');
    }
    if (status === 'GRACE') out.push('GRACE');
    if (status === 'SUSPENDED') out.push('SUSPENDED');
    if (['ACTIVE', 'PAYMENT_PENDING', 'GRACE'].includes(status) && !company.planId) out.push('ACTIVE_WITHOUT_PLAN');
    if (status === 'ACTIVE' && !company.currentPeriodEnd) out.push('NO_PERIOD');
    if (status === 'TRIAL' && company.trialEndsAt && company.trialEndsAt < this.now()) out.push('TRIAL_EXPIRED');
    if (status === 'CANCELED' && company.currentPeriodEnd && company.currentPeriodEnd < this.now()) out.push('CANCEL_DUE');
    if (u && ((u.users.max !== null && u.users.used > u.users.max) || (u.bots.max !== null && u.bots.used > u.bots.max) || (u.whatsappLines.max !== null && u.whatsappLines.used > u.whatsappLines.max))) out.push('OVER_LIMIT');
    return out.map((k) => ({ key: k, label: PROBLEM_LABEL[k] }));
  }

  private priceOf(company: any, plan: any) {
    if (!plan) return null;
    const custom = company.customPriceMonthly ?? null;
    return { monthly: custom ?? plan.priceMonthly, currency: plan.currency, cycle: company.billingCycle ?? 'MONTHLY', custom: custom !== null };
  }

  /** Panel global: empresas con su suscripción y problemas detectados. */
  async adminList(actor: AuthUser, q: { status?: string; problem?: string }) {
    if (!isPlatformRole(actor.role)) throw new ForbiddenException();
    const [companies, plans, policy] = await Promise.all([
      this.prisma.company.findMany({ select: { id: true, name: true, slug: true, status: true, subscriptionStatus: true, planId: true, billingCycle: true, customPriceMonthly: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, trialEndsAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1000 }),
      this.prisma.plan.findMany(),
      this.policy(),
    ]);
    const planById = new Map(plans.map((p) => [p.id, p]));
    const rows: any[] = [];
    for (const c of companies) {
      const status = effectiveStatus(c);
      if (q.status && status !== q.status) continue;
      const plan = c.planId ? planById.get(c.planId) : null;
      const problems = await this.problemsOf(c, policy);
      if (q.problem && !problems.some((p) => p.key === q.problem)) continue;
      rows.push({
        id: c.id, name: c.name, slug: c.slug, status, statusLabel: SUBSCRIPTION_LABEL[status], legacy: !c.subscriptionStatus,
        plan: plan ? { id: plan.id, name: plan.name, line: plan.line, active: plan.active } : null, price: this.priceOf(c, plan),
        currentPeriodEnd: c.currentPeriodEnd, cancelAtPeriodEnd: !!c.cancelAtPeriodEnd, problems,
      });
    }
    return { policy, items: rows };
  }

  async adminDetail(actor: AuthUser, companyId: string) {
    if (!isPlatformRole(actor.role)) throw new ForbiddenException();
    return this.detail(companyId, true);
  }

  /** Portal de la empresa: solo lo suyo, sin costos internos ni datos de otras. */
  async mine(user: AuthUser) {
    return this.detail(this.ownCompany(user), false);
  }

  private async detail(companyId: string, platform: boolean) {
    const company: any = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const plan = company.planId ? await this.prisma.plan.findUnique({ where: { id: company.planId } }) : null;
    const status = effectiveStatus(company);
    const [events, invoices, payments, u, policy] = await Promise.all([
      this.prisma.subscriptionEvent.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.invoice.findMany({ where: { companyId }, orderBy: { period: 'desc' }, take: 24 }),
      this.prisma.payment.findMany({ where: { companyId, purpose: { not: 'ORDER' } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.usageOf(company),
      this.policy(),
    ]);
    return {
      companyId, name: company.name, status, statusLabel: SUBSCRIPTION_LABEL[status], access: accessFor(status), legacy: !company.subscriptionStatus,
      plan: plan ? {
        id: plan.id, name: plan.name, code: plan.code, description: plan.description ?? null, line: plan.line, currency: plan.currency,
        features: parseJson<string[]>(plan.featuresJson, []), includedProducts: parseJson<string[] | null>(plan.includedProductsJson, null),
        maxUsers: plan.maxUsers, maxBots: plan.maxBots, maxLines: plan.maxLines, includedAiConversations: plan.includedAiConversations,
      } : null,
      price: this.priceOf(company, plan),
      contractedProducts: parseJson<Record<string, any> | null>(company.productsJson, null),
      period: { start: company.currentPeriodStart ?? null, end: company.currentPeriodEnd ?? null },
      // Sin cobro recurrente automático: no hay "próximo cobro" que mostrar como si fuera un hecho
      nextCharge: { date: null, note: 'Los cobros los coordina el equipo de BackOffice (no hay débito automático).' },
      cancelAtPeriodEnd: !!company.cancelAtPeriodEnd, canceledAt: company.canceledAt ?? null, trialEndsAt: company.trialEndsAt ?? null,
      usage: u,
      invoices: invoices.map((i) => ({ id: i.id, period: i.period, total: i.totalAmount, currency: i.currency, status: i.status, issuedAt: i.issuedAt, paidAt: i.paidAt })),
      payments: payments.map((p) => ({
        id: p.id, reference: p.reference, provider: p.provider, status: p.status, purpose: p.purpose, method: p.paymentMethod,
        amount: p.amountInCents / 100, currency: p.currency, createdAt: p.createdAt,
      })),
      events: events.map((e) => ({ id: e.id, type: e.type, from: e.fromStatus, to: e.toStatus, source: e.source, actor: e.actor, reason: e.reason, at: e.createdAt, ...(platform ? { refs: parseJson(e.refsJson, {}) } : {}) })),
      ...(platform ? { problems: await this.problemsOf(company, policy, u), policy } : {}),
      actions: platform ? [] : [
        ...(['ACTIVE', 'PAYMENT_PENDING', 'GRACE'].includes(status) ? ['CANCEL'] : []),
        ...(status === 'CANCELED' ? ['UNDO_CANCEL'] : []),
        'CHANGE_PLAN_REQUEST',
      ],
    };
  }

  /**
   * Economía por empresa (solo plataforma). Separa lo MEDIDO de lo ESTIMADO
   * y no suma monedas distintas sin decir con qué tasa.
   */
  async economics(actor: AuthUser, companyId: string, period?: string) {
    if (!isPlatformRole(actor.role)) throw new ForbiddenException();
    const p = /^\d{4}-\d{2}$/.test(String(period ?? '')) ? String(period) : this.now().toISOString().slice(0, 7);
    const [y, m] = p.split('-').map(Number);
    const since = new Date(Date.UTC(y, m - 1, 1));
    const until = new Date(Date.UTC(y, m, 1));
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const [invoices, aiEvents, messages, grants, purchases] = await Promise.all([
      this.prisma.invoice.findMany({ where: { companyId, period: p } }),
      this.prisma.aiUsageEvent.findMany({ where: { companyId, createdAt: { gte: since, lt: until } }, select: { costUsd: true, billedTo: true } }),
      this.prisma.message.findMany({ where: { conversation: { companyId }, direction: 'OUT', createdAt: { gte: since, lt: until }, metaCostUsd: { gt: 0 } }, select: { metaCostUsd: true, deliveryStatus: true } }),
      this.prisma.aiCreditLot.findMany({ where: { companyId, source: 'GRANT', createdAt: { gte: since, lt: until } }, select: { total: true } }),
      this.prisma.payment.findMany({ where: { companyId, purpose: 'AI_CREDITS', status: 'APPROVED', createdAt: { gte: since, lt: until } }, select: { amountInCents: true, currency: true } }),
    ]);
    const paid = invoices.filter((i) => i.status === 'PAID');
    const round = (n: number) => Math.round(n * 100) / 100;
    const aiPlatformUsd = round(aiEvents.filter((e) => e.billedTo === 'PLATFORM').reduce((s, e) => s + (e.costUsd ?? 0), 0));
    // Mensajes simulados no costaron nada: solo cuentan los que salieron
    const metaUsd = round(messages.filter((x) => ['SENT', 'DELIVERED', 'READ'].includes(x.deliveryStatus ?? '')).reduce((s, x) => s + (x.metaCostUsd ?? 0), 0));
    let trm: number | null = null;
    try { trm = await usdCopRate(this.prisma); } catch { trm = null; }
    const revenue = paid.reduce((acc: Record<string, number>, i) => ({ ...acc, [i.currency]: round((acc[i.currency] ?? 0) + i.totalAmount) }), {});
    const costsUsd = aiPlatformUsd + metaUsd;
    const revenueInCop = Object.entries(revenue).reduce((s, [cur, v]) => s + (cur === 'COP' ? v : cur === 'USD' && trm ? v * trm : NaN), 0);
    return {
      period: p,
      revenue: { measured: revenue, invoicesPaid: paid.length, invoicesPending: invoices.filter((i) => i.status === 'PENDING').length, aiPackagesSold: purchases.length },
      costs: {
        aiProviderUsd: { value: aiPlatformUsd, kind: 'MEASURED', note: 'Costo de IA pagado por BackOffice (modo plataforma), según el registro de uso con la tarifa del modelo.' },
        messagingUsd: { value: metaUsd, kind: 'ESTIMATED', note: 'Tarifa de Meta configurada por categoría × mensajes enviados; no es la factura del proveedor.' },
        infrastructure: { value: null, kind: 'UNKNOWN', note: 'No se mide por empresa: hace falta un criterio de reparto (pendiente).' },
        adsApis: { value: 0, kind: 'MEASURED', note: 'Las APIs de anuncios de Meta no cobran por llamada.' },
        promotionalCredits: { conversations: grants.reduce((s, g) => s + g.total, 0), kind: 'MEASURED', note: 'Créditos de IA regalados en el periodo (cantidad, no dinero).' },
      },
      margin: Number.isFinite(revenueInCop) && trm
        ? { valueCop: Math.round(revenueInCop - costsUsd * trm), kind: 'ESTIMATED', trm, note: 'Ingresos cobrados menos IA medida y mensajería estimada, convertidos con la TRM del día. No incluye infraestructura.' }
        : { valueCop: null, kind: 'UNKNOWN', trm, note: 'No hay TRM disponible o hay monedas sin tasa: no se calcula un margen.' },
    };
  }
}

const PLATFORM = [ROLES.SUPER_ADMIN, ROLES.DEV] as const;

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get() @Roles(...PLATFORM)
  list(@CurrentUser() u: AuthUser, @Query() q: { status?: string; problem?: string }) { return this.subs.adminList(u, q); }

  @Get('policy') @Roles(...PLATFORM)
  policy() { return this.subs.policy(); }

  @Put('policy') @Roles(ROLES.SUPER_ADMIN)
  savePolicy(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.subs.savePolicy(u, dto); }

  @Post('run') @Roles(ROLES.SUPER_ADMIN) @Throttle({ default: { ttl: 60_000, limit: 3 } })
  run() { return this.subs.runLifecycle(); }

  /** Portal de la empresa (antes de :companyId para que no lo capture) */
  @Get('me') @Roles(ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  mine(@CurrentUser() u: AuthUser) { return this.subs.mine(u); }

  @Post('me/cancel') @Roles(ROLES.COMPANY_ADMIN)
  cancel(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.subs.requestCancel(u, dto); }

  @Post('me/undo-cancel') @Roles(ROLES.COMPANY_ADMIN)
  undoCancel(@CurrentUser() u: AuthUser) { return this.subs.undoCancel(u); }

  @Post('invoices/:invoiceId/manual-payment') @Roles(ROLES.SUPER_ADMIN) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  manualPayment(@CurrentUser() u: AuthUser, @Param('invoiceId') id: string, @Body() dto: any) { return this.subs.recordManualPayment(u, id, dto); }

  @Get(':companyId') @Roles(...PLATFORM)
  detail(@CurrentUser() u: AuthUser, @Param('companyId') id: string) { return this.subs.adminDetail(u, id); }

  @Get(':companyId/economics') @Roles(...PLATFORM)
  economics(@CurrentUser() u: AuthUser, @Param('companyId') id: string, @Query('period') period?: string) { return this.subs.economics(u, id, period); }

  @Post(':companyId/transition') @Roles(ROLES.SUPER_ADMIN)
  transition(@CurrentUser() u: AuthUser, @Param('companyId') id: string, @Body() dto: any) { return this.subs.adminTransition(u, id, dto); }
}

@Module({
  imports: [AuditModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}

