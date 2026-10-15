/**
 * Operación: domicilios 2.0, sucursales y zonas, Instagram/Messenger,
 * pedidos externos, factura electrónica, armado con IA, herramientas nuevas
 * del agente y permanencia (salida anticipada).
 */
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { matchZone, nearestBranch, pickCourier, quoteDelivery, suggestRoute } from '../src/common/geo';
import { OrdersService } from '../src/modules/orders.module';
import { DeliveryService } from '../src/modules/delivery.module';
import { parseMessagingEvents, sendMetaText, verifyMetaSignature } from '../src/common/meta';
import { WebhooksService } from '../src/modules/webhooks.module';
import { TwilioService } from '../src/modules/twilio.module';
import { InboundOrdersService } from '../src/modules/inbound-orders.module';
import { einvoiceTotals, issueEinvoice, serializeEinvoiceConfig } from '../src/common/einvoice';
import { AiSetupService, normalizeProposal } from '../src/modules/ai-setup.module';
import { AGENT_TOOLS } from '../src/ai/agent/tools';
import { EngineService } from '../src/modules/engine.module';
import { AgentService } from '../src/ai/agent/agent.service';
import { CompaniesService } from '../src/modules/companies.module';
import { AiChatOptions, AiChatResult, AiProvider } from '../src/ai/types';
import { encryptSecret } from '../src/common/crypto';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

const ADMIN = { id: 'adm1', role: 'COMPANY_ADMIN', companyId: 'co1', name: 'Admin', email: 'a@x.co' } as any;
const PLATFORM = { id: 'dev1', role: 'DEV', companyId: null, name: 'Dev', email: 'd@x.co' } as any;
const audit = { log: jest.fn(async () => undefined) };
const ORIGIN = { lat: 6.2442, lng: -75.5812 };

/* ═══ Domicilios 2.0 ═══ */

describe('domicilios: asignación automática', () => {
  const now = new Date();
  const couriers = [
    { id: 'lejos', onShift: true, lastLat: 6.30, lastLng: -75.55, lastLocAt: now },
    { id: 'cerca', onShift: true, lastLat: 6.245, lastLng: -75.581, lastLocAt: now },
    { id: 'sin_senal', onShift: true, lastLat: 6.2442, lastLng: -75.5812, lastLocAt: new Date(now.getTime() - 60 * 60e3) },
    { id: 'fuera', onShift: false, lastLat: 6.2442, lastLng: -75.5812, lastLocAt: now },
  ];

  it('elige el de menos carga; a igual carga el más cercano; sin señal o fuera de turno no', () => {
    expect(pickCourier(couriers, new Map(), ORIGIN, now)?.id).toBe('cerca');
    expect(pickCourier(couriers, new Map([['cerca', 2]]), ORIGIN, now)?.id).toBe('lejos');
    expect(pickCourier(couriers.slice(2), new Map(), ORIGIN, now)).toBeNull();
  });

  it('al quedar "listo" se asigna solo (si está activado) y nunca pisa una asignación manual', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'co1', orderConfigJson: JSON.stringify({ delivery: { enabled: true, autoAssign: true, origin: ORIGIN } }) });
    db.user.push({ id: 'u1', companyId: 'co1', role: 'COMPANY_COURIER', active: true, onShift: true, name: 'Andrés', lastLat: 6.245, lastLng: -75.58, lastLocAt: new Date() });
    db.order.push({ id: 'oA', companyId: 'co1', status: 'en_produccion', courierId: null, deletedAt: null });
    const orders = new OrdersService(prisma as any, audit as any, {} as any, undefined, { emit: jest.fn() } as any);
    await orders.changeStatus('oA', 'listo', { type: 'SISTEMA', name: 'test' });
    expect(db.order[0].courierId).toBe('u1');
    db.order.push({ id: 'oB', companyId: 'co1', status: 'listo', courierId: 'manual', deletedAt: null });
    expect(await orders.autoAssignCourier('oB')).toBeNull();
    expect(db.order[1].courierId).toBe('manual');
    db.company[0].orderConfigJson = JSON.stringify({ delivery: { enabled: true, autoAssign: false } });
    db.order.push({ id: 'oC', companyId: 'co1', status: 'listo', courierId: null, deletedAt: null });
    expect(await orders.autoAssignCourier('oC')).toBeNull();
  });
});

