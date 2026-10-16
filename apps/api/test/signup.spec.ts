/**
 * Registro por la web: IA genérica con rotación de llaves, rubros que deciden
 * qué ve cada empresa, pasos pendientes, aviso al equipo y acompañamiento.
 */
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { GeminiPool, fingerprint } from '../src/ai/gemini-pool';
import { RUBRO_CONFIG, guessRubro, modulesForRubro, onboardingChecklist } from '../src/common/rubros';
import { SignupService, slugBase, whatsappDigits } from '../src/modules/signup.module';
import { CompaniesService } from '../src/modules/companies.module';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn(async () => undefined) };
const ADMIN = { id: 'adm1', role: 'COMPANY_ADMIN', companyId: 'co1', name: 'Ana', email: 'ana@x.co' } as any;

function reply(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

describe('IA genérica: rotación de llaves Gemini', () => {
  const OLD = process.env;
  beforeEach(() => {
    process.env = { ...OLD, GEMINI_API_KEYS: 'llave-uno-1111,llave-dos-2222', GEMINI_MODELS: 'modelo-a,modelo-b', GEMINI_DAILY_LIMIT: '2' };
  });
  afterAll(() => { process.env = OLD; });

  it('si la primera llave se agota pasa a la siguiente; si un modelo está saturado prueba el otro', async () => {
    const { prisma, db } = createMockPrisma();
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const key = init.headers.Authorization.slice(7);
      const model = JSON.parse(init.body).model;
      calls.push(`${key.slice(6, 10)}:${model}`);
      if (key === 'llave-uno-1111') return reply(429, { error: { status: 'RESOURCE_EXHAUSTED' } });
      if (model === 'modelo-a') return reply(503, { error: { message: 'high demand' } });
      return reply(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 30 } });
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    const r = await pool.chat({ messages: [{ role: 'user', content: 'hola' }], json: true });
    expect(r).toMatchObject({ content: '{"ok":true}', model: 'modelo-b', keyLabel: 'llave 2' });
    expect(calls).toEqual(['uno-:modelo-a', 'dos-:modelo-a', 'dos-:modelo-b']);
    // La llave 1 quedó agotada hoy: la siguiente llamada ni la intenta
    expect(db.aiKeyUsage.find((u: any) => u.fingerprint === fingerprint('llave-uno-1111'))?.exhaustedAt).toBeTruthy();
    calls.length = 0;
    await pool.chat({ messages: [{ role: 'user', content: 'otra' }] });
    expect(calls.every((c) => c.startsWith('dos-'))).toBe(true);
    // Nunca se guarda la llave, solo su huella
    expect(JSON.stringify(db.aiKeyUsage)).not.toContain('llave-dos-2222');
  });

  it('respeta el tope diario propio por llave y, sin llaves disponibles, avisa sin romper', async () => {
    const { prisma } = createMockPrisma();
    const fetchImpl = jest.fn(async () => reply(200, { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } }));
    const pool = new GeminiPool(prisma, fetchImpl as any);
    for (let i = 0; i < 4; i++) await pool.chat({ messages: [{ role: 'user', content: `${i}` }] });
    const status = await pool.status();
    expect(status.keys.map((k) => k.requestsToday)).toEqual([2, 2]);
    expect(status.keys.every((k) => k.exhausted)).toBe(true);
    expect(status.keys[0].label).not.toContain('llave-uno-1111');
    await expect(pool.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.GEMINI_API_KEYS = '';
    await expect(new GeminiPool(prisma, fetchImpl as any).chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('rubros: cada empresa ve lo suyo', () => {
  it('una tienda de ropa no ve cocina, comandas ni domicilios; un restaurante sí', () => {
    expect(guessRubro('Tienda de ropa y calzado para mujer en Envigado')).toBe('VENTAS');
    expect(guessRubro('Restaurante de almuerzos corrientazo con domicilio')).toBe('COMIDAS');
    expect(guessRubro('Consultorio odontológico, agendamos citas')).toBe('SERVICIOS');
    expect(guessRubro('Estudio webcam con 6 modelos')).toBe('WEBCAM');
    expect(guessRubro('algo que no se entiende')).toBe('VENTAS');
    const ropa = modulesForRubro('VENTAS');
    expect(ropa).toEqual(expect.arrayContaining(['orders', 'campaigns']));
    expect(ropa).not.toEqual(expect.arrayContaining(['production']));
    expect(ropa).not.toContain('delivery');
    expect(ropa).not.toContain('menu');
    expect(modulesForRubro('COMIDAS')).toEqual(expect.arrayContaining(['production', 'delivery', 'menu']));
    expect(modulesForRubro('SERVICIOS')).toContain('agenda');
    expect(modulesForRubro('SERVICIOS')).not.toContain('orders');
    expect(modulesForRubro('inventado')).not.toContain('orders');
  });

  it('los pasos pendientes dependen del rubro y del avance real', () => {
    const company = { name: 'X', contactPhone: '3001234567', orderConfigJson: JSON.stringify({ schedule: { days: [1] } }) };
    const comidas = onboardingChecklist({ rubro: 'COMIDAS', company, products: 3, bots: 1, connectedLines: 0, hasPayments: false, requestedPlan: false });
    expect(comidas.items.map((i) => i.key)).toContain('domicilios');
    expect(comidas.items.find((i) => i.key === 'catalogo')?.done).toBe(true);
    const servicios = onboardingChecklist({ rubro: 'SERVICIOS', company, products: 0, bots: 0, connectedLines: 1, hasPayments: true, requestedPlan: true });
    expect(servicios.items.map((i) => i.key)).not.toContain('domicilios');
    expect(servicios.items.find((i) => i.key === 'whatsapp')?.done).toBe(true);
    expect(servicios.percent).toBeGreaterThan(0);
    expect(whatsappDigits('300 123 4567')).toBe('573001234567');
    expect(whatsappDigits('+57 300 123 4567')).toBe('573001234567');
    expect(whatsappDigits('123')).toBeNull();
    expect(slugBase('Pizzería Doña Ana!!')).toBe('pizzeria-dona-ana');
  });
});

describe('registro por la web', () => {
  function setup(aiContent: string) {
    const { prisma, db } = createMockPrisma();
    db.plan.push({ id: 'p1', code: 'ventas-ventas', name: 'Ventas', line: 'VENTAS', active: true, priceMonthly: 199000, currency: 'COP', sortOrder: 1, minTermMonths: 6, featuresJson: '[]' });
    const emails = { systemSend: jest.fn(async () => ({ status: 'QUEUED' })) };
    const auth = { login: jest.fn(async (email: string) => ({ token: 't', user: { email } })) };
    const companies = new CompaniesService(prisma as any, audit as any);
    const service = new SignupService(prisma as any, audit as any, emails as any, companies, auth as any);
    (service as any).pool = { chat: jest.fn(async () => ({ content: aiContent, model: 'm', keyLabel: 'llave 1', tokens: 10 })) };
    return { db, service, emails, auth };
  }
  const AI = JSON.stringify({
    rubro: 'VENTAS', empresa: { nombre: 'Moda Luna', ciudad: 'Envigado', resumen: 'Ropa para mujer' },
    productos: [{ nombre: 'Blusa lino', categoria: 'Blusas', precio: '89.000' }, { nombre: 'Jean tiro alto', precio: 120000 }],
    horario: { dias: [1, 2, 3, 4, 5, 6], abre: '09:00', cierra: '19:00' },
    preguntas: [{ pregunta: '¿Hacen envíos?', respuesta: 'Sí, a todo el país.' }],
    asistente: { nombre: 'Luna', tono: 'cercano', estilo: 'corto', bienvenida: '¡Hola! Soy Luna', instrucciones: 'Vende ropa' },
  });

  it('la IA propone rubro, catálogo y asistente; describe poco o nada → pide más', async () => {
    const { service } = setup(AI);
    await expect(service.preview({ description: 'ropa' })).rejects.toBeInstanceOf(BadRequestException);
    const r = await service.preview({ description: 'Tengo una tienda de ropa para mujer en Envigado, blusas de lino a 89 mil y jeans a 120 mil.' });
    expect(r).toMatchObject({ rubro: 'VENTAS', company: { name: 'Moda Luna', city: 'Envigado' } });
    expect(r.proposal.products.map((p) => p.price)).toEqual([89000, 120000]);
    const bad = setup(JSON.stringify({ rubro: 'HACKER', productos: [] }));
    const r2 = await bad.service.preview({ description: 'Restaurante de almuerzos con domicilio en Laureles, todos los días' });
    expect(r2.rubro).toBe('COMIDAS'); // rubro inválido → clasificación propia
  });

  it('crea la empresa EN CONFIGURACIÓN con los módulos de su rubro, avisa al equipo y entra', async () => {
    const { db, service, emails, auth } = setup(AI);
    const preview = await service.preview({ description: 'Tienda de ropa para mujer en Envigado, blusas de lino a 89 mil y jeans a 120 mil.' });
    const res = await service.register({
      description: 'Tienda de ropa para mujer en Envigado', rubro: preview.rubro, proposal: preview.proposal,
      company: { name: 'Moda Luna', city: 'Envigado' }, acceptTerms: true,
      admin: { name: 'Laura Gómez', email: 'Laura@ModaLuna.co', phone: '300 555 1234', password: 'secreta123' },
    });
    expect(res).toMatchObject({ token: 't' });
    expect(auth.login).toHaveBeenCalledWith('laura@modaluna.co', 'secreta123');
    const company = db.company[0];
    expect(company).toMatchObject({ name: 'Moda Luna', status: 'ONBOARDING', currency: 'COP' });
    const modules = JSON.parse(company.modulesJson);
    expect(modules).toEqual(RUBRO_CONFIG.VENTAS.modules);
    expect(modules).not.toContain('production');
    expect(db.product.map((p: any) => p.name)).toEqual(['Blusa lino', 'Jean tiro alto']);
    expect(db.bot.filter((b: any) => b.companyId === company.id)).toHaveLength(1);
    expect(db.user[0]).toMatchObject({ email: 'laura@modaluna.co', role: 'COMPANY_ADMIN', companyId: company.id });
    expect(db.user[0].passwordHash).not.toBe('secreta123');
    expect(JSON.parse(company.onboardingJson)).toMatchObject({ source: 'SIGNUP', rubro: 'VENTAS', phone: '300 555 1234' });
    // Aviso al equipo con lo que falta y el WhatsApp
    expect(emails.systemSend).toHaveBeenCalledTimes(1);
    const mail = (emails.systemSend as jest.Mock).mock.calls[0][0];
    expect(mail.toEmail).toBe('restrepos591@gmail.com');
    expect(mail.subject).toContain('Moda Luna');
    expect(mail.body).toContain('wa.me/573005551234');
    expect(mail.body).toContain('Conectar tu WhatsApp');
    // Mismo correo otra vez → no duplica
    await expect(service.register({
      company: { name: 'Otra' }, acceptTerms: true,
      admin: { name: 'L', email: 'laura@modaluna.co', phone: '3005551234', password: 'secreta123' },
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('valida datos, términos y no rompe si el correo de aviso falla', async () => {
    const { db, service, emails } = setup(AI);
    const base = { company: { name: 'Mi Tienda' }, acceptTerms: true, admin: { name: 'Ana', email: 'ana@tienda.co', phone: '3001112233', password: 'clave1234' } };
    await expect(service.register({ ...base, acceptTerms: false })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.register({ ...base, admin: { ...base.admin, password: '123' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.register({ ...base, admin: { ...base.admin, phone: '12' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.register({ ...base, admin: { ...base.admin, email: 'no-es-correo' } })).rejects.toBeInstanceOf(BadRequestException);
    (emails.systemSend as jest.Mock).mockRejectedValueOnce(new Error('SMTP caído'));
    db.company.push({ id: 'old', name: 'Mi Tienda', slug: 'mi-tienda' }); // nombre repetido → slug distinto
    await service.register(base);
    const created = db.company.find((c: any) => c.id !== 'old')!;
    expect(created.slug).toMatch(/^mi-tienda-[a-z0-9]{4}$/);
    expect(created.status).toBe('ONBOARDING');
  });

  it('acompañamiento: responde con el estado real, respeta el cupo diario; el plan elegido avisa al equipo', async () => {
    const { db, service, emails } = setup('¡Vas muy bien! Te falta conectar tu WhatsApp.');
    db.company.push({ id: 'co1', name: 'Moda Luna', status: 'ONBOARDING', modulesJson: '[]', orderConfigJson: '{}', paymentConfigJson: '{}',
      onboardingJson: JSON.stringify({ source: 'SIGNUP', rubro: 'VENTAS', phone: '3005551234', contactName: 'Laura' }) });
    const st = await service.status(ADMIN);
    expect(st).toMatchObject({ rubro: 'VENTAS', chatLeft: 40 });
    expect(st.plans.map((p: any) => p.name)).toEqual(['Ventas']);
    const r = await service.chat(ADMIN, { messages: [{ role: 'user', content: '¿Qué me falta?' }] });
    expect(r).toMatchObject({ reply: expect.stringContaining('WhatsApp'), chatLeft: 39 });
    const prompt = ((service as any).pool.chat as jest.Mock).mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Moda Luna');
    expect(prompt).toContain('desde $199.000');
    await expect(service.chat(ADMIN, { messages: [] })).rejects.toBeInstanceOf(BadRequestException);
    // Cupo agotado
    const ob = JSON.parse(db.company[0].onboardingJson);
    db.company[0].onboardingJson = JSON.stringify({ ...ob, chat: { ...ob.chat, count: 40 } });
    await expect(service.chat(ADMIN, { messages: [{ role: 'user', content: 'hola' }] })).rejects.toBeInstanceOf(BadRequestException);
    // Elegir plan
    await expect(service.requestPlan(ADMIN, { planId: 'no-existe' })).rejects.toBeInstanceOf(BadRequestException);
    const plan = await service.requestPlan(ADMIN, { planId: 'p1', billingCycle: 'ANNUAL' });
    expect(plan.requestedPlan).toMatchObject({ name: 'Ventas', billingCycle: 'ANNUAL', amount: 1990000 });
    expect((emails.systemSend as jest.Mock).mock.calls.at(-1)![0].subject).toContain('eligió el plan Ventas');
    // Otra empresa no puede pedir el estado sin companyId
    await expect(service.status({ ...ADMIN, companyId: null })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
