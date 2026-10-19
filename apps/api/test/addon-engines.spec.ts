/**
 * Pruebas — motores de los complementos: reactivación de clientes dormidos,
 * cobranza humanizada, auditor de ventas y límites de canales por plan.
 * Ningún envío sale a la red: la cola es un doble que solo registra.
 */
import { BadRequestException } from '@nestjs/common';
import { ReactivationService } from '../src/modules/addons/reactivation.service';
import { CollectionsService } from '../src/modules/addons/collections.service';
import { SalesAuditService } from '../src/modules/addons/sales-audit.service';
import { assertChannelAllowed } from '../src/common/channel-limits';
import { fillText } from '../src/common/addon-config';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const DAY = 86400e3;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function company(extra: Record<string, any> = {}) {
  return {
    id: 'c1', name: 'Doña Rosa', status: 'ACTIVE', timezone: 'America/Bogota', paymentConfigJson: JSON.stringify({ manualInstructions: 'Nequi 300 000 0000' }),
    waTemplatesJson: JSON.stringify([
      { key: 'vuelve', name: 'Te extrañamos', contentSid: 'HX111', category: 'MARKETING', body: 'Hola {{1}}, {{2}}' },
      { key: 'cobro', name: 'Recordatorio de pago', contentSid: 'HX222', category: 'UTILIDAD', body: 'Hola {{1}}, saldo {{2}} ({{3}})' },
    ]),
    addonsJson: JSON.stringify({ reactivation: { enabled: true }, collections: { enabled: true }, salesAudit: { enabled: true } }),
    ...extra,
  };
}

function base() {
  const { prisma, db } = createMockPrisma();
  const queue = { add: jest.fn(async () => undefined) };
  db.integration.push({ id: 'line1', companyId: 'c1', type: 'WHATSAPP', status: 'CONNECTED', createdAt: ago(300) });
  return { prisma, db, queue };
}