describe('domicilios: alertas de demora y ruta sugerida', () => {
  function setup(cfg: Record<string, any> = {}) {
    const { prisma, db } = createMockPrisma();
    const events = { emit: jest.fn() };
    const q = { add: jest.fn(async () => undefined) };
    db.company.push({ id: 'co1', status: 'ACTIVE', orderConfigJson: JSON.stringify({ delivery: { enabled: true, delayAlertMinutes: 10, unassignedAlertMinutes: 15, ...cfg } }) });
    const service = new DeliveryService(prisma as any, {} as any, audit as any, events as any, q as any);
    return { db, events, q, service };
  }

  it('alerta UNA vez si el pedido en ruta pasa su hora estimada; avisa al cliente si está activado', async () => {
    const { db, events, q, service } = setup({ notifyDelayToCustomer: true });
    db.conversation.push({ id: 'conv1', companyId: 'co1', channel: 'WHATSAPP' });
    db.message.push({ id: 'm', conversationId: 'conv1', direction: 'IN', createdAt: new Date(Date.now() - 3600e3) });
    db.order.push({ id: 'late1', companyId: 'co1', status: 'despachado', etaAt: new Date(Date.now() - 25 * 60e3), delayAlertedAt: null, deletedAt: null, conversationId: 'conv1' });
    db.order.push({ id: 'ontime', companyId: 'co1', status: 'despachado', etaAt: new Date(Date.now() - 5 * 60e3), delayAlertedAt: null, deletedAt: null });
    const alerts = await service.checkDelays();
    expect(alerts).toEqual([{ orderId: 'late1', kind: 'LATE', minutes: 25 }]);
    expect(events.emit).toHaveBeenCalledWith('co1', expect.objectContaining({ type: 'delivery.delay' }));
    expect(q.add).toHaveBeenCalledTimes(1);
    expect(await service.checkDelays()).toEqual([]); // no repite
  });

  it('alerta pedidos listos sin domiciliario; ruta del vecino más cercano', async () => {
    const { db, service } = setup();
    db.order.push({ id: 'r1', companyId: 'co1', status: 'listo', courierId: null, delayAlertedAt: null, deletedAt: null, updatedAt: new Date(Date.now() - 20 * 60e3) });
    db.orderStatusHistory.push({ orderId: 'r1', toStatus: 'listo', createdAt: new Date(Date.now() - 20 * 60e3) });
    expect(await service.checkDelays()).toEqual([{ orderId: 'r1', kind: 'UNASSIGNED', minutes: 20 }]);
    const route = suggestRoute(ORIGIN, [
      { id: 'lejos', lat: 6.30, lng: -75.55 }, { id: 'sin', lat: null, lng: null }, { id: 'cerca', lat: 6.25, lng: -75.58 }, { id: 'medio', lat: 6.27, lng: -75.57 },
    ]);
    expect(route.map((r) => r.id)).toEqual(['cerca', 'medio', 'lejos', 'sin']);
  });
});

