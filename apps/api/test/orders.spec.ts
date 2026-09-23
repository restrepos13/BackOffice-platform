/**
 * Pruebas Fase 4 — distribución, agenda y recordatorios.
 */
import {
  ORDER_TRANSITIONS,
  OrdersService,
  RemindersService,
  canTransition,
  renderTemplate,
  resolveArea,
  violatesCutoff,
} from '../src/modules/orders.module';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

function futureDeliveryDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  d.setHours(11, 0, 0, 0);
  return d;
}

function setup(cfgOverrides: Record<string, any> = {}) {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const emails = { systemSend: jest.fn(async () => undefined) };
  const reminders = new RemindersService(prisma as any, audit as any, emails as any);
  const orders = new OrdersService(prisma as any, audit as any, reminders);

  db.company.push({
    id: 'co1', name: 'Catering Test', slug: 'catering-test',
    timezone: 'America/Bogota',
    orderConfigJson: JSON.stringify({
      schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' },
      minLeadHours: 18,
      reminderDefaults: { clientSameDayHour: 7 },
      ...cfgOverrides,
    }),
    waTemplatesJson: '[]',
  });
  db.productionArea.push(
    {
      id: 'area-cocina', companyId: 'co1', name: 'Cocina',
      responsiblesJson: JSON.stringify([{ name: 'Jefe de cocina', phone: '+571' }]),
      notifyChannel: 'PANEL', reminderHoursBefore: 24, active: true,
    },
    {
      id: 'area-despacho', companyId: 'co1', name: 'Despacho',
      responsiblesJson: JSON.stringify([{ name: 'Despachador' }]),
      notifyChannel: 'PANEL', reminderHoursBefore: 3, active: true,
    },
  );
  db.customer.push({
    id: 'cust1', companyId: 'co1', name: 'Constructora Test',
    addressesJson: '[]',
  });
  db.contact.push({
    id: 'ct1', companyId: 'co1', customerId: 'cust1',
    name: 'Marta Ruiz', phone: '+573105550101',
  });
  db.product.push(
    {
      id: 'p1', companyId: 'co1', name: 'Almuerzo ejecutivo', unit: 'porción',
      category: 'Almuerzos', productionAreaId: 'area-cocina',
      active: true, deletedAt: null, presentationsJson: '[]',
    },
    {
      id: 'p2', companyId: 'co1', name: 'Estación de café', unit: 'servicio',
      category: 'Bebidas', productionAreaId: 'area-despacho',
      active: true, deletedAt: null, presentationsJson: '[]',
    },
  );

  const makeOrder = (status: string, deliveryAt = futureDeliveryDate()) => {
    const order = {
      id: `ord_${db.order.length + 1}`, companyId: 'co1', customerId: 'cust1',
      contactId: 'ct1', status, deliveryAt,
      deliveryAddressJson: JSON.stringify({ label: 'Obra', address: 'Av. 68' }),
      deletedAt: null, correctedAfterAi: false, createdAt: new Date(),
    };
    db.order.push(order);
    db.orderItem.push(
      {
        id: `it_${db.orderItem.length + 1}`, companyId: 'co1', orderId: order.id,
        productId: 'p1', productName: 'Almuerzo ejecutivo', quantity: 40,
        unit: 'porción', productionAreaId: null, areaStatus: 'pendiente',
      },
      {
        id: `it_${db.orderItem.length + 2}`, companyId: 'co1', orderId: order.id,
        productId: 'p2', productName: 'Estación de café', quantity: 1,
        unit: 'servicio', productionAreaId: null, areaStatus: 'pendiente',
      },
    );
    return order;
  };

  return { prisma, db, audit, emails, orders, reminders, makeOrder };
}

/* ─── Transiciones ───────────────────────────────────────────────────── */

