/**
 * Fase 5 · Administración comercial: catálogo único, ciclo de vida de la
 * suscripción, pagos (Wompi simulado: ningún cobro real), webhooks repetidos
 * y fuera de orden, límites ante concurrencia, créditos sin doble descuento,
 * tareas programadas idempotentes, panel global y portal de la empresa.
 */
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SubscriptionsController, SubscriptionsService } from '../src/modules/subscriptions.module';
import { PaymentsService } from '../src/modules/payments.module';
import { PlansService } from '../src/modules/plans.module';
import { CheckoutService } from '../src/modules/checkout.module';
import { BillingService } from '../src/modules/billing.module';
import { IntegrationsService } from '../src/modules/integrations.module';
import { SubscriptionGuard } from '../src/auth/subscription.guard';
import { TRANSITIONS, accessFor, canTransition, effectiveStatus, readPolicy } from '../src/common/subscription';
import { consumeAiCredit, creditAiLot } from '../src/ai/ai-access';
import { signEvent } from '../src/common/wompi';
import { ROLES_KEY } from '../src/auth/decorators';
import { createMockPrisma } from './helpers/mock-prisma';

const PLATFORM = { id: 'p1', name: 'Santi', email: 's@b.co', role: 'SUPER_ADMIN' as const, companyId: null };
const DEV = { id: 'p2', name: 'Dani', email: 'd@b.co', role: 'DEV' as const, companyId: null };
const ADMIN_A = { id: 'uA', name: 'Ana', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const VIEWER_A = { id: 'uV', name: 'Vera', email: 'v@a.co', role: 'COMPANY_VIEWER' as const, companyId: 'coA' };
const ADMIN_B = { id: 'uB', name: 'Bruno', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const NOW = new Date('2026-10-27T12:00:00Z');

function world(companyOver: Record<string, any> = {}) {
  const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: true });
  const audit = { log: jest.fn(async () => undefined) };
  db.plan.push(
    { id: 'plan1', code: 'basico', name: 'Básico', priceMonthly: 150000, currency: 'COP', line: 'WPP', maxUsers: 3, maxBots: 1, maxLines: 1, maxWorkspaces: 1, featuresJson: '[]', active: true, includedAiConversations: 2 },
    { id: 'old', code: 'pro-viejo', name: 'Pro viejo', priceMonthly: 49, currency: 'USD', line: 'PRO', maxUsers: 5, maxBots: 2, maxWorkspaces: 1, featuresJson: '[]', active: false, includedAiConversations: 0 },
  );
  db.company.push(
    { id: 'coA', name: 'Aurora', slug: 'aurora', status: 'ACTIVE', planId: 'plan1', billingCycle: 'MONTHLY', productsJson: null, limitsJson: '{}', addonsJson: null, onboardingJson: null, modulesJson: '[]', landingJson: null, paymentConfigJson: '{}', ...companyOver },
    { id: 'coB', name: 'Otra', slug: 'otra', status: 'ONBOARDING', planId: null, billingCycle: 'MONTHLY', limitsJson: '{}' },
  );
  const subs = new SubscriptionsService(prisma as any, audit as any);
  subs.now = () => NOW;
  return { prisma, db, audit, subs };
}