describe('reactivación de clientes dormidos', () => {
  function setup(extra: Record<string, any> = {}) {
    const ctx = base();
    const co = company(extra);
    ctx.db.company.push(co);
    const c = (id: string, name: string, lastActivity: Date, more: Record<string, any> = {}) =>
      ctx.db.contact.push({ id, companyId: 'c1', name, phone: `57300${id}`, channel: 'WHATSAPP', optOut: false, lastActivityAt: lastActivity, createdAt: ago(400), ...more });
    c('a', 'Ana Gómez', ago(5)); // activa
    c('b', 'Beto Ruiz', ago(10)); // compró hace 40 días
    c('d', 'Dora Paz', ago(95)); // sin pedidos, no escribe hace 95
    c('e', 'Elsa Mora', ago(70), { optOut: true }); // pidió la baja
    ctx.db.order.push({ id: 'o1', companyId: 'c1', contactId: 'b', status: 'entregado', total: 52000, createdAt: ago(40), deletedAt: null });
    ctx.db.orderItem.push({ id: 'i1', orderId: 'o1', productName: 'Torta de chocolate' });
    const svc = new ReactivationService(ctx.prisma as any, ctx.queue as any);
    return { ...ctx, co, svc };
  }

  it('detecta a los dormidos por su última compra (o su última conversación) y en qué escalón están; nunca a quien pidió la baja', async () => {
    const { svc, co } = setup();
    const list = await svc.candidates(co, undefined, NOW);
    expect(list.map((x) => [x.name, x.step, x.basis])).toEqual([['Beto Ruiz', 30, 'compra'], ['Dora Paz', 90, 'conversación']]);
    expect(list[0].lastProduct).toBe('Torta de chocolate');
  });

  it('fuera de las 24 h usa la plantilla aprobada; sin plantilla lo omite y lo explica; no repite el escalón', async () => {
    const { svc, db, queue, co } = setup();
    let r = await svc.run(co, { now: NOW });
    expect(r).toMatchObject({ sent: 0, skipped: 2 });
    expect(db.addonTouch[0].skipReason).toContain('plantilla');
    db.company[0].addonsJson = JSON.stringify({ reactivation: { enabled: true, config: { templateKey: 'vuelve', offer: '10% en tu próxima torta' } } });
    db.addonTouch.length = 0;
    r = await svc.run(db.company[0], { now: NOW });
    expect(r.sent).toBe(2);
    const job = (queue.add.mock.calls[0] as any[])[1];
    expect(job).toMatchObject({ contentSid: 'HX111', metaCategory: 'MARKETING' });
    expect(job.contentVariables['1']).toBe('Beto');
    // El mismo escalón no se repite (a los 10 días sigue en el de 30)
    r = await svc.run(db.company[0], { now: new Date(NOW.getTime() + 10 * DAY) });
    expect(r.sent).toBe(0);
    // A los 25 días: Beto (65 días) pasa al escalón de 60 y Ana cumple 30; Dora sigue en el de 90, ya enviado
    r = await svc.run(db.company[0], { now: new Date(NOW.getTime() + 25 * DAY) });
    expect(r.sent).toBe(2);
    expect(db.addonTouch.filter((t: any) => t.status === 'SENT').map((t: any) => t.step).sort((a: number, b: number) => a - b)).toEqual([30, 30, 60, 90]);
  });

  it('dentro de las 24 h escribe libre con su nombre, lo último que compró y la oferta', async () => {
    const { svc, db, co } = setup();
    db.conversation.push({ id: 'conv-b', companyId: 'c1', contactId: 'b', integrationId: 'line1', channel: 'WHATSAPP', status: 'OPEN', lastMessageAt: NOW });
    db.message.push({ id: 'm1', conversationId: 'conv-b', direction: 'IN', content: 'hola', createdAt: new Date(NOW.getTime() - 3600e3) });
    co.addonsJson = JSON.stringify({ reactivation: { enabled: true, config: { offer: 'Hoy 2x1 en pan.', maxPerDay: 1 } } });
    await svc.run(co, { now: NOW });
    const out: any = db.message.find((m: any) => m.direction === 'OUT');
    expect(out.content).toContain('Beto');
    expect(out.content).toContain('2x1');
    expect(db.addonTouch.filter((t: any) => t.status === 'SENT')).toHaveLength(1); // tope diario
  });

  it('marca quién respondió y quién volvió a comprar (con el valor)', async () => {
    const { svc, db } = setup();
    db.addonTouch.push(
      { id: 't1', companyId: 'c1', addon: 'REACTIVATION', contactId: 'b', conversationId: 'cb', status: 'SENT', step: 30, createdAt: ago(5) },
      { id: 't2', companyId: 'c1', addon: 'REACTIVATION', contactId: 'd', conversationId: 'cd', status: 'SENT', step: 90, createdAt: ago(5) },
    );
    db.order.push({ id: 'o2', companyId: 'c1', contactId: 'b', status: 'confirmado', total: 80000, createdAt: ago(2), deletedAt: null });
    db.message.push({ id: 'r1', conversationId: 'cd', direction: 'IN', content: 'hola!', createdAt: ago(4) });
    await svc.updateResults('c1', NOW);
    expect(db.addonTouch.find((t: any) => t.id === 't1')).toMatchObject({ status: 'RECOVERED', amount: 80000 });
    expect(db.addonTouch.find((t: any) => t.id === 't2')).toMatchObject({ status: 'REPLIED' });
  });
});