describe('Transiciones de estado explícitas', () => {
  test('el flujo vendido es válido paso a paso', () => {
    const flow = ['borrador', 'confirmado', 'programado', 'en_produccion', 'listo', 'empacado', 'despachado', 'entregado'];
    for (let i = 0; i < flow.length - 1; i++) {
      expect(canTransition(flow[i], flow[i + 1])).toBe(true);
    }
  });
  test('NO se puede saltar de confirmado a despachado', () => {
    expect(canTransition('confirmado', 'despachado')).toBe(false);
  });
  test('entregado y cancelado son terminales', () => {
    expect(ORDER_TRANSITIONS.entregado).toHaveLength(0);
    expect(ORDER_TRANSITIONS.cancelado).toHaveLength(0);
  });
  test('changeStatus rechaza transición inválida y no escribe historia', async () => {
    const { orders, db, makeOrder } = setup();
    const order = makeOrder('confirmado');
    await expect(
      orders.changeStatus(order.id, 'despachado', { type: 'USUARIO', name: 'Test' }),
    ).rejects.toThrow('Transición inválida');
    expect(db.orderStatusHistory).toHaveLength(0);
  });
  test('changeStatus válido escribe la traza con autor y motivo', async () => {
    const { orders, db, makeOrder } = setup();
    const order = makeOrder('programado');
    await orders.changeStatus(order.id, 'en_produccion', { type: 'USUARIO', name: 'Admin' }, 'Inicio de turno');
    expect(db.order[0].status).toBe('en_produccion');
    expect(db.orderStatusHistory[0]).toMatchObject({
      fromStatus: 'programado', toStatus: 'en_produccion',
      authorType: 'USUARIO', authorName: 'Admin', reason: 'Inicio de turno',
    });
  });
});

/* ─── Motor de reglas de distribución ────────────────────────────────── */

describe('resolveArea (motor de reglas)', () => {
  const product = { category: 'Almuerzos', productionAreaId: 'area-default' };

  test('sin reglas usa el área del producto', () => {
    expect(resolveArea([], { productId: 'p1', quantity: 10 }, product)).toBe('area-default');
  });
  test('regla por producto gana', () => {
    const rules = [{ productId: 'p1', areaId: 'area-x' }];
    expect(resolveArea(rules, { productId: 'p1', quantity: 10 }, product)).toBe('area-x');
  });
  test('regla por categoría', () => {
    const rules = [{ category: 'Almuerzos', areaId: 'area-cat' }];
    expect(resolveArea(rules, { productId: 'otro', quantity: 10 }, product)).toBe('area-cat');
  });
  test('regla por cantidad (combinada con categoría)', () => {
    const rules = [
      { category: 'Almuerzos', minQuantity: 50, areaId: 'area-masiva', priority: 1 },
      { category: 'Almuerzos', areaId: 'area-normal', priority: 2 },
    ];
    expect(resolveArea(rules, { productId: 'p1', quantity: 80 }, product)).toBe('area-masiva');
    expect(resolveArea(rules, { productId: 'p1', quantity: 20 }, product)).toBe('area-normal');
  });
  test('prioridad menor gana', () => {
    const rules = [
      { category: 'Almuerzos', areaId: 'segunda', priority: 5 },
      { category: 'Almuerzos', areaId: 'primera', priority: 1 },
    ];
    expect(resolveArea(rules, { productId: 'p1', quantity: 1 }, product)).toBe('primera');
  });
});

/* ─── Agenda: corte y capacidad ──────────────────────────────────────── */

