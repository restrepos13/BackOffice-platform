/**
 * Cobro a empresas personalizable, paquetes prepagos de IA y pagos (Wompi).
 */
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  adjustmentApplies,
  buildInvoiceLines,
  earlyExitFee,
  annualCyclePosition,
  includedIva,
  sanitizeLines,
  shiftPeriod,
} from '../src/common/billing-engine';
import { CompaniesService } from '../src/modules/companies.module';
import { computeAiCredits, consumeAiCredit, creditAiLot } from '../src/ai/ai-access';
import { BillingService } from '../src/modules/billing.module';
import { PaymentsService } from '../src/modules/payments.module';
import { AiCreditsService } from '../src/modules/ai-credits.module';
import { signEvent, verifyEventSignature } from '../src/common/wompi';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

const PLATFORM = { id: 'dev1', role: 'DEV', companyId: null, name: 'Dev', email: 'd@x.co' } as any;
const ADMIN = { id: 'adm1', role: 'COMPANY_ADMIN', companyId: 'co1', name: 'Admin', email: 'a@x.co' } as any;
const audit = { log: jest.fn(async () => undefined) };

/* ═══ Motor de cobro: lo que se cobra cada mes ═══ */

describe('cobro personalizable: el mes decide qué se cobra', () => {
  const base = { period: '2026-11', currency: 'COP', planName: 'Negocio', planPrice: 349000 };

  it('aplica ajustes por mes, rango y recurrentes', () => {
    expect(adjustmentApplies({ kind: 'CHARGE', concept: 'x', amount: 1, startPeriod: '2026-11' }, '2026-11')).toBe(true);
    expect(adjustmentApplies({ kind: 'CHARGE', concept: 'x', amount: 1, startPeriod: '2026-11' }, '2026-12')).toBe(false);
    expect(adjustmentApplies({ kind: 'CHARGE', concept: 'x', amount: 1, startPeriod: '2026-11', endPeriod: '2027-01' }, '2026-12')).toBe(true);
    expect(adjustmentApplies({ kind: 'CHARGE', concept: 'x', amount: 1, startPeriod: '2026-11', recurring: true }, '2027-08')).toBe(true);
    expect(adjustmentApplies({ kind: 'CHARGE', concept: 'x', amount: 1, startPeriod: '2026-11', active: false }, '2026-11')).toBe(false);
    expect(shiftPeriod('2026-11', 3)).toBe('2027-02');
  });

  it('"este mes se le cobra esto": el ajuste PRICE pisa al plan y al precio pactado', () => {
    const inv = buildInvoiceLines({
      ...base, customPrice: 300000,
      adjustments: [{ kind: 'PRICE', concept: 'Mes de arranque', amount: 150000, startPeriod: '2026-11' }],
    });
    expect(inv.lines[0]).toMatchObject({ kind: 'PLAN', amount: 150000 });
    expect(inv.total).toBe(150000);
    // al mes siguiente vuelve el precio pactado
    const next = buildInvoiceLines({ ...base, period: '2026-12', customPrice: 300000, adjustments: [{ kind: 'PRICE', concept: 'x', amount: 150000, startPeriod: '2026-11' }] });
    expect(next.total).toBe(300000);
  });

  it('descuentos porcentuales y fijos, cargos extra y consumo al costo; nunca negativo', () => {
    const inv = buildInvoiceLines({
      ...base,
      adjustments: [
        { kind: 'DISCOUNT', concept: 'Fidelidad', amount: 0, percent: 10, startPeriod: '2026-11' },
        { kind: 'CHARGE', concept: 'Línea extra', amount: 50000, startPeriod: '2026-11', recurring: true },
      ],
      whatsappCost: 12345.6,
    });
    expect(inv.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['PLAN', 349000], ['CHARGE', 50000], ['DISCOUNT', -34900], ['WHATSAPP', 12346],
    ]);
    expect(inv.total).toBe(349000 + 50000 - 34900 + 12346);
    const huge = buildInvoiceLines({ ...base, adjustments: [{ kind: 'DISCOUNT', concept: 'Cortesía', amount: 999999, startPeriod: '2026-11' }] });
    expect(huge.total).toBe(0);
  });

  it('las líneas editadas a mano se sanean (descuento resta, lo demás suma)', () => {
    const lines = sanitizeLines([
      { kind: 'PLAN', concept: 'Plan', amount: -100 },
      { kind: 'DISCOUNT', concept: 'Promo', amount: 30 },
      { kind: 'HACK', concept: 'x', amount: 1 },
      { kind: 'CHARGE', concept: '', amount: 'abc' },
    ], 'COP');
    expect(lines).toEqual([
      { kind: 'PLAN', concept: 'Plan', amount: 100 },
      { kind: 'DISCOUNT', concept: 'Promo', amount: -30 },
    ]);
  });

  it('salida anticipada: montaje proporcional a los meses que faltan', () => {
    const start = new Date(2026, 0, 15);
    expect(earlyExitFee({ contractStartAt: start, minTermMonths: 6, setupFeeValue: 1200000, exitAt: new Date(2026, 2, 20) }))
      .toEqual({ remainingMonths: 4, amount: 800000 });
    expect(earlyExitFee({ contractStartAt: start, minTermMonths: 6, setupFeeValue: 1200000, exitAt: new Date(2026, 9, 1) }).amount).toBe(0);
    expect(earlyExitFee({ contractStartAt: null, minTermMonths: 6, setupFeeValue: 1 }).amount).toBe(0);
  });
});

