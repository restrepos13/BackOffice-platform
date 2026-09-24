/**
 * Pruebas Fase 7 — INTEGRACIÓN del flujo completo:
 * mensaje entra → pedido creado → distribuido → recordatorios → estados →
 * entrega → feedback. Más: fallos simulados de Twilio y del proveedor de IA,
 * idempotencia del job de recordatorios y conversaciones difíciles.
 */
import { EngineService } from '../src/modules/engine.module';
import { OrdersService, RemindersService } from '../src/modules/orders.module';
import { TwilioService } from '../src/modules/twilio.module';
import { AiChatOptions, AiChatResult, AiProvider } from '../src/ai/types';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const ADMIN = {
  id: 'u1', email: 'a@a.co', name: 'Admin Test', role: 'COMPANY_ADMIN' as const,
  companyId: 'co1',
};

class FakeProvider implements AiProvider {
  calls: AiChatOptions[] = [];
  private queue: Array<string | Error> = [];

  script(...outputs: Array<object | string | Error>) {
    this.queue.push(
      ...outputs.map((o) =>
        o instanceof Error ? o : typeof o === 'string' ? o : JSON.stringify(o),
      ),
    );
  }

  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    this.calls.push(opts);
    const item = this.queue.shift();
    if (item === undefined) throw new Error('FakeProvider sin guion');
    if (item instanceof Error) throw item;
    return { content: item, inputTokens: 500, outputTokens: 80, model: opts.model };
  }

  async transcribe(): Promise<{ text: string }> {
    return { text: '' };
  }
}

function fakeQueue() {
  return {
    add: jest.fn(async () => undefined),
    getJob: jest.fn(async () => null),
  };
}

function nextDelivery(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  d.setHours(11, 30, 0, 0);
  return d;
}

function setup() {
  const { prisma, db } = createMockPrisma();
  const provider = new FakeProvider();
  const audit = {
    log: jest.fn(async (entry: any) => {
      db.auditLog.push({ id: `a${db.auditLog.length}`, createdAt: new Date(), ...entry });
    }),
  };
  const emails = { systemSend: jest.fn(async () => undefined) };
  const events = { emit: jest.fn() };
  const outboundQueue = fakeQueue();
  const engineQueue = fakeQueue();

  const reminders = new RemindersService(prisma as any, audit as any, emails as any);
  const orders = new OrdersService(prisma as any, audit as any, reminders);
  const engine = new EngineService(
    prisma as any, provider, audit as any,
    outboundQueue as any, orders, events as any,
  );
  const twilio = new TwilioService(
    prisma as any, audit as any,
    fakeQueue() as any, outboundQueue as any, engineQueue as any,
    events as any,
  );

  db.company.push({
    id: 'co1', name: 'Catering Integración', slug: 'catering-int', status: 'ACTIVE',
    timezone: 'America/Bogota', deepinfraApiKey: 'di_test',
    modulesJson: JSON.stringify(['orders']),
    orderConfigJson: JSON.stringify({
      schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' },
      minLeadHours: 18, aiConfidenceThreshold: 0.8,
      reminderDefaults: { clientSameDayHour: 7 },
      feedbackDelayHours: 3,
    }),
    waTemplatesJson: '[]',
  });
  db.bot.push({
    id: 'bot1', companyId: 'co1', status: 'ACTIVE',
    systemPrompt: 'Atiendes el catering.', personalityJson: '{}', salesJson: '{}',
    model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.7,
    replyDelayMinSec: 0, replyDelayMaxSec: 0, typingSimulation: false,
    handoffKeywords: '', welcomeMessage: null,
  });
  db.integration.push({
    id: 'line1', companyId: 'co1', botId: 'bot1', type: 'WHATSAPP',
    promptMode: 'INHERIT', overridePersonalityJson: '{}', overrideSalesJson: '{}',
    configJson: JSON.stringify({ provider: 'TWILIO', sandbox: true }),
  });
  db.productionArea.push(
    {
      id: 'cocina', companyId: 'co1', name: 'Cocina',
      responsiblesJson: '[]', notifyChannel: 'PANEL', reminderHoursBefore: 24, active: true,
    },
    {
      id: 'despacho', companyId: 'co1', name: 'Despacho',
      responsiblesJson: '[]', notifyChannel: 'PANEL', reminderHoursBefore: 3, active: true,
    },
  );
  db.product.push({
    id: 'p1', companyId: 'co1', name: 'Almuerzo ejecutivo', unit: 'porción',
    category: 'Almuerzos', presentationsJson: '[]', productionAreaId: 'cocina',
    active: true, deletedAt: null, description: null,
  });
  db.customer.push({
    id: 'cust1', companyId: 'co1', name: 'Constructora Integración',
    addressesJson: JSON.stringify([{ label: 'Obra Norte', address: 'Cl 100 # 10-20', city: 'Bogotá' }]),
  });
  db.contact.push({
    id: 'ct1', companyId: 'co1', customerId: 'cust1',
    name: 'Marta Ruiz', phone: '+573105550101', channel: 'WHATSAPP', stage: 'CLIENTE',
  });
  db.aiModel.push({
    id: 'm1', modelId: 'meta-llama/Llama-3.3-70B-Instruct',
    inputCostPerMTok: 0.23, outputCostPerMTok: 0.4,
  });

  return { prisma, db, provider, audit, emails, events, outboundQueue, engineQueue, reminders, orders, engine, twilio };
}