describe('zonas por barrio y sucursales', () => {
  const zones = [{ name: 'Laureles', fee: 5000, keywords: ['laureles', 'estadio'] }, { name: 'Poblado', fee: 9000, keywords: ['poblado'] }];

  it('tarifa por zona (con o sin ubicación) y respaldo por km opcional', () => {
    expect(matchZone(zones, 'Cra 76 # 33-40 Laureles')?.name).toBe('Laureles');
    expect(matchZone(zones, 'Barrio Estadiolandia')).toBeNull(); // palabra completa
    expect(quoteDelivery({ enabled: true, pricingMode: 'ZONES', zones }, null, 0, 'COP', { addressText: 'cl 10 el poblado' })).toMatchObject({ covered: true, fee: 9000, zone: 'Poblado' });
    expect(quoteDelivery({ enabled: true, pricingMode: 'ZONES', zones }, null, 0, 'COP', { addressText: 'Bello' }).covered).toBe(false);
    expect(quoteDelivery({ enabled: true, pricingMode: 'ZONES', zones, zonesFallbackKm: true, origin: ORIGIN, baseFee: 3000, perKm: 1000 }, { lat: 6.25, lng: -75.57 }, 0, 'COP', { addressText: 'Bello' })).toMatchObject({ covered: true, zone: null });
  });

  it('la sucursal más cercana despacha y cambia el costo; validaciones del CRUD', async () => {
    const branches = [{ id: 'b1', name: 'Centro', lat: 6.2442, lng: -75.5812 }, { id: 'b2', name: 'Norte', lat: 6.33, lng: -75.56, active: true }];
    expect(nearestBranch(branches, { lat: 6.335, lng: -75.555 })?.id).toBe('b2');
    const cfg = { enabled: true, origin: ORIGIN, baseFee: 3000, perKm: 1000, maxKm: 5 };
    expect(quoteDelivery(cfg, { lat: 6.335, lng: -75.555 }).covered).toBe(false); // desde el origen
    expect(quoteDelivery(cfg, { lat: 6.335, lng: -75.555 }, 0, 'COP', { origin: branches[1] }).covered).toBe(true);
    const { prisma } = createMockPrisma();
    const service = new DeliveryService(prisma as any, {} as any, audit as any, { emit: jest.fn() } as any);
    await expect(service.saveBranch(ADMIN, { name: 'Sin ubicar' })).rejects.toBeInstanceOf(BadRequestException);
    const b = await service.saveBranch(ADMIN, { name: 'Laureles', lat: 6.24, lng: -75.59 });
    await expect(service.removeBranch({ ...ADMIN, companyId: 'co2' }, b.id)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/* ═══ Instagram / Messenger / WhatsApp Cloud API ═══ */

describe('Instagram y Messenger', () => {
  const igBody = {
    object: 'instagram',
    entry: [{ id: 'IG123', messaging: [
      { sender: { id: 'IGSID_1' }, recipient: { id: 'IG123' }, message: { mid: 'mid.1', text: 'hola, tienen almuerzo?' } },
      { sender: { id: 'IG123' }, recipient: { id: 'IGSID_1' }, message: { mid: 'mid.2', text: 'eco', is_echo: true } },
    ] }],
  };

  it('normaliza eventos (sin ecos) y verifica la firma HMAC de Meta', () => {
    expect(parseMessagingEvents(igBody)).toEqual([
      { channel: 'INSTAGRAM', accountId: 'IG123', senderId: 'IGSID_1', mid: 'mid.1', text: 'hola, tienen almuerzo?', type: 'TEXT' },
    ]);
    const raw = Buffer.from(JSON.stringify(igBody));
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    expect(verifyMetaSignature(raw, sig, 'app-secret')).toBe(true);
    expect(verifyMetaSignature(raw, sig, 'otro')).toBe(false);
    expect(verifyMetaSignature(raw, undefined, 'app-secret')).toBe(false);
  });

  it('el mensaje entra al motor (cola engine), es idempotente y respeta la baja', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'co1', slug: 'la-esquina', name: 'La Esquina' });
    db.integration.push({ id: 'ig1', companyId: 'co1', type: 'INSTAGRAM', botId: 'bot1', configJson: JSON.stringify({ igUserId: 'IG123' }) });
    const engineQueue = { add: jest.fn(async () => undefined), getJob: jest.fn(async () => null) };
    const service = new WebhooksService(prisma as any, engineQueue as any, { add: jest.fn() } as any, { emit: jest.fn() } as any);
    expect(await service.ingestMeta('la-esquina', igBody)).toEqual({ ok: true, stored: 1 });
    expect(await service.ingestMeta('la-esquina', igBody)).toEqual({ ok: true, stored: 0 }); // reintento de Meta
    expect(db.contact[0]).toMatchObject({ externalId: 'INSTAGRAM:IGSID_1', channel: 'INSTAGRAM' });
    expect(db.conversation[0]).toMatchObject({ channel: 'INSTAGRAM', integrationId: 'ig1', botId: 'bot1' });
    expect(engineQueue.add).toHaveBeenCalledTimes(1);
    const stop = { object: 'instagram', entry: [{ id: 'IG123', messaging: [{ sender: { id: 'IGSID_1' }, message: { mid: 'mid.3', text: 'STOP' } }] }] };
    await service.ingestMeta('la-esquina', stop);
    expect(db.contact[0].optOut).toBe(true);
    expect(engineQueue.add).toHaveBeenCalledTimes(1); // la baja no pasa por la IA
  });

  it('la respuesta sale por la Graph API (o en sandbox sin token); fuera de 24 h no se envía', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ message_id: 'm_out' }) })) as any;
    const sent = await sendMetaText({ channel: 'INSTAGRAM', config: { provider: 'META', accessToken: 'tok', sandbox: false }, recipient: 'IGSID_1', text: 'hola' }, fetchMock);
    expect(sent.id).toBe('m_out');
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/me/messages');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ recipient: { id: 'IGSID_1' }, message: { text: 'hola' } });

    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'co1', slug: 'x', orderConfigJson: '{}' });
    db.contact.push({ id: 'c1', companyId: 'co1', externalId: 'INSTAGRAM:IGSID_1' });
    db.integration.push({ id: 'ig1', companyId: 'co1', type: 'INSTAGRAM', configJson: '{}' });
    db.conversation.push({ id: 'conv1', companyId: 'co1', contactId: 'c1', integrationId: 'ig1', channel: 'INSTAGRAM' });
    db.message.push({ id: 'in1', conversationId: 'conv1', direction: 'IN', createdAt: new Date() });
    db.message.push({ id: 'out1', conversationId: 'conv1', direction: 'OUT', content: 'respuesta', deliveryStatus: 'QUEUED', createdAt: new Date() });
    const twilio = new TwilioService(prisma as any, audit as any, {} as any, {} as any, {} as any, { emit: jest.fn() } as any);
    const res = await twilio.processOutbound({ messageId: 'out1' });
    expect(String(res.sid)).toMatch(/^SANDBOX_/); // sin token: jamás sale real
    db.message[0].createdAt = new Date(Date.now() - 30 * 3600e3);
    db.message.push({ id: 'out2', conversationId: 'conv1', direction: 'OUT', content: 'tarde', deliveryStatus: 'QUEUED', createdAt: new Date() });
    expect(await twilio.processOutbound({ messageId: 'out2' })).toMatchObject({ failed: 'fuera de ventana' });
  });
});

