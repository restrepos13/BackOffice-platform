/**
 * Pruebas — aprovisionamiento SIN código: plantillas de vertical y clonado
 * de la configuración de una empresa existente (jamás datos ni credenciales).
 */
import { CompaniesService } from '../src/modules/companies.module';
import { COMPANY_TEMPLATES, findTemplate } from '../src/modules/company-templates';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const PLATFORM = {
  id: 'sa', email: 's@backoffice.dev', name: 'Santiago', role: 'SUPER_ADMIN' as const,
  companyId: null,
};

function setup() {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const companies = new CompaniesService(prisma as any, audit as any);
  return { prisma, db, companies, audit };
}

describe('catálogo de plantillas', () => {
  it('existen las tres verticales y todas declaran módulos y descripción', () => {
    const ids = COMPANY_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['catering', 'webcam', 'servicios']));
    for (const t of COMPANY_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.includes.length).toBeGreaterThan(0);
      expect(t.modules).toContain('inbox');
    }
  });

  it('la plantilla de catering trae el módulo de pedidos COMPLETO (como Nexus)', () => {
    const t = findTemplate('catering')!;
    expect(t.modules).toContain('orders');
    expect(t.orderConfig?.schedule?.days).toBeDefined();
    expect(t.orderConfig?.orderCutoff).toBeDefined();
    expect(t.orderConfig?.slots?.length).toBeGreaterThan(0);
    expect(t.orderConfig?.aiConfidenceThreshold).toBe(0.8);
    expect(t.areas?.map((a) => a.name)).toEqual(
      expect.arrayContaining(['Cocina', 'Despacho']),
    );
    expect(t.bot?.systemPrompt).toContain('pedido');
  });

  it('findTemplate: id inexistente o vacío → null', () => {
    expect(findTemplate('noexiste')).toBeNull();
    expect(findTemplate(null)).toBeNull();
    expect(findTemplate(undefined)).toBeNull();
  });
});

describe('aprovisionar con plantilla', () => {
  it('catering: empresa lista para operar sin tocar código', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, {
      name: 'Delicias Bogotá',
      templateId: 'catering',
      admin: { name: 'Ana', email: 'ana@delicias.co', password: 'ClaveFuerte-99' },
    } as any);

    const company = db.company.find((c: any) => c.slug === 'delicias-bogota')!;
    expect(company).toBeDefined();
    expect(JSON.parse(company.modulesJson)).toContain('orders');
    expect(company.currency).toBe('COP');
    const cfg = JSON.parse(company.orderConfigJson);
    expect(cfg.orderCutoff).toBe('14:00');
    expect(cfg.slots).toHaveLength(2);

    // Bot de la plantilla en borrador con personalidad y ventas
    const bot = db.bot.find((b: any) => b.companyId === company.id)!;
    expect(bot.status).toBe('DRAFT');
    expect(JSON.parse(bot.personalityJson).tone).toContain('colombiano');
    expect(bot.replyDelayMaxSec).toBe(40);

    // 4 áreas base
    const areas = db.productionArea.filter((a: any) => a.companyId === company.id);
    expect(areas.map((a: any) => a.name)).toEqual(
      expect.arrayContaining(['Cocina', 'Empaque', 'Logística', 'Despacho']),
    );

    // Línea WhatsApp nace Twilio EN SANDBOX (jamás mensajes reales)
    const line = db.integration.find(
      (i: any) => i.companyId === company.id && i.type === 'WHATSAPP',
    )!;
    const lineCfg = JSON.parse(line.configJson);
    expect(lineCfg.provider).toBe('TWILIO');
    expect(lineCfg.sandbox).toBe(true);
    expect(line.botId).toBe(bot.id);

    // Admin creado
    const admin = db.user.find((u: any) => u.companyId === company.id)!;
    expect(admin.role).toBe('COMPANY_ADMIN');
  });

  it('webcam: modo chatter sin módulo de pedidos', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, {
      name: 'Nova Studio 2', templateId: 'webcam',
    } as any);
    const company = db.company.find((c: any) => c.slug === 'nova-studio-2')!;
    expect(JSON.parse(company.modulesJson)).not.toContain('orders');
    expect(company.currency).toBe('USD');
    const bot = db.bot.find((b: any) => b.companyId === company.id)!;
    expect(JSON.parse(bot.salesJson).goal).toContain('PPV');
    expect(db.productionArea.filter((a: any) => a.companyId === company.id)).toHaveLength(0);
  });

  it('plantilla desconocida → error claro, no se crea nada', async () => {
    const { db, companies } = setup();
    await expect(
      companies.provision(PLATFORM as any, { name: 'X', templateId: 'fantasma' } as any),
    ).rejects.toThrow(/Plantilla desconocida/);
    expect(db.company).toHaveLength(0);
  });

  it('sin plantilla: comportamiento clásico intacto (módulos default, sin áreas)', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, { name: 'Empresa Simple' } as any);
    const company = db.company.find((c: any) => c.slug === 'empresa-simple')!;
    expect(JSON.parse(company.modulesJson)).toEqual(
      expect.arrayContaining(['inbox', 'contacts', 'bots']),
    );
    expect(db.productionArea).toHaveLength(0);
    expect(db.bot).toHaveLength(0);
  });

  it('el wizard explícito manda sobre la plantilla (módulos y bot propios)', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, {
      name: 'Custom', templateId: 'catering',
      modules: ['inbox', 'contacts'],
      bot: { name: 'Mi Bot Propio' },
    } as any);
    const company = db.company.find((c: any) => c.slug === 'custom')!;
    expect(JSON.parse(company.modulesJson)).toEqual(['inbox', 'contacts']);
    const bots = db.bot.filter((b: any) => b.companyId === company.id);
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe('Mi Bot Propio');
    // La config de agenda de la plantilla igual queda lista por si activan orders
    expect(JSON.parse(company.orderConfigJson).orderCutoff).toBe('14:00');
  });
});

