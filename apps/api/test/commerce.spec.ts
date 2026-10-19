/**
 * Pruebas — transparencia de costos de IA, compra del plan (recomendación,
 * pedido, activación), términos con versión, Meta Ads y modelos premium.
 */
import { BadRequestException } from '@nestjs/common';
import { estimateAiCosts, parseDailyChats, REFERENCE_MODELS } from '../src/common/ai-cost';
import { recommendPlan } from '../src/common/plan-recommend';
import { CheckoutService } from '../src/modules/checkout.module';
import { TermsService } from '../src/modules/terms.module';
import { MetaAdsService } from '../src/modules/meta-ads.module';
import { consumeAiCredit } from '../src/ai/ai-access';
import { isOpenRouterModel } from '../src/ai/model-routing';
import { dailyChatsFrom } from '../src/modules/signup.module';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const audit = { log: jest.fn(async () => undefined) };
const emails = { systemSend: jest.fn(async () => ({ status: 'QUEUED' })) };
const ADMIN = { id: 'u1', role: 'COMPANY_ADMIN', companyId: 'c1', name: 'Rosa', email: 'rosa@x.co' } as any;
const DEV = { id: 'd1', role: 'DEV', companyId: null, name: 'Santi', email: 's@b.dev' } as any;

const PACKAGES = [
  { id: 'k1', name: 'Paquete 500', conversations: 500, price: 99000, validityMonths: 12 },
  { id: 'k2', name: 'Paquete 2.000', conversations: 2000, price: 299000, validityMonths: 12 },
  { id: 'k3', name: 'Paquete 5.000', conversations: 5000, price: 599000, validityMonths: 12 },
];

