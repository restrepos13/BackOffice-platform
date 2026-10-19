/**
 * Registro por la web: IA genérica con rotación de llaves, rubros que deciden
 * qué ve cada empresa, pasos pendientes, aviso al equipo y acompañamiento.
 */
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { GeminiPool, fingerprint } from '../src/ai/gemini-pool';
import { extractJson } from '../src/ai/types';
import { RUBRO_CONFIG, guessRubro, modulesForRubro, onboardingChecklist } from '../src/common/rubros';
import { SignupService, slugBase, whatsappDigits } from '../src/modules/signup.module';
import { CompaniesService } from '../src/modules/companies.module';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn(async () => undefined) };
/** Pool falso: chatJson sobre un chat simulado (igual que el real: JSON útil o AI_UNAVAILABLE). */
function fakePool(chat: jest.Mock) {
  return {
    chat,
    chatJson: async (opts: any, accept: (raw: any) => boolean) => {
      const r = await chat(opts);
      const raw = extractJson(r.content);
      if (raw && accept(raw)) return { raw, result: r, tokens: r.tokens ?? 0, calls: 1 };
      throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'x', tokens: r.tokens ?? 0, calls: 1 });
    },
  };
}

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
    (service as any).pool = fakePool(jest.fn(async () => ({ content: aiContent, model: 'm', keyLabel: 'llave 1', tokens: 10 })));
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

/* ═══ Entrevista y plano a la medida ═══ */

import { normalizeBlueprint, normalizeInterviewTurn, revalidateBlueprint, assistantPromptFromBlueprint, agentPresetFor } from '../src/common/blueprint';
import { entryStageFor, wonStageFor } from '../src/common/pipelines';

describe('entrevista: la IA pregunta cómo funciona el negocio', () => {
  function setupInterview(content: string) {
    const { prisma } = createMockPrisma();
    const service = new SignupService(prisma as any, audit as any, {} as any, {} as any, {} as any);
    const chat = jest.fn(async () => ({ content, model: 'm', keyLabel: 'llave 1', tokens: 5 }));
    (service as any).pool = fakePool(chat);
    return { service, chat };
  }

  const START = [{ role: 'user', content: 'Somos un centro de entrenamiento y certificación en trabajo seguro en alturas en Itagüí' }];
  const NAMED_ONLY = [...START, { role: 'assistant', content: '¿Cómo se llama tu negocio?' }, { role: 'user', content: 'Alturas Seguras, en Itagüí' }];
  const NAMED = [...NAMED_ONLY, { role: 'assistant', content: '¿Más o menos cuántos clientes te escriben al día?' }, { role: 'user', content: '10 a 30' }];

  it('la primera pregunta (nombre y ciudad) es fija y no gasta IA; después pregunta la IA con opciones', async () => {
    const { service, chat } = setupInterview(JSON.stringify({ listo: false, pregunta: '¿Tus clientes son personas o empresas?', opciones: ['Personas', 'Empresas', 'Ambas'], nota: 'Certificas trabajo en alturas' }));
    await expect(service.interview({ messages: [] })).rejects.toBeInstanceOf(BadRequestException);
    const first = await service.interview({ messages: START });
    expect(first).toMatchObject({ done: false, question: expect.stringContaining('Cómo se llama') });
    const second = await service.interview({ messages: NAMED_ONLY });
    expect(second).toMatchObject({ done: false, question: expect.stringContaining('cuántos clientes'), options: expect.arrayContaining(['10 a 30']) });
    expect(chat).not.toHaveBeenCalled();
    const turn = await service.interview({ messages: NAMED });
    expect(turn).toMatchObject({ done: false, question: '¿Tus clientes son personas o empresas?', options: ['Personas', 'Empresas', 'Ambas'], mode: 'ai' });
    // El prompt se adapta al negocio y no se trae roles inventados del navegador
    const sent = (chat.mock.calls[0] as any[])[0].messages;
    expect(sent[0].content).toContain('A LA MEDIDA');
    expect(sent).toHaveLength(6);
    
  });

  it('nunca se alarga más de 8 respuestas y respeta cuando la IA dice listo', async () => {
    const { service, chat } = setupInterview(JSON.stringify({ listo: true }));
    const long = Array.from({ length: 8 }, (_, i) => [{ role: 'assistant', content: `p${i}` }, { role: 'user', content: `respuesta número ${i} con detalle` }]).flat();
    expect(await service.interview({ messages: long })).toMatchObject({ done: true });
    expect(chat).not.toHaveBeenCalled(); // tope: ni llama a la IA
    expect(await service.interview({ messages: NAMED })).toMatchObject({ done: true });
    expect(normalizeInterviewTurn({ pregunta: '' }, 1, 8).done).toBe(true);
  });

  it('si ninguna IA responde (o responde basura) sigue con preguntas fijas: nadie se queda trabado', async () => {
    const { service } = setupInterview('');
    (service as any).pool = fakePool(jest.fn(async () => { throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'ocupada' }); }));
    const turn = await service.interview({ messages: NAMED });
    expect(turn).toMatchObject({ done: false, mode: 'guided' });
    expect(turn.question.length).toBeGreaterThan(5);
    expect(turn.options.length).toBeGreaterThan(1);
    (service as any).pool = fakePool(jest.fn(async () => ({ content: 'no sé', model: 'm', keyLabel: 'k', tokens: 1 })));
    expect(await service.interview({ messages: NAMED })).toMatchObject({ done: false, mode: 'guided' });
  });
});

