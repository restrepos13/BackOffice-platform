/**
 * Fase 1 — configuración personalizada y selección de productos:
 *  - perfil de negocio, complejidad operativa y productos son tres cosas distintas,
 *  - el autoservicio y la configuración asistida producen la MISMA estructura,
 *  - cada empresa recibe solo los productos elegidos y el servidor los exige,
 *  - las empresas anteriores siguen igual y una provisión fallida no deja huérfanos.
 */
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { extractJson } from '../src/ai/types';
import { ProductsGuard } from '../src/auth/products.guard';
import { guessRubro, onboardingChecklist } from '../src/common/rubros';
import { hasProduct, productsExplicit, readProducts } from '../src/common/products';
import { computeComplexity, normalizeSetup, readOperation, setupFromConversation, setupOf } from '../src/common/setup-profile';
import { CompaniesService } from '../src/modules/companies.module';
import { ConversationsController } from '../src/modules/conversations.module';
import { CreativeController } from '../src/modules/creative.module';
import { AdsController } from '../src/modules/ads.module';
import { SignupService } from '../src/modules/signup.module';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn(async () => undefined) };
const DEV = { id: 'dev1', role: 'DEV', companyId: null, name: 'Santiago', email: 'dev@backoffice.dev' } as any;

function fakePool(content: string | null) {
  const chat = jest.fn(async (_opts?: unknown) => {
    if (content === null) throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'sin IA' });
    return { content, model: 'm', keyLabel: 'k', tokens: 5 };
  });
  return {
    chat,
    chatJson: async (opts: any, accept: (raw: any) => boolean) => {
      const r = await chat(opts);
      const raw = extractJson(r.content);
      if (raw && accept(raw)) return { raw, result: r, tokens: 5, calls: 1 };
      throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'x', tokens: 5, calls: 1 });
    },
  };
}

function world(aiContent: string | null = null) {
  const { prisma, db } = createMockPrisma();
  const emails = { systemSend: jest.fn(async () => ({ status: 'QUEUED' })) };
  const auth = { login: jest.fn(async (email: string) => ({ token: 't', user: { email } })) };
  const companies = new CompaniesService(prisma as any, audit as any);
  const service = new SignupService(prisma as any, audit as any, emails as any, companies, auth as any);
  (service as any).pool = fakePool(aiContent);
  return { prisma, db, companies, service };
}

const CANCHAS = 'Alquilamos dos canchas de fútbol 5 en Envigado. Nos escriben por WhatsApp para reservar por hora y piden anticipo por Nequi. Somos dos: yo y mi hermano. Anoto las reservas en un cuaderno y me toca responder disponibilidad todo el día.';
const CATERING = 'Catering para empresas y eventos en Medellín. Somos 14 personas. Primero cotizamos, luego el cliente aprueba y paga anticipo, después compras pide los insumos al proveedor, entonces producción cocina, finalmente despacho y entregas con nuestros domiciliarios. El gerente aprueba cada cotización. Llevamos todo en Excel y facturamos en Siigo. Quiero que el asistente cotice.';

const account = (email: string, extra: Record<string, unknown> = {}) => ({
  company: { name: `Empresa ${email}` }, acceptTerms: true,
  admin: { name: 'Dueña', email, phone: '3001112233', password: 'clave1234' },
  description: 'Vendemos ropa por Instagram y WhatsApp en Medellín, blusas y jeans.',
  ...extra,
});
const selection = (selected: string[]) => ({ setup: { answers: { offer: 'Ropa', needs: ['VENTAS', 'ATENCION'] }, signals: {}, products: { selected } } });