describe('cobranza humanizada', () => {
  function setup() {
    const ctx = base();
    const co = company({ addonsJson: JSON.stringify({ collections: { enabled: true, config: { templateKey: 'cobro', firstReminderDays: 1, repeatEveryDays: 3, maxReminders: 2 } } }) });
    ctx.db.company.push(co);
    ctx.db.contact.push({ id: 'k', companyId: 'c1', name: 'Karen López', phone: '573001', channel: 'WHATSAPP', optOut: false });
    ctx.db.order.push(
      { id: 'p1', companyId: 'c1', contactId: 'k', status: 'entregado', paymentStatus: 'NONE', total: 120000, deliveredAt: ago(4), deliveryAt: ago(4), createdAt: ago(5), deletedAt: null },
      { id: 'p2', companyId: 'c1', contactId: 'k', status: 'entregado', paymentStatus: 'PAID', total: 50000, deliveredAt: ago(4), createdAt: ago(5), deletedAt: null },
      { id: 'p3', companyId: 'c1', contactId: 'k', status: 'borrador', paymentStatus: 'NONE', total: 9000, createdAt: ago(5), deletedAt: null },
    );
    return { ...ctx, co, svc: new CollectionsService(ctx.prisma as any, ctx.queue as any) };
  }

  it('crea la cuenta por cobrar solo para el pedido sin pagar, recuerda con la plantilla de utilidad y respeta los intervalos y el máximo', async () => {
    const { svc, db, queue, co } = setup();
    await svc.syncFromOrders(co);
    expect(db.receivable.map((r: any) => [r.orderId, r.amount])).toEqual([['p1', 120000]]);
    let r = await svc.run(co, { now: NOW });
    expect(r.sent).toBe(1);
    const job = (queue.add.mock.calls[0] as any[])[1];
    expect(job).toMatchObject({ contentSid: 'HX222', metaCategory: 'UTILIDAD' });
    expect(job.contentVariables['2']).toBe('$120.000');
    r = await svc.run(co, { now: new Date(NOW.getTime() + 1 * DAY) });
    expect(r.sent).toBe(0); // todavía no pasan 3 días
    r = await svc.run(co, { now: new Date(NOW.getTime() + 3 * DAY) });
    expect(r.sent).toBe(1);
    r = await svc.run(co, { now: new Date(NOW.getTime() + 7 * DAY) });
    expect(r.sent).toBe(0); // máximo 2
    expect(db.receivable[0].remindersSent).toBe(2);
  });

  it('cuando el pedido aparece pagado deja de cobrar y el último recordatorio cuenta como pagado', async () => {
    const { svc, db, co } = setup();
    await svc.run(co, { now: NOW });
    db.order[0].paymentStatus = 'PAID';
    db.order[0].paidAt = NOW;
    await svc.syncFromOrders(co);
    expect(db.receivable[0].status).toBe('PAID');
    expect(db.addonTouch[0]).toMatchObject({ status: 'PAID', amount: 120000 });
    const s = await svc.summary(co);
    expect(s.totals).toMatchObject({ pendingCount: 0, recoveredAmount: 120000 });
  });

  it('cuentas a mano: validan cliente, valor y concepto; el texto lleva cómo pagar', async () => {
    const { svc, db, co } = setup();
    await expect(svc.create('c1', 'Rosa', { contactId: 'nadie', amount: 1000, concept: 'x', dueDate: '2026-10-01' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create('c1', 'Rosa', { contactId: 'k', amount: '0', concept: 'x', dueDate: '2026-10-01' })).rejects.toThrow(/valor/);
    await svc.create('c1', 'Rosa', { contactId: 'k', amount: '85.000', concept: 'Cuota de octubre', dueDate: '2026-10-10' });
    db.conversation.push({ id: 'ck', companyId: 'c1', contactId: 'k', integrationId: 'line1', channel: 'WHATSAPP', status: 'OPEN', lastMessageAt: NOW });
    db.message.push({ id: 'mk', conversationId: 'ck', direction: 'IN', content: 'ok', createdAt: new Date(NOW.getTime() - 3600e3) });
    co.addonsJson = JSON.stringify({ collections: { enabled: true, config: { autoFromOrders: false } } });
    await svc.run(co, { now: NOW });
    const out: any = db.message.find((m: any) => m.direction === 'OUT');
    expect(out.content).toContain('$85.000');
    expect(out.content).toContain('(cuota de octubre)');
    expect(out.content).toContain('Nequi');
  });
});

describe('auditor de ventas', () => {
  function setup(aiContent?: string) {
    const ctx = base();
    const co = company({ aiBillingMode: 'BYOK', deepinfraApiKey: 'llave-byok-de-prueba' });
    ctx.db.company.push(co);
    const conv = (id: string, msgs: Array<[string, string, number]>) => {
      ctx.db.contact.push({ id: `ct-${id}`, companyId: 'c1', name: `Cliente ${id}`, channel: 'WHATSAPP' });
      ctx.db.conversation.push({ id, companyId: 'c1', contactId: `ct-${id}`, integrationId: 'line1', channel: 'WHATSAPP', status: 'OPEN', lastMessageAt: ago(1) });
      msgs.forEach(([dir, content, minAgo], i) => ctx.db.message.push({ id: `${id}-${i}`, conversationId: id, direction: dir, content, createdAt: new Date(NOW.getTime() - minAgo * 60e3) }));
    };
    conv('venta', [['IN', 'quiero una torta', 3000], ['OUT', 'claro, ¿de qué sabor?', 2998]]);
    ctx.db.order.push({ id: 'ov', companyId: 'c1', conversationId: 'venta', status: 'confirmado', total: 60000, createdAt: ago(2), deletedAt: null });
    conv('caro', [['IN', 'cuánto vale la torta grande?', 3000], ['OUT', 'vale 90.000', 2999], ['IN', 'uy muy caro', 2990], ['OUT', 'te entiendo', 2989]]);
    conv('agotado', [['IN', 'tienen pan integral?', 2000], ['OUT', 'hoy no tenemos, está agotado', 1999]]);
    conv('nadie', [['IN', 'hola, hacen domicilios?', 600]]);
    conv('frio', [['IN', 'precio del ponqué?', 1500], ['OUT', 'vale 30.000, ¿te lo aparto?', 1499]]);
    const ai = aiContent ? { chat: jest.fn(async () => ({ content: aiContent, inputTokens: 900, outputTokens: 120, model: 'meta-llama/Llama-3.3-70B-Instruct' })) } : undefined;
    const emails = { systemSend: jest.fn(async () => ({})) };
    return { ...ctx, co, emails, ai, svc: new SalesAuditService(ctx.prisma as any, emails as any, ai as any) };
  }

  it('con reglas (sin IA): ventas, conversión y por qué se perdió cada conversación', async () => {
    const { svc, co } = setup();
    const r = await svc.generate(co, { now: NOW, send: false });
    expect(r.source).toBe('REGLAS');
    expect(r.stats).toMatchObject({ conversations: 5, sales: 1, conversion: 20, revenue: 60000, lost: 4 });
    const byReason = Object.fromEntries(r.reasons.map((x: any) => [x.reason, x.count]));
    expect(byReason).toMatchObject({ PRECIO: 1, SIN_PRODUCTO: 1, NO_RESPONDIMOS: 1, CLIENTE_SE_ENFRIO: 1 });
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it('con IA: una sola llamada afina motivos y recomendaciones y el consumo queda registrado', async () => {
    const { svc, co, db, ai, emails } = setup(JSON.stringify({ motivos: [{ n: 1, motivo: 'PRECIO' }], recomendaciones: ['Ofrece una torta mediana', 'Responde en menos de 5 minutos', 'Actualiza agotados'] }));
    const r = await svc.generate(co, { now: NOW });
    expect(ai!.chat).toHaveBeenCalledTimes(1);
    expect(r.source).toBe('IA');
    expect(r.recommendations[0]).toBe('Ofrece una torta mediana');
    expect(r.tokens).toBe(1020);
    expect(db.aiUsageEvent[0]).toMatchObject({ companyId: 'c1', billedTo: 'BYOK' });
    expect(emails.systemSend).not.toHaveBeenCalled(); // sin administradores registrados
    expect(db.salesAudit).toHaveLength(1);
  });
});

describe('límites de canales por plan', () => {
  it('Básico: 1 número de WhatsApp; Instagram solo con "Canal extra" (uno por canal); planes viejos sin cambios', async () => {
    const { prisma, db } = createMockPrisma();
    db.plan.push({ id: 'pb', name: 'Básico', line: 'WPP', maxLines: 1 }, { id: 'old', name: 'Viejo', line: 'COMIDAS', maxLines: 1 });
    db.company.push({ id: 'c1', planId: 'pb', addonsJson: null }, { id: 'c2', planId: 'old', addonsJson: null });
    // include: { plan: true } del doble de pruebas
    const realFind = prisma.company.findUnique;
    (prisma.company as any).findUnique = async (args: any) => {
      const c = await realFind(args);
      return c ? { ...c, plan: db.plan.find((p: any) => p.id === c.planId) ?? null } : null;
    };
    await assertChannelAllowed(prisma, 'c1', 'WHATSAPP');
    db.integration.push({ id: 'w1', companyId: 'c1', type: 'WHATSAPP' });
    await expect(assertChannelAllowed(prisma, 'c1', 'WHATSAPP')).rejects.toThrow(/1 número/);
    await expect(assertChannelAllowed(prisma, 'c1', 'INSTAGRAM')).rejects.toThrow(/Canal extra/);
    await assertChannelAllowed(prisma, 'c1', 'META_SOCIAL'); // publicar en redes no es un canal de chat
    db.company[0].addonsJson = JSON.stringify({ extraChannels: { enabled: true, qty: 1 } });
    await assertChannelAllowed(prisma, 'c1', 'INSTAGRAM');
    db.integration.push({ id: 'ig', companyId: 'c1', type: 'INSTAGRAM' });
    await expect(assertChannelAllowed(prisma, 'c1', 'MESSENGER')).rejects.toThrow(/pide uno más/);
    db.integration.push({ id: 'w2', companyId: 'c2', type: 'WHATSAPP' });
    await assertChannelAllowed(prisma, 'c2', 'WHATSAPP');
  });

  it('textos con variables: lo que falta se limpia sin dejar espacios raros', () => {
    expect(fillText('Hola {{nombre}}, {{oferta}} ¿Te ayudamos?', { nombre: 'Beto', oferta: '' })).toBe('Hola Beto, ¿Te ayudamos?');
  });
});
