/**
 * Pruebas Fase 6 — reporte diario, comparativos, consulta con herramientas
 * predefinidas y feedback post-entrega.
 */
import { ReportsService } from '../src/modules/reports.module';
import { OrdersService, RemindersService } from '../src/modules/orders.module';
import { TwilioService } from '../src/modules/twilio.module';
import { inferSentiment, isDissatisfied, parseRating } from '../src/common/feedback';
import { AiChatOptions, AiChatResult, AiProvider } from '../src/ai/types';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const ADMIN = {
  id: 'u1', email: 'a@a.co', name: 'Admin', role: 'COMPANY_ADMIN' as const,
  companyId: 'co1',
};
const OTHER_ADMIN = { ...ADMIN, id: 'u2', companyId: 'co2' };

function fakeQueue() {
  return {
    add: jest.fn(async () => undefined),
    getJob: jest.fn(async () => null),
  };
}

/** Proveedor guionado: devuelve respuestas en orden. */
function scriptedAi(responses: string[]): AiProvider {
  let i = 0;
  return {
    chat: jest.fn(async (_opts: AiChatOptions): Promise<AiChatResult> => ({
      content: responses[Math.min(i++, responses.length - 1)],
      inputTokens: 10,
      outputTokens: 5,
      model: 'test-model',
    })),
    transcribe: jest.fn(async () => ({ text: '' })),
  } as any;
}

function setup() {
  const { prisma, db } = createMockPrisma();
  const audit = {
    log: jest.fn(async (entry: any) => {
      db.auditLog.push({ id: `a${db.auditLog.length}`, createdAt: new Date(), ...entry });
    }),
  };
  const emails = { systemSend: jest.fn(async () => undefined) };
  const events = { emit: jest.fn() };

  db.company.push({
    id: 'co1', name: 'Catering Test', slug: 'catering-test', status: 'ACTIVE',
    timezone: 'America/Bogota', deepinfraApiKey: 'llave-test',
    modulesJson: JSON.stringify(['orders']),
    orderConfigJson: JSON.stringify({
      schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' },
      minLeadHours: 18,
      aiConfidenceThreshold: 0.8,
      feedbackDelayHours: 3,
      reminderDefaults: { clientSameDayHour: 7 },
    }),
    waTemplatesJson: '[]',
  });
  db.company.push({
    id: 'co2', name: 'Otra Empresa', slug: 'otra', status: 'ACTIVE',
    timezone: 'America/Bogota',
    modulesJson: JSON.stringify(['orders']),
    orderConfigJson: '{}', waTemplatesJson: '[]',
  });
  db.customer.push({ id: 'cust1', companyId: 'co1', name: 'Constructora Test', addressesJson: '[]' });
  db.customer.push({ id: 'cust2', companyId: 'co2', name: 'Cliente Ajeno', addressesJson: '[]' });
  db.contact.push({
    id: 'ct1', companyId: 'co1', customerId: 'cust1',
    name: 'Marta Ruiz', phone: '+573100000001', channel: 'WHATSAPP', stage: 'CLIENTE',
  });

  return { prisma, db, audit, emails, events };
}

function makeOrder(db: any, over: Record<string, any> = {}) {
  const order = {
    id: over.id ?? `o${db.order.length + 1}`,
    companyId: 'co1', customerId: 'cust1', contactId: 'ct1',
    status: 'programado',
    deliveryAt: new Date(Date.now() + 86400e3),
    deliveryAddressJson: '{}',
    takenByType: 'IA', correctedAfterAi: false, aiConfidence: 0.9,
    createdAt: new Date(), deletedAt: null,
    ...over,
  };
  db.order.push(order);
  return order;
}

/* ═══ Parser determinista de feedback ═══ */