describe('Productos elegidos en el autoservicio', () => {
  it.each([
    [['AUTOMATION'], true],
    [['CREATIVE'], false],
    [['ADS'], false],
    [['CREATIVE', 'ADS'], false],
    [['AUTOMATION', 'ADS'], true],
    [['AUTOMATION', 'CREATIVE', 'ADS'], true],
  ])('con %j la empresa recibe exactamente esos productos (WhatsApp y asistente solo con Automation)', async (selected, automation) => {
    const { db, service } = world();
    await service.register(account(`a${selected.join('')}@x.co`, selection(selected)));
    const company = db.company[0];
    expect(productsExplicit(company)).toBe(true);
    expect((['AUTOMATION', 'CREATIVE', 'ADS'] as const).filter((p) => hasProduct(company, p))).toEqual(selected);
    expect(db.integration.filter((i: any) => i.companyId === company.id).length > 0).toBe(automation);
    expect(db.bot.filter((b: any) => b.companyId === company.id).length > 0).toBe(automation);
    // El perfil queda guardado con la misma selección
    expect(setupOf(company)?.products.selected).toEqual(selected);
    // Activar un plan después NO agrega productos que no eligió
    company.planId = 'p1';
    expect((['AUTOMATION', 'CREATIVE', 'ADS'] as const).filter((p) => hasProduct(company, p))).toEqual(selected);
  });

  it('la selección del navegador se valida en el servidor: vacía o inventada no crea nada', async () => {
    const { db, service } = world();
    await expect(service.register(account('v1@x.co', selection([])))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.register(account('v2@x.co', selection(['AUTOMATION', 'GRATIS'])))).rejects.toBeInstanceOf(BadRequestException);
    expect(db.company).toHaveLength(0);
    expect(db.user).toHaveLength(0);
  });

  it('el navegador no puede imponer la complejidad: se recalcula con las respuestas', () => {
    const s = normalizeSetup({ answers: { needs: ['RESERVAS'] }, signals: { people: 2 }, complexity: { level: 'COMPLEX', override: { level: 'COMPLEX', reason: 'porque sí' } } }, { source: 'SELF_SERVICE' });
    expect(s.complexity).toMatchObject({ level: 'SIMPLE', override: null });
  });
});

describe('Cada negocio recibe su configuración', () => {
  it('una empresa de reservas (dos canchas) queda simple: agenda y recordatorios, sin pedidos, domicilios ni Creative/Ads', async () => {
    const { db, service } = world(null); // sin IA: el respaldo por código debe bastar
    const preview = await service.preview({ description: CANCHAS });
    expect(preview.setup).toMatchObject({ business: { profileKey: 'RESERVAS' }, complexity: { level: 'SIMPLE' }, products: { recommended: ['AUTOMATION'] } });
    expect(preview.rubro).toBe('SERVICIOS');
    expect(guessRubro('Alquilamos canchas sintéticas por turnos')).toBe('SERVICIOS');
    const caps = preview.setup.capabilities.map((c: any) => c.key);
    expect(caps).toEqual(expect.arrayContaining(['ATENCION_IA', 'AGENDA', 'RECORDATORIOS']));
    expect(caps).not.toEqual(expect.arrayContaining(['PEDIDOS']));
    // Reservas por el chat: real desde la Fase 2; los recordatorios dependen de la ventana de 24 h o la plantilla
    expect(preview.setup.capabilities.find((c: any) => c.key === 'AGENDA')).toMatchObject({ status: 'AVAILABLE' });
    expect(preview.setup.capabilities.find((c: any) => c.key === 'RECORDATORIOS')).toMatchObject({ status: 'PARTIAL' });
    expect(preview.blueprint.modules).toContain('agenda');
    for (const m of ['orders', 'production', 'delivery', 'menu']) expect(preview.blueprint.modules).not.toContain(m);

    await service.register({
      ...account('canchas@x.co'), description: CANCHAS, rubro: preview.rubro, proposal: preview.proposal, blueprint: preview.blueprint, setup: preview.setup,
    });
    const company = db.company[0];
    const modules = JSON.parse(company.modulesJson);
    expect(modules).toContain('agenda');
    for (const m of ['orders', 'production', 'delivery', 'menu']) expect(modules).not.toContain(m);
    expect(db.productionArea.filter((a: any) => a.companyId === company.id)).toHaveLength(0);
    expect(hasProduct(company, 'CREATIVE') || hasProduct(company, 'ADS')).toBe(false);
    // El asistente no recibe herramientas de pedidos que no usaría
    const bot = db.bot.find((b: any) => b.companyId === company.id)!;
    const tools = JSON.parse(bot.toolsJson).map((t: any) => t.tool);
    expect(tools).not.toContain('armar_pedido');
    expect(tools).toEqual(expect.arrayContaining(['ver_disponibilidad', 'crear_reserva', 'cancelar_reserva', 'reprogramar_reserva']));
  });

  it('un catering con procesos complejos recibe otras capacidades (y lo que no existe aún se marca como próxima fase)', () => {
    const s = setupFromConversation({ text: CATERING, firstAnswer: 'Catering para empresas y eventos', dailyVolume: 40, source: 'SELF_SERVICE' });
    expect(s.complexity.level).toBe('COMPLEX');
    const caps = Object.fromEntries(s.capabilities.map((c) => [c.key, c.status]));
    expect(caps).toMatchObject({ PEDIDOS: 'AVAILABLE', PRODUCCION: 'AVAILABLE', DOMICILIOS: 'AVAILABLE', PROCESOS: 'PLANNED', APROBACIONES: 'PLANNED', INTEGRACIONES: 'PARTIAL', REPORTES: 'AVAILABLE' });
    expect(caps.AGENDA).toBeUndefined();
    expect(s.signals).toMatchObject({ people: 14 });
    expect(s.answers.integrations).toEqual(expect.arrayContaining(['Excel', 'Siigo']));
  });

  it('la complejidad sale de cómo trabaja, no del sector: dos restaurantes pueden quedar distintos', () => {
    const small = setupFromConversation({ text: 'Restaurante de almuerzos. Solo yo atiendo el WhatsApp y vendo 20 almuerzos.', source: 'SELF_SERVICE' });
    const big = setupFromConversation({ text: 'Restaurante con 3 sedes. Somos 40 personas. Compras, producción, despacho y entregas. El administrador aprueba compras y el gerente aprueba descuentos. Usamos Siigo, Excel y Rappi.', source: 'SELF_SERVICE', dailyVolume: 150 });
    expect(small.business.profileKey).toBe(big.business.profileKey);
    expect(small.complexity.level).toBe('SIMPLE');
    expect(big.complexity.level).toBe('COMPLEX');
    expect(computeComplexity(readOperation('').answers, readOperation('').signals).level).toBe('SIMPLE');
  });

  it('papel, cuaderno o los canales de chat no cuentan como sistemas externos (no suben la complejidad)', () => {
    const s = normalizeSetup({ answers: { integrations: ['Cuaderno', 'WhatsApp', 'Nequi', 'Siigo'] }, signals: {} }, { source: 'SELF_SERVICE' });
    expect(s.answers.integrations).toEqual(['Siigo']);
  });

  it('pide Creative y Ads solo si los necesita, con sus razones', () => {
    const s = setupFromConversation({ text: 'Tienda de ropa. Necesito contenido para redes y hacemos publicidad en Facebook Ads.', source: 'SELF_SERVICE' });
    expect(s.products.recommended).toEqual(['AUTOMATION', 'CREATIVE', 'ADS']);
    expect(s.products.reasons.CREATIVE?.[0]).toMatch(/contenido/);
    expect(setupFromConversation({ text: 'Tienda de ropa. No hago publicidad.', source: 'SELF_SERVICE' }).products.recommended).not.toContain('ADS');
  });
});