describe('Comercial · máquina de estados', () => {
  it('solo transiciones explícitas; cancelar no quita el acceso, finalizar sí', () => {
    expect(canTransition('ACTIVE', 'CANCELED')).toBe(true);
    expect(canTransition('ENDED', 'TRIAL')).toBe(false);
    expect(canTransition('PENDING_ACTIVATION', 'SUSPENDED')).toBe(false);
    expect(canTransition('CANCELED', 'PAYMENT_PENDING')).toBe(false);
    expect(Object.keys(TRANSITIONS)).toHaveLength(8);
    expect(accessFor('CANCELED')).toBe('FULL');
    expect(accessFor('GRACE')).toBe('FULL');
    expect(accessFor('SUSPENDED')).toBe('READ_ONLY');
    expect(accessFor('ENDED')).toBe('READ_ONLY');
  });

  it('empresas existentes: el estado se deriva del anterior sin migrar datos', () => {
    expect(effectiveStatus({ status: 'ONBOARDING' })).toBe('PENDING_ACTIVATION');
    expect(effectiveStatus({ status: 'ACTIVE' })).toBe('ACTIVE');
    expect(effectiveStatus({ status: 'CANCELLED' })).toBe('ENDED');
    expect(effectiveStatus({ status: 'ACTIVE', subscriptionStatus: 'GRACE' })).toBe('GRACE');
    expect(effectiveStatus({ status: 'RARO' })).toBe('PENDING_ACTIVATION');
  });

  it('una transición inválida se rechaza; la misma clave dos veces no duplica; el estado anterior se sincroniza', async () => {
    const { subs, db } = world();
    await expect(subs.transition('coA', { to: 'TRIAL', type: 'X', source: 'ADMIN', key: 'k0' })).rejects.toThrow(/No se puede pasar/);
    const r1 = await subs.transition('coA', { to: 'PAYMENT_PENDING', type: 'PAYMENT_PENDING', source: 'SYSTEM', key: 'invoice-issued:i1' });
    const r2 = await subs.transition('coA', { to: 'PAYMENT_PENDING', type: 'PAYMENT_PENDING', source: 'SYSTEM', key: 'invoice-issued:i1' });
    expect(r1).toMatchObject({ applied: true, from: 'ACTIVE', status: 'PAYMENT_PENDING' });
    expect(r2).toMatchObject({ applied: false, duplicate: true });
    expect(db.subscriptionEvent).toHaveLength(1);
    // Lo que ya consulta Company.status (crons de complementos) sigue viendo ACTIVE
    expect(db.company[0]).toMatchObject({ subscriptionStatus: 'PAYMENT_PENDING', status: 'ACTIVE' });
  });

  it('dos cambios simultáneos distintos: uno gana y el otro se rechaza sin dejar historial falso', async () => {
    const { subs, db } = world();
    const r = await Promise.allSettled([
      subs.transition('coA', { to: 'SUSPENDED', type: 'SUSPEND', source: 'ADMIN', key: 'a' }),
      subs.transition('coA', { to: 'CANCELED', type: 'CANCEL_REQUEST', source: 'COMPANY', key: 'b' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(db.subscriptionEvent).toHaveLength(1);
  });
});

describe('Comercial · pagos con Wompi (simulado)', () => {
  function pay(w: ReturnType<typeof world>) {
    w.db.platformSetting.push({ key: 'WOMPI_EVENTS_SECRET', value: 'evsecret' }, { key: 'WOMPI_ENV', value: 'test' });
    w.db.invoice.push({ id: 'inv1', companyId: 'coA', period: '2026-10', totalAmount: 150000, currency: 'COP', status: 'PENDING', issuedAt: NOW });
    w.db.payment.push({ id: 'pay1', companyId: 'coA', invoiceId: 'inv1', provider: 'WOMPI', reference: 'BO-REF-1', amountUsd: 0, amountInCents: 15000000, currency: 'COP', status: 'PENDING', purpose: 'INVOICE', eventsLog: '[]', metaJson: '{}' });
    const payments = new PaymentsService(w.prisma as any, w.audit as any, undefined, w.subs);
    const event = (status: string, extra: Record<string, unknown> = {}) => {
      const data = { transaction: { id: `tx-${status}`, reference: 'BO-REF-1', status, amount_in_cents: 15000000, currency: 'COP', ...extra } };
      const timestamp = 1761566400;
      return { data, timestamp, signature: signEvent(data, timestamp, 'evsecret', ['transaction.id', 'transaction.status', 'transaction.amount_in_cents']) };
    };
    return { payments, event };
  }

  it('aprobado → factura pagada y suscripción activa con el periodo de la factura; repetido no hace nada más', async () => {
    const w = world({ subscriptionStatus: 'PAYMENT_PENDING' });
    const { payments, event } = pay(w);
    await payments.handleWompiEvent(event('APPROVED'));
    expect(w.db.invoice[0].status).toBe('PAID');
    expect(w.db.company[0]).toMatchObject({ subscriptionStatus: 'ACTIVE', currentPeriodStart: new Date('2026-10-01T00:00:00Z') });
    expect(w.db.company[0].currentPeriodEnd.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    const events = w.db.subscriptionEvent.length;
    expect(await payments.handleWompiEvent(event('APPROVED'))).toMatchObject({ duplicate: true });
    await Promise.all([payments.handleWompiEvent(event('APPROVED')), payments.handleWompiEvent(event('APPROVED'))]);
    expect(w.db.subscriptionEvent).toHaveLength(events);
  });

  it('un aviso tardío (PENDING) no hace retroceder un pago aprobado', async () => {
    const w = world({ subscriptionStatus: 'PAYMENT_PENDING' });
    const { payments, event } = pay(w);
    await payments.handleWompiEvent(event('APPROVED'));
    await payments.handleWompiEvent(event('PENDING'));
    expect(w.db.payment[0].status).toBe('APPROVED');
    expect(JSON.parse(w.db.payment[0].eventsLog).map((e: any) => e.status)).toEqual(['APPROVED', 'PENDING']);
  });

  it('rechazado: queda en el historial como pago fallido, sin cambiar el estado ni marcar pagada la factura', async () => {
    const w = world({ subscriptionStatus: 'PAYMENT_PENDING' });
    const { payments, event } = pay(w);
    await payments.handleWompiEvent(event('DECLINED', { status_message: 'Fondos insuficientes' }));
    await payments.handleWompiEvent(event('DECLINED', { status_message: 'Fondos insuficientes' }));
    expect(w.db.invoice[0].status).toBe('PENDING');
    expect(w.db.company[0].subscriptionStatus).toBe('PAYMENT_PENDING');
    expect(w.db.subscriptionEvent.filter((e: any) => e.type === 'PAYMENT_FAILED')).toHaveLength(1);
    const list = await w.subs.adminList(PLATFORM, {});
    expect(list.items.find((c: any) => c.id === 'coA').problems.map((p: any) => p.key)).toEqual(expect.arrayContaining(['PAYMENT_FAILED', 'PAYMENT_PENDING', 'OVERDUE_NO_POLICY']));
  });

  it('monto distinto al cobrado: no se aplica nada y queda para revisión; firma inválida se rechaza', async () => {
    const w = world({ subscriptionStatus: 'PAYMENT_PENDING' });
    const { payments, event } = pay(w);
    expect(await payments.handleWompiEvent(event('APPROVED', { amount_in_cents: 100 }))).toMatchObject({ status: 'REVIEW' });
    expect(w.db.invoice[0].status).toBe('PENDING');
    expect(w.db.company[0].subscriptionStatus).toBe('PAYMENT_PENDING');
    const e = event('APPROVED');
    await expect(payments.handleWompiEvent({ ...e, signature: { ...e.signature, checksum: 'x'.repeat(64) } })).rejects.toThrow(/Firma/);
  });

  it('dos webhooks aprobados simultáneos de un paquete de IA acreditan una sola vez (sin índice único)', async () => {
    const w = world();
    await Promise.all([
      creditAiLot(w.prisma, { companyId: 'coA', conversations: 500, source: 'PURCHASE', paymentRef: 'REF-IA' }),
      creditAiLot(w.prisma, { companyId: 'coA', conversations: 500, source: 'PURCHASE', paymentRef: 'REF-IA' }),
    ]);
    expect(w.db.aiCreditLot).toHaveLength(1);
  });
});

describe('Comercial · pago manual, cancelación y renovación', () => {
  it('pago manual comprobado: exige confirmación, solo una vez, reactiva una suspendida y queda auditado', async () => {
    const w = world({ subscriptionStatus: 'SUSPENDED' });
    w.db.invoice.push({ id: 'inv2', companyId: 'coA', period: '2026-10', totalAmount: 150000, currency: 'COP', status: 'PENDING', issuedAt: NOW });
    await expect(w.subs.recordManualPayment(PLATFORM, 'inv2', { method: 'TRANSFER' })).rejects.toThrow(/Confirma/);
    await expect(w.subs.recordManualPayment(PLATFORM, 'inv2', { method: 'BITCOIN', confirm: true })).rejects.toThrow(/cómo se pagó/);
    await w.subs.recordManualPayment(PLATFORM, 'inv2', { method: 'TRANSFER', note: 'Comprobante 123', confirm: true });
    await expect(w.subs.recordManualPayment(PLATFORM, 'inv2', { method: 'TRANSFER', confirm: true })).rejects.toBeInstanceOf(ConflictException);
    expect(w.db.payment).toHaveLength(1);
    expect(w.db.payment[0]).toMatchObject({ provider: 'MANUAL', status: 'APPROVED', paymentMethod: 'TRANSFER' });
    expect(w.db.company[0].subscriptionStatus).toBe('ACTIVE');
    expect(w.db.subscriptionEvent.at(-1)).toMatchObject({ type: 'REACTIVATE', source: 'ADMIN', actor: 'Santi' });
    expect((w.audit.log.mock.calls as any[]).some((c) => c[0].action === 'billing.manual_payment')).toBe(true);
  });

  it('la empresa cancela la renovación (sigue con acceso), puede deshacerlo, y al terminar el periodo queda finalizada una sola vez', async () => {
    const w = world({ subscriptionStatus: 'ACTIVE', currentPeriodEnd: new Date('2026-11-15T00:00:00Z') });
    await expect(w.subs.requestCancel(ADMIN_A, {})).rejects.toThrow(/Confirma/);
    await w.subs.requestCancel(ADMIN_A, { confirm: true, reason: 'Cerramos la sede' });
    expect(w.db.company[0]).toMatchObject({ subscriptionStatus: 'CANCELED', cancelAtPeriodEnd: true, status: 'ACTIVE' });
    expect(accessFor(effectiveStatus(w.db.company[0]))).toBe('FULL');
    await w.subs.undoCancel(ADMIN_A);
    expect(w.db.company[0]).toMatchObject({ subscriptionStatus: 'ACTIVE', cancelAtPeriodEnd: false });
    await w.subs.requestCancel(ADMIN_A, { confirm: true });
    expect(await w.subs.runLifecycle(new Date('2026-11-10T00:00:00Z'))).toMatchObject({ ended: 0 });
    expect(await w.subs.runLifecycle(new Date('2026-11-16T00:00:00Z'))).toMatchObject({ ended: 1 });
    expect(await w.subs.runLifecycle(new Date('2026-11-17T00:00:00Z'))).toMatchObject({ ended: 0 });
    expect(w.db.company[0]).toMatchObject({ subscriptionStatus: 'ENDED', status: 'CANCELLED' });
    expect(w.db.subscriptionEvent.filter((e: any) => e.type === 'END')).toHaveLength(1);
  });

  it('sin política de gracia definida no se suspende a nadie; con política: vencida → gracia → suspendida, sin repetir', async () => {
    const w = world({ subscriptionStatus: 'PAYMENT_PENDING' });
    w.db.invoice.push({ id: 'inv3', companyId: 'coA', period: '2026-10', totalAmount: 150000, currency: 'COP', status: 'PENDING', issuedAt: new Date('2026-10-01T00:00:00Z') });
    expect(await w.subs.runLifecycle(new Date('2026-12-30T00:00:00Z'))).toMatchObject({ policy: 'PENDIENTE', grace: 0, suspended: 0 });
    expect(w.db.company[0].subscriptionStatus).toBe('PAYMENT_PENDING');
    await w.subs.savePolicy(PLATFORM, { dueDays: 10, graceDays: 5 });
    expect(await w.subs.runLifecycle(new Date('2026-10-05T00:00:00Z'))).toMatchObject({ grace: 0 });
    expect(await w.subs.runLifecycle(new Date('2026-10-12T00:00:00Z'))).toMatchObject({ grace: 1 });
    expect(await w.subs.runLifecycle(new Date('2026-10-12T05:00:00Z'))).toMatchObject({ grace: 0 });
    expect(await w.subs.runLifecycle(new Date('2026-10-17T00:00:00Z'))).toMatchObject({ suspended: 1 });
    expect(w.db.company[0]).toMatchObject({ subscriptionStatus: 'SUSPENDED', status: 'SUSPENDED' });
    expect(readPolicy('{"graceDays":-3,"dueDays":"x"}')).toEqual({ graceDays: null, dueDays: null });
  });
});

describe('Comercial · acceso según la suscripción (servidor)', () => {
  async function can(w: ReturnType<typeof world>, user: any, method: string, path: string) {
    const guard = new SubscriptionGuard({ getAllAndOverride: () => false } as any, w.prisma as any);
    const ctx: any = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ user, method, path }) }) };
    return guard.canActivate(ctx).then(() => true, () => false);
  }

  it('suspendida: puede consultar y pagar, no cambiar nada; plataforma no se limita', async () => {
    const w = world({ id: 'coS', subscriptionStatus: 'SUSPENDED' });
    const u = { ...ADMIN_A, companyId: 'coS' };
    expect(await can(w, u, 'GET', '/api/contacts')).toBe(true);
    expect(await can(w, u, 'POST', '/api/contacts')).toBe(false);
    expect(await can(w, u, 'POST', '/api/payments/checkout')).toBe(true);
    expect(await can(w, u, 'POST', '/api/subscriptions/me/cancel')).toBe(true);
    expect(await can(w, PLATFORM, 'POST', '/api/contacts')).toBe(true);
    const ok = world({ id: 'coOk', subscriptionStatus: 'CANCELED' });
    expect(await can(ok, { ...ADMIN_A, companyId: 'coOk' }, 'POST', '/api/contacts')).toBe(true);
  });
});

