/**
 * Agente con herramientas + domicilios + IA revendida.
 * Cubre: protocolo del agente, permisos por herramienta, flujo completo de un
 * domicilio por WhatsApp (menú → ubicación → resumen → confirmación con link),
 * escalamientos, cálculo de envío, topes de IA, seguimiento público sin fugas
 * y el rol de domiciliario con mínimo privilegio.
 */
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { EngineService } from '../src/modules/engine.module';
import { AgentService } from '../src/ai/agent/agent.service';
import { validateAgentStep } from '../src/ai/agent/protocol';
import { AGENT_PRESETS, enabledTools, matchProduct, sanitizeToolsConfig } from '../src/ai/agent/tools';
import { AiProviderError } from '../src/ai/deepinfra.provider';
import {
  AiSession,
  recordAiUsage,
  computeAiCredits,
  creditAiLot,
  maskCompanyKey,
  readCompanyKey,
  resolveAiAccess,
  storeCompanyKey,
} from '../src/ai/ai-access';
import { isLatLng, quoteDelivery, roadKm } from '../src/common/geo';
import { parseSharedLocation } from '../src/modules/twilio.module';
import { DeliveryService } from '../src/modules/delivery.module';
import { RolesGuard } from '../src/auth/roles.guard';
import { AiChatOptions, AiChatResult, AiProvider } from '../src/ai/types';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

class FakeProvider implements AiProvider {
  calls: AiChatOptions[] = [];
  private queue: string[] = [];
  script(...outputs: Array<object | string>) {
    this.queue.push(...outputs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))));
  }
  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    this.calls.push(opts);
    const content = this.queue.shift();
    if (content === undefined) throw new Error('FakeProvider sin guion');
    return { content, inputTokens: 1200, outputTokens: 90, model: opts.model };
  }
  async transcribe(): Promise<{ text: string }> {
    return { text: '' };
  }
}

const ORIGIN = { lat: 6.2442, lng: -75.5812 }; // Medellín centro
const NEAR = { lat: 6.2518, lng: -75.5636 }; // ~2 km
const FAR = { lat: 6.3389, lng: -75.5579 }; // ~11 km

function setup(opts: { preset?: keyof typeof AGENT_PRESETS; billing?: 'BYOK' | 'PLATFORM' } = {}) {
  const { prisma, db } = createMockPrisma();
  const provider = new FakeProvider();
  const audit = { log: jest.fn(async () => undefined) };
  const agent = new AgentService(prisma as any, provider);
  const engine = new EngineService(prisma as any, provider, audit as any, undefined, undefined, undefined, agent);

  db.company.push({
    id: 'co1', name: 'Almuerzos La Esquina', slug: 'la-esquina', city: 'Medellín', country: 'Colombia',
    timezone: 'America/Bogota', currency: 'COP', deepinfraApiKey: 'di_byok_key',
    aiBillingMode: opts.billing ?? 'BYOK', aiSpendCapUsd: null, planId: null,
    orderConfigJson: JSON.stringify({
      aiConfidenceThreshold: 0.7,
      delivery: { enabled: true, origin: ORIGIN, maxKm: 8, baseFee: 3000, perKm: 1000, prepMinutes: 20, avgSpeedKmh: 24 },
      knowledgeBase: [{ question: '¿Aceptan Nequi?', answer: 'Sí, Nequi y efectivo.' }],
    }),
    waTemplatesJson: '[]',
  });
  db.bot.push({
    id: 'bot1', companyId: 'co1', status: 'ACTIVE', engineMode: 'AGENT',
    toolsJson: JSON.stringify(AGENT_PRESETS[opts.preset ?? 'domicilios'].tools),
    systemPrompt: 'Atiendes el WhatsApp de Almuerzos La Esquina.',
    personalityJson: '{}', salesJson: '{}', model: 'meta-llama/Llama-3.3-70B-Instruct',
    temperature: 0.5, replyDelayMinSec: 1, replyDelayMaxSec: 3, typingSimulation: false,
    handoffKeywords: 'gerente', welcomeMessage: null,
  });
  db.integration.push({
    id: 'line1', companyId: 'co1', botId: 'bot1', type: 'WHATSAPP',
    promptMode: 'INHERIT', overridePersonalityJson: '{}', overrideSalesJson: '{}',
  });
  db.product.push(
    { id: 'p1', companyId: 'co1', name: 'Almuerzo ejecutivo', category: 'Almuerzos', unit: 'unidad', price: 18000, presentationsJson: '[]', active: true, deletedAt: null },
    { id: 'p2', companyId: 'co1', name: 'Jugo natural', category: 'Bebidas', unit: 'unidad', price: 5000, presentationsJson: '[]', active: true, deletedAt: null },
  );
  db.aiModel.push({ modelId: 'meta-llama/Llama-3.3-70B-Instruct', inputCostPerMTok: 0.23, outputCostPerMTok: 0.4 });
  db.contact.push({ id: 'ct1', companyId: 'co1', name: 'Laura', phone: '+573001112233', stage: 'CURIOSO', customerId: null });
  db.conversation.push({
    id: 'conv1', companyId: 'co1', contactId: 'ct1', integrationId: 'line1', botId: 'bot1',
    channel: 'SIMULATOR', status: 'OPEN', botPaused: false, needsAttention: false,
    aiStateJson: '{}', lastMessageAt: new Date(),
  });
  const say = (content: string, extra: Record<string, any> = {}) =>
    db.message.push({
      id: `m${db.message.length + 1}`, conversationId: 'conv1', direction: 'IN', author: 'CONTACT',
      content, type: 'TEXT', createdAt: new Date(Date.now() + db.message.length), ...extra,
    });
  return { prisma, db, provider, engine, agent, audit, say };
}

