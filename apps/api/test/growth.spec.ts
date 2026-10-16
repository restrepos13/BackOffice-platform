/**
 * Crecimiento y operación: campañas, baja, seguimiento automático, reseñas,
 * promociones, comprobantes con IA, agotados, menú con QR, respuestas
 * rápidas, embudos y base de conocimiento.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CampaignsService, sanitizeSegment } from '../src/modules/campaigns.module';
import { applyConsent, isOptInText, isOptOutText, renderCampaignText } from '../src/common/customer-notify';
import { TwilioService } from '../src/modules/twilio.module';
import { evaluatePromotion, pickPromotion, validatePromotionInput } from '../src/common/promotions';
import { PromotionsService } from '../src/modules/promotions.module';
import { describeForChat, normalizeAnalysis, receiptMatches } from '../src/ai/vision';
import { AGENT_TOOLS, isSoldOut } from '../src/ai/agent/tools';
import { MenuService, menuWhatsapp } from '../src/modules/menu.module';
import { qrMatrix, qrSvg } from '../src/common/qr';
import { sanitizeStages } from '../src/common/pipelines';
import { PipelinesService } from '../src/modules/pipelines.module';
import { ContactsService } from '../src/modules/contacts.module';
import { assertPublicUrl, chunkText, htmlToText, searchChunks } from '../src/common/knowledge';
import { KnowledgeService, pdfToText } from '../src/modules/knowledge.module';
import { createMockPrisma } from './helpers/mock-prisma';

const ADMIN = { id: 'adm1', role: 'COMPANY_ADMIN', companyId: 'co1', name: 'Admin', email: 'a@x.co' } as any;
const audit = { log: jest.fn(async () => undefined) };
const queue = () => ({ add: jest.fn(async () => undefined) });

function company(db: any, extra: Record<string, any> = {}) {
  db.company.push({
    id: 'co1', name: 'La Esquina', slug: 'la-esquina', status: 'ACTIVE', timezone: 'America/Bogota', currency: 'COP',
    orderConfigJson: '{}', waTemplatesJson: '[]', ...extra,
  });
}

/* ═══ Campañas ═══ */