describe('Agenda', () => {
  test('violatesCutoff: pedido después del corte del día anterior', () => {
    const delivery = new Date('2026-10-02T11:00:00');
    expect(violatesCutoff('14:00', delivery, new Date('2026-10-01T13:00:00'))).toBe(false);
    expect(violatesCutoff('14:00', delivery, new Date('2026-10-01T15:00:00'))).toBe(true);
    expect(violatesCutoff(undefined, delivery, new Date('2026-10-01T23:00:00'))).toBe(false);
  });

  test('capacidad por franja: la franja llena rechaza y propone alternativas', async () => {
    const { orders, makeOrder } = setup({
      maxPerSlot: 1,
      slots: [{ key: 'manana', label: 'Mañana', from: '06:00', to: '12:00' }],
      orderCutoff: undefined, minLeadHours: 0,
    });
    const date = futureDeliveryDate();
    makeOrder('programado', date); // ocupa la única plaza de la franja
    const result = await orders.validateAgenda('co1', new Date(date));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('llena');
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  test('franja con cupo → ok', async () => {
    const { orders } = setup({
      maxPerSlot: 8,
      slots: [{ key: 'manana', from: '06:00', to: '12:00' }],
      minLeadHours: 0,
    });
    const result = await orders.validateAgenda('co1', futureDeliveryDate());
    expect(result.ok).toBe(true);
  });
});

/* ─── Pipeline de confirmación ───────────────────────────────────────── */

describe('runConfirmationPipeline', () => {
  test('distribuye por reglas, programa recordatorios y pasa a programado', async () => {
    const { orders, db, makeOrder } = setup({
      minLeadHours: 0,
      distributionRules: [{ category: 'Bebidas', areaId: 'area-despacho', priority: 1 }],
    });
    const order = makeOrder('confirmado');
    const result = await orders.runConfirmationPipeline(order.id, { type: 'IA', name: 'Asistente IA' });
    expect(result.scheduled).toBe(true);

    // Distribución: cada ítem con su área (regla + fallback del producto)
    const items = db.orderItem.filter((i) => i.orderId === order.id);
    expect(items.find((i) => i.productId === 'p1')!.productionAreaId).toBe('area-cocina');
    expect(items.find((i) => i.productId === 'p2')!.productionAreaId).toBe('area-despacho');

    // Recordatorios: 2 por área (nuevo trabajo + anticipación) + 1 al cliente
    const reminders = db.reminder.filter((r) => r.orderId === order.id);
    expect(reminders).toHaveLength(5);
    expect(reminders.filter((r) => r.kind === 'CLIENTE')).toHaveLength(1);
    expect(reminders.filter((r) => r.kind === 'DESPACHO')).toHaveLength(2);
    // Anticipación del área respetada (cocina 24 h antes)
    const cocinaReminder = reminders.find(
      (r) => r.templateKey === 'recordatorio_area' && r.recipientJson.includes('area-cocina'),
    )!;
    const expected = order.deliveryAt.getTime() - 24 * 3600e3;
    expect(Math.abs(cocinaReminder.scheduledAt.getTime() - expected)).toBeLessThan(120e3);

    // Estado final: programado, con trazabilidad del sistema
    expect(db.order[0].status).toBe('programado');
    expect(db.orderStatusHistory.at(-1)).toMatchObject({
      fromStatus: 'confirmado', toStatus: 'programado', authorType: 'SISTEMA',
    });
  });

  test('agenda inválida → requiere_atencion con motivo, nunca "acepta y falla"', async () => {
    const { orders, db, makeOrder } = setup({
      maxPerSlot: 1,
      slots: [{ key: 'manana', from: '06:00', to: '12:00' }],
      minLeadHours: 0,
    });
    const date = futureDeliveryDate();
    makeOrder('programado', date); // llena la franja
    const order = makeOrder('confirmado', new Date(date));
    const result = await orders.runConfirmationPipeline(order.id, { type: 'IA', name: 'IA' });
    expect(result.scheduled).toBe(false);
    expect(db.order.find((o) => o.id === order.id)!.status).toBe('requiere_atencion');
    expect(db.orderStatusHistory.at(-1)!.reason).toContain('llena');
  });

  test('IDEMPOTENCIA de recordatorios: confirmar dos veces no duplica', async () => {
    const { orders, db, makeOrder } = setup({ minLeadHours: 0 });
    const order = makeOrder('confirmado');
    await orders.runConfirmationPipeline(order.id, { type: 'IA', name: 'IA' });
    const first = db.reminder.length;
    await orders.runConfirmationPipeline(order.id, { type: 'SISTEMA', name: 'Reintento' });
    expect(db.reminder.length).toBe(first);
  });
});

/* ─── Despacho de recordatorios ──────────────────────────────────────── */

describe('dispatchDue (job idempotente)', () => {
  test('envía los vencidos una sola vez aunque corra dos veces', async () => {
    const { reminders, db, audit } = setup();
    db.reminder.push({
      id: 'r1', companyId: 'co1', kind: 'AREA', channel: 'PANEL',
      recipientJson: JSON.stringify({ name: 'Cocina' }),
      scheduledAt: new Date(Date.now() - 60e3), status: 'PENDIENTE',
      attempts: 0, bodyRendered: 'Recordatorio de prueba',
    });
    const first = await reminders.dispatchDue();
    expect(first.sent).toBe(1);
    expect(db.reminder[0].status).toBe('ENVIADO');
    const second = await reminders.dispatchDue();
    expect(second.sent).toBe(0); // no reenvía
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reminder.panel' }),
    );
  });

  test('los futuros no se tocan', async () => {
    const { reminders, db } = setup();
    db.reminder.push({
      id: 'r2', companyId: 'co1', kind: 'AREA', channel: 'PANEL',
      recipientJson: '{}', scheduledAt: new Date(Date.now() + 3600e3),
      status: 'PENDIENTE', attempts: 0,
    });
    await reminders.dispatchDue();
    expect(db.reminder[0].status).toBe('PENDIENTE');
  });

  test('EMAIL sin destinatario: reintenta y al tercer fallo alerta (FALLIDO)', async () => {
    const { reminders, db, audit } = setup();
    db.reminder.push({
      id: 'r3', companyId: 'co1', kind: 'AREA', channel: 'EMAIL',
      recipientJson: JSON.stringify({ name: 'Sin correo' }),
      scheduledAt: new Date(Date.now() - 60e3), status: 'PENDIENTE', attempts: 0,
    });
    await reminders.dispatchDue(); // intento 1 → PENDIENTE
    expect(db.reminder[0].status).toBe('PENDIENTE');
    expect(db.reminder[0].attempts).toBe(1);
    await reminders.dispatchDue(); // intento 2
    const result = await reminders.dispatchDue(); // intento 3 → FALLIDO + alerta
    expect(result.failed).toBe(1);
    expect(db.reminder[0].status).toBe('FALLIDO');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reminder.failed' }),
    );
  });

  test('WHATSAPP en sandbox: se marca enviado sin salir nada real', async () => {
    const { reminders, db } = setup();
    db.integration.push({
      id: 'line1', companyId: 'co1', type: 'WHATSAPP',
      configJson: JSON.stringify({ provider: 'TWILIO', sandbox: true }),
    });
    db.reminder.push({
      id: 'r4', companyId: 'co1', kind: 'CLIENTE', channel: 'WHATSAPP',
      recipientJson: JSON.stringify({ name: 'Marta', phone: '+573105550101' }),
      scheduledAt: new Date(Date.now() - 60e3), status: 'PENDIENTE', attempts: 0,
      templateKey: 'recordatorio_cliente', bodyRendered: 'Tu entrega es hoy a las 11:00',
    });
    const result = await reminders.dispatchDue();
    expect(result.sent).toBe(1);
    expect(db.reminder[0].status).toBe('ENVIADO');
  });
});