/* ═══ Geo y envío ═══ */

describe('geo: cobertura, costo y tiempo del domicilio', () => {
  const cfg = { enabled: true, origin: ORIGIN, maxKm: 8, baseFee: 3000, perKm: 1000, prepMinutes: 20, avgSpeedKmh: 24 };

  it('cotiza dentro de cobertura con costo redondeado a la centena', () => {
    const q = quoteDelivery(cfg, NEAR, 30000, 'COP');
    expect(q.covered).toBe(true);
    expect(q.km).toBeGreaterThan(1.5);
    expect(q.km).toBeLessThan(4);
    expect(q.fee! % 100).toBe(0);
    expect(q.etaMinutes).toBeGreaterThan(20);
  });

  it('rechaza fuera de cobertura con el motivo', () => {
    const q = quoteDelivery(cfg, FAR, 0);
    expect(q.covered).toBe(false);
    expect(q.reason).toMatch(/cobertura/);
  });

  it('envío gratis desde el subtotal configurado', () => {
    const q = quoteDelivery({ ...cfg, freeFromSubtotal: 50000 }, NEAR, 60000);
    expect(q.fee).toBe(0);
  });

  it('sin domicilios u origen configurado no inventa nada', () => {
    expect(quoteDelivery({ enabled: false }, NEAR).covered).toBe(false);
    expect(quoteDelivery({ enabled: true }, NEAR).reason).toMatch(/punto de despacho/);
  });

  it('isLatLng descarta 0,0 y valores fuera de rango', () => {
    expect(isLatLng({ lat: 0, lng: 0 })).toBe(false);
    expect(isLatLng({ lat: 91, lng: 10 })).toBe(false);
    expect(isLatLng({ lat: '6.2', lng: '-75.5' })).toBe(true);
    expect(roadKm(ORIGIN, ORIGIN)).toBe(0);
  });

  it('ubicación compartida por WhatsApp (Twilio) se reconoce', () => {
    const loc = parseSharedLocation({ Latitude: '6.25', Longitude: '-75.56', Address: 'Cra 43A #1-50' });
    expect(loc).toMatchObject({ lat: 6.25, lng: -75.56 });
    expect(loc!.content).toMatch(/^\[ubicación\] .*Cra 43A/);
    expect(parseSharedLocation({ Body: 'hola' })).toBeNull();
  });
});

/* ═══ Protocolo y permisos ═══ */

describe('agente: protocolo y permisos', () => {
  it('valida tool_calls y respuestas finales', () => {
    expect(validateAgentStep({ tool_calls: [{ name: 'ver_menu', args: {} }] })).toMatchObject({ ok: true, step: { kind: 'tools' } });
    expect(validateAgentStep({ reply: ['Hola'], confidence: 0.9, state: 'saludo' })).toMatchObject({ ok: true, step: { kind: 'reply' } });
    expect(validateAgentStep({ reply: [], confidence: 0.9 }).ok).toBe(false);
    expect(validateAgentStep({ reply: ['x'], confidence: 2 }).ok).toBe(false);
    expect(validateAgentStep({ tool_calls: [1, 2, 3, 4].map(() => ({ name: 'ver_menu' })) }).ok).toBe(false);
    expect(validateAgentStep('texto').ok).toBe(false);
  });

  it('sanea la config: herramienta de lectura nunca queda con escritura y se ignoran desconocidas', () => {
    const out = sanitizeToolsConfig([
      { tool: 'ver_menu', access: 'write' },
      { tool: 'armar_pedido', access: 'write' },
      { tool: 'borrar_todo', access: 'write' },
      { tool: 'armar_pedido', access: 'read' },
    ]);
    expect(out).toEqual([
      { tool: 'ver_menu', access: 'read' },
      { tool: 'armar_pedido', access: 'write' },
    ]);
    expect(enabledTools('[]').has('pasar_a_humano')).toBe(true);
  });

  it('el preset "solo consultas" no incluye herramientas que modifican', () => {
    expect(AGENT_PRESETS.solo_consultas.tools.every((t) => t.access === 'read')).toBe(true);
    expect(AGENT_PRESETS.solo_consultas.tools.map((t) => t.tool)).not.toContain('armar_pedido');
  });

  it('matchProduct tolera tildes y nombres parciales', () => {
    const products = [{ name: 'Almuerzo ejecutivo' }, { name: 'Jugo natural' }];
    expect(matchProduct(products, 'almuerzo EJECUTIVO')?.name).toBe('Almuerzo ejecutivo');
    expect(matchProduct(products, 'jugo')?.name).toBe('Jugo natural');
    expect(matchProduct(products, 'pizza')).toBeNull();
  });
});

