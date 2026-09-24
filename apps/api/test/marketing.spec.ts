/**
 * Pruebas — módulo de MARKETING (cascarón): campañas, piezas, copy con la IA
 * de la empresa (BYOK), aislamiento multi-tenant y gancho del generador de
 * video (MoneyPrinterTurbo) con su manejo de "no configurado".
 * Más: creación MANUAL de pedidos y PDFs con marca.
 */
import { MarketingService } from '../src/modules/marketing.module';
import { OrdersService, RemindersService } from '../src/modules/orders.module';
import { buildDailyReportPdf, buildOrderPdf } from '../src/common/pdf';
import { AiChatOptions, AiChatResult, AiProvider } from '../src/ai/types';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const ADMIN = {
  id: 'u1', email: 'a@a.co', name: 'Admin', role: 'COMPANY_ADMIN' as const, companyId: 'co1',
};
const ATTACKER = { ...ADMIN, id: 'u2', companyId: 'co2' };

function scriptedAi(responses: string[]): AiProvider {
  let i = 0;
  return {
    chat: jest.fn(async (_o: AiChatOptions): Promise<AiChatResult> => ({
      content: responses[Math.min(i++, responses.length - 1)],
      inputTokens: 300, outputTokens: 120, model: 'test-model',
    })),
    transcribe: jest.fn(async () => ({ text: '' })),
  } as any;
}

function setup(ai?: AiProvider) {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const marketing = new MarketingService(prisma as any, audit as any, ai);
  db.company.push(
    {
      id: 'co1', name: 'Nexus Catering', slug: 'nexus', industry: 'Catering',
      country: 'Colombia', timezone: 'America/Bogota', brandColor: '#1F4F7A',
      deepinfraApiKey: 'llave', orderConfigJson: '{}', waTemplatesJson: '[]',
      contactEmail: 'hola@nexus.co',
    },
    {
      id: 'co2', name: 'Otra', slug: 'otra', timezone: 'America/Bogota',
      orderConfigJson: '{}', waTemplatesJson: '[]',
    },
  );
  return { prisma, db, marketing, audit };
}

/* ═══ Campañas y piezas ═══ */

describe('marketing: campañas y piezas', () => {
  it('crea campaña con canales válidos (los inválidos se filtran)', async () => {
    const ctx = setup();
    const campaign = await ctx.marketing.saveCampaign(ADMIN as any, {
      name: 'Lanzamiento', objective: 'ventas',
      channels: ['instagram', 'tiktok', 'sql-injection'],
      status: 'ACTIVA',
    });
    expect(campaign.companyId).toBe('co1');
    expect(JSON.parse(campaign.channelsJson)).toEqual(['instagram', 'tiktok']);
    expect(campaign.status).toBe('ACTIVA');
  });

  it('crea pieza y la lista con filtros', async () => {
    const ctx = setup();
    await ctx.marketing.savePiece(ADMIN as any, {
      title: 'Reel de menú', type: 'REEL', channel: 'instagram',
      hashtags: ['#catering'],
    });
    await ctx.marketing.savePiece(ADMIN as any, {
      title: 'Post fotos', type: 'POST', status: 'PUBLICADO',
    });
    const reels = await ctx.marketing.listPieces(ADMIN as any, { type: 'REEL' });
    expect(reels).toHaveLength(1);
    expect(reels[0].hashtags).toEqual(['#catering']);
    const publicadas = await ctx.marketing.listPieces(ADMIN as any, { status: 'PUBLICADO' });
    expect(publicadas).toHaveLength(1);
  });

  it('estado/tipo inválidos se ignoran (whitelist)', async () => {
    const ctx = setup();
    const piece = await ctx.marketing.savePiece(ADMIN as any, {
      title: 'X', type: 'MALWARE', status: 'HACKED',
    });
    expect(piece.type).toBe('POST');
    expect(piece.status).toBe('IDEA');
  });

  it('resumen: contadores por estado + próximas programadas', async () => {
    const ctx = setup();
    await ctx.marketing.savePiece(ADMIN as any, { title: 'A', status: 'IDEA' });
    await ctx.marketing.savePiece(ADMIN as any, {
      title: 'B', status: 'PROGRAMADO',
      scheduledAt: new Date(Date.now() + 86400e3).toISOString(),
    });
    const summary = await ctx.marketing.summary(ADMIN as any);
    expect(summary.totalPiezas).toBe(2);
    expect(summary.piezas.PROGRAMADO).toBe(1);
    expect(summary.próximas).toHaveLength(1);
    expect(summary.videoGeneratorReady).toBe(false); // sin MPT_BASE_URL
  });

  it('multi-tenant: el atacante no ve, edita ni borra piezas ajenas', async () => {
    const ctx = setup();
    const piece = await ctx.marketing.savePiece(ADMIN as any, { title: 'Privada' });
    await expect(
      ctx.marketing.savePiece(ATTACKER as any, { title: 'pwned' }, piece.id),
    ).rejects.toThrow(/Forbidden/i);
    await expect(ctx.marketing.removePiece(ATTACKER as any, piece.id)).rejects.toThrow(/Forbidden/i);
    const ajenas = await ctx.marketing.listPieces(ATTACKER as any, { companyId: 'co1' });
    expect(ajenas).toHaveLength(0); // escopa a co2 aunque pida co1
  });
});