describe('costos de IA calculados con código', () => {
  const llama = { modelId: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', provider: 'DEEPINFRA', inputCostPerMTok: 0.23, outputCostPerMTok: 0.4, creditsPerConversation: 1 };

  it('el costo crece con lo que lee el asistente y con el volumen; Haiku 4.5 gasta 3 del paquete', () => {
    const base = { promptChars: 2000, knowledgeChars: 0, products: 10, dailyChats: 20, agentMode: false, trm: 4000 };
    const small = estimateAiCosts(base, [llama, ...REFERENCE_MODELS], PACKAGES);
    const big = estimateAiCosts({ ...base, promptChars: 12000, products: 80 }, [llama], PACKAGES);
    expect(big.tokens.input).toBeGreaterThan(small.tokens.input);
    expect(small.inputs.monthlyConversations).toBe(600);
    const l = small.models.find((m) => m.modelId === llama.modelId)!;
    expect(l.perConversation.cop).toBeCloseTo(l.perConversation.usd * 4000, 0);
    expect(l.withPackage?.name).toBe('Paquete 2.000'); // 600 al mes: el de 500 no alcanza
    const haiku = small.models.find((m) => m.modelId === 'anthropic/claude-haiku-4.5')!;
    expect(haiku.creditsPerConversation).toBe(3);
    expect(haiku.perConversation.usd).toBeGreaterThan(l.perConversation.usd * 3);
    expect(haiku.withPackage?.name).toBe('Paquete 2.000'); // 1.800 créditos al mes
    expect(l.report.perQuery.usd).toBeGreaterThan(0);
  });

  it('lee el volumen de la respuesta del registro', () => {
    expect(parseDailyChats('10 a 30')).toBe(20);
    expect(parseDailyChats('Más de 100')).toBe(150);
    expect(parseDailyChats('unos 45 diarios')).toBe(45);
    expect(parseDailyChats('pocos')).toBe(5);
    expect(dailyChatsFrom([
      { role: 'assistant', content: '¿Más o menos cuántos clientes te escriben al día?' },
      { role: 'user', content: '30 a 100' },
    ])).toBe(65);
  });
});

describe('modelos premium (Claude Haiku)', () => {
  it('van por OpenRouter y gastan varias conversaciones del paquete', async () => {
    expect(isOpenRouterModel('anthropic/claude-haiku-4.5')).toBe(true);
    expect(isOpenRouterModel('meta-llama/Llama-3.3-70B-Instruct')).toBe(false);
    const { prisma, db } = createMockPrisma();
    const company = { id: 'c1', aiBillingMode: 'PLATFORM', planId: null };
    db.company.push(company);
    db.aiCreditLot.push({ id: 'lot1', companyId: 'c1', total: 10, remaining: 10, expiresAt: new Date(Date.now() + 86400e3), createdAt: new Date(), alertedLow: false, alertedEmpty: false });
    const r = await consumeAiCredit(prisma, company, { conversationId: 'conv1', weight: 3 });
    expect(r.charged).toBe(true);
    expect(db.aiCreditLot[0].remaining).toBe(7);
    // La misma conversación en 24 h no vuelve a cobrar
    await consumeAiCredit(prisma, company, { conversationId: 'conv1', weight: 3 });
    expect(db.aiCreditLot[0].remaining).toBe(7);
  });
});

describe('recomendación de plan (código)', () => {
  const plans = [
    { id: 'p1', name: 'Emprende', priceMonthly: 149000, maxUsers: 2, maxLines: 1, maxCouriers: 0, sortOrder: 1, features: [] },
    { id: 'p2', name: 'Crece', priceMonthly: 349000, maxUsers: 5, maxLines: 2, maxCouriers: 3, sortOrder: 2, features: [] },
    { id: 'p3', name: 'Escala', priceMonthly: 890000, maxUsers: 15, maxLines: 5, maxCouriers: 10, sortOrder: 3, features: [] },
  ];

  it('negocio pequeño → plan de entrada; con domicilios o mucho volumen sube y explica por qué', () => {
    expect(recommendPlan(plans, { dailyChats: 8, modules: ['orders', 'menu'], users: 1, lines: 1 })?.planId).toBe('p1');
    const delivery = recommendPlan(plans, { dailyChats: 8, modules: ['orders', 'delivery'], users: 1, lines: 1 })!;
    expect(delivery.planId).toBe('p2');
    expect(delivery.reasons.join(' ')).toContain('domiciliarios');
    expect(recommendPlan(plans, { dailyChats: 200, modules: ['orders'], users: 1, lines: 1 })?.planId).toBe('p3');
    expect(recommendPlan(plans, { dailyChats: 10, modules: ['orders'], users: 8, lines: 1 })?.planId).toBe('p3');
  });
});

describe('compra del plan: modalidad, complementos, pago confirmado y activación', () => {
  function setup() {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'c1', name: 'Doña Rosa', status: 'ONBOARDING', aiBillingMode: 'BYOK', contactPhone: '3001234567', onboardingJson: JSON.stringify({ rubro: 'COMIDAS', dailyChats: 25, modules: ['orders', 'menu'], contactName: 'Rosa', phone: '3001234567' }), modulesJson: '[]' });
    db.plan.push(
      { id: 'p1', code: 'wpp-basico', name: 'Básico', tier: 'BASICO', priceMonthly: 149000, priceManaged: 279000, includedMetaUsd: 10, maxUsers: 2, maxLines: 1, maxCouriers: 0, sortOrder: 1, line: 'WPP', active: true, featuresJson: '[]', minTermMonths: 6 },
      { id: 'p2', code: 'wpp-intermedio', name: 'Intermedio', tier: 'INTERMEDIO', priceMonthly: 349000, priceManaged: 529000, includedMetaUsd: 10, maxUsers: 5, maxLines: 2, maxCouriers: 5, sortOrder: 2, line: 'WPP', active: true, featuresJson: '[]', minTermMonths: 6 },
      { id: 'old', code: 'negocios-1', name: 'Viejo', priceMonthly: 99000, line: 'COMIDAS', active: false, featuresJson: '[]' },
    );
    db.aiModel.push({ modelId: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', provider: 'DEEPINFRA', inputCostPerMTok: 0.23, outputCostPerMTok: 0.4, recommended: true, active: true });
    db.user.push({ id: 'u1', companyId: 'c1', active: true, role: 'COMPANY_ADMIN' });
    return { db, service: new CheckoutService(prisma as any, audit as any, emails as any) };
  }

  it('ofrece los 3 planes WPP con sus dos precios, sin datos bancarios, con avisos claros y Wompi "próximamente"', async () => {
    const { service } = setup();
    const v: any = await service.checkout(ADMIN);
    expect(v.plans.map((p: any) => [p.name, p.priceSelf, p.priceManaged])).toEqual([['Básico', 149000, 279000], ['Intermedio', 349000, 529000]]);
    expect(v.recommendation.serviceMode).toBe('MANAGED'); // sin llave propia → Todo incluido
    expect(v.recommendation.aiEstimate.monthly).toBeGreaterThan(0);
    expect(v.notices.humanOversight).toContain('100 %');
    expect(v.notices.numbers).toContain('hasta 5');
    expect(v.landingGift).toBe(true);
    expect(v.addons.find((a: any) => a.key === 'voiceCalls').status).toBe('SOON');
    expect(v.paymentOptions.find((o: any) => o.id === 'WOMPI')).toMatchObject({ comingSoon: true, available: false });
    expect(JSON.stringify(v)).not.toMatch(/\d{9,}/);
  });

  it('pedido Todo incluido + complementos; al activar: modalidad, IA de BackOffice, complementos y landing de regalo', async () => {
    const { db, service } = setup();
    await service.createOrder(ADMIN, { planId: 'p1', billingCycle: 'MONTHLY', serviceMode: 'SELF' });
    const { order } = await service.createOrder(ADMIN, {
      planId: 'p2', billingCycle: 'MONTHLY', serviceMode: 'MANAGED',
      addons: [{ key: 'reactivation' }, { key: 'extraChannels', qty: 2 }, { key: 'voiceCalls' }, { key: 'hackeo' } as any],
    });
    expect(order).toMatchObject({ planName: 'Intermedio', serviceMode: 'MANAGED', planAmount: 529000, total: 529000 + 89000 + 59000 * 2 });
    expect(order.addons.map((a: any) => a.key)).toEqual(['reactivation', 'extraChannels']); // "próximamente" y basura fuera
    expect(db.planOrder.filter((o: any) => o.status === 'CANCELLED')).toHaveLength(1);
    await expect(service.createOrder({ ...ADMIN, role: 'COMPANY_VIEWER' }, { planId: 'p1' })).rejects.toBeTruthy();

    await service.saveMethods(DEV, { accounts: [{ bank: 'Bancolombia', type: 'Ahorros', number: '123-456789-01', holder: 'Santiago R.', document: '1020304050', owner: 'Santiago' }] });
    const msg = await service.paymentMessage(order.id, 'TRANSFER');
    expect(msg.text).toContain('123-456789-01');
    expect(msg.text).toContain('Todo incluido');
    expect(msg.text).toContain('US$10');
    await expect(service.saveMethods(DEV, { accounts: [{ bank: 'X', number: '12' }] })).rejects.toBeInstanceOf(BadRequestException);

    await service.activate(DEV, order.id);
    const c = db.company[0];
    expect(c).toMatchObject({ planId: 'p2', status: 'ACTIVE', serviceMode: 'MANAGED', aiBillingMode: 'PLATFORM' });
    const addons = JSON.parse(c.addonsJson);
    expect(addons.reactivation.enabled).toBe(true);
    expect(addons.extraChannels.qty).toBe(2);
    expect(JSON.parse(c.landingJson).status).toBe('PENDING');
  });
});

describe('cobro mensual por modalidad (mes vencido)', () => {
  const { buildInvoiceLines } = require('../src/common/billing-engine');
  const base = { period: '2026-11', currency: 'COP', planName: 'Intermedio', planPrice: 529000, adjustments: [], whatsappCost: 18 * 4000, storageCost: 0 };

  it('Todo incluido: plan + IA consumida + solo el excedente de Meta sobre US$10', () => {
    const r = buildInvoiceLines({ ...base, serviceMode: 'MANAGED', aiCost: 30000, metaIncluded: 40000, metaUsedUsd: 18, metaIncludedUsd: 10, addons: [{ concept: 'Complemento · Cobranza', amount: 89000 }] });
    expect(r.lines.map((l: any) => [l.kind, l.amount])).toEqual([['PLAN', 529000], ['ADDON', 89000], ['AI', 30000], ['WHATSAPP', 32000]]);
    expect(r.lines.find((l: any) => l.kind === 'AI').concept).not.toMatch(/%|margen/);
    expect(r.total).toBe(529000 + 89000 + 30000 + 32000);
  });

  it('Todo incluido bajo los US$10: no hay línea de Meta; Tu IA: ni IA ni Meta en la factura', () => {
    const managed = buildInvoiceLines({ ...base, whatsappCost: 20000, serviceMode: 'MANAGED', aiCost: 0, metaIncluded: 40000 });
    expect(managed.lines.map((l: any) => l.kind)).toEqual(['PLAN']);
    const self = buildInvoiceLines({ ...base, planPrice: 349000, serviceMode: 'SELF', aiCost: 99999 });
    expect(self.lines.map((l: any) => l.kind)).toEqual(['PLAN']);
    expect(self.total).toBe(349000);
  });

  it('la IA de Todo incluido se cobra al costo real + 5 % (sin desglose) y sin descontar créditos', async () => {
    const { computeCompanyInvoice } = require('../src/common/billing-engine');
    const { prisma, db } = createMockPrisma();
    db.platformSetting.push({ id: 'r', key: 'USD_COP_RATE', value: '4000' });
    const company = { id: 'c9', serviceMode: 'MANAGED', plan: { name: 'Básico', line: 'WPP', priceMonthly: 149000, priceManaged: 279000, includedMetaUsd: 10, currency: 'COP' }, addonsJson: null };
    db.aiUsageEvent.push({ companyId: 'c9', billedTo: 'PLATFORM', costUsd: 10, createdAt: new Date(2026, 10, 5) }, { companyId: 'c9', billedTo: 'BYOK', costUsd: 50, createdAt: new Date(2026, 10, 5) });
    const inv = await computeCompanyInvoice(prisma, company, '2026-11');
    expect(inv.lines.find((l: any) => l.kind === 'PLAN').amount).toBe(279000);
    expect(inv.lines.find((l: any) => l.kind === 'AI').amount).toBe(42000); // 10 USD × 1.05 × 4000
    const { recordAiUsage } = require('../src/ai/ai-access');
    db.company.push({ id: 'c9', serviceMode: 'MANAGED' });
    db.aiCreditLot.push({ id: 'l', companyId: 'c9', total: 5, remaining: 5, expiresAt: new Date(Date.now() + 86400e3), createdAt: new Date() });
    await recordAiUsage(prisma, { companyId: 'c9', model: 'x', inputTokens: 10, outputTokens: 10, billedTo: 'PLATFORM', conversationId: 'k' });
    expect(db.aiCreditLot[0].remaining).toBe(5);
  });
});

describe('complementos: se piden, los activa el equipo y se apagan hasta un día antes del pago', () => {
  const { activeDuring, addonLinesFor, cancelDeadline } = require('../src/common/addons');
  const { ADDONS } = require('../src/common/offer');

  it('se cobra cada mes en que estuvo activo al menos un día', () => {
    expect(activeDuring({ enabled: true, since: '2026-10-10T00:00:00' }, '2026-10')).toBe(true);
    expect(activeDuring({ enabled: true, since: '2026-11-02T00:00:00' }, '2026-10')).toBe(false);
    // Apagado el 31 de octubre (un día antes del pago): noviembre ya no se cobra
    const off = { enabled: false, since: '2026-09-01T00:00:00', until: new Date(2026, 9, 31, 22).toISOString() };
    expect(activeDuring(off, '2026-10')).toBe(true);
    expect(activeDuring(off, '2026-11')).toBe(false);
    // Apagado el 1 de noviembre (el día de pago): noviembre sí se cobra
    expect(activeDuring({ enabled: false, until: new Date(2026, 10, 1, 9).toISOString() }, '2026-11')).toBe(true);
    const lines = addonLinesFor({ addonsJson: JSON.stringify({ extraChannels: { enabled: true, qty: 3 }, social: { enabled: true, price: 150000, credits: 20 } }) }, ADDONS, '2026-10');
    expect(lines.map((l: any) => l.amount)).toEqual([59000 * 3, 150000]);
    const d = cancelDeadline(new Date(2026, 9, 15));
    expect(d.getDate()).toBe(31);
  });

  it('el cliente pide (no puede activar lo "próximamente"), el equipo activa, el cliente apaga', async () => {
    const { CommerceService } = require('../src/modules/commerce.module');
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'c1', name: 'Doña Rosa', addonsJson: null, modulesJson: '[]' });
    const svc = new CommerceService(prisma as any, audit as any, emails as any);
    await expect(svc.request(ADMIN, 'voiceCalls', {})).rejects.toThrow(/próximamente/);
    await svc.request(ADMIN, 'collections', {});
    expect((await svc.requests())[0]).toMatchObject({ key: 'collections', companyName: 'Doña Rosa' });
    await svc.setAddon(DEV, 'c1', 'collections', { enabled: true });
    let view = await svc.addons(ADMIN);
    expect(view.addons.find((a: any) => a.key === 'collections')).toMatchObject({ active: true, monthly: 89000 });
    await svc.cancel(ADMIN, 'collections', {});
    view = await svc.addons(ADMIN);
    expect(view.addons.find((a: any) => a.key === 'collections')).toMatchObject({ active: false });
    expect(JSON.parse(db.company[0].addonsJson).collections.until).toBeTruthy();
    await svc.setAddon(DEV, 'c1', 'social', { enabled: true });
    expect(JSON.parse(db.company[0].modulesJson)).toContain('marketing');
  });
});