/* ═══ Flujo completo de un domicilio por WhatsApp ═══ */

describe('agente: domicilio de punta a punta', () => {
  it('menú → ubicación → resumen con envío → confirmación con link de seguimiento', async () => {
    const { db, provider, engine, say } = setup();
    say('Hola, ¿qué tienen de almuerzo hoy?');
    provider.script(
      { tool_calls: [{ name: 'ver_menu', args: {} }] },
      { reply: ['Hoy tenemos almuerzo ejecutivo a $18.000 y jugo natural a $5.000'], confidence: 0.92, state: 'consultando' },
    );
    const r1 = await engine.processConversation('conv1');
    expect(r1!.escalated).toBe(false);
    // el resultado de la herramienta volvió al modelo con precios reales
    const toolResult = provider.calls[1].messages.find((m) => String(m.content).startsWith('[RESULTADO ver_menu]'));
    expect(toolResult!.content).toContain('18.000');

    // el cliente pide y comparte su ubicación
    say('Quiero 2 almuerzos y un jugo');
    say('[ubicación] Mi casa', { type: 'LOCATION', latitude: NEAR.lat, longitude: NEAR.lng });
    provider.script(
      {
        tool_calls: [{
          name: 'armar_pedido',
          args: { items: [{ producto: 'almuerzo ejecutivo', cantidad: 2 }, { producto: 'jugo', cantidad: 1 }], entrega: 'lo antes posible', usar_ubicacion_compartida: true },
        }],
      },
      { reply: ['Listo: 2 almuerzos + 1 jugo, total con envío. ¿Te lo confirmo?'], confidence: 0.9, state: 'esperando_confirmacion' },
    );
    const r2 = await engine.processConversation('conv1');
    expect(r2!.state).toBe('esperando_confirmacion');
    const draft = db.order.find((o) => o.conversationId === 'conv1')!;
    expect(draft.status).toBe('borrador');
    expect(draft.subtotal).toBe(41000);
    expect(draft.deliveryFee).toBeGreaterThan(3000);
    expect(draft.total).toBe(41000 + draft.deliveryFee);
    expect(JSON.parse(draft.deliveryAddressJson)).toMatchObject({ lat: NEAR.lat, lng: NEAR.lng });
    expect(db.orderItem.filter((i) => i.orderId === draft.id)).toHaveLength(2);
    // se creó la ficha del cliente desde el contacto
    expect(db.contact[0].customerId).toBeTruthy();

    // el cliente confirma
    say('Sí, confírmalo');
    provider.script(
      { tool_calls: [{ name: 'confirmar_pedido', args: { cliente_confirmo: true } }] },
      { reply: ['¡Confirmado! Sigue tu pedido aquí'], confidence: 0.95, state: 'confirmado' },
    );
    await engine.processConversation('conv1');
    const confirmed = db.order.find((o) => o.id === draft.id)!;
    expect(confirmed.status).toBe('confirmado');
    expect(confirmed.trackingToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(db.contact[0].stage).toBe('CLIENTE');
    const confirmResult = provider.calls.at(-1)!.messages.find((m) => String(m.content).startsWith('[RESULTADO confirmar_pedido]'));
    expect(confirmResult!.content).toContain(`/t/${confirmed.trackingToken}`);

    // cada llamada al modelo quedó registrada como BYOK y ligada a la conversación
    expect(db.aiUsageEvent.length).toBe(provider.calls.length);
    expect(db.aiUsageEvent.every((e) => e.billedTo === 'BYOK' && e.conversationId === 'conv1')).toBe(true);
  });

  it('no inventa productos: si no existe, la herramienta lo devuelve como error y no crea pedido', async () => {
    const { db, provider, engine, say } = setup();
    say('Quiero una pizza hawaiana');
    provider.script(
      { tool_calls: [{ name: 'armar_pedido', args: { items: [{ producto: 'pizza hawaiana', cantidad: 1 }], direccion: 'Calle 10 # 40-20' } }] },
      { reply: ['Uy, pizza no manejamos. Hoy hay almuerzo ejecutivo y jugos'], confidence: 0.9, state: 'consultando' },
    );
    await engine.processConversation('conv1');
    expect(db.order).toHaveLength(0);
    const result = provider.calls[1].messages.find((m) => String(m.content).startsWith('[RESULTADO armar_pedido]'));
    expect(result!.content).toContain('no_encontrados');
  });

  it('fuera de cobertura: no arma el pedido', async () => {
    const { db, provider, engine, say } = setup();
    say('[ubicación] Bello', { type: 'LOCATION', latitude: FAR.lat, longitude: FAR.lng });
    provider.script(
      { tool_calls: [{ name: 'armar_pedido', args: { items: [{ producto: 'almuerzo', cantidad: 1 }], usar_ubicacion_compartida: true } }] },
      { reply: ['Qué pena, hasta allá no llegamos'], confidence: 0.85, state: 'cerrado' },
    );
    await engine.processConversation('conv1');
    expect(db.order).toHaveLength(0);
  });

  it('confirmar sin un SÍ explícito se bloquea', async () => {
    const { db, provider, engine, say } = setup();
    say('2 almuerzos a la Calle 10');
    db.order.push({
      id: 'o_draft', companyId: 'co1', customerId: 'c1', contactId: 'ct1', conversationId: 'conv1',
      status: 'borrador', deliveryAt: new Date(), deletedAt: null, createdAt: new Date(),
      deliveryAddressJson: JSON.stringify({ address: 'Calle 10', lat: NEAR.lat, lng: NEAR.lng }),
    });
    db.orderItem.push({ id: 'oi1', orderId: 'o_draft', productName: 'Almuerzo ejecutivo', quantity: 2 });
    provider.script(
      { tool_calls: [{ name: 'confirmar_pedido', args: { cliente_confirmo: false } }] },
      { reply: ['¿Te lo confirmo así?'], confidence: 0.9, state: 'esperando_confirmacion' },
    );
    await engine.processConversation('conv1');
    expect(db.order[0].status).toBe('borrador');
  });

  it('sin permiso de escritura (solo consultas) la herramienta se niega y el agente sigue', async () => {
    const { db, provider, engine, say } = setup({ preset: 'solo_consultas' });
    say('Pídeme 1 almuerzo');
    provider.script(
      { tool_calls: [{ name: 'armar_pedido', args: { items: [{ producto: 'almuerzo', cantidad: 1 }] } }] },
      { reply: ['Para pedidos te comunico con el equipo'], confidence: 0.9, state: 'consultando' },
    );
    await engine.processConversation('conv1');
    expect(db.order).toHaveLength(0);
    const denied = provider.calls[1].messages.find((m) => String(m.content).startsWith('[RESULTADO armar_pedido]'));
    expect(denied!.content).toContain('No tienes permiso');
  });

  it('pasar_a_humano escala, pausa la IA y deja el mensaje al cliente', async () => {
    const { db, provider, engine, say, audit } = setup();
    say('El almuerzo de ayer llegó frío, quiero un reembolso');
    provider.script({
      tool_calls: [{ name: 'pasar_a_humano', args: { motivo: 'Reclamo por pedido frío', mensaje_al_cliente: 'Lo siento mucho, ya te atiende alguien del equipo.' } }],
    });
    const r = await engine.processConversation('conv1');
    expect(r!.escalated).toBe(true);
    expect(db.conversation[0]).toMatchObject({ botPaused: true, needsAttention: true });
    expect(db.message.at(-1)!.content).toContain('Lo siento mucho');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'engine.escalate', detail: 'Reclamo por pedido frío' }));
  });

  it('confianza baja → escala; salida inválida dos veces → escala', async () => {
    const a = setup();
    a.say('mmm no sé');
    a.provider.script({ reply: ['¿Qué necesitas?'], confidence: 0.3, state: 'saludo' });
    expect((await a.engine.processConversation('conv1'))!.escalated).toBe(true);

    const b = setup();
    b.say('hola');
    b.provider.script('no soy json', '{"foo": 1}');
    const r = await b.engine.processConversation('conv1');
    expect(r!.escalated).toBe(true);
    expect(r!.escalationReason).toMatch(/formato/);
  });

  it('herramienta desconocida no rompe: el modelo recibe el error', async () => {
    const { provider, engine, say } = setup();
    say('hola');
    provider.script(
      { tool_calls: [{ name: 'borrar_base', args: {} }] },
      { reply: ['¡Hola! ¿Qué se te antoja hoy?'], confidence: 0.9, state: 'saludo' },
    );
    const r = await engine.processConversation('conv1');
    expect(r!.escalated).toBe(false);
    expect(provider.calls[1].messages.some((m) => String(m.content).includes('no existe'))).toBe(true);
  });
});