describe('campañas por WhatsApp', () => {
  function setup() {
    const { prisma, db } = createMockPrisma();
    const q = queue();
    const service = new CampaignsService(prisma as any, audit as any, q as any);
    company(db, { waTemplatesJson: JSON.stringify([{ key: 'menu_semana', contentSid: 'HX123', category: 'MARKETING' }]) });
    db.integration.push({ id: 'line1', companyId: 'co1', type: 'WHATSAPP', name: 'Línea' });
    const now = Date.now();
    db.contact.push(
      { id: 'c_hot', companyId: 'co1', name: 'Laura Gómez', phone: '+57300', channel: 'WHATSAPP', stage: 'CLIENTE', tagsJson: '["vip"]', optOut: false, lastActivityAt: new Date() },
      { id: 'c_cold', companyId: 'co1', name: 'Pedro', phone: '+57301', channel: 'WHATSAPP', stage: 'CLIENTE', tagsJson: '[]', optOut: false, lastActivityAt: new Date(now - 40 * 86400e3) },
      { id: 'c_out', companyId: 'co1', name: 'No Molestar', phone: '+57302', channel: 'WHATSAPP', stage: 'CLIENTE', tagsJson: '["vip"]', optOut: true, lastActivityAt: new Date() },
      { id: 'c_lead', companyId: 'co1', name: 'Lead', phone: '+57303', channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]', lastActivityAt: new Date() },
    );
    // Laura escribió hace 2 h (dentro de 24 h); Pedro hace 40 días
    db.conversation.push({ id: 'conv_hot', companyId: 'co1', contactId: 'c_hot', integrationId: 'line1', channel: 'WHATSAPP', status: 'OPEN', lastMessageAt: new Date() });
    db.message.push({ id: 'mh', conversationId: 'conv_hot', direction: 'IN', author: 'CONTACT', content: 'hola', createdAt: new Date(now - 2 * 3600e3) });
    db.order.push(
      { id: 'o1', companyId: 'co1', contactId: 'c_cold', status: 'entregado', createdAt: new Date(now - 40 * 86400e3), deletedAt: null },
      { id: 'o2', companyId: 'co1', contactId: 'c_hot', status: 'entregado', createdAt: new Date(now - 3 * 86400e3), deletedAt: null },
    );
    db.orderItem.push({ id: 'i1', orderId: 'o1', productId: 'p_almuerzo' }, { id: 'i2', orderId: 'o2', productId: 'p_jugo' });
    return { prisma, db, q, service };
  }

  it('segmentos: clientes, inactivos, por producto y por etiqueta — nunca a quien pidió la baja', async () => {
    const { service } = setup();
    const names = async (segment: any) => (await service.resolveAudience('co1', sanitizeSegment(segment))).map((c) => c.id).sort();
    expect(await names({})).toEqual(['c_cold', 'c_hot', 'c_lead']);
    expect(await names({ customersOnly: true })).toEqual(['c_cold', 'c_hot']);
    expect(await names({ inactiveDays: 30, customersOnly: true })).toEqual(['c_cold']);
    expect(await names({ productIds: ['p_jugo'] })).toEqual(['c_hot']);
    expect(await names({ tags: ['VIP'] })).toEqual(['c_hot']);
    expect(sanitizeSegment({ inactiveDays: -3, stages: 'x', hack: 1 })).toEqual({});
  });

  it('vista previa: dentro de 24 h va gratis; fuera solo con plantilla (y se estima el costo)', async () => {
    const { service } = setup();
    const noTemplate = await service.preview(ADMIN, { segment: { customersOnly: true }, integrationId: 'line1' });
    expect(noTemplate).toMatchObject({ count: 2, inWindow: 1, outWindow: 1, willSkip: 1, estimatedCostUsd: 0 });
    const withTemplate = await service.preview(ADMIN, { segment: { customersOnly: true }, integrationId: 'line1', templateKey: 'menu_semana' });
    expect(withTemplate).toMatchObject({ willSkip: 0, estimatedCostUsd: 0.0125 });
  });

  it('envío: escalonado por la cola, con plantilla fuera de 24 h, sin doble envío y con métricas', async () => {
    const { db, q, service } = setup();
    const b = await service.create(ADMIN, {
      name: 'Menú de la semana', integrationId: 'line1', templateKey: 'menu_semana',
      message: 'Hola {{nombre}}, este es el menú de {{empresa}} 🥗', segment: { customersOnly: true },
    });
    const sent = await service.send(ADMIN, b.id);
    expect(sent).toMatchObject({ queued: 2, skipped: 0, status: 'SENT' });
    await expect(service.send(ADMIN, b.id)).rejects.toBeInstanceOf(BadRequestException);
    const calls = q.add.mock.calls.map((c: any[]) => ({ cat: c[1].metaCategory, sid: c[1].contentSid, delay: c[2].delay }));
    expect(calls).toEqual(expect.arrayContaining([
      { cat: 'SERVICIO', sid: undefined, delay: expect.any(Number) },
      { cat: 'MARKETING', sid: 'HX123', delay: expect.any(Number) },
    ]));
    expect(db.message.some((m: any) => m.content === 'Hola Laura, este es el menú de La Esquina 🥗')).toBe(true);

    // Laura responde y pide → métricas
    db.message.push({ id: 'reply', conversationId: 'conv_hot', direction: 'IN', author: 'CONTACT', content: 'quiero 2', createdAt: new Date(Date.now() + 1000) });
    db.order.push({ id: 'o3', companyId: 'co1', contactId: 'c_hot', status: 'programado', total: 41000, createdAt: new Date(Date.now() + 2000), deletedAt: null });
    const detail = await service.detail(ADMIN, b.id);
    expect(detail.stats).toMatchObject({ recipients: 2, queued: 2, replied: 1, orders: 1, revenue: 41000 });

    // Reenvío solo a quien no respondió
    const retarget = await service.retarget(ADMIN, b.id, {});
    expect(retarget.preview.count).toBe(1);
    expect(retarget.segment).toMatchObject({ fromBroadcastId: b.id, fromBroadcastFilter: 'no_reply' });
  });

  it('sin plantilla, los de fuera de 24 h se omiten con motivo', async () => {
    const { service } = setup();
    const b = await service.create(ADMIN, { name: 'Promo', integrationId: 'line1', message: 'Hoy 2x1', segment: { customersOnly: true } });
    const sent = await service.send(ADMIN, b.id);
    expect(sent).toMatchObject({ queued: 1, skipped: 1 });
    const detail = await service.detail(ADMIN, b.id);
    expect(detail.skipReasons[0]).toMatch(/24 h/);
  });
});