function inboundPayload(sid: string, body: string) {
  return {
    MessageSid: sid,
    From: 'whatsapp:+573105550101',
    To: 'whatsapp:+14155238886',
    ProfileName: 'Marta Ruiz',
    Body: body,
  };
}

/* ═══ Flujo completo ═══ */

describe('flujo completo: mensaje → pedido → distribución → recordatorios → entrega → feedback', () => {
  it('recorre el ciclo de vida entero sin intervención', async () => {
    const ctx = setup();
    const deliveryAt = nextDelivery();

    // 1) Entra el mensaje por el webhook (idempotente, encola el motor)
    const in1 = await ctx.twilio.processInbound({
      companyId: 'co1', lineId: 'line1',
      payload: inboundPayload('SM_int_1', 'Hola, 30 almuerzos ejecutivos para pasado mañana 11:30 en la Obra Norte'),
    });
    expect(in1.conversationId).toBeDefined();
    const convId = in1.conversationId!;
    expect(ctx.engineQueue.add).toHaveBeenCalledWith(
      'process',
      { conversationId: convId },
      expect.objectContaining({ jobId: `conv-${convId}` }),
    );

    // 2) El motor arma el borrador y pide confirmación
    ctx.provider.script({
      reply: ['Listo, 30 almuerzos para la Obra Norte. ¿Confirmas?'],
      state: 'esperando_confirmacion', action: 'request_confirmation',
      order: {
        deliveryAtISO: deliveryAt.toISOString(),
        addressLabel: 'Obra Norte',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 30, unit: 'porción' }],
      },
      confidence: 0.95, escalationReason: null, missingFields: [],
    });
    const r1 = await ctx.engine.processConversation(convId);
    expect(r1?.escalated).toBe(false);
    expect(r1?.draftOrderId).toBeDefined();
    const orderId = r1!.draftOrderId!;
    expect(ctx.db.order.find((o: any) => o.id === orderId)?.status).toBe('borrador');

    // 3) El cliente confirma → pipeline completo hasta "programado"
    await ctx.twilio.processInbound({
      companyId: 'co1', lineId: 'line1',
      payload: inboundPayload('SM_int_2', 'Sí, confirmado'),
    });
    ctx.provider.script({
      reply: ['¡Confirmado! Nos vemos el jueves.'],
      state: 'cerrado', action: 'confirm_order',
      order: {
        deliveryAtISO: deliveryAt.toISOString(),
        addressLabel: 'Obra Norte',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 30, unit: 'porción' }],
      },
      confidence: 0.97, escalationReason: null, missingFields: [],
    });
    const r2 = await ctx.engine.processConversation(convId);
    expect(r2?.orderStatus).toBe('programado');

    // Distribución: el ítem quedó en Cocina (área del producto)
    const items = ctx.db.orderItem.filter((i: any) => i.orderId === orderId);
    expect(items).toHaveLength(1);
    expect(items[0].productionAreaId).toBe('cocina');

    // Recordatorios programados (área + cliente) y trazabilidad completa
    const orderReminders = ctx.db.reminder.filter((r: any) => r.orderId === orderId);
    expect(orderReminders.length).toBeGreaterThanOrEqual(3);
    const historia = ctx.db.orderStatusHistory
      .filter((h: any) => h.orderId === orderId)
      .map((h: any) => h.toStatus);
    expect(historia).toEqual(expect.arrayContaining(['confirmado', 'programado']));

    // Las respuestas del bot salieron a la cola de envío (sandbox)
    expect(ctx.outboundQueue.add).toHaveBeenCalled();

    // 4) Despacho de recordatorios vencidos (inmediatos) — quedan ENVIADO
    const { sent } = await ctx.reminders.dispatchDue();
    expect(sent).toBeGreaterThanOrEqual(1);

    // 5) Producción: el área marca listo → listo → empacado → despachado → entregado
    await ctx.orders.changeStatus(orderId, 'en_produccion', { type: 'USUARIO', name: 'Admin' });
    await ctx.orders.markItemReady(ADMIN as any, items[0].id);
    expect(ctx.db.order.find((o: any) => o.id === orderId)?.status).toBe('listo');
    await ctx.orders.changeStatus(orderId, 'empacado', { type: 'USUARIO', name: 'Admin' });
    await ctx.orders.changeStatus(orderId, 'despachado', { type: 'USUARIO', name: 'Admin' });
    await ctx.orders.changeStatus(orderId, 'entregado', { type: 'USUARIO', name: 'Admin' });

    // 6) Feedback quedó programado; simulamos que ya se preguntó y responde 5
    const feedback = ctx.db.feedback.find((f: any) => f.orderId === orderId);
    expect(feedback).toBeDefined();
    feedback!.requestedAt = new Date(Date.now() - 60e3);
    ctx.engineQueue.add.mockClear();
    const in3 = await ctx.twilio.processInbound({
      companyId: 'co1', lineId: 'line1',
      payload: inboundPayload('SM_int_3', '5, todo excelente. ¡Gracias!'),
    });
    expect((in3 as any).feedback).toBe(true);
    expect(ctx.engineQueue.add).not.toHaveBeenCalled(); // no pasa por el motor
    expect(feedback!.rating).toBe(5);
    expect(feedback!.status).toBe('RESPONDIDO');
  });

  it('webhook duplicado (mismo MessageSid) no duplica nada', async () => {
    const ctx = setup();
    const p = inboundPayload('SM_dup', 'Hola');
    const first = await ctx.twilio.processInbound({ companyId: 'co1', lineId: 'line1', payload: p });
    const second = await ctx.twilio.processInbound({ companyId: 'co1', lineId: 'line1', payload: p });
    expect((second as any).skipped).toBe('duplicado');
    expect(ctx.db.message.filter((m: any) => m.providerId === 'SM_dup')).toHaveLength(1);
    expect((second as any).messageId).toBe((first as any).messageId);
  });
});