/* ═══ IA revendida: llaves, topes y conteo ═══ */

describe('IA: BYOK cifrada, IA de BackOffice y tope de gasto', () => {
  afterEach(() => { delete process.env.DEEPINFRA_API_KEY; });

  it('la llave BYOK se guarda cifrada, se lee y se enmascara', () => {
    const stored = storeCompanyKey('di_secret_1234')!;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('di_secret');
    expect(readCompanyKey(stored)).toBe('di_secret_1234');
    expect(readCompanyKey('legacy_plain')).toBe('legacy_plain');
    expect(maskCompanyKey(stored)).toBe('••••1234');
    expect(storeCompanyKey('  ')).toBeNull();
  });

  it('BYOK sin llave → NO_KEY; PLATFORM sin llave del servidor → NO_PLATFORM_KEY', async () => {
    const { prisma } = createMockPrisma();
    // Sin DeepInfra ni OpenRouter de plataforma (otras suites pueden cargar el .env real)
    const savedOr = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(await resolveAiAccess(prisma, { aiBillingMode: 'BYOK', deepinfraApiKey: null })).toMatchObject({ ok: false, code: 'NO_KEY' });
    expect(await resolveAiAccess(prisma, { aiBillingMode: 'PLATFORM' })).toMatchObject({ ok: false, code: 'NO_PLATFORM_KEY' });
    process.env.OPENROUTER_API_KEY = 'sk-or-prueba';
    // Solo con OpenRouter la IA de BackOffice sirve para los modelos premium
    const credited = { aiBillingMode: 'PLATFORM', id: 'cx' };
    const res: any = await resolveAiAccess(prisma, credited);
    expect(res.code === 'NO_PLATFORM_KEY').toBe(false);
    if (savedOr) process.env.OPENROUTER_API_KEY = savedOr;
    else delete process.env.OPENROUTER_API_KEY;
  });

  it('PLATFORM: sin saldo prepago ni incluidas → NO_CREDITS; con paquete → disponible', async () => {
    process.env.DEEPINFRA_API_KEY = 'platform_key';
    const { prisma, db } = createMockPrisma();
    const company = { id: 'co1', aiBillingMode: 'PLATFORM', aiSpendCapUsd: null, planId: null, aiIncludedOverride: null };
    db.company.push({ ...company });
    expect(await resolveAiAccess(prisma, company)).toMatchObject({ ok: false, code: 'NO_CREDITS' });
    await creditAiLot(prisma, { companyId: 'co1', conversations: 500, source: 'PURCHASE', paymentRef: 'PKG-1' });
    await creditAiLot(prisma, { companyId: 'co1', conversations: 500, source: 'PURCHASE', paymentRef: 'PKG-1' }); // webhook repetido
    expect(db.aiCreditLot).toHaveLength(1);
    expect(await resolveAiAccess(prisma, company)).toMatchObject({ ok: true, apiKey: 'platform_key', billedTo: 'PLATFORM' });
    const credits = await computeAiCredits(prisma, company);
    expect(credits).toMatchObject({ balance: 500, available: 500, includedLeft: 0 });
  });

  it('PLATFORM: el tope de gasto sigue cortando aunque haya saldo', async () => {
    process.env.DEEPINFRA_API_KEY = 'platform_key';
    const { prisma, db } = createMockPrisma();
    const company = { id: 'co1', aiBillingMode: 'PLATFORM', aiSpendCapUsd: 1, planId: null, aiIncludedOverride: 100 };
    db.aiUsageEvent.push({ companyId: 'co1', billedTo: 'PLATFORM', conversationId: 'x', costUsd: 1.2, createdAt: new Date() });
    expect(await resolveAiAccess(prisma, company)).toMatchObject({ ok: false, code: 'CAP_REACHED' });
  });

  it('con el tope alcanzado el agente no llama al modelo y escala con el motivo', async () => {
    process.env.DEEPINFRA_API_KEY = 'platform_key';
    const { db, provider, engine, say, audit } = setup({ billing: 'PLATFORM' });
    db.company[0].aiSpendCapUsd = 0.01;
    db.aiUsageEvent.push({ companyId: 'co1', billedTo: 'PLATFORM', conversationId: 'old', costUsd: 0.02, createdAt: new Date() });
    say('hola');
    const r = await engine.processConversation('conv1');
    expect(r!.escalated).toBe(true);
    expect(r!.escalationReason).toMatch(/tope mensual/);
    expect(provider.calls).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai.cap_reached' }));
  });

  it('en modo PLATFORM el consumo se registra como PLATFORM', async () => {
    process.env.DEEPINFRA_API_KEY = 'platform_key';
    const { db, provider, engine, say } = setup({ billing: 'PLATFORM' });
    db.company[0].aiIncludedOverride = 100; // conversaciones incluidas en el plan
    say('hola');
    provider.script({ reply: ['¡Hola!'], confidence: 0.9, state: 'saludo' });
    await engine.processConversation('conv1');
    expect(provider.calls[0].apiKey).toBe('platform_key');
    expect(db.aiUsageEvent[0]).toMatchObject({ billedTo: 'PLATFORM', conversationId: 'conv1' });
  });
});