/* ═══ Copy con IA (BYOK) ═══ */

describe('marketing: copy con la IA de la empresa', () => {
  it('genera título, copy, hashtags y guion (reel) y registra consumo', async () => {
    const ai = scriptedAi([
      JSON.stringify({
        title: 'El error #1 al pedir catering',
        copy: 'Deja de improvisar los almuerzos de tu equipo. Escríbenos.',
        hashtags: ['#catering', '#bogota'],
        script: 'Hola, ¿sabías que…',
      }),
    ]);
    const ctx = setup(ai);
    const piece = await ctx.marketing.savePiece(ADMIN as any, {
      title: 'idea suelta', type: 'REEL', brief: 'promocionar almuerzos corporativos',
    });
    const updated = await ctx.marketing.generateCopy(ADMIN as any, piece.id);
    expect(updated.copy).toContain('improvisar');
    expect(updated.hashtags).toEqual(['#catering', '#bogota']);
    expect(updated.script).toContain('Hola');
    expect(updated.status).toBe('BORRADOR'); // IDEA → BORRADOR
    expect(ctx.db.aiUsageEvent).toHaveLength(1); // BYOK registrado
  });

  it('sin llave DeepInfra → error claro', async () => {
    const ctx = setup(scriptedAi(['{}']));
    const company = ctx.db.company.find((c: any) => c.id === 'co1')!;
    delete company.deepinfraApiKey;
    const piece = await ctx.marketing.savePiece(ADMIN as any, { title: 'X' });
    await expect(ctx.marketing.generateCopy(ADMIN as any, piece.id)).rejects.toThrow(/DeepInfra/);
  });

  it('salida inválida del modelo → error, la pieza no se corrompe', async () => {
    const ctx = setup(scriptedAi(['no soy json']));
    const piece = await ctx.marketing.savePiece(ADMIN as any, { title: 'Original' });
    await expect(ctx.marketing.generateCopy(ADMIN as any, piece.id)).rejects.toThrow(/copy válido/);
    const after = ctx.db.contentPiece.find((p: any) => p.id === piece.id)!;
    expect(after.title).toBe('Original');
    expect(after.copy).toBeUndefined();
  });
});

/* ═══ Video (cascarón MoneyPrinterTurbo) ═══ */