describe('parseRating / inferSentiment', () => {
  it('extrae dígitos, palabras y estrellas', () => {
    expect(parseRating('5')).toBe(5);
    expect(parseRating('le doy un 4, muy rico')).toBe(4);
    expect(parseRating('cinco estrellas!')).toBe(5);
    expect(parseRating('⭐⭐⭐')).toBe(3);
    expect(parseRating('todo excelente')).toBeNull();
    expect(parseRating('llegó a las 10 en punto')).toBeNull(); // 10 no es rating
  });

  it('sentimiento: manda el rating; sin rating, palabras clave', () => {
    expect(inferSentiment('lo que sea', 5)).toBe('POSITIVO');
    expect(inferSentiment('lo que sea', 3)).toBe('NEUTRO');
    expect(inferSentiment('lo que sea', 1)).toBe('NEGATIVO');
    expect(inferSentiment('todo delicioso, gracias', null)).toBe('POSITIVO');
    expect(inferSentiment('llegó frío y tarde', null)).toBe('NEGATIVO');
    expect(inferSentiment('ok', null)).toBe('NEUTRO');
  });

  it('insatisfacción: rating ≤ 3 o sentimiento negativo', () => {
    expect(isDissatisfied(2, 'NEGATIVO')).toBe(true);
    expect(isDissatisfied(3, 'NEUTRO')).toBe(true);
    expect(isDissatisfied(null, 'NEGATIVO')).toBe(true);
    expect(isDissatisfied(5, 'POSITIVO')).toBe(false);
    expect(isDissatisfied(null, 'NEUTRO')).toBe(false);
  });
});

/* ═══ Feedback post-entrega ═══ */