/* ═══ Domiciliario y seguimiento público ═══ */

function deliverySetup() {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const events = { emit: jest.fn() };
  const orders = {
    changeStatus: jest.fn(async (id: string, to: string) => {
      const order = db.order.find((o) => o.id === id)!;
      db.orderStatusHistory.push({ orderId: id, fromStatus: order.status, toStatus: to, createdAt: new Date() });
      order.status = to;
      if (to === 'despachado') order.dispatchedAt = new Date();
      if (to === 'entregado') order.deliveredAt = new Date();
      return order;
    }),
  };
  const service = new DeliveryService(prisma as any, orders as any, audit as any, events as any);
  db.company.push({
    id: 'co1', name: 'La Esquina', brandColor: '#C2410C', logoUrl: null, contactPhone: '+573000000000',
    currency: 'COP', timezone: 'America/Bogota',
    orderConfigJson: JSON.stringify({ delivery: { enabled: true, origin: ORIGIN, avgSpeedKmh: 24 } }),
  });
  db.company.push({ id: 'co2', name: 'Otra', orderConfigJson: '{}' });
  db.user.push(
    { id: 'u_courier', companyId: 'co1', role: 'COMPANY_COURIER', name: 'Carlos Pérez', phone: '+573009998877', onShift: false, active: true, lastLat: null, lastLng: null, lastLocAt: null },
    { id: 'u_courier2', companyId: 'co1', role: 'COMPANY_COURIER', name: 'Ana Gómez', onShift: true, active: true },
    { id: 'u_other', companyId: 'co2', role: 'COMPANY_COURIER', name: 'Ajeno', active: true },
  );
  db.order.push({
    id: 'order_abc123', companyId: 'co1', customerId: 'c1', contactId: 'ct1', status: 'listo',
    deliveryAt: new Date(), deletedAt: null, courierId: 'u_courier', trackingToken: 'tok_publico_seguro_123456',
    deliveryAddressJson: JSON.stringify({ address: 'Calle 10 # 40-20', lat: NEAR.lat, lng: NEAR.lng }),
    subtotal: 36000, deliveryFee: 5000, total: 41000, createdAt: new Date(),
  });
  db.orderItem.push({ id: 'i1', orderId: 'order_abc123', productName: 'Almuerzo ejecutivo', quantity: 2 });
  db.orderStatusHistory.push({ orderId: 'order_abc123', toStatus: 'programado', createdAt: new Date(Date.now() - 3600e3) });
  const courier = { id: 'u_courier', role: 'COMPANY_COURIER', companyId: 'co1', name: 'Carlos Pérez', email: 'c@x.co' } as any;
  return { prisma, db, service, orders, events, courier };
}