/* ═══ Pedidos de otras plataformas ═══ */

describe('pedidos externos (Rappi, web) con llave de API', () => {
  function setup(scopes = ['orders']) {
    const { prisma, db } = createMockPrisma();
    const secret = 'bo_live_' + 'a'.repeat(48);
    db.apiKey.push({ id: 'k1', companyId: 'co1', hash: createHash('sha256').update(secret).digest('hex'), scopesJson: JSON.stringify(scopes), revokedAt: null });
    db.company.push({ id: 'co1', name: 'La Esquina', currency: 'COP', orderConfigJson: '{}' });
    db.product.push({ id: 'p1', companyId: 'co1', name: 'Almuerzo', price: 18000, unit: 'porción', deletedAt: null });
    const orders = { changeStatus: jest.fn(async (id: string, to: string) => { db.order.find((o: any) => o.id === id)!.status = 'programado'; }) };
    return { db, secret, orders, service: new InboundOrdersService(prisma as any, orders as any, audit as any) };
  }

  it('llave válida con scope de pedidos; inválida, revocada o sin scope → rechazada', async () => {
    const { db, secret, service } = setup();
    expect(await service.companyFromKey(secret)).toBe('co1');
    await expect(service.companyFromKey('bo_live_otra')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.companyFromKey(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    db.apiKey[0].scopesJson = '["read"]';
    await expect(service.companyFromKey(secret)).rejects.toBeInstanceOf(ForbiddenException);
    db.apiKey[0].revokedAt = new Date();
    await expect(service.companyFromKey(secret)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('crea el pedido en la misma operación, es idempotente y valida la entrada', async () => {
    const { db, orders, service } = setup();
    const dto = {
      source: 'rappi', externalId: 'RP-998', customer: { name: 'Carlos', phone: '+57 310 555 0000', address: 'Cl 10 # 40-20', lat: 6.25, lng: -75.57 },
      items: [{ name: 'almuerzo', quantity: 2 }, { name: 'Gaseosa', quantity: 1, unitPrice: 4000 }], deliveryFee: 0, paid: true,
    };
    const first = await service.createExternal('co1', dto);
    expect(first).toMatchObject({ duplicate: false, status: 'programado' });
    expect(orders.changeStatus).toHaveBeenCalledWith(first.id, 'confirmado', expect.anything(), expect.any(String));
    const order = db.order.find((o: any) => o.id === first.id)!;
    expect(order).toMatchObject({ source: 'RAPPI', externalId: 'RP-998', subtotal: 40000, paymentStatus: 'PAID' });
    expect(db.orderItem.filter((i: any) => i.orderId === first.id).map((i: any) => i.productId)).toEqual(['p1', null]);
    expect(await service.createExternal('co1', dto)).toMatchObject({ duplicate: true, id: first.id });
    await expect(service.createExternal('co1', { ...dto, source: 'HACK' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createExternal('co1', { ...dto, externalId: 'x2', items: [] })).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ═══ Factura electrónica ═══ */

describe('factura electrónica DIAN', () => {
  const input = {
    orderCode: 'ABC123', customer: { name: 'Carlos', taxId: '1.020.304' },
    items: [{ name: 'Almuerzo', quantity: 2, unitPrice: 18900 }], deliveryFee: 5400, date: new Date('2026-10-15'),
  };

  it('simulada: numeración consecutiva y totales con impuesto incluido', async () => {
    const first = await issueEinvoice(JSON.stringify({ provider: 'SIMULADO' }), input);
    expect(first.result).toMatchObject({ ok: true, number: 'SIM-0001' });
    const second = await issueEinvoice(first.nextConfig, input);
    expect(second.result.number).toBe('SIM-0002');
    expect(einvoiceTotals(input, 0.08)).toEqual({ total: 43200, base: 40000, tax: 3200 });
    expect((await issueEinvoice('{}', input)).result.ok).toBe(false);
  });

  it('Alegra: crea contacto y factura con timbrado; errores del proveedor se devuelven claros', async () => {
    const cfg = JSON.stringify({ provider: 'ALEGRA', email: 'cont@x.co', tokenEnc: encryptSecret('tok-alegra'), alegraTaxId: 3 });
    const calls: any[] = [];
    const fetchOk = jest.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return url.endsWith('/contacts')
        ? { ok: true, json: async () => ({ id: 77 }) }
        : { ok: true, json: async () => ({ id: 901, numberTemplate: { fullNumber: 'FE-901' } }) };
    }) as any;
    const res = await issueEinvoice(cfg, input, fetchOk);
    expect(res.result).toMatchObject({ ok: true, number: 'FE-901', providerId: '901' });
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('cont@x.co:tok-alegra').toString('base64')}`);
    expect(calls[1].body).toMatchObject({ client: 77, stamp: { generateStamp: true } });
    expect(calls[1].body.items[0]).toMatchObject({ name: 'Almuerzo', quantity: 2, price: 17500, tax: [{ id: 3 }] });
    const fetchErr = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ message: 'Numeración vencida' }) })) as any;
    expect((await issueEinvoice(cfg, input, fetchErr)).result).toMatchObject({ ok: false, error: expect.stringContaining('Numeración vencida') });
    expect(serializeEinvoiceConfig(cfg)).toMatchObject({ provider: 'ALEGRA', hasToken: true, ready: true });
    expect(JSON.stringify(serializeEinvoiceConfig(cfg))).not.toContain('enc:v1');
  });
});

/* ═══ Armado del negocio con IA ═══ */

class ScriptProvider implements AiProvider {
  calls: AiChatOptions[] = [];
  constructor(private readonly outputs: any[]) {}
  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    this.calls.push(opts);
    return { content: JSON.stringify(this.outputs.shift()), inputTokens: 500, outputTokens: 300, model: opts.model };
  }
  async transcribe() {
    return { text: '' };
  }
}

describe('armado del negocio con IA', () => {
  it('normaliza la propuesta: sin duplicados, precios válidos, horario coherente', () => {
    const p = normalizeProposal({
      productos: [{ nombre: 'Almuerzo', precio: '18.000' }, { nombre: 'almuerzo', precio: 1 }, { nombre: '', precio: 1 }, { nombre: 'Jugo', precio: -5 }],
      horario: { dias: [1, 2, 9, 2], abre: '11:00', cierra: '15:30' },
      domicilios: { activo: true, tarifa_base: 3000 },
      preguntas: [{ pregunta: '¿Nequi?', respuesta: 'Sí' }, { pregunta: 'sin respuesta' }],
      asistente: { nombre: 'Tomás', tono: 'cercano' },
    });
    expect(p.products).toEqual([
      { name: 'Almuerzo', category: null, price: 18000, description: null, presentations: [] },
      { name: 'Jugo', category: null, price: null, description: null, presentations: [] },
    ]);
    expect(p.schedule).toEqual({ days: [1, 2], open: '11:00', close: '15:30' });
    expect(p.faqs).toHaveLength(1);
    expect(normalizeProposal({ horario: { dias: [1], abre: '18:00', cierra: '09:00' } }).schedule).toBeNull();
  });

  it('propone con la IA de la empresa y aplica sin pisar productos ni inventar el punto de despacho', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'co1', name: 'La Esquina', city: 'Medellín', deepinfraApiKey: 'di_key', aiBillingMode: 'BYOK', orderConfigJson: '{}' });
    db.product.push({ id: 'p0', companyId: 'co1', name: 'Almuerzo', deletedAt: null });
    const provider = new ScriptProvider([{
      productos: [{ nombre: 'Almuerzo', precio: 18000 }, { nombre: 'Bandeja paisa', precio: 25000, categoria: 'Platos' }],
      horario: { dias: [1, 2, 3, 4, 5], abre: '11:00', cierra: '15:00' },
      domicilios: { activo: true, tarifa_base: 3000, por_km: 1000 },
      preguntas: [{ pregunta: '¿Aceptan Nequi?', respuesta: 'Sí, Nequi y efectivo.' }],
      asistente: { nombre: 'Tomás', tono: 'paisa', instrucciones: 'Vendes almuerzos.' },
    }]);
    const service = new AiSetupService(prisma as any, audit as any, provider);
    await expect(service.preview(ADMIN, { description: 'corto' })).rejects.toBeInstanceOf(BadRequestException);
    const proposal = await service.preview(ADMIN, { description: 'Vendemos almuerzos ejecutivos a 18 mil y bandeja paisa a 25 mil, de lunes a viernes, con domicilios.' });
    expect(db.aiUsageEvent).toHaveLength(1);
    const applied = await service.apply(ADMIN, { proposal });
    expect(applied).toMatchObject({ productsCreated: 1, productsSkipped: 1, faqsAdded: 1, scheduleSet: true, deliveryNeedsOrigin: true });
    const cfg = JSON.parse(db.company[0].orderConfigJson);
    expect(cfg.delivery).toMatchObject({ enabled: false, baseFee: 3000 }); // sin origen no se activa
    expect(db.bot[0]).toMatchObject({ engineMode: 'AGENT', status: 'DRAFT', name: 'Tomás' });
  });
});

/* ═══ Herramientas nuevas del agente ═══ */

describe('agente: cupones, link de pago y base de conocimiento', () => {
  function ctx(db: any, prisma: any, extra: Record<string, any> = {}) {
    return { prisma, company: db.company[0], orderConfig: {}, conversation: { id: 'conv1' }, contact: db.contact[0], now: new Date(), state: { draftOrderId: null, confirmedOrderId: null }, ...extra } as any;
  }
  function setup() {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'co1', name: 'La Esquina', slug: 'la-esquina', currency: 'COP', timezone: 'America/Bogota', paymentConfigJson: JSON.stringify({ publicKey: 'pub_test_x', manualInstructions: 'Nequi 300 000 0000' }) });
    db.contact.push({ id: 'c1', companyId: 'co1', name: 'Ana', customerId: null });
    db.product.push({ id: 'p1', companyId: 'co1', name: 'Almuerzo', price: 18000, active: true, deletedAt: null, unit: 'u' });
    db.promotion.push({ id: 'pr1', companyId: 'co1', code: 'HOLA10', name: 'Bienvenida', kind: 'PERCENT', value: 10, active: true, usedCount: 0, productIdsJson: '[]' });
    return { prisma, db };
  }
  const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;

  it('armar_pedido aplica el cupón (o explica por qué no); confirmar descuenta un uso', async () => {
    const { prisma, db } = setup();
    const c = ctx(db, prisma);
    const bad = await tool('armar_pedido').run(c, { items: [{ producto: 'almuerzo', cantidad: 2 }], direccion: 'Cl 10', cupon: 'NOPE' });
    expect(bad.error).toMatch(/Cupón no aplicado/);
    const ok = await tool('armar_pedido').run(c, { items: [{ producto: 'almuerzo', cantidad: 2 }], direccion: 'Cl 10', entrega: '2026-12-01T12:00', cupon: 'hola10' });
    expect(ok.borrador.descuento).toMatch(/3\.600/);
    expect(db.order[0]).toMatchObject({ discount: 3600, couponCode: 'HOLA10', total: 32400 });
    await tool('confirmar_pedido').run(c, { cliente_confirmo: true });
    expect(db.promotion[0].usedCount).toBe(1);
  });

  it('enviar_link_pago: con Wompi genera el link; sin Wompi da las instrucciones manuales', async () => {
    const { prisma, db } = setup();
    db.order.push({ id: 'ordX', companyId: 'co1', contactId: 'c1', status: 'programado', total: 36000, paymentStatus: 'NONE', deletedAt: null, createdAt: new Date() });
    const payments = { createOrderPaymentLink: jest.fn(async () => ({ url: 'https://checkout.wompi.co/p/?x', reference: 'ORD-1' })) };
    const withWompi = await tool('enviar_link_pago').run(ctx(db, prisma, { payments }), {});
    expect(withWompi).toMatchObject({ ok: true, link_pago: 'https://checkout.wompi.co/p/?x' });
    db.company[0].paymentConfigJson = JSON.stringify({ manualInstructions: 'Nequi 300 000 0000' });
    const manual = await tool('enviar_link_pago').run(ctx(db, prisma, { payments }), {});
    expect(manual).toMatchObject({ pago_en_linea: false, instrucciones_pago: 'Nequi 300 000 0000' });
  });

  it('buscar_conocimiento devuelve fragmentos o pide no inventar', async () => {
    const { prisma, db } = setup();
    const knowledge = { search: jest.fn(async (_c: string, q: string) => (q.includes('frío') ? [{ text: 'Lo reponemos sin costo', doc: 'Políticas', score: 2 }] : [])) };
    expect(await tool('buscar_conocimiento').run(ctx(db, prisma, { knowledge }), { pregunta: 'llegó frío' }))
      .toEqual({ resultados: [{ fuente: 'Políticas', texto: 'Lo reponemos sin costo' }] });
    expect((await tool('buscar_conocimiento').run(ctx(db, prisma, { knowledge }), { pregunta: 'parqueadero' })).nota).toMatch(/no inventes/);
  });
});

describe('comprobante por WhatsApp → pedido "por verificar"', () => {
  it('el motor lee la imagen y deja el pedido REPORTED (nunca PAGADO solo)', async () => {
    const { prisma, db } = createMockPrisma();
    const outputs = [
      { es_comprobante: true, monto: '$41.000', entidad: 'Nequi', referencia: 'M77' },
      { reply: ['¡Gracias! Ya lo verificamos.'], confidence: 0.9, state: 'seguimiento' },
    ];
    const provider: AiProvider = {
      chat: jest.fn(async (o: AiChatOptions) => ({ content: JSON.stringify(outputs.shift()), inputTokens: 100, outputTokens: 20, model: o.model })),
      transcribe: jest.fn(),
    };
    const agent = new AgentService(prisma as any, provider);
    const engine = new EngineService(prisma as any, provider, audit as any, undefined, undefined, { emit: jest.fn() } as any, agent);
    db.company.push({ id: 'co1', name: 'X', timezone: 'America/Bogota', deepinfraApiKey: 'k', aiBillingMode: 'BYOK', orderConfigJson: '{}' });
    db.bot.push({ id: 'b1', companyId: 'co1', status: 'ACTIVE', engineMode: 'AGENT', toolsJson: '[]', systemPrompt: '', personalityJson: '{}', salesJson: '{}', model: 'm', temperature: 0.4, replyDelayMinSec: 1, replyDelayMaxSec: 2, handoffKeywords: '' });
    db.contact.push({ id: 'c1', companyId: 'co1', name: 'Ana' });
    db.conversation.push({ id: 'conv1', companyId: 'co1', contactId: 'c1', botId: 'b1', channel: 'SIMULATOR', status: 'OPEN', botPaused: false, aiStateJson: '{}' });
    db.order.push({ id: 'o1', companyId: 'co1', contactId: 'c1', status: 'programado', total: 41000, paymentStatus: 'PENDING', deletedAt: null, createdAt: new Date() });
    const fs = require('fs');
    const path = require('path');
    const dir = path.resolve(process.cwd(), 'uploads', 'co1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-recibo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    db.message.push({ id: 'img', conversationId: 'conv1', direction: 'IN', author: 'CONTACT', type: 'IMAGE', fileName: 'test-recibo.jpg', content: '[image recibido]', createdAt: new Date() });
    await engine.processConversation('conv1');
    fs.unlinkSync(path.join(dir, 'test-recibo.jpg'));
    expect(db.order[0]).toMatchObject({ paymentStatus: 'REPORTED', receiptMessageId: 'img' });
    expect(JSON.parse(db.order[0].receiptJson)).toMatchObject({ amount: 41000, matches: true });
    // la IA conversacional vio la descripción, no la imagen cruda
    const chatCall = (provider.chat as jest.Mock).mock.calls[1][0] as AiChatOptions;
    expect(chatCall.messages.some((m) => String(m.content).includes('comprobante de pago Nequi'))).toBe(true);
  });
});

/* ═══ Permanencia ═══ */

describe('permanencia: salida anticipada', () => {
  it('cancelar antes de cumplir la permanencia crea el cobro proporcional del montaje (salvo exoneración)', async () => {
    const { prisma, db } = createMockPrisma();
    const plan = { id: 'pl', minTermMonths: 6, setupFeeValue: 1200000 };
    db.plan.push(plan);
    const start = new Date();
    start.setMonth(start.getMonth() - 2);
    db.company.push({ id: 'co1', name: 'X', status: 'ACTIVE', planId: 'pl', contractStartAt: start, plan, modulesJson: '[]', limitsJson: '{}', orderConfigJson: '{}', waTemplatesJson: '[]', paymentConfigJson: '{}', einvoiceConfigJson: '{}' });
    const service = new CompaniesService(prisma as any, audit as any);
    await expect(service.update(ADMIN, 'co1', { customPriceMonthly: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await service.update(PLATFORM, 'co1', { status: 'CANCELLED' });
    expect(db.billingAdjustment).toHaveLength(1);
    expect(db.billingAdjustment[0]).toMatchObject({ kind: 'SETUP', amount: 800000 });
    db.company[0].status = 'ACTIVE';
    await service.update(PLATFORM, 'co1', { status: 'CANCELLED', waiveSetupFee: true });
    expect(db.billingAdjustment).toHaveLength(1);
  });
});