describe('referidos y landing de regalo', () => {
  it('quien trae una empresa que paga 2 meses recibe 20 % x 2 meses (una sola vez)', async () => {
    const { CommerceService, linkReferral } = require('../src/modules/commerce.module');
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'a', name: 'Invita' }, { id: 'b', name: 'Nueva' });
    const svc = new CommerceService(prisma as any, audit as any, emails as any);
    const { code } = await svc.referrals({ ...ADMIN, companyId: 'a' });
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(await linkReferral(prisma, 'a', code)).toBe(false); // no se refiere a sí misma
    expect(await linkReferral(prisma, 'b', code.toLowerCase())).toBe(true);
    db.invoice.push({ id: 'i1', companyId: 'b', status: 'PAID' });
    await svc.rewardReferrals();
    expect(db.billingAdjustment).toHaveLength(0); // aún 1 mes
    db.invoice.push({ id: 'i2', companyId: 'b', status: 'PAID' });
    await svc.rewardReferrals();
    await svc.rewardReferrals();
    expect(db.billingAdjustment).toHaveLength(1);
    expect(db.billingAdjustment[0]).toMatchObject({ companyId: 'a', kind: 'DISCOUNT', percent: 20 });
    const ref = await svc.referrals({ ...ADMIN, companyId: 'a' });
    expect(ref.referred[0]).toMatchObject({ name: 'Nueva', status: 'REWARDED', paidMonths: 2 });
  });

  it('la landing se marca entregada solo con un enlace https', async () => {
    const { CommerceService } = require('../src/modules/commerce.module');
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'c1', name: 'Doña Rosa', landingJson: JSON.stringify({ status: 'PENDING' }) });
    const svc = new CommerceService(prisma as any, audit as any, emails as any);
    await expect(svc.setLanding(DEV, 'c1', { status: 'DELIVERED' })).rejects.toThrow(/enlace/);
    await expect(svc.setLanding(DEV, 'c1', { status: 'DELIVERED', url: 'javascript:alert(1)' })).rejects.toThrow(/https/);
    await svc.setLanding(DEV, 'c1', { status: 'DELIVERED', url: 'https://donarosa.vercel.app' });
    expect(await svc.landing(ADMIN)).toMatchObject({ status: 'DELIVERED', url: 'https://donarosa.vercel.app' });
  });
});