describe('domicilios: domiciliario con mínimo privilegio', () => {
  it('sin turno no comparte ubicación; con turno actualiza posición, rastro y ETA', async () => {
    const { db, service, courier, events } = deliverySetup();
    await expect(service.ping(courier, { lat: 6.25, lng: -75.57 })).rejects.toBeInstanceOf(BadRequestException);
    await service.setShift(courier, true);
    await expect(service.ping(courier, { lat: 999, lng: 0 })).rejects.toBeInstanceOf(BadRequestException);

    db.order[0].status = 'despachado';
    const res = await service.ping(courier, { lat: ORIGIN.lat, lng: ORIGIN.lng, accuracy: 12 });
    expect(res.inRoute).toBe(1);
    expect(db.user[0]).toMatchObject({ lastLat: ORIGIN.lat, lastLng: ORIGIN.lng });
    expect(db.courierPing).toHaveLength(1);
    expect(db.order[0].etaAt).toBeInstanceOf(Date);
    expect(events.emit).toHaveBeenCalledWith('co1', expect.objectContaining({ type: 'courier.location' }));
  });

  it('recoger y entregar: solo SUS pedidos y en orden', async () => {
    const { db, service, orders, courier } = deliverySetup();
    const intruder = { ...courier, id: 'u_courier2', name: 'Ana Gómez' };
    await expect(service.pickup(intruder, 'order_abc123')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deliver(courier, 'order_abc123')).rejects.toBeInstanceOf(BadRequestException);

    await service.pickup(courier, 'order_abc123');
    expect(orders.changeStatus).toHaveBeenNthCalledWith(1, 'order_abc123', 'empacado', expect.anything(), expect.any(String));
    expect(orders.changeStatus).toHaveBeenNthCalledWith(2, 'order_abc123', 'despachado', expect.anything(), expect.any(String));
    expect(db.order[0].status).toBe('despachado');

    await service.deliver(courier, 'order_abc123', {
      mimetype: 'image/svg+xml', size: 10, buffer: Buffer.from('<svg/>'),
    } as any).catch((err) => expect(err).toBeInstanceOf(BadRequestException));
    await service.deliver(courier, 'order_abc123');
    expect(db.order[0].status).toBe('entregado');
  });

  it('asignar: solo domiciliarios activos de la MISMA empresa', async () => {
    const { db, service } = deliverySetup();
    const admin = { id: 'adm', role: 'COMPANY_ADMIN', companyId: 'co1', name: 'Admin' } as any;
    await expect(service.assign(admin, 'order_abc123', 'u_other')).rejects.toBeInstanceOf(BadRequestException);
    await service.assign(admin, 'order_abc123', 'u_courier2');
    expect(db.order[0].courierId).toBe('u_courier2');
    const foreignAdmin = { id: 'x', role: 'COMPANY_ADMIN', companyId: 'co2', name: 'X' } as any;
    await expect(service.assign(foreignAdmin, 'order_abc123', null)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('RolesGuard: el domiciliario solo entra a endpoints que lo nombran', () => {
    const make = (required?: string[], url = '/api/delivery/me/route') => {
      const reflector: any = { getAllAndOverride: jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(required) };
      const guard = new RolesGuard(reflector);
      const ctx: any = {
        getHandler: () => ({}), getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => ({ user: { role: 'COMPANY_COURIER' }, url }) }),
      };
      return () => guard.canActivate(ctx);
    };
    expect(make(['COMPANY_COURIER'])()).toBe(true);
    expect(make(undefined, '/api/orders')).toThrow(ForbiddenException);
    expect(make(['COMPANY_ADMIN'], '/api/delivery/board')).toThrow(ForbiddenException);
    expect(make(undefined, '/api/auth/me')()).toBe(true);
  });
});

describe('seguimiento público: lo que ve el cliente final', () => {
  it('muestra marca, línea de tiempo y domiciliario en ruta — sin datos internos', async () => {
    const { db, service, courier } = deliverySetup();
    db.user[0].onShift = true;
    db.user[0].lastLat = ORIGIN.lat;
    db.user[0].lastLng = ORIGIN.lng;
    db.user[0].lastLocAt = new Date();
    await service.pickup(courier, 'order_abc123');

    const view = await service.publicTracking('tok_publico_seguro_123456');
    expect(view.company).toMatchObject({ name: 'La Esquina', brandColor: '#C2410C' });
    expect(view.order).toMatchObject({ code: 'ABC123', status: 'despachado', statusLabel: 'En camino', total: 41000 });
    expect(view.courier).toEqual({ name: 'Carlos' });
    expect(view.map!.courier).toMatchObject({ lat: ORIGIN.lat, lng: ORIGIN.lng });
    expect(view.order.timeline.map((t: any) => [t.key, t.done])).toEqual([
      ['recibido', true], ['preparando', true], ['en_camino', true], ['entregado', false],
    ]);
    const raw = JSON.stringify(view);
    for (const secret of ['order_abc123', 'u_courier', 'co1', '+573009998877', 'c1', 'ct1']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('pasadas 72 h de la entrega oculta el detalle; token inválido → 404', async () => {
    const { db, service } = deliverySetup();
    db.order[0].status = 'entregado';
    db.order[0].deliveredAt = new Date(Date.now() - 80 * 3600e3);
    const view = await service.publicTracking('tok_publico_seguro_123456');
    expect(view.expired).toBe(true);
    expect(view.order.items).toEqual([]);
    expect(view.order.address).toBeNull();
    expect(view.map).toBeNull();
    await expect(service.publicTracking('../../etc')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.publicTracking('tok_inexistente_00000000')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* ═══ IA híbrida: llave propia + IA de BackOffice con respaldo ═══ */

/** Proveedor que rechaza una llave concreta (sin saldo / inválida). */
class RejectingProvider extends FakeProvider {
  constructor(private readonly rejectKey: string, private readonly status = 402) {
    super();
  }
  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    if (opts.apiKey === this.rejectKey) {
      this.calls.push(opts);
      throw new AiProviderError(this.status, `DeepInfra respondió ${this.status}`);
    }
    return super.chat(opts);
  }
}

describe('IA híbrida: la empresa usa su cuenta y BackOffice le vende IA aparte', () => {
  beforeEach(() => { process.env.DEEPINFRA_API_KEY = 'platform_key'; });
  afterEach(() => { delete process.env.DEEPINFRA_API_KEY; });

  it('principal + respaldo según aiHybridPrimary', async () => {
    const { prisma } = createMockPrisma();
    const base = { id: 'co1', aiBillingMode: 'HYBRID', deepinfraApiKey: 'byok_key', aiSpendCapUsd: null, planId: null, aiIncludedOverride: 100 };
    expect(await resolveAiAccess(prisma, { ...base, aiHybridPrimary: 'BYOK' })).toMatchObject({
      ok: true, apiKey: 'byok_key', billedTo: 'BYOK', mode: 'HYBRID',
      fallback: { apiKey: 'platform_key', billedTo: 'PLATFORM' },
    });
    expect(await resolveAiAccess(prisma, { ...base, aiHybridPrimary: 'PLATFORM' })).toMatchObject({
      ok: true, billedTo: 'PLATFORM', fallback: { billedTo: 'BYOK' },
    });
  });

  it('si falta la principal arranca con la otra; si no hay ninguna, NO_AI con los dos motivos', async () => {
    const { prisma, db } = createMockPrisma();
    const noKey = { id: 'co1', aiBillingMode: 'HYBRID', aiHybridPrimary: 'BYOK', deepinfraApiKey: null, aiSpendCapUsd: null, planId: null, aiIncludedOverride: 100 };
    const access = await resolveAiAccess(prisma, noKey);
    expect(access).toMatchObject({ ok: true, billedTo: 'PLATFORM' });
    expect((access as any).fallback).toBeUndefined();

    db.aiUsageEvent.push({ companyId: 'co1', billedTo: 'PLATFORM', conversationId: 'x', costUsd: 5, createdAt: new Date() });
    const denied = await resolveAiAccess(prisma, { ...noKey, aiSpendCapUsd: 1 });
    expect(denied).toMatchObject({ ok: false, code: 'NO_AI' });
    expect((denied as any).reason).toMatch(/llave de DeepInfra/);
    expect((denied as any).reason).toMatch(/tope mensual/);
  });

  it('un asistente vendido aparte (aiSource PLATFORM) usa la IA de BackOffice aunque la empresa sea BYOK', async () => {
    const { prisma } = createMockPrisma();
    const company = { id: 'co1', aiBillingMode: 'BYOK', deepinfraApiKey: 'byok_key', aiSpendCapUsd: null, planId: null, aiIncludedOverride: 100 };
    expect(await resolveAiAccess(prisma, company, { aiSource: 'PLATFORM' })).toMatchObject({ billedTo: 'PLATFORM' });
    expect(await resolveAiAccess(prisma, company, { aiSource: 'INHERIT' })).toMatchObject({ billedTo: 'BYOK' });
  });

  it('AiSession: si DeepInfra rechaza la principal (402) sigue con el respaldo y se queda con él', async () => {
    const seen: string[] = [];
    const session = new AiSession({ apiKey: 'byok_key', billedTo: 'BYOK', fallback: { apiKey: 'platform_key', billedTo: 'PLATFORM' } });
    const call = (apiKey: string) => {
      seen.push(apiKey);
      if (apiKey === 'byok_key') throw new AiProviderError(402, 'sin saldo');
      return Promise.resolve('ok');
    };
    expect(await session.run(call)).toEqual({ result: 'ok', billedTo: 'PLATFORM' });
    expect(await session.run(call)).toEqual({ result: 'ok', billedTo: 'PLATFORM' });
    expect(seen).toEqual(['byok_key', 'platform_key', 'platform_key']);
    expect(session.switched).toBe(true);

    // Un error que NO es de llave (500) no cambia de cuenta: se propaga
    const other = new AiSession({ apiKey: 'a', billedTo: 'BYOK', fallback: { apiKey: 'b', billedTo: 'PLATFORM' } });
    await expect(other.run(() => Promise.reject(new AiProviderError(500, 'caído')))).rejects.toThrow('caído');
  });

  it('agente en híbrido: la llave del cliente se queda sin saldo y la conversación sigue con BackOffice', async () => {
    const { prisma, db } = createMockPrisma();
    const provider = new RejectingProvider('di_byok_key');
    const audit = { log: jest.fn(async () => undefined) };
    const agent = new AgentService(prisma as any, provider);
    const engine = new EngineService(prisma as any, provider, audit as any, undefined, undefined, undefined, agent);
    db.company.push({
      id: 'co1', name: 'Híbrida', timezone: 'America/Bogota', currency: 'COP',
      deepinfraApiKey: 'di_byok_key', aiBillingMode: 'HYBRID', aiHybridPrimary: 'BYOK',
      aiSpendCapUsd: null, planId: null, aiIncludedOverride: 100, orderConfigJson: '{}',
    });
    db.bot.push({
      id: 'bot1', companyId: 'co1', status: 'ACTIVE', engineMode: 'AGENT', toolsJson: '[]',
      systemPrompt: '', personalityJson: '{}', salesJson: '{}', model: 'meta-llama/Llama-3.3-70B-Instruct',
      temperature: 0.5, replyDelayMinSec: 1, replyDelayMaxSec: 2, handoffKeywords: '',
    });
    db.aiModel.push({ modelId: 'meta-llama/Llama-3.3-70B-Instruct', inputCostPerMTok: 0.23, outputCostPerMTok: 0.4 });
    db.contact.push({ id: 'ct1', companyId: 'co1', name: 'Ana', phone: '+57300' });
    db.conversation.push({ id: 'conv1', companyId: 'co1', contactId: 'ct1', botId: 'bot1', channel: 'SIMULATOR', status: 'OPEN', botPaused: false, aiStateJson: '{}' });
    db.message.push({ id: 'm1', conversationId: 'conv1', direction: 'IN', author: 'CONTACT', content: 'hola', type: 'TEXT', createdAt: new Date() });

    provider.script({ reply: ['¡Hola! ¿Qué se te antoja?'], confidence: 0.9, state: 'saludo' });
    const r = await engine.processConversation('conv1');
    expect(r!.escalated).toBe(false);
    expect(provider.calls.map((c) => c.apiKey)).toEqual(['di_byok_key', 'platform_key']);
    expect(db.aiUsageEvent).toHaveLength(1);
    expect(db.aiUsageEvent[0]).toMatchObject({ billedTo: 'PLATFORM', conversationId: 'conv1' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai.fallback' }));
  });

  it('agente sin proveedor (DeepInfra caído): escala con motivo, nunca deja la conversación colgada', async () => {
    const { db, provider, engine, say } = setup();
    say('hola');
    jest.spyOn(provider, 'chat').mockRejectedValue(new AiProviderError(503, 'DeepInfra respondió 503'));
    const r = await engine.processConversation('conv1');
    expect(r!.escalated).toBe(true);
    expect(r!.escalationReason).toMatch(/Proveedor de IA no disponible/);
    expect(db.conversation[0]).toMatchObject({ botPaused: true, needsAttention: true });
  });

  it('en híbrido solo lo que pagó BackOffice descuenta saldo (BYOK no consume créditos)', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'co1', aiBillingMode: 'HYBRID', planId: null, aiIncludedOverride: 0 });
    await creditAiLot(prisma, { companyId: 'co1', conversations: 10, source: 'GRANT' });
    for (const [conv, billedTo] of [['a', 'PLATFORM'], ['a', 'PLATFORM'], ['b', 'BYOK'], ['c', 'PLATFORM']] as const) {
      await recordAiUsage(prisma, { companyId: 'co1', model: 'm', inputTokens: 10, outputTokens: 5, billedTo, conversationId: conv });
    }
    const credits = await computeAiCredits(prisma, { id: 'co1', aiBillingMode: 'HYBRID', planId: null, aiIncludedOverride: 0 });
    // a (1 vez por ventana de 24 h) + c = 2 créditos; b fue con la llave del cliente
    expect(credits).toMatchObject({ mode: 'HYBRID', balance: 8, usedThisMonth: 2 });
  });
});