describe('cobro personalizable: servicio (plataforma vs empresa)', () => {
  function setup() {
    const { prisma, db } = createMockPrisma();
    db.plan.push({ id: 'plan1', name: 'Negocio', priceMonthly: 349000, currency: 'COP', line: 'NEGOCIOS', minTermMonths: 6, setupFeeValue: 1200000 });
    db.company.push({ id: 'co1', name: 'La Esquina', planId: 'plan1', customPriceMonthly: null, status: 'ACTIVE' });
    // el mock no resuelve include: plan → lo dejamos colgado del registro
    db.company[0].plan = db.plan[0];
    return { prisma, db, service: new BillingService(prisma as any, audit as any) };
  }

  it('solo plataforma crea ajustes; se validan tipo, concepto, meses y porcentaje', async () => {
    const { db, service } = setup();
    await expect(service.createAdjustment(ADMIN, 'co1', { kind: 'DISCOUNT', concept: 'x', amount: 1, startPeriod: '2026-11' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createAdjustment(PLATFORM, 'co1', { kind: 'REGALO', concept: 'x', startPeriod: '2026-11' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createAdjustment(PLATFORM, 'co1', { kind: 'CHARGE', concept: 'x', amount: 1, startPeriod: '2026-13' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createAdjustment(PLATFORM, 'co1', { kind: 'DISCOUNT', concept: 'x', percent: 150, startPeriod: '2026-11' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createAdjustment(PLATFORM, 'co1', { kind: 'CHARGE', concept: 'x', amount: 1, startPeriod: '2026-12', endPeriod: '2026-11' })).rejects.toBeInstanceOf(BadRequestException);
    await service.createAdjustment(PLATFORM, 'co1', { kind: 'PRICE', concept: 'Precio de lanzamiento', amount: 199000, startPeriod: '2026-11', endPeriod: '2027-01' });
    expect(db.billingAdjustment).toHaveLength(1);
  });

  it('emite la factura con el cálculo del mes y deja editarla mientras está pendiente', async () => {
    const { db, service } = setup();
    await service.createAdjustment(PLATFORM, 'co1', { kind: 'PRICE', concept: 'Mes de prueba', amount: 99000, startPeriod: '2026-11' });
    const inv = await service.issueInvoice(PLATFORM, 'co1', '2026-11');
    expect(inv).toMatchObject({ totalAmount: 99000, currency: 'COP', status: 'PENDING' });
    const edited = await service.updateInvoice(PLATFORM, inv.id, {
      lines: [{ kind: 'PLAN', concept: 'Plan Negocio', amount: 99000 }, { kind: 'CHARGE', concept: 'Capacitación extra', amount: 60000 }],
    });
    expect(edited.totalAmount).toBe(159000);
    db.invoice[0].status = 'PAID';
    await expect(service.updateInvoice(PLATFORM, inv.id, { lines: [{ kind: 'PLAN', concept: 'x', amount: 1 }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.issueInvoice(PLATFORM, 'co1', '2026-11')).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ═══ Pago anual (2 meses gratis) e IVA incluido ═══ */

describe('pago anual e IVA incluido', () => {
  it('el mes de inicio cobra 10 mensualidades, los 11 siguientes salen cubiertos y el ciclo se repite', () => {
    const base = { currency: 'COP', planName: 'Negocio', planPrice: 349000, adjustments: [] as any[], billingCycle: 'ANNUAL', annualStartPeriod: '2026-11' };
    const start = buildInvoiceLines({ ...base, period: '2026-11' });
    expect(start.total).toBe(3490000);
    expect(start.lines[0].concept).toContain('pago anual');
    const covered = buildInvoiceLines({ ...base, period: '2027-04' });
    expect(covered.total).toBe(0);
    expect(covered.lines[0].concept).toContain('mes 6 de 12');
    expect(buildInvoiceLines({ ...base, period: '2027-11' }).total).toBe(3490000); // renovación
    expect(buildInvoiceLines({ ...base, period: '2026-10' }).total).toBe(349000); // antes del anual: mensual
    expect(annualCyclePosition('MONTHLY', '2026-11', '2026-11')).toBeNull();
    // Cargos extra y precio pactado siguen funcionando dentro del anual
    const withCharge = buildInvoiceLines({
      ...base, period: '2027-02', customPrice: 300000,
      adjustments: [{ kind: 'CHARGE', concept: 'Capacitación', amount: 80000, startPeriod: '2027-02' }],
    });
    expect(withCharge.total).toBe(80000);
    expect(buildInvoiceLines({ ...base, period: '2026-11', customPrice: 300000 }).total).toBe(3000000);
  });

  it('informa el IVA incluido en COP (19 %) y no lo inventa en USD', () => {
    expect(includedIva(349000, 'COP')).toBe(55723);
    expect(includedIva(119000, 'COP')).toBe(19000);
    expect(includedIva(599, 'USD')).toBe(0);
    expect(buildInvoiceLines({ period: '2026-11', currency: 'COP', planName: 'Esencial', planPrice: 149000, adjustments: [] }).iva).toBe(23790);
  });

  it('solo plataforma pasa una empresa a anual; arranca en el mes indicado o el actual', async () => {
    const { prisma, db } = createMockPrisma();
    const service = new CompaniesService(prisma as any, audit as any);
    db.company.push({ id: 'co1', name: 'X', status: 'ACTIVE', billingCycle: 'MONTHLY', modulesJson: '[]', limitsJson: '{}', orderConfigJson: '{}', waTemplatesJson: '[]', paymentConfigJson: '{}', einvoiceConfigJson: '{}' });
    await expect(service.update(ADMIN, 'co1', { billingCycle: 'ANNUAL' })).rejects.toBeInstanceOf(ForbiddenException);
    await service.update(PLATFORM, 'co1', { billingCycle: 'ANNUAL', annualStartPeriod: '2027-01' });
    expect(db.company[0]).toMatchObject({ billingCycle: 'ANNUAL', annualStartPeriod: '2027-01' });
    await service.update(PLATFORM, 'co1', { billingCycle: 'MONTHLY' });
    expect(db.company[0]).toMatchObject({ billingCycle: 'MONTHLY', annualStartPeriod: null });
    await service.update(PLATFORM, 'co1', { billingCycle: 'ANNUAL', annualStartPeriod: 'mañana' });
    expect(db.company[0].annualStartPeriod).toMatch(/^\d{4}-\d{2}$/);
  });
});

/* ═══ Paquetes prepagos de IA ═══ */

describe('IA prepaga: incluidas primero, después paquetes FIFO con vencimiento', () => {
  it('consume lo incluido del plan antes que el saldo prepago; 1 crédito por conversación cada 24 h', async () => {
    const { prisma, db } = createMockPrisma();
    const company = { id: 'co1', aiIncludedOverride: 2, planId: null };
    db.company.push({ ...company });
    await creditAiLot(prisma, { companyId: 'co1', conversations: 3, source: 'PURCHASE' });
    expect((await consumeAiCredit(prisma, company, { conversationId: 'a' })).source).toBe('INCLUDED');
    expect((await consumeAiCredit(prisma, company, { conversationId: 'a' })).charged).toBe(false); // misma conversación
    expect((await consumeAiCredit(prisma, company, { conversationId: 'b' })).source).toBe('INCLUDED');
    expect((await consumeAiCredit(prisma, company, { conversationId: 'c' })).source).toBe('PREPAID');
    const credits = await computeAiCredits(prisma, company);
    expect(credits).toMatchObject({ includedUsed: 2, includedLeft: 0, balance: 2, usedThisMonth: 3 });
  });

  it('FIFO: gasta primero el paquete más viejo; los vencidos no cuentan; avisa al 20 % y al agotarse', async () => {
    const { prisma, db } = createMockPrisma();
    const company = { id: 'co1', aiIncludedOverride: 0, planId: null };
    const old = await creditAiLot(prisma, { companyId: 'co1', conversations: 1, source: 'GRANT', now: new Date(Date.now() - 10 * 86400e3) });
    db.aiCreditLot.push({ id: 'expired', companyId: 'co1', source: 'PURCHASE', total: 100, remaining: 100, expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 400 * 86400e3), alertedLow: false, alertedEmpty: false });
    const recent = await creditAiLot(prisma, { companyId: 'co1', conversations: 5, source: 'PURCHASE' });
    expect((await computeAiCredits(prisma, company)).balance).toBe(6); // el vencido no suma
    await consumeAiCredit(prisma, company, { conversationId: 'x1' });
    expect(db.aiCreditLot.find((l) => l.id === old.id)!.remaining).toBe(0);
    const alerts: Array<string | null> = [];
    for (const conv of ['x2', 'x3', 'x4', 'x5', 'x6']) alerts.push((await consumeAiCredit(prisma, company, { conversationId: conv })).alert);
    expect(alerts).toEqual([null, null, null, 'LOW', 'EMPTY']);
    expect(db.aiCreditLot.find((l) => l.id === recent.id)!.remaining).toBe(0);
    expect(await consumeAiCredit(prisma, company, { conversationId: 'x7' })).toMatchObject({ charged: false, alert: 'EMPTY' });
  });

  it('paquetes: solo plataforma los edita; la empresa compra con Wompi y el webhook acredita una sola vez', async () => {
    const { prisma, db } = createMockPrisma();
    db.platformSetting.push({ key: 'WOMPI_PUBLIC_KEY', value: 'pub_test_abc' }, { key: 'WOMPI_EVENTS_SECRET', value: 'evsecret' }, { key: 'WOMPI_ENV', value: 'test' });
    db.company.push({ id: 'co1', name: 'La Esquina', slug: 'la-esquina', paymentConfigJson: '{}' });
    const payments = new PaymentsService(prisma as any, audit as any);
    const service = new AiCreditsService(prisma as any, audit as any, payments);
    await expect(service.savePackage(ADMIN, { name: 'x', conversations: 10, price: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    const pkg = await service.savePackage(PLATFORM, { name: 'Paquete 500', conversations: 500, price: 99000 });
    const checkout = await service.checkout(ADMIN, pkg.id);
    expect(checkout.checkoutUrl).toContain('amount-in-cents=9900000');
    expect(checkout.purpose).toBe('AI_CREDITS');

    // Como los eventos reales de Wompi: traen monto y moneda (se verifican contra lo cobrado)
    const data = { transaction: { id: 'tx1', reference: checkout.reference, status: 'APPROVED', payment_method_type: 'NEQUI', amount_in_cents: 9900000, currency: 'COP' } };
    const timestamp = 1700000000;
    const body = { data, timestamp, signature: signEvent(data, timestamp, 'evsecret', ['transaction.id', 'transaction.status']) };
    expect(verifyEventSignature(body, 'evsecret')).toBe(true);
    await payments.handleWompiEvent(body);
    await payments.handleWompiEvent(body); // reintento de Wompi
    expect(db.aiCreditLot).toHaveLength(1);
    expect(db.aiCreditLot[0]).toMatchObject({ companyId: 'co1', total: 500, remaining: 500, source: 'PURCHASE' });
    await expect(payments.handleWompiEvent({ ...body, signature: { ...body.signature, checksum: 'falso' } })).rejects.toBeInstanceOf(UnauthorizedException);
    // Un aprobado con otro monto no acredita: queda para revisión
    const other = await service.checkout(ADMIN, pkg.id);
    const bad = { transaction: { id: 'tx2', reference: other.reference, status: 'APPROVED', amount_in_cents: 100, currency: 'COP' } };
    await payments.handleWompiEvent({ data: bad, timestamp, signature: signEvent(bad, timestamp, 'evsecret', ['transaction.id', 'transaction.status']) });
    expect(db.aiCreditLot).toHaveLength(1);
    expect(db.payment.find((p: any) => p.reference === other.reference)!.status).toBe('REVIEW');
  });

  it('plataforma regala saldo con vigencia; cantidades absurdas se rechazan', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'co1', name: 'X' });
    const service = new AiCreditsService(prisma as any, audit as any, {} as any);
    await expect(service.grant(ADMIN, { companyId: 'co1', conversations: 100 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.grant(PLATFORM, { companyId: 'co1', conversations: -5 })).rejects.toBeInstanceOf(BadRequestException);
    const lot = await service.grant(PLATFORM, { companyId: 'co1', conversations: 200, validityMonths: 3, note: 'Compensación' });
    const months = (lot.expiresAt.getFullYear() - new Date().getFullYear()) * 12 + lot.expiresAt.getMonth() - new Date().getMonth();
    expect(months).toBe(3);
  });
});

/* ═══ Cobro de pedidos con la cuenta Wompi de la empresa ═══ */

describe('cobro en el chat: link de pago por pedido y webhook de la empresa', () => {
  function setup() {
    const { prisma, db } = createMockPrisma();
    const payments = new PaymentsService(prisma as any, audit as any, { emit: jest.fn() } as any);
    db.company.push({ id: 'co1', name: 'La Esquina', slug: 'la-esquina', paymentConfigJson: '{}' });
    db.order.push({ id: 'order_pay123', companyId: 'co1', customerId: 'c1', status: 'programado', total: 41000, paymentStatus: 'NONE', deliveryAt: new Date(), createdAt: new Date() });
    return { prisma, db, payments };
  }

  it('sin Wompi configurado no hay link; con llave pública genera uno y lo reutiliza', async () => {
    const { db, payments } = setup();
    await expect(payments.createOrderPaymentLink('order_pay123', ADMIN)).rejects.toThrow(/Wompi/);
    await payments.updateCompanyConfig(ADMIN, { publicKey: 'pub_test_xyz', integritySecret: 'mi-secreto-integridad', eventsSecret: 'mi-secreto-eventos' });
    expect(db.company[0].paymentConfigJson).not.toContain('mi-secreto'); // secretos cifrados
    const visible = await payments.getCompanyConfig(ADMIN);
    expect(JSON.stringify(visible)).not.toContain('enc:v1');
    expect(visible).toMatchObject({ onlineReady: true, hasIntegritySecret: true, hasEventsSecret: true });
    const first = await payments.createOrderPaymentLink('order_pay123', ADMIN);
    expect(first.url).toContain('pub_test_xyz');
    expect(first.url).toContain('signature%3Aintegrity');
    expect(db.order[0]).toMatchObject({ paymentStatus: 'PENDING', paymentRef: first.reference });
    const again = await payments.createOrderPaymentLink('order_pay123', ADMIN);
    expect(again).toMatchObject({ reused: true, reference: first.reference });
    await expect(payments.updateCompanyConfig(ADMIN, { publicKey: 'cualquier-cosa' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('webhook firmado de la empresa: pago completo → PAGADO; parcial → por verificar; firma falsa → 401', async () => {
    const { db, payments } = setup();
    await payments.updateCompanyConfig(ADMIN, { publicKey: 'pub_test_xyz', eventsSecret: 'ev-secret' });
    const link = await payments.createOrderPaymentLink('order_pay123', ADMIN);
    const event = (status: string, cents: number) => {
      const data = { transaction: { id: `tx_${cents}`, reference: link.reference, status, amount_in_cents: cents, payment_method_type: 'NEQUI' } };
      return { data, timestamp: 1, signature: signEvent(data, 1, 'ev-secret', ['transaction.id', 'transaction.status', 'transaction.amount_in_cents']) };
    };
    await expect(payments.handleCompanyWompiEvent('la-esquina', { ...event('APPROVED', 4100000), signature: { properties: ['transaction.id'], checksum: 'x' } }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await payments.handleCompanyWompiEvent('la-esquina', event('APPROVED', 2000000));
    expect(db.order[0].paymentStatus).toBe('REPORTED');
    await payments.handleCompanyWompiEvent('la-esquina', event('APPROVED', 4100000));
    expect(db.order[0]).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'NEQUI' });
  });

  it('pago manual (efectivo) y rechazo de un comprobante', async () => {
    const { db, payments } = setup();
    await payments.markOrderPaid(ADMIN, 'order_pay123', { method: 'EFECTIVO' });
    expect(db.order[0]).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'EFECTIVO' });
    await payments.markOrderPaid(ADMIN, 'order_pay123', { method: 'NEQUI', verified: false });
    expect(db.order[0].paymentStatus).toBe('NONE');
    const other = { ...ADMIN, companyId: 'co2' };
    await expect(payments.markOrderPaid(other, 'order_pay123', {})).rejects.toBeInstanceOf(ForbiddenException);
  });
});