describe('vigilante 24/7', () => {
  it('agrupa repeticiones, avisa al equipo una vez, recuerda a la hora y cierra tras 30 min de silencio', async () => {
    const { reportIncident } = require('../src/common/incidents');
    const { IncidentsService } = require('../src/modules/incidents.module');
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'c1', name: 'Doña Rosa' });
    const mails = { systemSend: jest.fn(async () => ({})) };
    await reportIncident(prisma, { companyId: 'c1', kind: 'AI_DOWN', detail: 'DeepInfra 503' });
    await reportIncident(prisma, { companyId: 'c1', kind: 'AI_DOWN', detail: 'DeepInfra 503' });
    await reportIncident(prisma, { companyId: 'c1', kind: 'WA_SEND_FAILED', detail: 'Twilio 400' });
    expect(db.incident).toHaveLength(2);
    expect(db.incident[0].count).toBe(2);
    const svc = new IncidentsService(prisma as any, mails as any);
    await svc.watch();
    expect(mails.systemSend).toHaveBeenCalledTimes(2);
    await svc.watch();
    expect(mails.systemSend).toHaveBeenCalledTimes(2); // no repite antes de 1 hora
    db.incident[0].lastAt = new Date(Date.now() - 31 * 60e3);
    await svc.watch();
    expect(db.incident[0].resolvedAt).toBeTruthy();
    const list = await svc.list();
    expect(list.open).toHaveLength(1);
    expect(list.recent[0].companyName).toBe('Doña Rosa');
  });
});