/* ═══ Baja (STOP) ═══ */

describe('baja y re-alta por WhatsApp', () => {
  it('reconoce los textos de baja y de alta (cortos y explícitos)', () => {
    for (const t of ['STOP', 'baja', 'No más mensajes', 'no quiero recibir más mensajes', 'Desuscribirme.']) expect(isOptOutText(t)).toBe(true);
    for (const t of ['no me gustó el almuerzo, stop', 'quiero dar de baja mi pedido de mañana', 'hola']) expect(isOptOutText(t)).toBe(false);
    expect(isOptInText('ALTA')).toBe(true);
    expect(renderCampaignText('Hola {{nombre}} , ¿qué tal?', { nombre: 'Laura Gómez' })).toBe('Hola Laura, ¿qué tal?');
  });

  it('STOP marca la baja, responde y queda fuera de campañas; ALTA lo vuelve a incluir', async () => {
    const { prisma, db } = createMockPrisma();
    company(db);
    db.contact.push({ id: 'c1', companyId: 'co1', name: 'Ana', phone: '+57', channel: 'WHATSAPP', optOut: false });
    const conversation = { id: 'conv1', channel: 'WHATSAPP' };
    db.conversation.push({ ...conversation, companyId: 'co1', contactId: 'c1' });
    const q = queue();
    expect(await applyConsent(prisma, q as any, db.contact[0], conversation, 'STOP')).toBe('OPT_OUT');
    expect(db.contact[0].optOut).toBe(true);
    expect(q.add).toHaveBeenCalledTimes(1);
    const campaigns = new CampaignsService(prisma as any, audit as any, q as any);
    expect(await campaigns.resolveAudience('co1', {})).toHaveLength(0);
    expect(await applyConsent(prisma, q as any, db.contact[0], conversation, 'hola')).toBeNull();
    expect(await applyConsent(prisma, q as any, db.contact[0], conversation, 'alta')).toBe('OPT_IN');
    expect(db.contact[0].optOut).toBe(false);
  });
});

/* ═══ Seguimiento automático ═══ */

describe('seguimiento automático', () => {
  function setup(rules: any[], lastBotHoursAgo: number) {
    const { prisma, db } = createMockPrisma();
    company(db, { orderConfigJson: JSON.stringify({ followUps: rules }) });
    db.contact.push({ id: 'c1', companyId: 'co1', name: 'Ana Ruiz', optOut: false });
    db.conversation.push({ id: 'conv1', companyId: 'co1', contactId: 'c1', channel: 'WHATSAPP', status: 'OPEN', botPaused: false, needsAttention: false, aiStateJson: '{}', lastMessageAt: new Date() });
    const now = Date.now();
    db.message.push(
      { id: 'in', conversationId: 'conv1', direction: 'IN', author: 'CONTACT', content: 'cuánto vale', createdAt: new Date(now - (lastBotHoursAgo + 0.1) * 3600e3) },
      { id: 'out', conversationId: 'conv1', direction: 'OUT', author: 'BOT', content: 'vale 18.000', createdAt: new Date(now - lastBotHoursAgo * 3600e3) },
    );
    const q = queue();
    return { db, q, service: new CampaignsService(prisma as any, audit as any, q as any) };
  }

  it('escribe UNA vez por regla cuando el cliente dejó de responder', async () => {
    const { db, q, service } = setup([{ id: 'r1', enabled: true, afterHours: 2, message: '{{nombre}}, ¿te ayudo a terminar tu pedido?', when: 'no_reply' }], 3);
    expect(await service.runFollowUps()).toEqual({ sent: 1 });
    expect(await service.runFollowUps()).toEqual({ sent: 0 });
    expect(q.add).toHaveBeenCalledTimes(1);
    expect(db.message.at(-1)!.content).toBe('Ana, ¿te ayudo a terminar tu pedido?');
  });

  it('respeta el tiempo, la condición de pedido a medias y a quien pidió la baja', async () => {
    const early = setup([{ id: 'r1', enabled: true, afterHours: 5, message: 'x', when: 'no_reply' }], 3);
    expect(await early.service.runFollowUps()).toEqual({ sent: 0 });
    const draftRule = setup([{ id: 'r2', enabled: true, afterHours: 1, message: 'tu pedido', when: 'draft_open' }], 2);
    expect(await draftRule.service.runFollowUps()).toEqual({ sent: 0 }); // no hay borrador
    draftRule.db.order.push({ id: 'd1', companyId: 'co1', conversationId: 'conv1', status: 'borrador', deletedAt: null });
    expect(await draftRule.service.runFollowUps()).toEqual({ sent: 1 });
    const optOut = setup([{ id: 'r3', enabled: true, afterHours: 1, message: 'x' }], 2);
    optOut.db.contact[0].optOut = true;
    expect(await optOut.service.runFollowUps()).toEqual({ sent: 0 });
  });
});