describe('marketing: generador de video (cascarón)', () => {
  it('sin MPT_BASE_URL configurado → mensaje claro de qué falta', async () => {
    const ctx = setup();
    const piece = await ctx.marketing.savePiece(ADMIN as any, {
      title: 'Reel', type: 'REEL', script: 'guion',
    });
    await expect(ctx.marketing.renderVideo(ADMIN as any, piece.id)).rejects.toThrow(/MPT_BASE_URL/);
  });

  it('solo las piezas REEL generan video', async () => {
    const ctx = setup();
    const piece = await ctx.marketing.savePiece(ADMIN as any, { title: 'Post', type: 'POST' });
    await expect(ctx.marketing.renderVideo(ADMIN as any, piece.id)).rejects.toThrow(/REEL/);
  });

  it('con generador configurado: encola, guarda task_id y el job queda PROCESANDO', async () => {
    const ctx = setup();
    ctx.db.platformSetting.push({ key: 'MPT_BASE_URL', value: 'http://mpt.local:8080' });
    const piece = await ctx.marketing.savePiece(ADMIN as any, {
      title: 'Reel', type: 'REEL', script: 'guion hablado',
    });
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 200, data: { task_id: 'mpt-task-1' } }),
    } as any);

    const result = await ctx.marketing.renderVideo(ADMIN as any, piece.id);
    expect(result.externalTaskId).toBe('mpt-task-1');
    expect(result.state).toBe('PROCESANDO');
    const [url, opts] = fetchSpy.mock.calls[0] as any[];
    expect(url).toBe('http://mpt.local:8080/api/v1/videos');
    const body = JSON.parse(opts.body);
    expect(body.video_aspect).toBe('9:16');
    expect(body.video_script).toBe('guion hablado');
    fetchSpy.mockRestore();
  });

  it('generador caído → job FALLIDO con el error, sin romper nada', async () => {
    const ctx = setup();
    ctx.db.platformSetting.push({ key: 'MPT_BASE_URL', value: 'http://mpt.local:8080' });
    const piece = await ctx.marketing.savePiece(ADMIN as any, {
      title: 'Reel', type: 'REEL', script: 'g',
    });
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(ctx.marketing.renderVideo(ADMIN as any, piece.id)).rejects.toThrow(/ECONNREFUSED/);
    expect(ctx.db.videoJob[0].state).toBe('FALLIDO');
    fetchSpy.mockRestore();
  });
});

/* ═══ Creación manual de pedidos ═══ */