describe('términos y condiciones con versión', () => {
  it('el admin de la empresa debe aceptar; una versión nueva pide aceptar otra vez; una corrección no', async () => {
    const { prisma, db } = createMockPrisma();
    db.user.push({ id: 'u1', companyId: 'c1', role: 'COMPANY_ADMIN', active: true });
    const terms = new TermsService(prisma as any, audit as any);
    expect((await terms.status(ADMIN)).required).toBe(true);
    expect((await terms.status(DEV)).required).toBe(false);
    expect((await terms.status({ ...ADMIN, role: 'COMPANY_COURIER' })).required).toBe(false);
    await expect(terms.accept(ADMIN, { version: 9 })).rejects.toBeInstanceOf(BadRequestException);
    await terms.accept(ADMIN, { version: 1 });
    expect((await terms.status(ADMIN)).required).toBe(false);

    const body = 'Texto de prueba de los términos. '.repeat(10);
    await terms.save(DEV, { title: 'Términos BackOffice', body, newVersion: false });
    expect((await terms.status(ADMIN)).required).toBe(false);
    const v2 = await terms.save(DEV, { title: 'Términos BackOffice', body: `${body} Cambio importante.`, newVersion: true });
    expect(v2).toMatchObject({ version: 2, usersTotal: 1, usersAccepted: 0 });
    expect((await terms.status(ADMIN))).toMatchObject({ required: true, updatedSinceAccepted: true });
    await expect(terms.save(DEV, { title: 'T', body: 'corto' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Meta Ads de BackOffice', () => {
  it('conecta la cuenta, trae campañas y calcula el costo por registro y por empresa con los UTM', async () => {
    const { prisma, db } = createMockPrisma();
    const ads = new MetaAdsService(prisma as any, audit as any);
    const calls: string[] = [];
    ads.fetchImpl = async (url: string) => {
      calls.push(url.split('?')[0]);
      const body = url.includes('/insights')
        ? { data: [{ campaign_id: '111111', spend: '200000', impressions: '50000', reach: '30000', clicks: '900', ctr: '1.8', cpc: '222', actions: [{ action_type: 'lead', value: '7' }] }] }
        : url.includes('/campaigns')
          ? { data: [{ id: '111111', name: 'Lanzamiento-Oct', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] }
          : { name: 'BackOffice Ads', currency: 'COP', account_status: 1 };
      return { ok: true, status: 200, json: async () => body };
    };
    await expect(ads.connect(DEV, { accountId: 'abc', token: 'x'.repeat(30) })).rejects.toBeInstanceOf(BadRequestException);
    await ads.connect(DEV, { accountId: 'act_1234567', token: 'EAAB'.padEnd(40, 'x') });
    expect(JSON.stringify(db.platformSetting)).not.toContain('EAABxxxx'); // token cifrado
    db.signupSession.push(
      { id: 's1', step: 'DONE', utmSource: 'facebook', utmCampaign: 'lanzamiento-oct', createdAt: new Date() },
      { id: 's2', step: 'PREVIEW', utmSource: 'instagram', utmCampaign: 'Lanzamiento-Oct', createdAt: new Date() },
      { id: 's3', step: 'DONE', utmSource: null, referrer: 'https://google.com', createdAt: new Date() },
    );
    await ads.addManual(DEV, { date: new Date().toISOString().slice(0, 10), campaign: 'volantes', spend: '50.000' });
    const r: any = await ads.overview({ days: '30' });
    expect(r.connected).toBe(true);
    expect(r.campaigns[0]).toMatchObject({ name: 'Lanzamiento-Oct', spend: 200000, leads: 7, signups: 2, companies: 1, costPerSignup: 100000, costPerCompany: 200000 });
    expect(r.totals).toMatchObject({ spend: 250000, signupsFromMeta: 2, companiesFromMeta: 1, signupsTotal: 3 });
    await expect(ads.setStatus(DEV, '111111', 'BORRAR')).rejects.toBeInstanceOf(BadRequestException);
    await ads.setStatus(DEV, '111111', 'PAUSED');
    expect(calls.at(-1)).toContain('/111111');
  });
});
