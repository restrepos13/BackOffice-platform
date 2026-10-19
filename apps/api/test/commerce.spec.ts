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

describe('compra del plan: pedido → pago confirmado → activación', () => {
  function setup() {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'c1', name: 'Doña Rosa', status: 'ONBOARDING', aiBillingMode: 'PLATFORM', contactPhone: '3001234567', onboardingJson: JSON.stringify({ rubro: 'COMIDAS', dailyChats: 25, modules: ['orders', 'menu'], contactName: 'Rosa', phone: '3001234567' }), modulesJson: '[]' });
    db.plan.push(
      { id: 'p1', code: 'negocios-1', name: 'Emprende', priceMonthly: 149000, maxUsers: 2, maxLines: 1, maxCouriers: 0, sortOrder: 1, line: 'COMIDAS', active: true, featuresJson: '[]', minTermMonths: 0 },
      { id: 'p2', code: 'negocios-2', name: 'Crece', priceMonthly: 349000, maxUsers: 5, maxLines: 2, maxCouriers: 3, sortOrder: 2, line: 'COMIDAS', active: true, featuresJson: '[]', minTermMonths: 12 },
    );
    PACKAGES.forEach((p) => db.aiCreditPackage.push({ ...p, active: true, currency: 'COP' }));
    db.user.push({ id: 'u1', companyId: 'c1', active: true, role: 'COMPANY_ADMIN' });
    return { db, service: new CheckoutService(prisma as any, audit as any, emails as any) };
  }

  it('la empresa ve la recomendación sin datos bancarios y Wompi como "próximamente"', async () => {
    const { service } = setup();
    const v: any = await service.checkout(ADMIN);
    expect(v.recommendation.plan.planId).toBe('p1');
    expect(v.recommendation.aiPackage.name).toBe('Paquete 2.000'); // 25 al día ≈ 750 al mes
    expect(v.paymentOptions.find((o: any) => o.id === 'WOMPI')).toMatchObject({ comingSoon: true, available: false });
    expect(JSON.stringify(v)).not.toMatch(/\d{9,}/); // ningún número de cuenta
  });

  it('comprar crea un pedido (reemplaza el anterior), avisa al equipo y al activar deja todo listo', async () => {
    const { db, service } = setup();
    await service.createOrder(ADMIN, { planId: 'p1', billingCycle: 'MONTHLY' });
    const { order } = await service.createOrder(ADMIN, { planId: 'p2', billingCycle: 'ANNUAL', aiPackageId: 'k2' });
    expect(order).toMatchObject({ planName: 'Crece', planAmount: 3490000, aiPackageAmount: 299000, total: 3789000, status: 'REQUESTED' });
    expect(db.planOrder.filter((o: any) => o.status === 'CANCELLED')).toHaveLength(1);
    expect(emails.systemSend).toHaveBeenCalled();
    await expect(service.createOrder({ ...ADMIN, role: 'COMPANY_VIEWER' }, { planId: 'p1' })).rejects.toBeTruthy();

    await service.saveMethods(DEV, { accounts: [{ bank: 'Bancolombia', type: 'Ahorros', number: '123-456789-01', holder: 'Santiago R.', document: '1020304050', owner: 'Santiago' }] });
    const msg = await service.paymentMessage(order.id, 'TRANSFER');
    expect(msg.text).toContain('123-456789-01');
    expect(msg.text).toContain('$3.789.000');
    await expect(service.saveMethods(DEV, { accounts: [{ bank: 'X', number: '12' }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.saveMethods(DEV, { qr: { enabled: true } })).rejects.toThrow(/QR/);

    const done = await service.activate(DEV, order.id);
    expect(done.status).toBe('ACTIVE');
    expect(db.company[0]).toMatchObject({ planId: 'p2', status: 'ACTIVE', billingCycle: 'ANNUAL' });
    expect(db.aiCreditLot[0]).toMatchObject({ companyId: 'c1', total: 2000, source: 'PURCHASE' });
    // Activar dos veces no duplica el saldo
    await service.activate(DEV, order.id);
    expect(db.aiCreditLot).toHaveLength(1);
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