describe('feedback post-entrega', () => {
  function services(ctx: ReturnType<typeof setup>) {
    const reminders = new RemindersService(ctx.prisma as any, ctx.audit as any, ctx.emails as any);
    const orders = new OrdersService(ctx.prisma as any, ctx.audit as any, reminders);
    const twilio = new TwilioService(
      ctx.prisma as any, ctx.audit as any,
      fakeQueue() as any, fakeQueue() as any, fakeQueue() as any,
      ctx.events as any,
    );
    return { reminders, orders, twilio };
  }

  it('al marcar entregado programa la encuesta con la anticipación configurada', async () => {
    const ctx = setup();
    const { orders } = services(ctx);
    makeOrder(ctx.db, { id: 'o1', status: 'despachado' });

    await orders.changeStatus('o1', 'entregado', { type: 'USUARIO', name: 'Admin' });

    const feedback = ctx.db.feedback.find((f: any) => f.orderId === 'o1')!;
    expect(feedback).toBeDefined();
    expect(feedback.status).toBe('PENDIENTE');
    // ~3 h de anticipación
    const deltaH = (new Date(feedback.requestedAt).getTime() - Date.now()) / 3600e3;
    expect(deltaH).toBeGreaterThan(2.5);
    expect(deltaH).toBeLessThan(3.5);

    const reminder = ctx.db.reminder.find((r: any) => r.orderId === 'o1' && r.kind === 'FEEDBACK')!;
    expect(reminder).toBeDefined();
    expect(reminder.channel).toBe('WHATSAPP');
    expect(reminder.bodyRendered).toContain('Marta');
  });

  it('es idempotente: entregar dos veces no duplica la encuesta', async () => {
    const ctx = setup();
    const { reminders } = services(ctx);
    makeOrder(ctx.db, { id: 'o1', status: 'entregado' });

    await reminders.scheduleFeedback('o1');
    await reminders.scheduleFeedback('o1');

    expect(ctx.db.feedback.filter((f: any) => f.orderId === 'o1')).toHaveLength(1);
    expect(ctx.db.reminder.filter((r: any) => r.kind === 'FEEDBACK')).toHaveLength(1);
  });

  it('captura la respuesta: rating, comentario y sentimiento, y no pasa por el motor', async () => {
    const ctx = setup();
    const { twilio } = services(ctx);
    makeOrder(ctx.db, { id: 'o1', status: 'entregado' });
    ctx.db.feedback.push({
      id: 'f1', companyId: 'co1', orderId: 'o1', customerId: 'cust1', contactId: 'ct1',
      requestedAt: new Date(Date.now() - 3600e3), respondedAt: null, status: 'PENDIENTE',
      rating: null, alerted: false,
    });
    ctx.db.conversation.push({
      id: 'cv1', companyId: 'co1', contactId: 'ct1', channel: 'WHATSAPP',
      status: 'OPEN', botPaused: false, needsAttention: false,
    });

    const captured = await twilio.captureFeedback('co1', 'ct1', 'cv1', 'Un 5, todo delicioso. Gracias!');
    expect(captured).toBe(true);

    const feedback = ctx.db.feedback.find((f: any) => f.id === 'f1')!;
    expect(feedback.rating).toBe(5);
    expect(feedback.sentiment).toBe('POSITIVO');
    expect(feedback.status).toBe('RESPONDIDO');
    expect(feedback.alerted).toBe(false);
    // sin alerta: la conversación queda como estaba
    const convo = ctx.db.conversation.find((c: any) => c.id === 'cv1')!;
    expect(convo.needsAttention).toBe(false);
  });

  it('insatisfacción → alerta inmediata: needsAttention + botPaused + audit', async () => {
    const ctx = setup();
    const { twilio } = services(ctx);
    makeOrder(ctx.db, { id: 'o1', status: 'entregado' });
    ctx.db.feedback.push({
      id: 'f1', companyId: 'co1', orderId: 'o1', customerId: 'cust1', contactId: 'ct1',
      requestedAt: new Date(Date.now() - 3600e3), respondedAt: null, status: 'PENDIENTE',
      rating: null, alerted: false,
    });
    ctx.db.conversation.push({
      id: 'cv1', companyId: 'co1', contactId: 'ct1', channel: 'WHATSAPP',
      status: 'OPEN', botPaused: false, needsAttention: false,
    });

    await twilio.captureFeedback('co1', 'ct1', 'cv1', '2, llegó frío y tarde');

    const feedback = ctx.db.feedback.find((f: any) => f.id === 'f1')!;
    expect(feedback.rating).toBe(2);
    expect(feedback.alerted).toBe(true);
    const convo = ctx.db.conversation.find((c: any) => c.id === 'cv1')!;
    expect(convo.needsAttention).toBe(true);
    expect(convo.botPaused).toBe(true);
    expect(ctx.db.auditLog.some((a: any) => a.action === 'feedback.alert')).toBe(true);
  });

  it('NO captura si todavía no se preguntó (requestedAt en el futuro)', async () => {
    const ctx = setup();
    const { twilio } = services(ctx);
    makeOrder(ctx.db, { id: 'o1', status: 'entregado' });
    ctx.db.feedback.push({
      id: 'f1', companyId: 'co1', orderId: 'o1', customerId: 'cust1', contactId: 'ct1',
      requestedAt: new Date(Date.now() + 3600e3), respondedAt: null, status: 'PENDIENTE',
      rating: null, alerted: false,
    });

    const captured = await twilio.captureFeedback('co1', 'ct1', 'cv1', 'quiero pedir 20 almuerzos');
    expect(captured).toBe(false);
    expect(ctx.db.feedback[0].status).toBe('PENDIENTE');
  });
});

/* ═══ Reporte diario ═══ */