/* ═══ Conversaciones difíciles ═══ */

describe('conversaciones difíciles', () => {
  async function freshConversation(ctx: ReturnType<typeof setup>) {
    const r = await ctx.twilio.processInbound({
      companyId: 'co1', lineId: 'line1',
      payload: inboundPayload(`SM_${Math.random()}`, 'Hola, quiero cotizar'),
    });
    return r.conversationId!;
  }

  it('cambio a mitad de pedido: el borrador refleja SIEMPRE el último estado', async () => {
    const ctx = setup();
    const convId = await freshConversation(ctx);
    const deliveryAt = nextDelivery();
    const base = {
      deliveryAtISO: deliveryAt.toISOString(), addressLabel: 'Obra Norte',
    };
    ctx.provider.script(
      {
        reply: ['Anotados 20.'], state: 'tomando_pedido', action: 'update_draft',
        order: { ...base, items: [{ productName: 'Almuerzo ejecutivo', quantity: 20, unit: 'porción' }] },
        confidence: 0.9, escalationReason: null, missingFields: [],
      },
    );
    await ctx.engine.processConversation(convId);
    ctx.provider.script(
      {
        reply: ['Cambiado a 45.'], state: 'esperando_confirmacion', action: 'update_draft',
        order: { ...base, items: [{ productName: 'Almuerzo ejecutivo', quantity: 45, unit: 'porción' }] },
        confidence: 0.9, escalationReason: null, missingFields: [],
      },
    );
    const r = await ctx.engine.processConversation(convId);
    const items = ctx.db.orderItem.filter((i: any) => i.orderId === r!.draftOrderId);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(45);
  });

  it('cliente que se arrepiente: el pedido queda en borrador, jamás se confirma solo', async () => {
    const ctx = setup();
    const convId = await freshConversation(ctx);
    ctx.provider.script({
      reply: ['Tranquila, quedamos atentos para otra ocasión.'],
      state: 'cerrado', action: 'none', order: null,
      confidence: 0.95, escalationReason: null, missingFields: [],
    });
    const r = await ctx.engine.processConversation(convId);
    expect(r?.escalated).toBe(false);
    expect(ctx.db.order.filter((o: any) => o.status !== 'borrador')).toHaveLength(0);
  });

  it('información contradictoria → escala con motivo y pausa la IA', async () => {
    const ctx = setup();
    const convId = await freshConversation(ctx);
    ctx.provider.script({
      reply: ['Déjame confirmar con el equipo.'],
      state: 'escalado', action: 'escalate', order: null,
      confidence: 0.3, escalationReason: 'El cliente dio dos fechas distintas',
      missingFields: [],
    });
    const r = await ctx.engine.processConversation(convId);
    expect(r?.escalated).toBe(true);
    const convo = ctx.db.conversation.find((c: any) => c.id === convId)!;
    expect(convo.botPaused).toBe(true);
    expect(convo.needsAttention).toBe(true);
    expect(ctx.db.auditLog.some((a: any) => a.action === 'engine.escalate')).toBe(true);
  });

  it('pedido fuera de horario: la confirmación se bloquea, nunca "acepta y después falla"', async () => {
    const ctx = setup();
    const convId = await freshConversation(ctx);
    const domingo = new Date();
    domingo.setDate(domingo.getDate() + ((7 - domingo.getDay()) % 7 || 7)); // próximo domingo
    domingo.setHours(11, 0, 0, 0);
    ctx.provider.script({
      reply: ['Confirmado para el domingo.'],
      state: 'cerrado', action: 'confirm_order',
      order: {
        deliveryAtISO: domingo.toISOString(), addressLabel: 'Obra Norte',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 10, unit: 'porción' }],
      },
      confidence: 0.95, escalationReason: null, missingFields: [],
    });
    const r = await ctx.engine.processConversation(convId);
    expect(r?.orderStatus).not.toBe('programado');
    expect(
      ctx.db.auditLog.some((a: any) => a.action === 'engine.confirm_blocked'),
    ).toBe(true);
  });
});