describe('plan B del plano y seguimiento del registro', () => {
  const MSGS = [
    { role: 'user', content: 'Tengo una panadería, vendo pan y tortas por encargo a domicilio' },
    { role: 'assistant', content: '¿Cómo se llama tu negocio?' },
    { role: 'user', content: 'Panadería Doña Rosa en Envigado' },
  ];

  it('sin IA arma un plano básico con el nombre, el tipo de negocio y un asistente', async () => {
    const { prisma } = createMockPrisma();
    const service = new SignupService(prisma as any, audit as any, {} as any, {} as any, {} as any);
    (service as any).pool = fakePool(jest.fn(async () => { throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'x' }); }));
    const r: any = await service.preview({ messages: MSGS });
    expect(r.mode).toBe('guided');
    expect(r.rubro).toBe('COMIDAS');
    expect(r.company.name).toBe('Panadería Doña Rosa');
    expect(r.company.city).toBe('Envigado');
    expect(r.proposal.assistant.welcome).toContain('Doña Rosa');
    expect(r.blueprint.modules).toEqual(expect.arrayContaining(['orders', 'menu']));
  });

  it('el mismo plano no se vuelve a pedir a la IA (volver atrás no gasta)', async () => {
    const { prisma } = createMockPrisma();
    const service = new SignupService(prisma as any, audit as any, {} as any, {} as any, {} as any);
    const chat = jest.fn(async () => ({ content: JSON.stringify({ rubro: 'COMIDAS', empresa: { nombre: 'Doña Rosa' }, asistente: { nombre: 'Rosa', bienvenida: 'Hola' } }), model: 'm', keyLabel: 'k', tokens: 900 }));
    (service as any).pool = fakePool(chat);
    await service.preview({ messages: MSGS });
    await service.preview({ messages: MSGS });
    expect(chat).toHaveBeenCalledTimes(1);
    
  });

  it('cada intento queda registrado: paso, respuestas, consumo de IA, contacto y errores; el paso nunca retrocede', async () => {
    const { prisma, db } = createMockPrisma();
    const service = new SignupService(prisma as any, audit as any, {} as any, {} as any, {} as any);
    (service as any).pool = fakePool(jest.fn(async () => ({ content: '{"listo":false,"pregunta":"¿A quién le vendes?","opciones":["A","B"]}', model: 'm', keyLabel: 'k', tokens: 120 })));
    const session = 'sesion-de-prueba-1234567890';
    await service.track({ session, event: 'view', step: 'STARTED', utmSource: 'Facebook', utmCampaign: 'lanzamiento-oct' }, { utmSource: 'Facebook', utmCampaign: 'lanzamiento-oct' } as any);
    await service.interview({ session, messages: [...MSGS, { role: 'assistant', content: '¿Más o menos cuántos clientes te escriben al día?' }, { role: 'user', content: '30 a 100' }] });
    await service.track({ session, event: 'contact', data: { name: 'Rosa', email: 'rosa@panaderia.co', phone: '300 123 4567' } });
    await service.track({ session, event: 'error', step: 'ACCOUNT', message: 'Ese correo ya tiene una cuenta' });
    await service.track({ session, event: 'view', step: 'INTERVIEW' }); // volver atrás
    const row = db.signupSession[0];
    expect(row).toMatchObject({ step: 'ACCOUNT', answers: 3, aiCalls: 1, aiTokens: 120, email: 'rosa@panaderia.co', contactName: 'Rosa', dailyChats: 65, utmSource: 'facebook', utmCampaign: 'lanzamiento-oct' });
    expect(JSON.parse(row.errorsJson)[0].message).toContain('correo');
    // Tokens inválidos se ignoran sin romper nada
    expect(await service.track({ session: 'x', event: 'view' })).toEqual({ ok: true });
    expect(db.signupSession).toHaveLength(1);
  });

  it('el equipo ve el embudo, quién abandonó, y agenda la reunión', async () => {
    const { prisma, db } = createMockPrisma();
    const service = new SignupService(prisma as any, audit as any, {} as any, {} as any, {} as any);
    const old = new Date(Date.now() - 2 * 3600e3);
    db.signupSession.push(
      { id: 's1', token: 't1', step: 'DONE', answers: 5, aiCalls: 3, aiTokens: 3000, followStatus: 'NEW', createdAt: new Date(), lastSeenAt: new Date(), companyId: 'c1', phone: '3001234567' },
      { id: 's2', token: 't2', step: 'PREVIEW', answers: 4, aiCalls: 2, aiTokens: 2000, followStatus: 'NEW', createdAt: old, lastSeenAt: old, email: 'a@b.co' },
      { id: 's3', token: 't3', step: 'STARTED', answers: 0, aiCalls: 0, aiTokens: 0, followStatus: 'NEW', createdAt: old, lastSeenAt: old },
    );
    const r = await service.tracker.list({});
    expect(r.funnel.map((f: any) => f.count)).toEqual([3, 2, 2, 1, 1]);
    expect(r.totals).toMatchObject({ done: 1, abandoned: 2, pendingFollow: 2, avgTokens: 2500 });
    expect(r.sessions.find((x: any) => x.id === 's1').whatsapp).toBe('573001234567');
    const v = await service.tracker.follow({ name: 'Santi' } as any, 's2', { meetingAt: '2026-10-21T15:00:00.000Z', followNotes: 'Llamar martes' });
    expect(v).toMatchObject({ followStatus: 'MEETING', followBy: 'Santi', followNotes: 'Llamar martes' });
    await expect(service.tracker.follow({ name: 'S' } as any, 's2', { followStatus: 'HACKEADO' })).rejects.toBeInstanceOf(BadRequestException);
    // Solo se avisa del abandono si dejó cómo contactarlo
    const pending = await service.tracker.pendingNotifications();
    expect(pending.map((p: any) => p.id)).toEqual(['s2']);
  });
});