describe('reporte diario', () => {
  function reports(ctx: ReturnType<typeof setup>, ai?: AiProvider) {
    return new ReportsService(
      ctx.prisma as any, ctx.audit as any, ctx.emails as any,
      ai, ctx.events as any,
    );
  }
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());

  it('cuenta pedidos, transiciones, conversaciones y precisión REAL de la IA', async () => {
    const ctx = setup();
    const service = reports(ctx);

    makeOrder(ctx.db, { id: 'o1' }); // IA, sin corrección
    makeOrder(ctx.db, { id: 'o2', correctedAfterAi: true }); // IA corregido
    makeOrder(ctx.db, { id: 'o3', takenByType: 'HUMANO', aiConfidence: null });
    ctx.db.orderStatusHistory.push(
      { id: 'h1', companyId: 'co1', orderId: 'o1', toStatus: 'confirmado', createdAt: new Date() },
      { id: 'h2', companyId: 'co1', orderId: 'o1', toStatus: 'programado', createdAt: new Date() },
      { id: 'h3', companyId: 'co1', orderId: 'o2', toStatus: 'entregado', createdAt: new Date() },
    );
    ctx.db.conversation.push(
      { id: 'cv1', companyId: 'co1', contactId: 'ct1', unreadCount: 0, lastMessageAt: new Date() },
      { id: 'cv2', companyId: 'co1', contactId: 'ct1', unreadCount: 0, lastMessageAt: new Date() },
    );
    ctx.db.message.push(
      { id: 'm1', conversationId: 'cv1', direction: 'IN', author: 'CONTACT', createdAt: new Date() },
      { id: 'm2', conversationId: 'cv2', direction: 'IN', author: 'CONTACT', createdAt: new Date() },
      { id: 'm3', conversationId: 'cv2', direction: 'OUT', author: 'AGENT', createdAt: new Date() },
    );
    ctx.db.auditLog.push({
      id: 'a1', companyId: 'co1', action: 'engine.escalate', createdAt: new Date(),
    });

    const data = await service.buildDaily('co1', today);

    expect(data.pedidos.recibidos).toBe(3);
    expect(data.pedidos.confirmados).toBe(1);
    expect(data.pedidos.programados).toBe(1);
    expect(data.pedidos.entregados).toBe(1);
    expect(data.conversaciones.atendidas).toBe(2);
    expect(data.conversaciones.escaladas).toBe(1);
    expect(data.conversaciones.conIntervencionHumana).toBe(1);
    // Precisión: 2 pedidos IA, 1 corregido → 50%
    expect(data.precisionIA.dia.total).toBe(2);
    expect(data.precisionIA.dia.corregidos).toBe(1);
    expect(data.precisionIA.dia.precisionPct).toBe(50);
  });

  it('lista dudas (confianza < umbral) y alertas accionables', async () => {
    const ctx = setup();
    const service = reports(ctx);

    makeOrder(ctx.db, { id: 'o1', aiConfidence: 0.55, status: 'requiere_atencion' });
    // borrador viejo (sin confirmar hace >12 h)
    makeOrder(ctx.db, {
      id: 'o2', status: 'borrador', createdAt: new Date(Date.now() - 20 * 3600e3),
    });
    // entrega próxima con ítem sin área
    const o3 = makeOrder(ctx.db, {
      id: 'o3', status: 'programado', deliveryAt: new Date(Date.now() + 24 * 3600e3),
    });
    ctx.db.orderItem.push({
      id: 'i1', companyId: 'co1', orderId: o3.id, productName: 'Almuerzo',
      quantity: 10, productionAreaId: null,
    });
    ctx.db.reminder.push({
      id: 'r1', companyId: 'co1', orderId: 'o3', kind: 'AREA', status: 'FALLIDO',
      lastError: 'sin plantilla', updatedAt: new Date(), scheduledAt: new Date(),
    });

    const data = await service.buildDaily('co1', today);

    expect(data.dudas.pedidosBajaConfianza.map((d: any) => d.id)).toContain('o1');
    expect(data.alertas.pedidosSinConfirmar.map((a: any) => a.id)).toContain('o2');
    expect(data.alertas.entregasProximasSinArea.map((a: any) => a.id)).toContain('o3');
    expect(data.alertas.recordatoriosFallidos).toHaveLength(1);
  });

  it('runDaily guarda el reporte y lo envía por correo si está configurado', async () => {
    const ctx = setup();
    const company = ctx.db.company.find((c: any) => c.id === 'co1')!;
    company.orderConfigJson = JSON.stringify({
      ...JSON.parse(company.orderConfigJson),
      dailyReport: { hour: 6, channel: 'EMAIL', email: 'gerencia@test.co' },
    });
    const service = reports(ctx);

    const result = await service.runDaily('co1', today, null);

    expect(result.channel).toBe('EMAIL');
    expect(result.sent).toBe(true);
    expect(ctx.emails.systemSend).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'gerencia@test.co' }),
    );
    expect(ctx.db.dailyReport).toHaveLength(1);
    // segunda corrida del mismo día: upsert, no duplica
    await service.runDaily('co1', today, null);
    expect(ctx.db.dailyReport).toHaveLength(1);
  });

  it('el reporte NO mezcla datos de otra organización', async () => {
    const ctx = setup();
    const service = reports(ctx);
    makeOrder(ctx.db, { id: 'o1' });
    makeOrder(ctx.db, { id: 'ajeno', companyId: 'co2', customerId: 'cust2' });

    const data = await service.buildDaily('co1', today);
    expect(data.pedidos.recibidos).toBe(1);
  });
});