describe('Comercial · panel global y portal', () => {
  it('el panel es solo de plataforma; activar o suspender exige motivo y confirmación', async () => {
    const { subs, db } = world();
    await expect(subs.adminList(ADMIN_A, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(subs.adminTransition(ADMIN_A, 'coB', { to: 'ACTIVE', reason: 'quiero', confirm: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(subs.economics(ADMIN_A, 'coA')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(subs.adminTransition(PLATFORM, 'coA', { to: 'SUSPENDED', reason: 'x' })).rejects.toThrow(/motivo/);
    await expect(subs.adminTransition(PLATFORM, 'coA', { to: 'SUSPENDED', reason: 'Impago de octubre' })).rejects.toThrow(/Confirma/);
    await expect(subs.adminTransition(PLATFORM, 'coB', { to: 'ACTIVE', reason: 'Pagó por transferencia', confirm: true })).rejects.toThrow(/Asigna un plan/);
    await subs.adminTransition(PLATFORM, 'coA', { to: 'SUSPENDED', reason: 'Impago de octubre', confirm: true });
    expect(db.company[0].subscriptionStatus).toBe('SUSPENDED');
    const roles = (m: string) => Reflect.getMetadata(ROLES_KEY, (SubscriptionsController.prototype as any)[m]) as string[];
    expect(roles('transition')).toEqual(['SUPER_ADMIN']);
    expect(roles('list')).toEqual(['SUPER_ADMIN', 'DEV']);
    expect(roles('cancel')).toEqual(['COMPANY_ADMIN']);
    expect(roles('mine')).toEqual(expect.arrayContaining(['COMPANY_ADMIN', 'COMPANY_VIEWER']));
    void DEV;
  });

  it('el portal muestra solo lo de la empresa de la sesión, sin fecha de cobro inventada ni datos internos', async () => {
    const { subs, db } = world();
    db.invoice.push({ id: 'iA', companyId: 'coA', period: '2026-10', totalAmount: 150000, currency: 'COP', status: 'PAID', issuedAt: NOW, paidAt: NOW });
    db.invoice.push({ id: 'iB', companyId: 'coB', period: '2026-10', totalAmount: 9, currency: 'COP', status: 'PENDING', issuedAt: NOW });
    const me: any = await subs.mine(ADMIN_A);
    expect(me.companyId).toBe('coA');
    expect(me.invoices.map((i: any) => i.id)).toEqual(['iA']);
    expect(me.nextCharge.date).toBeNull();
    expect(me.plan).toMatchObject({ name: 'Básico', maxUsers: 3 });
    expect(me.price).toEqual({ monthly: 150000, currency: 'COP', cycle: 'MONTHLY', custom: false });
    expect(me).not.toHaveProperty('problems');
    expect(me.actions).toContain('CANCEL');
    expect((await subs.mine(VIEWER_A)).companyId).toBe('coA');
    expect((await subs.mine(ADMIN_B)).companyId).toBe('coB');
    await expect(subs.mine(PLATFORM as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('economía: separa lo medido de lo estimado y no cuenta mensajes simulados', async () => {
    const { subs, db } = world();
    db.invoice.push({ id: 'iA', companyId: 'coA', period: '2026-10', totalAmount: 150000, currency: 'COP', status: 'PAID', issuedAt: NOW });
    db.aiUsageEvent.push({ id: 'e1', companyId: 'coA', billedTo: 'PLATFORM', costUsd: 0.5, createdAt: new Date('2026-10-10T00:00:00Z') });
    db.contact.push({ id: 'ct', companyId: 'coA' });
    db.conversation.push({ id: 'cv', companyId: 'coA', contactId: 'ct' });
    db.message.push({ id: 'm1', conversationId: 'cv', direction: 'OUT', metaCostUsd: 0.01, deliveryStatus: 'SENT', createdAt: new Date('2026-10-10T00:00:00Z') });
    db.message.push({ id: 'm2', conversationId: 'cv', direction: 'OUT', metaCostUsd: 0.5, deliveryStatus: 'SIMULATED', createdAt: new Date('2026-10-10T00:00:00Z') });
    const e: any = await subs.economics(PLATFORM, 'coA', '2026-10');
    expect(e.revenue.measured).toEqual({ COP: 150000 });
    expect(e.costs.aiProviderUsd).toMatchObject({ value: 0.5, kind: 'MEASURED' });
    expect(e.costs.messagingUsd).toMatchObject({ value: 0.01, kind: 'ESTIMATED' });
    expect(e.costs.infrastructure).toMatchObject({ value: null, kind: 'UNKNOWN' });
    expect(['ESTIMATED', 'UNKNOWN']).toContain(e.margin.kind);
  });
});

describe('Comercial · catálogo de planes', () => {
  it('el conteo de empresas por plan solo lo ve plataforma; un plan en uso no se borra; cambiar su precio pide confirmación', async () => {
    const w = world();
    const plans = new PlansService(w.prisma as any, w.audit as any);
    const forCompany: any[] = await plans.list(ADMIN_A);
    expect(forCompany[0]).not.toHaveProperty('_count');
    expect(forCompany.find((p) => p.id === 'old').onSale).toBe(false);
    await expect(plans.remove(PLATFORM, 'plan1')).rejects.toThrow(/desactívalo/);
    await expect(plans.update(PLATFORM, 'plan1', { priceMonthly: 180000 })).rejects.toThrow(/lo usan 1 empresas/);
    await plans.update(PLATFORM, 'plan1', { name: 'Básico', description: 'Para empezar', includedProducts: ['AUTOMATION', 'INVENTADO'] });
    expect(w.db.plan[0]).toMatchObject({ priceMonthly: 150000, description: 'Para empezar', includedProductsJson: '["AUTOMATION"]' });
    await plans.update(PLATFORM, 'plan1', { priceMonthly: 180000, confirmAffects: true });
    expect((w.audit.log.mock.calls as any[]).at(-1)[0].detail).toMatch(/priceMonthly: 150000 → 180000 · 1 empresas/);
  });

  it('activar un pedido de plan: una sola vez aunque lleguen dos clics, con periodo e historial', async () => {
    const w = world({ status: 'ONBOARDING', planId: null });
    w.db.planOrder.push({ id: 'ord1', companyId: 'coA', planId: 'plan1', planName: 'Básico', billingCycle: 'MONTHLY', planAmount: 150000, total: 150000, currency: 'COP', status: 'PAID', serviceMode: 'SELF', addonsJson: '[]' });
    const checkout = new CheckoutService(w.prisma as any, w.audit as any, {} as any, w.subs);
    const r = await Promise.allSettled([checkout.activate(PLATFORM, 'ord1'), checkout.activate(PLATFORM, 'ord1')]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(w.db.subscriptionEvent.filter((e: any) => e.type === 'ACTIVATE')).toHaveLength(1);
    expect(w.db.company[0]).toMatchObject({ subscriptionStatus: 'ACTIVE', status: 'ACTIVE', planId: 'plan1' });
    expect(w.db.company[0].currentPeriodEnd.getTime()).toBeGreaterThan(w.db.company[0].currentPeriodStart.getTime());
  });

  it('un plan fuera de venta no se puede pedir', async () => {
    const w = world();
    const checkout = new CheckoutService(w.prisma as any, w.audit as any, {} as any, w.subs);
    await expect(checkout.createOrder(ADMIN_A, { planId: 'old' })).rejects.toThrow(/ya no está a la venta/);
  });

  it('emitir la misma factura del mes dos veces a la vez no crea dos', async () => {
    const w = world();
    const billing = new BillingService(w.prisma as any, w.audit as any, w.subs);
    await Promise.allSettled([billing.issueInvoice(PLATFORM, 'coA', '2026-10'), billing.issueInvoice(PLATFORM, 'coA', '2026-10')]);
    expect(w.db.invoice.filter((i: any) => i.companyId === 'coA' && i.period === '2026-10')).toHaveLength(1);
  });
});

describe('Comercial · límites y consumo', () => {
  it('dos números de WhatsApp a la vez con un plan de 1: solo queda uno', async () => {
    const w = world();
    const svc = new IntegrationsService(w.prisma as any, w.audit as any);
    const r = await Promise.allSettled([
      svc.create(ADMIN_A, { type: 'WHATSAPP', name: 'L1' }),
      svc.create(ADMIN_A, { type: 'WHATSAPP', name: 'L2' }),
    ]);
    expect(w.db.integration.filter((i: any) => i.type === 'WHATSAPP')).toHaveLength(1);
    expect(r.some((x) => x.status === 'rejected' && (x as PromiseRejectedResult).reason instanceof BadRequestException)).toBe(true);
  });

  it('créditos de IA: un trabajo duplicado no cobra dos veces y lo incluido no se pasa del cupo con consumos simultáneos', async () => {
    const w = world({ aiBillingMode: 'PLATFORM' });
    const company = w.db.company[0];
    await Promise.all([1, 2, 3].map(() => consumeAiCredit(w.prisma, company, { conversationId: 'cv1', now: NOW })));
    expect(w.db.aiCreditUse.filter((u: any) => u.conversationId === 'cv1')).toHaveLength(1);
    // Cupo incluido: 2 al mes. Cinco conversaciones distintas a la vez, sin paquetes
    const r = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((c) => consumeAiCredit(w.prisma, company, { conversationId: c, now: NOW })));
    const included = w.db.aiCreditUse.filter((u: any) => u.fromIncluded).length;
    expect(included).toBe(2);
    expect(r.filter((x) => x.charged)).toHaveLength(1); // 'cv1' ya usó 1 de los 2
    expect(w.db.aiCreditUse).toHaveLength(2); // sin saldo, los reclamos se sueltan (no quedan cobrados)
  });
});