describe('plano a la medida (centro de certificación en alturas)', () => {
  const RAW = {
    rubro: 'SERVICIOS', tipo_negocio: 'Centro de entrenamiento en trabajo en alturas',
    necesidades: [{ titulo: 'Inscribir trabajadores de empresas', como_lo_resuelve: 'El asistente toma los datos y agenda el curso' }, { titulo: '', como_lo_resuelve: 'x' }],
    herramientas: ['agenda', 'campaigns', 'hackear', 'delivery'],
    embudo: { nombre: 'Inscripciones', etapas: [{ nombre: 'Interesado' }, { nombre: 'Documentos enviados' }, { nombre: 'Pagó', tipo: 'abierta' }, { nombre: 'Certificado', tipo: 'ganada' }, { nombre: 'No continuó', tipo: 'perdida' }] },
    datos_cliente: ['Nombre completo', 'Cédula', 'EPS y ARL', 'Empresa'],
    flujo_asistente: ['Saluda y pregunta qué curso necesita', 'Explica requisitos', 'Pide datos y agenda'],
    respuestas_rapidas: [{ atajo: '/Requisitos ', titulo: 'Requisitos', texto: 'Trae cédula y certificado de EPS' }, { atajo: 'requisitos', titulo: 'Dup', texto: 'x' }],
    seguimientos: [{ cuando: 'no_reply', horas: 50, mensaje: '¿Te reservo el cupo?' }, { cuando: 'x', horas: 2, mensaje: '' }],
  };

  it('valida y recorta: herramientas reales, embudo propio, sin duplicados ni basura', () => {
    const bp = normalizeBlueprint(RAW, 'VENTAS');
    expect(bp.rubro).toBe('SERVICIOS');
    expect(bp.modules).toEqual(['agenda', 'campaigns']); // sin "hackear"; domicilios sin pedidos no aplica
    expect(bp.pipeline?.stages.map((s) => s.key)).toEqual(['INTERESADO', 'DOCUMENTOS_ENVIADOS', 'PAGO', 'CERTIFICADO', 'NO_CONTINUO']);
    expect(bp.pipeline?.stages.find((s) => s.kind === 'WON')?.label).toBe('Certificado');
    expect(bp.needs).toHaveLength(1);
    expect(bp.quickReplies).toEqual([{ shortcut: 'requisitos', title: 'Requisitos', body: 'Trae cédula y certificado de EPS' }]);
    expect(bp.followUps).toEqual([{ when: 'no_reply', afterHours: 23, message: '¿Te reservo el cupo?' }]);
    const prompt = assistantPromptFromBlueprint('Atiendes el WhatsApp de Alturas Seguras.', bp);
    expect(prompt).toContain('1. Saluda y pregunta qué curso necesita');
    expect(prompt).toContain('Cédula, EPS y ARL');
    expect(agentPresetFor(bp.modules)).toBe('solo_consultas');
    expect(agentPresetFor(['orders', 'delivery'])).toBe('domicilios');
    // Lo editado por el dueño vuelve a validarse (y puede apagar todo)
    const edited = revalidateBlueprint({ ...bp, modules: ['agenda', 'orders', 'menu', 'nope'], pipeline: { name: 'X', stages: [{ label: 'Solo una', kind: 'OPEN' }] } }, 'SERVICIOS');
    expect(edited.modules).toEqual(['agenda', 'orders', 'menu']);
    expect(edited.pipeline).toBeNull(); // 1 etapa no es un embudo → estándar
    expect(revalidateBlueprint({ ...bp, modules: [] }, 'SERVICIOS').modules).toEqual([]);
  });

  it('la cuenta nace con SU embudo, respuestas, seguimientos y herramientas; los contactos entran al embudo propio', async () => {
    const { prisma, db } = createMockPrisma();
    const emails = { systemSend: jest.fn(async () => ({ status: 'QUEUED' })) };
    const auth = { login: jest.fn(async () => ({ token: 't' })) };
    const service = new SignupService(prisma as any, audit as any, emails as any, new CompaniesService(prisma as any, audit as any), auth as any);
    (service as any).pool = fakePool(jest.fn(async () => ({ content: JSON.stringify({ ...RAW, empresa: { nombre: 'Alturas Seguras' }, productos: [{ nombre: 'Curso avanzado', precio: '380.000' }], asistente: { nombre: 'Camila', bienvenida: 'Hola, soy Camila', instrucciones: 'Atiendes inscripciones' } }), model: 'm', keyLabel: 'l', tokens: 1 })));
    const messages = [
      { role: 'user', content: 'Centro de certificación en trabajo en alturas en Itagüí, cursos para trabajadores' },
      { role: 'assistant', content: '¿Personas o empresas?' },
      { role: 'user', content: 'Sobre todo empresas que mandan grupos, también personas' },
    ];
    const pv = await service.preview({ messages });
    expect(pv.blueprint.businessType).toBe('Centro de entrenamiento en trabajo en alturas');
    await service.register({
      messages, rubro: pv.rubro, proposal: pv.proposal, blueprint: pv.blueprint, acceptTerms: true,
      company: { name: 'Alturas Seguras', city: 'Itagüí' },
      admin: { name: 'Jorge', email: 'jorge@alturas.co', phone: '3104445566', password: 'segura123' },
    });
    const company = db.company[0];
    expect(company.industry).toBe('Centro de entrenamiento en trabajo en alturas');
    const modules = JSON.parse(company.modulesJson);
    expect(modules).toEqual(expect.arrayContaining(['inbox', 'contacts', 'bots', 'agenda', 'campaigns']));
    expect(modules).not.toContain('orders');
    expect(db.pipeline[0]).toMatchObject({ companyId: company.id, name: 'Inscripciones', isDefault: true });
    expect(db.quickReply.map((r: any) => r.shortcut)).toEqual(['requisitos']);
    expect(JSON.parse(company.orderConfigJson).followUps[0]).toMatchObject({ enabled: true, afterHours: 23 });
    const bot = db.bot.find((b: any) => b.companyId === company.id)!;
    expect(bot.systemPrompt).toContain('Datos que debes pedirle al cliente');
    expect(bot.engineMode).toBe('AGENT');
    const ob = JSON.parse(company.onboardingJson);
    expect(ob).toMatchObject({ businessType: 'Centro de entrenamiento en trabajo en alturas', clientData: ['Nombre completo', 'Cédula', 'EPS y ARL', 'Empresa'] });
    expect(ob.interview).toHaveLength(3);
    const mail = (emails.systemSend as jest.Mock).mock.calls[0][0];
    expect(mail.body).toContain('Lo que necesita');
    expect(mail.body).toContain('Sobre todo empresas');
    // Contactos nuevos entran a "Interesado"; al cerrar pasan a "Certificado"
    expect(await entryStageFor(prisma, company.id)).toEqual({ pipelineId: db.pipeline[0].id, stage: 'INTERESADO' });
    expect(await wonStageFor(prisma, db.pipeline[0].id)).toBe('CERTIFICADO');
    expect(await wonStageFor(prisma, null)).toBe('CLIENTE');
  });
});