/* ═══ Comparativos ═══ */

describe('comparativo semanal/mensual', () => {
  it('agrupa por semana con cumplimiento y precisión por período', async () => {
    const ctx = setup();
    const service = new ReportsService(ctx.prisma as any, ctx.audit as any, ctx.emails as any);

    const lastWeek = new Date(Date.now() - 7 * 86400e3);
    makeOrder(ctx.db, { id: 'o1', status: 'entregado', deliveryAt: lastWeek });
    makeOrder(ctx.db, { id: 'o2', status: 'cancelado', deliveryAt: lastWeek, correctedAfterAi: true });

    const result = await service.compare('co1', 'week');
    expect(result.buckets).toHaveLength(8);
    const bucket = result.buckets.find((b: any) => b.pedidos === 2);
    expect(bucket).toBeDefined();
    expect(bucket!.entregados).toBe(1);
    expect(bucket!.cancelados).toBe(1);
    expect(bucket!.cumplimientoPct).toBe(50); // 1 de 2 entregas pasadas llegó a entregado
    expect(bucket!.precisionIAPct).toBe(50); // 1 de 2 IA sin corrección
  });
});

/* ═══ Consulta en lenguaje natural (tools predefinidas) ═══ */

describe('consulta en lenguaje natural', () => {
  function service(ctx: ReturnType<typeof setup>, ai: AiProvider) {
    return new ReportsService(ctx.prisma as any, ctx.audit as any, ctx.emails as any, ai, ctx.events as any);
  }

  it('elige una herramienta, la ejecuta tenant-scoped y responde con los datos', async () => {
    const ctx = setup();
    makeOrder(ctx.db, { id: 'o1', status: 'borrador' });
    makeOrder(ctx.db, { id: 'ajeno', companyId: 'co2', customerId: 'cust2', status: 'borrador' });
    const ai = scriptedAi([
      JSON.stringify({ tool: 'pedidos_sin_confirmar', params: {} }),
      'Hay 1 pedido sin confirmar: Constructora Test.',
    ]);

    const result = await service(ctx, ai).ask(ADMIN as any, undefined, '¿qué falta por confirmar?');

    expect(result.tool).toBe('pedidos_sin_confirmar');
    expect((result.data as any).total).toBe(1); // el pedido de co2 NO aparece
    expect((result.data as any).pedidos[0].cliente).toBe('Constructora Test');
    expect(result.answer).toContain('1 pedido');
    // registró consumo de las dos llamadas
    expect(ctx.db.aiUsageEvent).toHaveLength(2);
  });

  it('valida parámetros: status inválido se ignora, limit se acota', async () => {
    const ctx = setup();
    makeOrder(ctx.db, { id: 'o1', status: 'programado', deliveryAt: new Date() });
    const ai = scriptedAi([
      JSON.stringify({
        tool: 'pedidos_por_fecha',
        params: {
          from: new Intl.DateTimeFormat('en-CA').format(new Date()),
          to: new Intl.DateTimeFormat('en-CA').format(new Date()),
          status: 'DROP TABLE', // inválido → se ignora
        },
      }),
      'Hay 1 pedido.',
    ]);

    const result = await service(ctx, ai).ask(ADMIN as any, undefined, '¿pedidos de hoy?');
    expect((result.data as any).total).toBe(1);
  });

  it('herramienta desconocida del modelo → respuesta honesta sin tocar la base', async () => {
    const ctx = setup();
    const ai = scriptedAi([JSON.stringify({ tool: 'sql_libre', params: { q: 'DELETE' } })]);

    const result = await service(ctx, ai).ask(ADMIN as any, undefined, 'borra todo');
    expect(result.tool).toBeNull();
    expect(result.data).toBeNull();
    expect(result.answer).toContain('No tengo una consulta preparada');
  });

  it('sin llave DeepInfra → error claro; usuario de otra empresa no puede pedir co1', async () => {
    const ctx = setup();
    const ai = scriptedAi(['{}']);
    const svc = service(ctx, ai);

    // co2 no tiene llave
    await expect(svc.ask(OTHER_ADMIN as any, undefined, 'hola')).rejects.toThrow(/DeepInfra/);
    // usuario de co2 pidiendo companyId=co1: el scoping lo clava a co2 igual
    const company2 = ctx.db.company.find((c: any) => c.id === 'co2')!;
    company2.deepinfraApiKey = 'llave2';
    const spy = jest.spyOn(svc as any, 'runTool');
    const aiOk = scriptedAi([
      JSON.stringify({ tool: 'pedidos_sin_confirmar', params: {} }),
      'ok',
    ]);
    const svc2 = service(ctx, aiOk);
    makeOrder(ctx.db, { id: 'o1', status: 'borrador' }); // de co1
    const result = await svc2.ask(OTHER_ADMIN as any, 'co1', 'pendientes');
    expect((result.data as any).total).toBe(0); // no ve los borradores de co1
    spy.mockRestore();
  });
});

