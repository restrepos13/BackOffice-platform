/**
 * Pruebas del motor conversacional (Fase 2 — Nexus/catering).
 * Escenarios exigidos por el alcance: pedido simple, cambios a mitad de camino,
 * cliente que pregunta y no compra, cliente recurrente, información
 * contradictoria (escala) y caso de escalamiento explícito. Más: validación de
 * formato con reintento, handoff por palabra clave, tokens registrados,
 * humanización y reglas de agenda.
 */
import {
  EngineService,
  humanizeDelays,
  resolveEffective,
  validateDelivery,
} from '../src/modules/engine.module';
import { AiChatOptions, AiChatResult, AiProvider, validateEngineOutput } from '../src/ai/types';
import { createMockPrisma } from './helpers/mock-prisma';

/* ─── Proveedor de IA guionado ───────────────────────────────────────── */

class FakeProvider implements AiProvider {
  calls: AiChatOptions[] = [];
  private queue: string[] = [];

  script(...outputs: Array<object | string>) {
    this.queue.push(
      ...outputs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))),
    );
  }

  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    this.calls.push(opts);
    const content = this.queue.shift();
    if (content === undefined) throw new Error('FakeProvider sin guion');
    return { content, inputTokens: 900, outputTokens: 120, model: opts.model };
  }

  async transcribe(): Promise<{ text: string }> {
    return { text: 'transcripción de prueba' };
  }
}

/* ─── Fixture del tenant de catering ─────────────────────────────────── */

function nextDeliveryDate(): Date {
  // Próximo día hábil (lun-sáb) a las 11:30 con más de 18 h de anticipación
  const d = new Date();
  d.setDate(d.getDate() + 2);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  d.setHours(11, 30, 0, 0);
  return d;
}

function setup() {
  const { prisma, db } = createMockPrisma();
  const provider = new FakeProvider();
  const audit = { log: jest.fn(async () => undefined) };
  const engine = new EngineService(prisma as any, provider, audit as any);

  db.company.push({
    id: 'co1', name: 'Catering Test', slug: 'catering-test',
    timezone: 'America/Bogota', deepinfraApiKey: 'di_test_key',
    orderConfigJson: JSON.stringify({
      schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' },
      minLeadHours: 18, aiConfidenceThreshold: 0.8,
    }),
  });
  db.bot.push({
    id: 'bot1', companyId: 'co1', status: 'ACTIVE',
    systemPrompt: 'Atiendes el WhatsApp del catering.',
    personalityJson: JSON.stringify({ tone: 'es-CO informal profesional' }),
    salesJson: '{}', model: 'meta-llama/Llama-3.3-70B-Instruct',
    temperature: 0.7, replyDelayMinSec: 2, replyDelayMaxSec: 8,
    typingSimulation: true, handoffKeywords: 'gerente, reclamo',
    welcomeMessage: null,
  });
  db.integration.push({
    id: 'line1', companyId: 'co1', botId: 'bot1', type: 'WHATSAPP',
    promptMode: 'INHERIT', overridePersonalityJson: '{}', overrideSalesJson: '{}',
  });
  db.customer.push({
    id: 'cust1', companyId: 'co1', name: 'Constructora Test',
    addressesJson: JSON.stringify([
      { label: 'Obra Salitre', address: 'Av. 68 # 24-50', city: 'Bogotá' },
    ]),
    notes: 'Almuerzan 12:00 en punto.',
  });
  db.contact.push({
    id: 'ct1', companyId: 'co1', customerId: 'cust1',
    name: 'Marta Ruiz', phone: '+57 310 555 0101',
  });
  db.conversation.push({
    id: 'cv1', companyId: 'co1', contactId: 'ct1', integrationId: 'line1',
    botId: 'bot1', channel: 'WHATSAPP', status: 'OPEN',
    botPaused: false, needsAttention: false, aiStateJson: '{}',
  });
  db.product.push(
    {
      id: 'p1', companyId: 'co1', name: 'Almuerzo ejecutivo', unit: 'porción',
      category: 'Almuerzos', presentationsJson: '[]', productionAreaId: 'area-cocina',
      active: true, deletedAt: null, description: null,
    },
    {
      id: 'p2', companyId: 'co1', name: 'Bandeja de frutas', unit: 'bandeja',
      category: 'Complementos', presentationsJson: '[]', productionAreaId: 'area-cocina',
      active: true, deletedAt: null, description: null,
    },
  );
  db.aiModel.push({
    id: 'm1', modelId: 'meta-llama/Llama-3.3-70B-Instruct',
    inputCostPerMTok: 0.23, outputCostPerMTok: 0.4,
  });

  const inbound = (content: string) =>
    db.message.push({
      id: `in_${db.message.length}`, conversationId: 'cv1', direction: 'IN',
      author: 'CONTACT', content, type: 'TEXT', createdAt: new Date(),
    });

  return { engine, provider, audit, db, inbound };
}