describe('Autoservicio y configuración asistida: la misma estructura', () => {
  it('las dos modalidades guardan un perfil con las mismas claves y los productos con el mismo formato', async () => {
    const self = world();
    const p1 = await self.service.preview({ description: CATERING });
    await self.service.register({ ...account('self@x.co'), description: CATERING, rubro: p1.rubro, proposal: p1.proposal, blueprint: p1.blueprint, setup: p1.setup });
    const a = setupOf(self.db.company[0])!;

    const assisted = world();
    const proposal = await assisted.service.propose(DEV, { notes: CATERING });
    const created: any = await assisted.companies.provision(DEV, {
      name: 'Catering Asistido', admin: { name: 'Dueño', email: 'asistido@x.co', password: 'clave1234' },
      setup: proposal.setup, proposal: proposal.proposal, blueprint: proposal.blueprint, rubro: proposal.rubro,
    } as any);
    const b = setupOf(assisted.db.company.find((c: any) => c.id === created.id)!)!;

    const shape = (o: any): any => (Array.isArray(o) ? 'array' : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape(o[k])])) : typeof o);
    expect(shape({ ...a, capabilities: [], agentCallId: null, updatedBy: null, complexity: { ...a.complexity, override: null } }))
      .toEqual(shape({ ...b, capabilities: [], agentCallId: null, updatedBy: null, complexity: { ...b.complexity, override: null } }));
    expect([a.source, b.source]).toEqual(['SELF_SERVICE', 'ASSISTED']);
    expect(b.products.selected).toEqual(a.products.selected);
    expect(Object.keys(JSON.parse(assisted.db.company.find((c: any) => c.id === created.id)!.productsJson))).toEqual(Object.keys(JSON.parse(self.db.company[0].productsJson)));
    // La propuesta de la reunión también crea el embudo y los productos, como el autoservicio
    expect(assisted.db.pipeline.filter((p: any) => p.companyId === created.id).length).toBe(self.db.pipeline.length);
  });

  it('en la provisión asistida mandan las herramientas que eligió el administrador; solo se suman las que piden las capacidades', async () => {
    const { db, companies } = world();
    const setup = setupFromConversation({ text: CANCHAS, source: 'ASSISTED' });
    const created: any = await companies.provision(DEV, { name: 'Canchas Asistidas', modules: ['inbox', 'contacts', 'orders'], setup } as any);
    const modules = JSON.parse(db.company.find((c: any) => c.id === created.id)!.modulesJson);
    expect(modules).toEqual(expect.arrayContaining(['orders', 'agenda'])); // venden bebidas: el admin dejó pedidos
    expect(setupOf(db.company.find((c: any) => c.id === created.id)!)?.source).toBe('ASSISTED');
  });

  it('el administrador ajusta la complejidad con un motivo y define los productos de una empresa existente, ligada a su reunión', async () => {
    const { db, service } = world();
    db.company.push({ id: 'old', name: 'Canchas Viejas', slug: 'cv', planId: 'p1', modulesJson: '["inbox"]', onboardingJson: JSON.stringify({ source: 'SIGNUP', description: CANCHAS, rubro: 'SERVICIOS' }) });
    db.agentCall.push({ id: 'call1', companyId: 'old', topic: 'SETUP', slotAt: new Date(), status: 'CONFIRMED' }, { id: 'callX', companyId: 'otra', topic: 'SETUP', slotAt: new Date() });
    const before = await service.companySetup('old');
    expect(before.setup).toBeNull();
    expect(before.draft?.business.profileKey).toBe('RESERVAS');
    expect(before.calls.map((c: any) => c.id)).toEqual(['call1']);
    await expect(service.saveCompanySetup(DEV, 'old', { setup: { ...before.draft, agentCallId: 'callX' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.saveCompanySetup(DEV, 'old', { setup: { ...before.draft, complexity: { override: { level: 'INTERMEDIATE', reason: '' } } } })).rejects.toBeInstanceOf(BadRequestException);
    const saved = await service.saveCompanySetup(DEV, 'old', {
      setup: { ...before.draft, agentCallId: 'call1', products: { selected: ['AUTOMATION'] }, complexity: { override: { level: 'INTERMEDIATE', reason: 'Van a abrir una tercera cancha' } } },
    });
    expect(saved.setup).toMatchObject({ source: 'ASSISTED', agentCallId: 'call1', complexity: { level: 'INTERMEDIATE', computed: 'SIMPLE', override: { by: 'Santiago' } } });
    const company = db.company.find((c: any) => c.id === 'old')!;
    // Tenía plan (regla vieja = los tres); ahora manda lo elegido en la reunión
    expect(readProducts(company).CREATIVE.enabled).toBe(false);
    expect(JSON.parse(company.modulesJson)).toEqual(expect.arrayContaining(['inbox', 'agenda']));
    expect(JSON.parse(company.onboardingJson)).toMatchObject({ source: 'SIGNUP', description: CANCHAS }); // lo anterior se conserva
  });
});

describe('El servidor exige el producto aunque la interfaz no muestre la opción', () => {
  it('una empresa que solo eligió Creative no entra a Automation ni a Ads llamando al endpoint directo', async () => {
    const { prisma, db, service } = world();
    await service.register(account('solo-creative@x.co', selection(['CREATIVE'])));
    const company = db.company[0];
    const user = { id: 'u', role: 'COMPANY_ADMIN', companyId: company.id };
    const guard = new ProductsGuard(new Reflector(), prisma as any);
    const call = (ctrl: any, method: string) => guard.canActivate({ getHandler: () => ctrl.prototype[method], getClass: () => ctrl, switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any);
    await expect(call(CreativeController, 'designs')).resolves.toBe(true);
    await expect(call(ConversationsController, 'detail')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call(AdsController, 'accounts')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Compatibilidad con empresas y registros anteriores', () => {
  it('sin productos ni perfil guardados todo sigue como antes (regla anterior y lista de pasos de siempre)', async () => {
    const { db, service } = world();
    db.company.push(
      { id: 'legacyPlan', name: 'Con plan', slug: 'lp', planId: 'p1', modulesJson: '["inbox"]', onboardingJson: JSON.stringify({ source: 'SIGNUP', rubro: 'VENTAS', description: 'Tienda' }) },
      { id: 'legacyNoPlan', name: 'Sin plan', slug: 'ln', planId: null, modulesJson: '["inbox"]' },
    );
    expect((['AUTOMATION', 'CREATIVE', 'ADS'] as const).filter((p) => hasProduct(db.company[0], p))).toEqual(['AUTOMATION', 'CREATIVE', 'ADS']);
    expect((['AUTOMATION', 'CREATIVE', 'ADS'] as const).filter((p) => hasProduct(db.company[1], p))).toEqual(['AUTOMATION']);
    expect(setupOf(db.company[0])).toBeNull();
    expect(setupOf({ onboardingJson: '{roto' })).toBeNull();
    const st = await service.status({ id: 'u', role: 'COMPANY_ADMIN', companyId: 'legacyPlan' } as any);
    expect(st.checklist.items.map((i: any) => i.key)).toContain('whatsapp');
    expect(st.checklist.items.map((i: any) => i.key)).not.toContain('marca'); // no se agregan pasos a quien no eligió
  });

  it('un registro de un cliente viejo (sin perfil) igual queda con productos explícitos: Automation', async () => {
    const { db, service } = world();
    await service.register(account('viejo@x.co'));
    expect(productsExplicit(db.company[0])).toBe(true);
    expect(readProducts(db.company[0]).AUTOMATION.enabled).toBe(true);
    expect(setupOf(db.company[0])?.source).toBe('SELF_SERVICE');
  });

  it('la lista de pasos de una empresa solo-Creative pide su marca, no WhatsApp ni asistente', () => {
    const r = onboardingChecklist({ rubro: 'VENTAS', company: { name: 'x', contactPhone: '1' }, products: 0, bots: 0, connectedLines: 0, hasPayments: false, requestedPlan: false, contracted: ['CREATIVE'], brandReady: false });
    expect(r.items.map((i) => i.key)).toEqual(['datos', 'marca', 'plan']);
  });
});

describe('Provisión sin empresas huérfanas', () => {
  it('correo repetido, productos inválidos o perfil inválido fallan ANTES de crear la empresa', async () => {
    const { db, companies } = world();
    db.user.push({ id: 'u1', email: 'ya@existe.co', companyId: 'otra' });
    await expect(companies.provision(DEV, { name: 'A', admin: { name: 'X', email: 'ya@existe.co', password: 'clave1234' } } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(companies.provision(DEV, { name: 'B', products: [] } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(companies.provision(DEV, { name: 'C', products: ['NADA'] } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(companies.provision(DEV, { name: 'D', admin: { name: 'X', email: 'no-es-correo', password: 'clave1234' } } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(companies.provision(DEV, { name: 'E', setup: { complexity: { override: { level: 'COMPLEX', reason: '' } } } } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.company).toHaveLength(0);
  });

  it('si algo falla a mitad de la provisión se deshace: ni empresa ni usuario quedan', async () => {
    const { prisma, db, companies } = world();
    const realCreate = (prisma as any).integration.create;
    (prisma as any).integration.create = jest.fn(async () => { throw new Error('Atlas se cayó'); });
    await expect(companies.provision(DEV, { name: 'Falla', products: ['AUTOMATION'], admin: { name: 'X', email: 'falla@x.co', password: 'clave1234' } } as any)).rejects.toThrow('Atlas se cayó');
    expect(db.company).toHaveLength(0);
    expect(db.user).toHaveLength(0);
    (prisma as any).integration.create = realCreate;
    // y luego la misma provisión funciona (el correo quedó libre)
    await companies.provision(DEV, { name: 'Falla', products: ['AUTOMATION'], admin: { name: 'X', email: 'falla@x.co', password: 'clave1234' } } as any);
    expect(db.company).toHaveLength(1);
  });

  it('si falla lo que el registro hace después de provisionar, también se deshace', async () => {
    const { prisma, db, service } = world();
    (prisma as any).quickReply.create = jest.fn(async () => { throw new Error('fallo'); });
    const p = await service.preview({ description: CATERING });
    await expect(service.register({ ...account('mitad@x.co'), description: CATERING, rubro: p.rubro, proposal: p.proposal, blueprint: { ...p.blueprint, quickReplies: [{ shortcut: 'hola', title: 'Hola', body: 'Hola' }] }, setup: p.setup })).rejects.toThrow('fallo');
    expect(db.company).toHaveLength(0);
    expect(db.user).toHaveLength(0);
  });
});