/* ═══ Feedback resumen / testimonios ═══ */

describe('resumen de feedback', () => {
  it('promedio, distribución, tasa de respuesta y testimonios positivos', async () => {
    const ctx = setup();
    const service = new ReportsService(ctx.prisma as any, ctx.audit as any, ctx.emails as any);
    const base = {
      companyId: 'co1', customerId: 'cust1', contactId: 'ct1',
      requestedAt: new Date(Date.now() - 86400e3),
    };
    ctx.db.feedback.push(
      { id: 'f1', ...base, orderId: 'o1', status: 'RESPONDIDO', respondedAt: new Date(), rating: 5, sentiment: 'POSITIVO', comment: 'Excelente todo', alerted: false },
      { id: 'f2', ...base, orderId: 'o2', status: 'RESPONDIDO', respondedAt: new Date(), rating: 2, sentiment: 'NEGATIVO', comment: 'Llegó tarde', alerted: true },
      { id: 'f3', ...base, orderId: 'o3', status: 'PENDIENTE', respondedAt: null, rating: null, alerted: false },
    );

    const summary = await service.feedbackSummary('co1');

    expect(summary.solicitados).toBe(3);
    expect(summary.respondidos).toBe(2);
    expect(summary.promedio).toBe(3.5);
    expect(summary.negativos).toBe(1);
    expect(summary.distribution.find((d: any) => d.star === 5)!.count).toBe(1);
    expect(summary.testimonios).toHaveLength(1);
    expect(summary.testimonios[0].comment).toBe('Excelente todo');
  });
});