/* ─── Marcar ítem listo → regla automática ───────────────────────────── */

describe('markItemReady', () => {
  const user = { id: 'u1', name: 'Cocina', role: 'COMPANY_ADMIN', companyId: 'co1' } as any;

  test('cuando todas las áreas terminan, el pedido pasa a "listo" solo', async () => {
    const { orders, db, makeOrder } = setup();
    const order = makeOrder('en_produccion');
    const [a, b] = db.orderItem.filter((i) => i.orderId === order.id);
    await orders.markItemReady(user, a.id);
    expect(db.order[0].status).toBe('en_produccion'); // aún falta un área
    const result = await orders.markItemReady(user, b.id);
    expect(result.allReady).toBe(true);
    expect(db.order[0].status).toBe('listo');
    expect(db.orderStatusHistory.at(-1)).toMatchObject({
      toStatus: 'listo', authorType: 'SISTEMA',
    });
  });
});

/* ─── Plantillas ─────────────────────────────────────────────────────── */

describe('renderTemplate', () => {
  test('reemplaza variables y deja vacías las desconocidas', () => {
    expect(
      renderTemplate('Hola {{contacto}}, entrega {{fecha}} {{nada}}', {
        contacto: 'Marta', fecha: 'jueves',
      }),
    ).toBe('Hola Marta, entrega jueves ');
  });
});