/* ═══ Reseñas en Google ═══ */

describe('reseña en Google tras una buena calificación', () => {
  function setup(googleReviewUrl: string | null) {
    const { prisma, db } = createMockPrisma();
    company(db, { googleReviewUrl });
    db.contact.push({ id: 'c1', companyId: 'co1', name: 'Ana' });
    db.conversation.push({ id: 'conv1', companyId: 'co1', contactId: 'c1', channel: 'WHATSAPP' });
    db.feedback.push({ id: 'f1', companyId: 'co1', contactId: 'c1', orderId: 'o1', status: 'PENDIENTE', requestedAt: new Date(Date.now() - 3600e3) });
    const q = queue();
    const twilio = new TwilioService(prisma as any, audit as any, queue() as any, q as any, queue() as any, { emit: jest.fn() } as any);
    return { db, q, twilio };
  }

  it('calificación 5 con link configurado → se le pide la reseña', async () => {
    const { db, q, twilio } = setup('https://g.page/r/la-esquina/review');
    expect(await twilio.captureFeedback('co1', 'c1', 'conv1', '5 excelente')).toBe(true);
    expect(q.add).toHaveBeenCalledTimes(1);
    expect(db.message.at(-1)!.content).toContain('https://g.page/r/la-esquina/review');
    expect(db.feedback[0].reviewRequested).toBe(true);
  });

  it('calificación baja o sin link → no se pide reseña', async () => {
    const bad = setup('https://g.page/r/x/review');
    await bad.twilio.captureFeedback('co1', 'c1', 'conv1', '2 llegó frío');
    expect(bad.q.add).not.toHaveBeenCalled();
    const noUrl = setup(null);
    await noUrl.twilio.captureFeedback('co1', 'c1', 'conv1', '5');
    expect(noUrl.q.add).not.toHaveBeenCalled();
  });
});

/* ═══ Promociones y cupones ═══ */