const okOutput = (extra: object) => ({
  reply: ['Listo, te confirmo.'],
  state: 'tomando_pedido',
  action: 'none',
  order: null,
  confidence: 0.95,
  escalationReason: null,
  missingFields: [],
  ...extra,
});

/* ─── Escenarios de conversación ─────────────────────────────────────── */

describe('Motor conversacional', () => {
  test('pedido simple: borrador → confirmación explícita → confirmado con trazabilidad', async () => {
    const { engine, provider, db, inbound } = setup();
    const deliveryISO = nextDeliveryDate().toISOString();

    // Turno 1: pedido completo → resumen y espera de confirmación
    inbound('Hola! Necesito 45 almuerzos para la obra Salitre');
    provider.script(okOutput({
      reply: ['De una, Marta.', 'Serían 45 almuerzos ejecutivos para la obra Salitre. ¿Confirmas?'],
      state: 'esperando_confirmacion',
      action: 'request_confirmation',
      order: {
        deliveryAtISO: deliveryISO,
        addressLabel: 'Obra Salitre',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 45, unit: 'porción' }],
      },
    }));
    const turn1 = await engine.processConversation('cv1');
    expect(turn1?.escalated).toBe(false);
    expect(turn1?.orderStatus).toBe('borrador');
    const draft = db.order[0];
    expect(draft.status).toBe('borrador');
    expect(draft.takenByType).toBe('IA');
    const items = db.orderItem.filter((i) => i.orderId === draft.id);
    expect(items).toHaveLength(1);
    expect(items[0].productId).toBe('p1'); // mapeado al catálogo
    expect(items[0].productionAreaId).toBe('area-cocina'); // área asignada
    expect(JSON.parse(draft.deliveryAddressJson).label).toBe('Obra Salitre');
    // sin confirmación explícita NO se confirma
    expect(db.orderStatusHistory.map((h) => h.toStatus)).toEqual(['borrador']);

    // Turno 2: el cliente dice que sí → confirmado
    inbound('Sí, confirmado');
    provider.script(okOutput({
      reply: ['¡Listo! Queda agendado.'],
      state: 'cerrado',
      action: 'confirm_order',
      order: {
        deliveryAtISO: deliveryISO,
        addressLabel: 'Obra Salitre',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 45 }],
      },
    }));
    const turn2 = await engine.processConversation('cv1');
    expect(turn2?.orderStatus).toBe('confirmado');
    const history = db.orderStatusHistory.map((h) => h.toStatus);
    expect(history).toEqual(['borrador', 'confirmado']);
    expect(db.orderStatusHistory[1].authorType).toBe('IA');
    expect(db.orderStatusHistory[1].reason).toContain('confirmó');
  });

  test('cambios a mitad de camino: el borrador se reemplaza completo', async () => {
    const { engine, provider, db, inbound } = setup();
    const deliveryISO = nextDeliveryDate().toISOString();

    inbound('30 almuerzos para el jueves');
    provider.script(okOutput({
      action: 'update_draft',
      state: 'completando_datos',
      order: {
        deliveryAtISO: deliveryISO, addressLabel: 'Obra Salitre',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 30 }],
      },
    }));
    await engine.processConversation('cv1');

    inbound('Mejor que sean 40 y agrégame 2 bandejas de frutas');
    provider.script(okOutput({
      action: 'update_draft',
      state: 'esperando_confirmacion',
      order: {
        deliveryAtISO: deliveryISO, addressLabel: 'Obra Salitre',
        items: [
          { productName: 'Almuerzo ejecutivo', quantity: 40 },
          { productName: 'Bandeja de frutas', quantity: 2 },
        ],
      },
    }));
    await engine.processConversation('cv1');

    expect(db.order).toHaveLength(1); // mismo borrador, no duplica
    const items = db.orderItem.filter((i) => i.orderId === db.order[0].id);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.productId === 'p1')?.quantity).toBe(40);
    expect(items.find((i) => i.productId === 'p2')?.quantity).toBe(2);
  });

  test('cliente que pregunta y no compra: cero pedidos, respuesta natural', async () => {
    const { engine, provider, db, inbound } = setup();
    inbound('¿Hasta qué hora entregan los sábados?');
    provider.script(okOutput({
      reply: ['Los sábados entregamos hasta las 4 de la tarde.'],
      state: 'identificando',
      action: 'none',
    }));
    const result = await engine.processConversation('cv1');
    expect(db.order).toHaveLength(0);
    expect(result?.escalated).toBe(false);
    const bot = db.message.filter((m) => m.author === 'BOT');
    expect(bot).toHaveLength(1);
  });

  test('cliente recurrente: el contexto incluye sus pedidos anteriores', async () => {
    const { engine, provider, db, inbound } = setup();
    // Pedido histórico: 45 almuerzos entregados
    db.order.push({
      id: 'old1', companyId: 'co1', customerId: 'cust1', contactId: 'ct1',
      status: 'entregado', deliveryAt: new Date(Date.now() - 30 * 86400000),
      deliveryAddressJson: JSON.stringify({ label: 'Obra Salitre', address: 'Av. 68' }),
      deletedAt: null, createdAt: new Date(Date.now() - 31 * 86400000),
    });
    db.orderItem.push({
      id: 'oldi1', companyId: 'co1', orderId: 'old1',
      productName: 'Almuerzo ejecutivo', quantity: 45, presentation: null,
    });

    inbound('Lo mismo del mes pasado pero para 40');
    provider.script(okOutput({
      action: 'update_draft',
      state: 'esperando_confirmacion',
      order: {
        deliveryAtISO: nextDeliveryDate().toISOString(),
        addressLabel: 'Obra Salitre',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 40 }],
      },
    }));
    await engine.processConversation('cv1');

    // El modelo recibió el historial (para poder resolver "lo mismo del mes pasado")
    const systemPrompt = provider.calls[0].messages[0].content;
    expect(systemPrompt).toContain('PEDIDOS ANTERIORES');
    expect(systemPrompt).toContain('45 × Almuerzo ejecutivo');
    expect(systemPrompt).toContain('Obra Salitre');
    // Y el nuevo borrador quedó con 40
    const draft = db.order.find((o) => o.status === 'borrador');
    const items = db.orderItem.filter((i) => i.orderId === draft!.id);
    expect(items[0].quantity).toBe(40);
  });

  test('información contradictoria: confianza < umbral → escala con motivo', async () => {
    const { engine, provider, audit, db, inbound } = setup();
    inbound('Para mañana en la sede norte… no, mejor donde siempre, pero doble… o lo de la vez pasada');
    provider.script(okOutput({
      reply: ['Dame un momento y lo reviso con el equipo.'],
      state: 'escalado',
      action: 'update_draft',
      confidence: 0.4, // por debajo del umbral 0.8
      order: null,
    }));
    const result = await engine.processConversation('cv1');
    expect(result?.escalated).toBe(true);
    expect(result?.escalationReason).toContain('0.40');
    const conversation = db.conversation[0];
    expect(conversation.needsAttention).toBe(true);
    expect(conversation.botPaused).toBe(true); // la IA se detiene hasta que retome una persona
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'engine.escalate' }),
    );
  });

  test('escalamiento explícito del modelo: queda registrado con su motivo', async () => {
    const { engine, provider, audit, inbound } = setup();
    inbound('Necesito 500 vacas enteras para pasado mañana');
    provider.script(okOutput({
      reply: ['Eso lo tengo que validar con el equipo, ya te digo.'],
      state: 'escalado',
      action: 'escalate',
      escalationReason: 'Solicitud fuera de catálogo y volumen inusual',
    }));
    const result = await engine.processConversation('cv1');
    expect(result?.escalated).toBe(true);
    expect(result?.escalationReason).toBe('Solicitud fuera de catálogo y volumen inusual');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'engine.escalate',
        detail: 'Solicitud fuera de catálogo y volumen inusual',
      }),
    );
  });

  test('salida inválida: un reintento con corrección y después escala', async () => {
    const { engine, provider, inbound } = setup();
    inbound('Hola');
    provider.script('esto no es JSON', '{"reply": []}'); // dos salidas inválidas
    const result = await engine.processConversation('cv1');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].messages.at(-1)?.content).toContain('no cumplió el formato');
    expect(result?.escalated).toBe(true);
    expect(result?.escalationReason).toContain('formato');
  });

  test('handoff por palabra clave: escala sin llamar al modelo', async () => {
    const { engine, provider, inbound } = setup();
    inbound('Quiero hablar con el gerente por favor');
    const result = await engine.processConversation('cv1');
    expect(result?.escalated).toBe(true);
    expect(result?.escalationReason).toContain('gerente');
    expect(provider.calls).toHaveLength(0); // ni un token gastado
  });

  test('modo humano (botPaused): la IA no responde', async () => {
    const { engine, provider, db, inbound } = setup();
    db.conversation[0].botPaused = true;
    inbound('Hola?');
    const result = await engine.processConversation('cv1');
    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  test('tokens registrados en UsageLog con costo del catálogo', async () => {
    const { engine, provider, db, inbound } = setup();
    inbound('Hola');
    provider.script(okOutput({ state: 'saludo' }));
    await engine.processConversation('cv1');
    expect(db.aiUsageEvent).toHaveLength(1);
    const event = db.aiUsageEvent[0];
    expect(event.inputTokens).toBe(900);
    expect(event.outputTokens).toBe(120);
    // (900×0.23 + 120×0.4) / 1M
    expect(event.costUsd).toBeCloseTo(0.000255, 6);
    expect(event.companyId).toBe('co1');
    expect(event.integrationId).toBe('line1');
  });

  test('confirmación bloqueada por el motor si viola reglas de agenda', async () => {
    const { engine, provider, db, inbound } = setup();
    const sunday = new Date();
    sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7 || 7)); // próximo domingo
    sunday.setHours(11, 0, 0, 0);

    inbound('Confírmame 20 almuerzos para el domingo');
    provider.script(okOutput({
      state: 'cerrado',
      action: 'confirm_order',
      order: {
        deliveryAtISO: sunday.toISOString(),
        addressLabel: 'Obra Salitre',
        items: [{ productName: 'Almuerzo ejecutivo', quantity: 20 }],
      },
    }));
    const result = await engine.processConversation('cv1');
    expect(result?.orderStatus).toBe('borrador'); // NO se confirmó
    expect(db.orderStatusHistory.map((h) => h.toStatus)).toEqual(['borrador']);
  });
});