describe('personalización del wizard sobre la plantilla', () => {
  it('orderConfigOverrides pisa la agenda de la plantilla SIN perder el resto', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, {
      name: 'Catering Nocturno', templateId: 'catering',
      orderConfigOverrides: {
        schedule: { days: [2, 3, 4, 5, 6], open: '14:00', close: '23:00' },
        orderCutoff: '10:00',
        minLeadHours: 6,
      },
    } as any);
    const company = db.company.find((c: any) => c.slug === 'catering-nocturno')!;
    const cfg = JSON.parse(company.orderConfigJson);
    expect(cfg.schedule.open).toBe('14:00'); // editado
    expect(cfg.orderCutoff).toBe('10:00'); // editado
    expect(cfg.minLeadHours).toBe(6); // editado
    expect(cfg.slots).toHaveLength(2); // heredado de la plantilla
    expect(cfg.aiConfidenceThreshold).toBe(0.8); // heredado
  });

  it('las áreas editadas en el wizard REEMPLAZAN las de la plantilla', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, {
      name: 'Solo Dos Áreas', templateId: 'catering',
      areas: [
        { name: 'Producción', notifyChannel: 'EMAIL', reminderHoursBefore: 12 },
        { name: 'Reparto', notifyChannel: 'PANEL' },
        { name: '   ' }, // vacía: se descarta
      ],
    } as any);
    const company = db.company.find((c: any) => c.slug === 'solo-dos-areas')!;
    const areas = db.productionArea.filter((a: any) => a.companyId === company.id);
    expect(areas.map((a: any) => a.name).sort()).toEqual(['Producción', 'Reparto']);
    expect(areas.find((a: any) => a.name === 'Producción')!.notifyChannel).toBe('EMAIL');
    expect(areas.find((a: any) => a.name === 'Reparto')!.reminderHoursBefore).toBe(24); // default
  });

  it('canal de aviso inválido en un área → cae a PANEL (whitelist)', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, {
      name: 'Whitelist', templateId: 'catering',
      areas: [{ name: 'X', notifyChannel: 'TELEGRAM-HACK' }],
    } as any);
    const area = db.productionArea.find((a: any) => a.name === 'X')!;
    expect(area.notifyChannel).toBe('PANEL');
  });

  it('la moneda del wizard manda sobre la de la plantilla', async () => {
    const { db, companies } = setup();
    await companies.provision(PLATFORM as any, {
      name: 'Catering Miami', templateId: 'catering', currency: 'USD',
    } as any);
    expect(db.company.find((c: any) => c.slug === 'catering-miami')!.currency).toBe('USD');
  });

  it('personaTemplateId: el bot nace con la personalidad de la biblioteca', async () => {
    const { db, companies } = setup();
    db.personaTemplate = db.personaTemplate ?? [];
    (db as any).personaTemplate.push({
      id: 'persona1', companyId: null, name: 'Recepcionista Clínica',
      category: 'Clínicas', description: 'Agenda citas',
      systemPrompt: 'Eres la recepcionista…',
      personalityJson: JSON.stringify({ tone: 'cálido' }),
      welcomeMessage: '¡Hola! ¿Agendamos tu cita?', handoffKeywords: 'urgencia',
    });
    await companies.provision(PLATFORM as any, {
      name: 'Clínica Persona', personaTemplateId: 'persona1',
    } as any);
    const company = db.company.find((c: any) => c.slug === 'clinica-persona')!;
    const bot = db.bot.find((b: any) => b.companyId === company.id)!;
    expect(bot.name).toBe('Recepcionista Clínica');
    expect(bot.systemPrompt).toContain('recepcionista');
    expect(JSON.parse(bot.personalityJson).tone).toBe('cálido');
    expect(bot.status).toBe('DRAFT');
  });

  it('personalidad inexistente → error claro, no se crea la empresa a medias', async () => {
    const { db, companies } = setup();
    await expect(
      companies.provision(PLATFORM as any, { name: 'X', personaTemplateId: 'fantasma' } as any),
    ).rejects.toThrow(/personalidad/i);
  });

  it('persona + bot del wizard: el prompt escrito manda, la personalidad complementa', async () => {
    const { db, companies } = setup();
    (db as any).personaTemplate = [{
      id: 'p1', companyId: null, name: 'Vendedora', category: 'Ventas',
      systemPrompt: 'prompt de la persona', personalityJson: '{"tone":"x"}',
      welcomeMessage: 'hola persona', handoffKeywords: '',
    }];
    await companies.provision(PLATFORM as any, {
      name: 'Mixto', personaTemplateId: 'p1',
      bot: { name: 'Mi Bot', systemPrompt: 'MI prompt propio' },
    } as any);
    const bot = db.bot.find((b: any) => b.name === 'Mi Bot')!;
    expect(bot.systemPrompt).toBe('MI prompt propio'); // lo escrito manda
    expect(JSON.parse(bot.personalityJson).tone).toBe('x'); // la persona complementa
  });
});