describe('promociones y cupones', () => {
  const ctx = (over: any = {}) => ({
    items: [{ productId: 'p1', quantity: 2, unitPrice: 18000 }, { productId: 'p2', quantity: 1, unitPrice: 5000 }],
    subtotal: 41000, deliveryFee: 6000, now: new Date(), ...over,
  });

  it('reglas: porcentaje sobre productos elegibles, fijo con tope, domicilio gratis, vigencia, mínimo y usos', () => {
    expect(evaluatePromotion({ id: 'a', name: 'x', kind: 'PERCENT', value: 10 }, ctx())).toMatchObject({ ok: true, discount: 4100 });
    expect(evaluatePromotion({ id: 'b', name: 'x', kind: 'PERCENT', value: 50, productIdsJson: '["p2"]' }, ctx())).toMatchObject({ discount: 2500 });
    expect(evaluatePromotion({ id: 'c', name: 'x', kind: 'FIXED', value: 99999, productIdsJson: '["p2"]' }, ctx())).toMatchObject({ discount: 5000 });
    expect(evaluatePromotion({ id: 'd', name: 'x', kind: 'FREE_DELIVERY', value: 0 }, ctx())).toMatchObject({ discount: 6000, freeDelivery: true });
    expect(evaluatePromotion({ id: 'e', name: 'x', kind: 'PERCENT', value: 10, minSubtotal: 50000 }, ctx()).ok).toBe(false);
    expect(evaluatePromotion({ id: 'f', name: 'x', kind: 'PERCENT', value: 10, endsAt: new Date(Date.now() - 1000) }, ctx()).ok).toBe(false);
    expect(evaluatePromotion({ id: 'g', name: 'x', kind: 'PERCENT', value: 10, maxUses: 3, usedCount: 3 }, ctx()).ok).toBe(false);
  });

  it('cupón exacto o la mejor automática (nunca dos); validación de entrada', () => {
    const promos = [
      { id: 'auto1', name: 'Martes', kind: 'PERCENT', value: 5 },
      { id: 'auto2', name: 'Domicilio gratis', kind: 'FREE_DELIVERY', value: 0 },
      { id: 'cup', name: 'Bienvenida', kind: 'FIXED', value: 3000, code: 'HOLA3' },
    ];
    expect(pickPromotion(promos, ctx()).promo?.id).toBe('auto2'); // 6.000 > 2.050
    expect(pickPromotion(promos, ctx(), ' hola3 ').promo?.id).toBe('cup');
    expect(pickPromotion(promos, ctx(), 'NOEXISTE').result.ok).toBe(false);
    expect(() => validatePromotionInput({ kind: 'PERCENT', name: 'x', value: 120 })).toThrow();
    expect(validatePromotionInput({ kind: 'FIXED', name: 'x', value: 2000, code: 'ab c' }).code).toBe('ABC');
  });

  it('CRUD: códigos únicos por empresa y aislamiento entre empresas', async () => {
    const { prisma, db } = createMockPrisma();
    const service = new PromotionsService(prisma as any, audit as any);
    await service.save(ADMIN, { kind: 'PERCENT', name: 'Lunes', value: 10, code: 'lunes10' });
    await expect(service.save(ADMIN, { kind: 'FIXED', name: 'Otro', value: 1, code: 'LUNES10' })).rejects.toBeInstanceOf(BadRequestException);
    const other = { ...ADMIN, companyId: 'co2' };
    await expect(service.remove(other, db.promotion[0].id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('respuestas rápidas: atajo normalizado y único', async () => {
    const { prisma } = createMockPrisma();
    const service = new PromotionsService(prisma as any, audit as any);
    const qr = await service.saveQuickReply(ADMIN, { shortcut: '/Saludo Inicial', title: 'Saludo', body: 'Hola {{nombre}}' });
    expect(qr.shortcut).toBe('saludoinicial');
    await expect(service.saveQuickReply(ADMIN, { shortcut: 'saludoinicial', title: 'x', body: 'y' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.saveQuickReply(ADMIN, { shortcut: 'x', title: '', body: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ═══ Comprobantes de pago con IA ═══ */

describe('lectura de comprobantes', () => {
  it('normaliza montos en formatos colombianos y no confía en datos inválidos', () => {
    expect(normalizeAnalysis({ es_comprobante: true, monto: '$41.000', entidad: 'Nequi' })).toMatchObject({ kind: 'RECEIPT', amount: 41000, bank: 'Nequi' });
    expect(normalizeAnalysis({ es_comprobante: true, monto: '41.000,50' }).amount).toBe(41000.5);
    expect(normalizeAnalysis({ es_comprobante: true, monto: 'ilegible' })).toMatchObject({ kind: 'OTHER', amount: null });
    expect(normalizeAnalysis({ es_comprobante: false, descripcion: 'Foto de un plato' })).toMatchObject({ kind: 'OTHER', summary: 'Foto de un plato' });
    expect(describeForChat(normalizeAnalysis({ es_comprobante: true, monto: 41000, entidad: 'Nequi', referencia: 'M123' })))
      .toMatch(/^\[imagen: comprobante de pago Nequi por \$\s41\.000, ref M123\]$/);
  });

  it('el comprobante cubre el total con tolerancia de $100', () => {
    expect(receiptMatches(41000, 41000)).toBe(true);
    expect(receiptMatches(40950, 41000)).toBe(true);
    expect(receiptMatches(35000, 41000)).toBe(false);
    expect(receiptMatches(null, 41000)).toBe(false);
  });
});

/* ═══ Agotados y menú digital ═══ */

describe('agotados', () => {
  it('agotado indefinido o hasta una fecha', () => {
    const now = new Date();
    expect(isSoldOut({ soldOut: true }, now)).toBe(true);
    expect(isSoldOut({ soldOut: true, soldOutUntil: new Date(now.getTime() + 3600e3) }, now)).toBe(true);
    expect(isSoldOut({ soldOut: true, soldOutUntil: new Date(now.getTime() - 1000) }, now)).toBe(false);
    expect(isSoldOut({ soldOut: false }, now)).toBe(false);
  });

  it('el agente no arma pedidos con productos agotados', async () => {
    const { prisma, db } = createMockPrisma();
    company(db);
    db.product.push({ id: 'p1', companyId: 'co1', name: 'Almuerzo ejecutivo', price: 18000, active: true, deletedAt: null, soldOut: true });
    const tool = AGENT_TOOLS.find((t) => t.name === 'armar_pedido')!;
    const result = await tool.run(
      { prisma, company: db.company[0], orderConfig: {}, conversation: { id: 'conv1' }, contact: { id: 'c1' }, now: new Date(), state: { draftOrderId: null, confirmedOrderId: null } } as any,
      { items: [{ producto: 'almuerzo ejecutivo', cantidad: 1 }] },
    );
    expect(result).toMatchObject({ agotados: ['Almuerzo ejecutivo'] });
    expect(db.order).toHaveLength(0);
  });
});

describe('menú digital con QR', () => {
  function setup(menuEnabled: boolean) {
    const { prisma, db } = createMockPrisma();
    company(db, { orderConfigJson: JSON.stringify({ menu: { enabled: menuEnabled } }), contactPhone: '+57 300 111 2233', brandColor: '#C2410C' });
    db.product.push(
      { id: 'p1', companyId: 'co1', name: 'Almuerzo', category: 'Almuerzos', price: 18000, active: true, deletedAt: null, presentationsJson: '[]', unit: 'u' },
      { id: 'p2', companyId: 'co1', name: 'Jugo', category: 'Bebidas', price: 5000, active: true, deletedAt: null, presentationsJson: '[]', unit: 'u', soldOut: true },
      { id: 'p3', companyId: 'co1', name: 'Viejo', active: false, deletedAt: null, presentationsJson: '[]', unit: 'u' },
    );
    return { prisma, db, service: new MenuService(prisma as any, audit as any) };
  }

  it('sin publicar → 404; publicado → categorías, agotados marcados y WhatsApp del negocio', async () => {
    await expect(setup(false).service.publicMenu('la-esquina')).rejects.toBeInstanceOf(NotFoundException);
    const menu = await setup(true).service.publicMenu('la-esquina');
    expect(menu.whatsapp).toBe('573001112233');
    expect(menu.categories.map((c) => c.name).sort()).toEqual(['Almuerzos', 'Bebidas']);
    const jugo = menu.categories.flatMap((c) => c.items).find((i) => i.name === 'Jugo');
    expect(jugo).toMatchObject({ soldOut: true, price: 5000 });
    expect(JSON.stringify(menu)).not.toContain('Viejo');
    expect(menuWhatsapp({ orderConfigJson: '{}', contactPhone: null }, [{ configJson: '{"displayPhone":"+57 315 000 1111"}' }])).toBe('573150001111');
  });

  it('agotar por hoy / indefinido y volver a disponible (solo la empresa dueña)', async () => {
    const { db, service } = setup(true);
    const today = await service.setSoldOut(ADMIN, 'p1', { soldOut: true, until: 'TODAY' });
    expect(today.soldOut).toBe(true);
    expect(today.soldOutUntil!.getTime()).toBeGreaterThan(Date.now());
    await service.setSoldOut(ADMIN, 'p1', { soldOut: false });
    expect(db.product[0]).toMatchObject({ soldOut: false, soldOutUntil: null });
    await expect(service.setSoldOut({ ...ADMIN, companyId: 'co2' }, 'p1', { soldOut: true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el QR es un SVG válido del tamaño correcto para el link del menú', () => {
    const m = qrMatrix('https://app.backoffice.co/m/la-esquina');
    expect(m.length).toBe(29); // versión 3 (29×29) para un link de ~40 caracteres
    const svg = qrSvg('https://app.backoffice.co/m/la-esquina');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 37 37"');
    expect(() => qrMatrix('x'.repeat(400))).toThrow(/demasiado largo/);
  });
});

/* ═══ Embudos configurables ═══ */

describe('embudos configurables', () => {
  it('valida etapas: 2 a 12, claves únicas, al menos una abierta', () => {
    expect(sanitizeStages([{ label: 'Nuevo' }, { label: 'Cotizado' }, { label: 'Ganado', kind: 'WON' }]).map((s) => s.key)).toEqual(['NUEVO', 'COTIZADO', 'GANADO']);
    expect(() => sanitizeStages([{ label: 'Solo una' }])).toThrow();
    expect(() => sanitizeStages([{ label: 'A', kind: 'WON' }, { label: 'B', kind: 'LOST' }])).toThrow(/abierta/);
    expect(sanitizeStages([{ label: 'Año' }, { label: 'año' }, { label: 'Otro' }])).toHaveLength(2);
  });

  it('el contacto solo puede estar en etapas de su embudo; al cambiar de embudo entra a la primera', async () => {
    const { prisma, db } = createMockPrisma();
    const pipelines = new PipelinesService(prisma as any, audit as any);
    const contacts = new ContactsService(prisma as any, audit as any);
    db.contact.push({ id: 'c1', companyId: 'co1', name: 'Ana', stage: 'CURIOSO', pipelineId: null, tagsJson: '[]' });
    const p = await pipelines.save(ADMIN, { name: 'Eventos', stages: [{ label: 'Solicitud' }, { label: 'Cotización enviada' }, { label: 'Contratado', kind: 'WON' }] });
    await contacts.update(ADMIN, 'c1', { pipelineId: p.id });
    expect(db.contact[0]).toMatchObject({ pipelineId: p.id, stage: 'SOLICITUD' });
    await expect(contacts.update(ADMIN, 'c1', { stage: 'CALIENTE' })).rejects.toBeInstanceOf(BadRequestException);
    await contacts.update(ADMIN, 'c1', { stage: 'CONTRATADO' });
    await pipelines.remove(ADMIN, p.id);
    expect(db.contact[0]).toMatchObject({ pipelineId: null, stage: 'CURIOSO' });
  });

  it('el embudo estándar incluye contactos viejos sin el campo; crear en un embudo valida la etapa', async () => {
    const { prisma, db } = createMockPrisma();
    const pipelines = new PipelinesService(prisma as any, audit as any);
    const contacts = new ContactsService(prisma as any, audit as any);
    // Contacto creado antes de existir los embudos: el campo ni siquiera existe
    db.contact.push({ id: 'viejo', companyId: 'co1', name: 'Viejo', stage: 'CURIOSO', tagsJson: '[]', createdAt: new Date(), lastActivityAt: new Date() });
    const p = await pipelines.save(ADMIN, { name: 'Eventos', stages: [{ label: 'Solicitud' }, { label: 'Contratado', kind: 'WON' }] });
    const nuevo = await contacts.create(ADMIN, { name: 'Nuevo', pipelineId: p.id, stage: 'CALIENTE' });
    expect(nuevo).toMatchObject({ pipelineId: p.id, stage: 'SOLICITUD' }); // etapa ajena → primera del embudo
    const std = await contacts.list(ADMIN, undefined, undefined, undefined, 'default');
    expect(std.map((c: any) => c.id)).toEqual(['viejo']);
    const own = await contacts.list(ADMIN, undefined, undefined, undefined, p.id);
    expect(own.map((c: any) => c.name)).toEqual(['Nuevo']);
    await expect(contacts.create(ADMIN, { name: 'X', pipelineId: 'no-existe' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ═══ Respuestas rápidas ═══ */

describe('respuestas rápidas', () => {
  it('normaliza el atajo y no permite duplicados en la misma empresa', async () => {
    const { prisma } = createMockPrisma();
    const promos = new PromotionsService(prisma as any, audit as any);
    const r = await promos.saveQuickReply(ADMIN, { shortcut: '/Horario ', title: 'Horario', body: 'Lun a sáb 11 a 3' });
    expect(r).toMatchObject({ companyId: 'co1', shortcut: 'horario' });
    await expect(promos.saveQuickReply(ADMIN, { shortcut: 'horario', title: 'Otro', body: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(promos.saveQuickReply(ADMIN, { shortcut: 'vacia', title: '', body: '' })).rejects.toBeInstanceOf(BadRequestException);
    // Editar la misma no choca consigo misma
    await promos.saveQuickReply(ADMIN, { shortcut: 'horario', title: 'Horario nuevo', body: 'Lun a vie' }, r.id);
    expect((await promos.listQuickReplies(ADMIN))[0]).toMatchObject({ title: 'Horario nuevo' });
  });

  it('una empresa no ve ni edita las respuestas de otra', async () => {
    const { prisma, db } = createMockPrisma();
    const promos = new PromotionsService(prisma as any, audit as any);
    db.quickReply.push({ id: 'ajena', companyId: 'co2', shortcut: 'pago', title: 'Pago', body: 'Nequi' });
    expect(await promos.listQuickReplies(ADMIN)).toEqual([]);
    await expect(promos.saveQuickReply(ADMIN, { shortcut: 'pago', title: 'x', body: 'y' }, 'ajena')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(promos.removeQuickReply(ADMIN, 'ajena')).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.quickReply).toHaveLength(1);
  });
});

/* ═══ Base de conocimiento ═══ */

describe('base de conocimiento', () => {
  it('fragmenta y encuentra el fragmento relevante (sin tildes ni mayúsculas)', () => {
    const text = `Horarios\n\nAtendemos de lunes a sábado de 11 am a 3 pm.\n\nPagos\n\nAceptamos Nequi, Daviplata y efectivo contra entrega.\n\nCobertura\n\nLlegamos a Laureles, Estadio y Belén.`;
    const chunks = chunkText(text, 80).map((t, idx) => ({ idx, text: t }));
    expect(chunks.length).toBeGreaterThan(2);
    const hits = searchChunks(chunks, '¿Puedo pagar con NEQUÍ?', 1);
    expect(hits[0].text).toContain('Nequi');
    expect(searchChunks(chunks, 'xyz zzz', 3)).toEqual([]);
    expect(htmlToText('<p>Hola&nbsp;<b>mundo</b></p><script>alert(1)</script>')).toBe('Hola mundo');
  });

  it('bloquea direcciones internas (SSRF) y protocolos raros', async () => {
    for (const url of ['http://127.0.0.1/admin', 'http://localhost:4001/api', 'http://10.0.0.5', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'http://user:pass@example.com']) {
      await expect(assertPublicUrl(url)).rejects.toThrow();
    }
  });

  it('ingesta de texto y búsqueda por empresa (aislada)', async () => {
    const { prisma } = createMockPrisma();
    const service = new KnowledgeService(prisma as any, audit as any);
    await service.addText(ADMIN, { title: 'Políticas', text: 'Si el almuerzo llega frío lo reponemos sin costo. Cambios hasta las 10 am.' });
    await service.addText({ ...ADMIN, companyId: 'co2' }, { title: 'Otra', text: 'Política secreta de otra empresa sobre almuerzos fríos y reposición.' });
    const hits = await service.search('co1', 'qué pasa si llega frío', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ doc: 'Políticas' });
    await expect(service.addText(ADMIN, { text: 'corto' })).rejects.toBeInstanceOf(BadRequestException);
  });

  const hasPdftotext = (() => {
    try {
      execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  (hasPdftotext ? it : it.skip)('lee el texto de un PDF real', async () => {
    const PDFDocument = require('pdfkit');
    const dir = mkdtempSync(join(tmpdir(), 'kb-'));
    const file = join(dir, 'menu.pdf');
    await new Promise<void>((resolveDone) => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => {
        writeFileSync(file, Buffer.concat(chunks));
        resolveDone();
      });
      doc.text('Politica de domicilios: llegamos en 40 minutos a Laureles.');
      doc.end();
    });
    expect(await pdfToText(file)).toContain('Laureles');
  });
});