/* ─── Unidades puras ─────────────────────────────────────────────────── */

describe('validateEngineOutput', () => {
  test('acepta salida válida', () => {
    const result = validateEngineOutput({
      reply: ['hola'], state: 'saludo', action: 'none',
      order: null, confidence: 0.9, escalationReason: null, missingFields: [],
    });
    expect(result.ok).toBe(true);
  });
  test('rechaza reply vacío, estado inválido y confianza fuera de rango', () => {
    const result = validateEngineOutput({
      reply: [], state: 'volando', action: 'none', order: null, confidence: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
  test('rechaza ítems sin producto o cantidad inválida', () => {
    const result = validateEngineOutput({
      reply: ['ok'], state: 'tomando_pedido', action: 'update_draft',
      order: { items: [{ productName: '', quantity: -2 }] }, confidence: 0.9,
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateDelivery (reglas de agenda)', () => {
  const cfg = {
    schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' },
    minLeadHours: 18,
  };
  const monday = (hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); // próximo lunes
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  test('día sin entregas → rechazado', () => {
    const sunday = new Date(monday(10).getTime() - 86400000);
    expect(validateDelivery(cfg, sunday).ok).toBe(false);
  });
  test('fuera de horario → rechazado', () => {
    expect(validateDelivery(cfg, monday(20)).ok).toBe(false);
  });
  test('sin anticipación mínima → rechazado', () => {
    const inTwoHours = new Date(Date.now() + 2 * 3600000);
    const result = validateDelivery({ ...cfg, schedule: undefined }, inTwoHours);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('anticipación');
  });
  test('fecha válida → aceptada', () => {
    expect(validateDelivery(cfg, monday(11), new Date()).ok).toBe(true);
  });
});

describe('humanizeDelays', () => {
  beforeEach(() => jest.spyOn(Math, 'random').mockReturnValue(0.5));
  afterEach(() => jest.restoreAllMocks());

  test('delays dentro de los límites y proporcionales al largo', () => {
    const plan = humanizeDelays(['ok', 'x'.repeat(400)], 2, 10);
    for (const part of plan) {
      expect(part.delayMs).toBeGreaterThanOrEqual(2000);
      expect(part.delayMs).toBeLessThanOrEqual(10000);
    }
    expect(plan[1].delayMs).toBeGreaterThan(plan[0].delayMs);
  });
});

describe('resolveEffective (línea CUSTOM pisa al bot)', () => {
  const bot = {
    systemPrompt: 'prompt del bot', personalityJson: '{"tone":"bot"}',
    salesJson: '{}', model: 'modelo-bot', temperature: 0.7,
    replyDelayMinSec: 3, replyDelayMaxSec: 12, handoffKeywords: 'x',
    welcomeMessage: 'hola', typingSimulation: true,
  };
  test('INHERIT usa el bot', () => {
    const effective = resolveEffective(bot, { promptMode: 'INHERIT' });
    expect(effective.systemPrompt).toBe('prompt del bot');
    expect(effective.model).toBe('modelo-bot');
  });
  test('CUSTOM pisa campo a campo', () => {
    const effective = resolveEffective(bot, {
      promptMode: 'CUSTOM', overridePrompt: 'prompt de la línea',
      overridePersonalityJson: '{"tone":"línea"}', overrideSalesJson: '{}',
      overrideModel: 'modelo-línea', overrideTemperature: 0.3,
      overrideReplyDelayMinSec: 10, overrideReplyDelayMaxSec: 60,
    });
    expect(effective.systemPrompt).toBe('prompt de la línea');
    expect(effective.personality.tone).toBe('línea');
    expect(effective.model).toBe('modelo-línea');
    expect(effective.delayMinSec).toBe(10);
  });
});