describe('clonar una empresa existente', () => {
  function seedSource(db: any) {
    db.company.push({
      id: 'src', name: 'Nexus Catering', slug: 'nexus', status: 'ACTIVE',
      timezone: 'America/Bogota', currency: 'COP',
      modulesJson: JSON.stringify(['inbox', 'orders', 'team']),
      orderConfigJson: JSON.stringify({ orderCutoff: '13:00', minLeadHours: 24 }),
      waTemplatesJson: JSON.stringify([{ key: 'recordatorio_cliente', contentSid: 'HX123' }]),
      savingsSalaryUsd: 350, agentCapacityPerMonth: 250,
      deepinfraApiKey: 'llave-secreta-de-nexus',
    });
    db.bot.push({
      id: 'srcbot', companyId: 'src', name: 'Asistente Nexus', status: 'ACTIVE',
      systemPrompt: 'prompt nexus', personalityJson: '{"tone":"x"}', salesJson: '{}',
      model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.7,
      replyDelayMinSec: 6, replyDelayMaxSec: 40, typingSimulation: true,
      handoffKeywords: 'gerente', welcomeMessage: 'hola', description: 'd',
    });
    db.productionArea.push({
      id: 'srcarea', companyId: 'src', name: 'Cocina', notifyChannel: 'WHATSAPP',
      notifyTarget: '+571', reminderHoursBefore: 24,
      responsiblesJson: '[{"name":"Jefe"}]', active: true, description: 'prod',
    });
    db.product.push({
      id: 'srcprod', companyId: 'src', name: 'Almuerzo', unit: 'porción',
      category: 'Almuerzos', presentationsJson: '["Individual"]',
      productionAreaId: 'srcarea', active: true, deletedAt: null, description: null,
    });
    db.integration.push({
      id: 'srcline', companyId: 'src', botId: 'srcbot', type: 'WHATSAPP',
      name: 'Línea Pedidos', status: 'CONNECTED', promptMode: 'CUSTOM',
      overridePrompt: 'prompt de línea', overridePersonalityJson: '{}',
      overrideSalesJson: '{}', overrideWelcome: null, overrideHandoff: null,
      overrideModel: null,
      configJson: JSON.stringify({
        provider: 'TWILIO', sandbox: false,
        accountSid: 'AC_REAL', authTokenEnc: 'enc:v1:aa:bb:cc', fromNumber: '+575550000',
      }),
    });
    // Datos operativos que JAMÁS deben clonarse
    db.customer.push({ id: 'srccust', companyId: 'src', name: 'Cliente Real', addressesJson: '[]' });
    db.order.push({
      id: 'srcorder', companyId: 'src', customerId: 'srccust', status: 'entregado',
      deliveryAt: new Date(), deliveryAddressJson: '{}', takenByType: 'IA',
      correctedAfterAi: false, createdAt: new Date(), deletedAt: null,
    });
  }

  it('clona configuración completa: módulos, agenda, catálogo, áreas, bots y líneas', async () => {
    const { db, companies } = setup();
    seedSource(db);
    await companies.provision(PLATFORM as any, {
      name: 'Catering Medellín', cloneFromCompanyId: 'src',
    } as any);

    const clone = db.company.find((c: any) => c.slug === 'catering-medellin')!;
    expect(JSON.parse(clone.modulesJson)).toEqual(['inbox', 'orders', 'team']);
    expect(JSON.parse(clone.orderConfigJson).orderCutoff).toBe('13:00');
    expect(JSON.parse(clone.waTemplatesJson)[0].key).toBe('recordatorio_cliente');
    expect(clone.savingsSalaryUsd).toBe(350);

    const bot = db.bot.find((b: any) => b.companyId === clone.id)!;
    expect(bot.systemPrompt).toBe('prompt nexus');
    expect(bot.status).toBe('DRAFT'); // clonado SIEMPRE nace en borrador

    const area = db.productionArea.find((a: any) => a.companyId === clone.id)!;
    expect(area.name).toBe('Cocina');
    expect(area.notifyTarget).toBe('+571');

    const product = db.product.find((p: any) => p.companyId === clone.id)!;
    expect(product.name).toBe('Almuerzo');
    expect(product.productionAreaId).toBe(area.id); // remapeado al área nueva
  });

  it('JAMÁS clona credenciales, llaves ni datos de clientes', async () => {
    const { db, companies } = setup();
    seedSource(db);
    await companies.provision(PLATFORM as any, {
      name: 'Clon Seguro', cloneFromCompanyId: 'src',
    } as any);

    const clone = db.company.find((c: any) => c.slug === 'clon-seguro')!;
    // Llave DeepInfra: NO viaja
    expect(clone.deepinfraApiKey).toBeUndefined();

    // Líneas: mismas propiedades, credenciales fuera y sandbox forzado
    const lines = db.integration.filter(
      (i: any) => i.companyId === clone.id && i.name === 'Línea Pedidos',
    );
    expect(lines).toHaveLength(1);
    const cfg = JSON.parse(lines[0].configJson);
    expect(cfg.sandbox).toBe(true);
    expect(cfg.accountSid).toBeUndefined();
    expect(cfg.authTokenEnc).toBeUndefined();
    expect(cfg.fromNumber).toBeUndefined();
    expect(lines[0].promptMode).toBe('CUSTOM');
    expect(lines[0].overridePrompt).toBe('prompt de línea');
    expect(lines[0].status).toBe('DISCONNECTED');

    // Datos operativos: cero
    expect(db.customer.filter((c: any) => c.companyId === clone.id)).toHaveLength(0);
    expect(db.order.filter((o: any) => o.companyId === clone.id)).toHaveLength(0);
  });

  it('empresa origen inexistente → error claro', async () => {
    const { companies } = setup();
    await expect(
      companies.provision(PLATFORM as any, { name: 'X', cloneFromCompanyId: 'nope' } as any),
    ).rejects.toThrow(/no existe/);
  });
});