describe('creación manual de pedidos', () => {
  function ordersSetup() {
    const { prisma, db } = createMockPrisma();
    const audit = { log: jest.fn(async () => undefined) };
    const emails = { systemSend: jest.fn(async () => undefined) };
    const reminders = new RemindersService(prisma as any, audit as any, emails as any);
    const orders = new OrdersService(prisma as any, audit as any, reminders);
    db.company.push({
      id: 'co1', name: 'Catering', slug: 'cat', timezone: 'America/Bogota',
      orderConfigJson: JSON.stringify({
        schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' },
        minLeadHours: 18, reminderDefaults: { clientSameDayHour: 7 },
      }),
      waTemplatesJson: '[]',
    });
    db.productionArea.push({
      id: 'cocina', companyId: 'co1', name: 'Cocina', responsiblesJson: '[]',
      notifyChannel: 'PANEL', reminderHoursBefore: 24, active: true,
    });
    db.product.push({
      id: 'p1', companyId: 'co1', name: 'Almuerzo', unit: 'porción',
      presentationsJson: '[]', productionAreaId: 'cocina', active: true, deletedAt: null,
    });
    db.customer.push({ id: 'cust1', companyId: 'co1', name: 'Cliente', addressesJson: '[]' });
    db.customer.push({ id: 'custB', companyId: 'coB', name: 'Ajeno', addressesJson: '[]' });
    return { db, orders };
  }
  const nextOk = () => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    while (d.getDay() === 0) d.setDate(d.getDate() + 1);
    d.setHours(11, 0, 0, 0);
    return d;
  };

  it('crea en borrador con trazabilidad y autor humano', async () => {
    const { db, orders } = ordersSetup();
    const order = await orders.createManual(ADMIN as any, {
      customerId: 'cust1',
      deliveryAt: nextOk().toISOString(),
      items: [{ productId: 'p1', quantity: 20 }],
    });
    expect(order!.status).toBe('borrador');
    const raw = db.order.find((o: any) => o.id === order!.id)!;
    expect(raw.takenByType).toBe('HUMANO');
    expect(raw.takenByName).toBe('Admin');
    expect(db.orderItem[0].productionAreaId).toBe('cocina'); // área del producto
    expect(db.orderStatusHistory[0].reason).toContain('manualmente');
  });

  it('con confirm=true corre el MISMO pipeline: distribuye, agenda y recordatorios → programado', async () => {
    const { db, orders } = ordersSetup();
    const order = await orders.createManual(ADMIN as any, {
      customerId: 'cust1',
      deliveryAt: nextOk().toISOString(),
      items: [{ productId: 'p1', quantity: 20 }],
      confirm: true,
    });
    expect(order!.status).toBe('programado');
    expect(db.reminder.filter((r: any) => r.orderId === order!.id).length).toBeGreaterThanOrEqual(1);
  });

  it('valida: cliente ajeno, sin fecha o sin ítems → error', async () => {
    const { orders } = ordersSetup();
    await expect(
      orders.createManual(ADMIN as any, { customerId: 'custB', deliveryAt: nextOk().toISOString(), items: [{ productId: 'p1', quantity: 1 }] }),
    ).rejects.toThrow(/Cliente no encontrado/);
    await expect(
      orders.createManual(ADMIN as any, { customerId: 'cust1', items: [{ productId: 'p1', quantity: 1 }] }),
    ).rejects.toThrow(/fecha/);
    await expect(
      orders.createManual(ADMIN as any, { customerId: 'cust1', deliveryAt: nextOk().toISOString(), items: [] }),
    ).rejects.toThrow(/ítem/);
  });
});

/* ═══ PDFs con marca ═══ */

describe('PDFs con identidad de marca', () => {
  const company = {
    name: 'Nexus Catering', brandColor: '#1F4F7A', contactEmail: 'hola@nexus.co',
    city: 'Bogotá', country: 'Colombia', timezone: 'America/Bogota',
  };

  it('la orden de pedido genera un PDF válido', async () => {
    const buffer = await buildOrderPdf(company, {
      id: 'abc123xyz', status: 'programado',
      deliveryAt: new Date(), deliveryAddressJson: JSON.stringify({ label: 'Sede', address: 'Cl 1 # 2-3' }),
      customer: { name: 'Constructora' },
      contact: { name: 'Marta', phone: '+571' },
      observations: 'Sin cebolla',
      items: [
        { quantity: 30, unit: 'porción', productName: 'Almuerzo', presentation: 'Individual', productionArea: { name: 'Cocina' }, specifications: '5 vegetarianos' },
      ],
      statusHistory: [
        { createdAt: new Date(), fromStatus: 'borrador', toStatus: 'confirmado', authorType: 'USUARIO', authorName: 'Admin' },
      ],
    });
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-'); // firma PDF real
  });

  it('el reporte diario genera un PDF válido incluso sin datos', async () => {
    const buffer = await buildDailyReportPdf(company, {
      date: '2026-09-23',
      pedidos: { recibidos: 0, confirmados: 0, programados: 0, despachados: 0, entregados: 0, cancelados: 0 },
      conversaciones: { atendidas: 0, escaladas: 0, conIntervencionHumana: 0, resueltasPorIA: 0 },
      dudas: { pedidosBajaConfianza: [], escalamientos: [] },
      alertas: { pedidosSinConfirmar: [], entregasProximasSinArea: [], recordatoriosFallidos: [], conversacionesSinRespuesta: 0 },
      precisionIA: { dia: { total: 0, corregidos: 0, precisionPct: null }, mes: { total: 0, corregidos: 0, precisionPct: null } },
      feedback: { respuestas: 0, promedio: null, negativos: [] },
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