/* ═══ Fallos simulados ═══ */

describe('fallos de integraciones', () => {
  it('proveedor de IA caído (excepción de red) → escala, no se pierde la conversación', async () => {
    const ctx = setup();
    const r0 = await ctx.twilio.processInbound({
      companyId: 'co1', lineId: 'line1',
      payload: inboundPayload('SM_down', 'Hola'),
    });
    ctx.provider.script(new Error('fetch failed: ECONNREFUSED'));
    const r = await ctx.engine.processConversation(r0.conversationId!);
    expect(r?.escalated).toBe(true);
    expect(r?.escalationReason).toContain('Proveedor de IA no disponible');
    const convo = ctx.db.conversation.find((c: any) => c.id === r0.conversationId)!;
    expect(convo.needsAttention).toBe(true);
  });

  it('recordatorio WHATSAPP sin plantilla (línea real, no sandbox) → 3 intentos → FALLIDO + auditoría', async () => {
    const ctx = setup();
    // Línea "real": sin sandbox y con credenciales
    const line = ctx.db.integration.find((i: any) => i.id === 'line1')!;
    line.configJson = JSON.stringify({
      provider: 'TWILIO', sandbox: false, accountSid: 'AC_test',
      authTokenEnc: 'enc:v1:00:00:00', fromNumber: '+15550000000',
    });
    ctx.db.reminder.push({
      id: 'r1', companyId: 'co1', orderId: null, kind: 'CLIENTE',
      recipientJson: JSON.stringify({ name: 'Marta', phone: '+573105550101' }),
      channel: 'WHATSAPP', scheduledAt: new Date(Date.now() - 60e3),
      templateKey: 'recordatorio_cliente', bodyRendered: 'Recordatorio…',
      status: 'PENDIENTE', attempts: 0,
    });

    let failed = 0;
    for (let i = 0; i < 3; i++) {
      const res = await ctx.reminders.dispatchDue();
      failed += res.failed;
    }
    const reminder = ctx.db.reminder.find((r: any) => r.id === 'r1')!;
    expect(reminder.status).toBe('FALLIDO');
    expect(reminder.attempts).toBe(3);
    expect(failed).toBe(1);
    expect(ctx.db.auditLog.some((a: any) => a.action === 'reminder.failed')).toBe(true);
  });

  it('idempotencia: correr el job de recordatorios DOS VECES A LA VEZ no duplica envíos', async () => {
    const ctx = setup();
    for (let i = 0; i < 5; i++) {
      ctx.db.reminder.push({
        id: `rr${i}`, companyId: 'co1', orderId: null, kind: 'AREA',
        recipientJson: JSON.stringify({ name: 'Cocina' }), channel: 'PANEL',
        scheduledAt: new Date(Date.now() - 60e3), templateKey: 'nuevo_pedido',
        bodyRendered: `aviso ${i}`, status: 'PENDIENTE', attempts: 0,
      });
    }
    const [a, b] = await Promise.all([
      ctx.reminders.dispatchDue(),
      ctx.reminders.dispatchDue(),
    ]);
    // Entre las dos corridas se envió cada uno UNA vez (claim condicional)
    expect(a.sent + b.sent).toBe(5);
    expect(ctx.db.reminder.filter((r: any) => r.status === 'ENVIADO')).toHaveLength(5);
    // Los "envíos" por PANEL quedan auditados: exactamente 5, sin duplicados
    expect(ctx.db.auditLog.filter((l: any) => l.action === 'reminder.panel')).toHaveLength(5);
  });

  it('envío saliente fuera de la ventana de 24 h sin plantilla → FAILED con alerta (no se pierde en silencio)', async () => {
    const ctx = setup();
    const line = ctx.db.integration.find((i: any) => i.id === 'line1')!;
    line.configJson = JSON.stringify({
      provider: 'TWILIO', sandbox: false, accountSid: 'AC_test',
      authTokenEnc: 'enc:v1:00:00:00', fromNumber: '+15550000000',
    });
    ctx.db.conversation.push({
      id: 'cvold', companyId: 'co1', contactId: 'ct1', integrationId: 'line1',
      channel: 'WHATSAPP', status: 'OPEN', botPaused: false, needsAttention: false,
    });
    // Último entrante hace 3 días → fuera de ventana
    ctx.db.message.push({
      id: 'mold', conversationId: 'cvold', direction: 'IN', author: 'CONTACT',
      content: 'hola', createdAt: new Date(Date.now() - 3 * 86400e3),
    });
    ctx.db.message.push({
      id: 'mout', conversationId: 'cvold', direction: 'OUT', author: 'AGENT',
      content: 'respuesta tardía', deliveryStatus: 'QUEUED', createdAt: new Date(),
    });

    const res = await ctx.twilio.processOutbound({ messageId: 'mout' });
    expect((res as any).failed).toBe('fuera de ventana');
    expect(ctx.db.message.find((m: any) => m.id === 'mout')!.deliveryStatus).toBe('FAILED');
    expect(ctx.db.conversation.find((c: any) => c.id === 'cvold')!.needsAttention).toBe(true);
  });
});
