/**
 * Registro con contacto primero: paso 0 (aviso, correo, Lead), embudo por
 * pregunta y por fuente, tiempo hasta el primer contacto, enlace para retomar,
 * API de Conversiones de Meta y el lector del link opcional.
 */
import { SignupService } from '../src/modules/signup.module';
import {
  SignupTracker, inBusinessHours, readResumeToken, resumeToken, sourceOf,
} from '../src/modules/signup-tracking';
import { capiConfig, capiPayload, normalizePhone, sendCapiEvent } from '../src/common/meta-capi';
import { normalizeLink, peekLink, peekLine, privateAddress } from '../src/common/site-peek';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn() };
const TOKEN = 'sesion-de-prueba-registro-0001';

function setup() {
  const { prisma, db } = createMockPrisma();
  const emails = { systemSend: jest.fn(async () => ({})) };
  const alerts = { send: jest.fn(async () => true) };
  const service = new SignupService(prisma as any, audit as any, emails as any, {} as any, {} as any, alerts as any);
  return { service, db, emails, alerts, prisma };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('Paso 0: contacto primero', () => {
  const OLD_ENV = process.env;
  beforeEach(() => { process.env = { ...OLD_ENV }; delete process.env.META_CAPI_PIXEL_ID; delete process.env.META_CAPI_TOKEN; });
  afterAll(() => { process.env = OLD_ENV; });

  it('valida negocio, WhatsApp y autorización (sin gastar IA)', async () => {
    const { service } = setup();
    await expect(service.startContact({ session: TOKEN, companyName: 'A', phone: '3001234567', accept: true })).rejects.toMatchObject({ response: { field: 'companyName' } });
    await expect(service.startContact({ session: TOKEN, companyName: 'Doña Rosa', phone: '300', accept: true })).rejects.toMatchObject({ response: { field: 'phone' } });
    await expect(service.startContact({ session: TOKEN, companyName: 'Doña Rosa', phone: '3001234567', email: 'rosa@', accept: true })).rejects.toMatchObject({ response: { field: 'email' } });
    await expect(service.startContact({ session: TOKEN, companyName: 'Doña Rosa', phone: '3001234567' })).rejects.toMatchObject({ response: { field: 'accept' } });
    await expect(service.startContact({ session: 'x', companyName: 'Doña Rosa', phone: '3001234567', accept: true })).rejects.toMatchObject({ response: { field: 'session' } });
  });

  it('queda «Dejó contacto» y «Por contactar» aunque se vaya; avisa a Telegram con WhatsApp y fuente; correo si lo dejó', async () => {
    const { service, db, alerts, emails } = setup();
    await service.event({ session: TOKEN, type: 'registro_abierto' }, { utmSource: 'meta', utmCampaign: 'prueba_3dias', fbclid: 'IwAR0abcdefgh', g: undefined });
    await service.startContact({ session: TOKEN, companyName: 'Doña Rosa', phone: '300 123 4567', email: 'rosa@gmail.com', accept: true }, {});
    await flush();
    const s = db.signupSession.find((x: any) => x.token === TOKEN)!;
    expect(s).toMatchObject({ step: 'CONTACT', businessName: 'Doña Rosa', phone: '300 123 4567', email: 'rosa@gmail.com', utmCampaign: 'prueba_3dias' });
    expect(s.contactAt).toBeInstanceOf(Date);
    expect(db.signupEvent.map((e: any) => e.type)).toEqual(['registro_abierto', 'contacto_dejado']);
    // Aviso al celular: negocio, WhatsApp, en qué paso va y de dónde vino, con botón de WhatsApp
    expect(alerts.send).toHaveBeenCalledTimes(1);
    const [kind, html, button] = (alerts.send as jest.Mock).mock.calls[0];
    expect(kind).toBe('SIGNUP_CONTACT');
    expect(html).toContain('Doña Rosa');
    expect(html).toContain('300 123 4567');
    expect(html).toContain('antes de la pregunta 1 de 5');
    expect(html).toContain('Anuncio de Meta');
    expect(html).toContain('prueba_3dias');
    expect(button.url).toMatch(/^https:\/\/wa\.me\/573001234567\?text=/);
    expect(decodeURIComponent(button.url)).toContain('Doña Rosa');
    // Correo inmediato
    expect(emails.systemSend).toHaveBeenCalledWith(expect.objectContaining({ toEmail: 'rosa@gmail.com', subject: 'Recibimos tu solicitud · BackOffice' }));
    expect((emails.systemSend as jest.Mock).mock.calls[0][0].body).toContain('Te escribimos en minutos por WhatsApp');
    // Aparece en «Por contactar» aunque no responda nada más
    const r = await service.tracker.list({ state: 'TODO' });
    expect(r.sessions.map((x: any) => x.id)).toEqual([s.id]);
    expect(r.funnel.find((f: any) => f.step === 'CONTACT')!.count).toBe(1);
    // Mandarlo otra vez (reintento) no repite el aviso
    await service.startContact({ session: TOKEN, companyName: 'Doña Rosa', phone: '300 123 4567', accept: true }, {});
    await flush();
    expect(alerts.send).toHaveBeenCalledTimes(1);
  });

  it('con la API de Conversiones configurada manda Lead con el event_id del píxel', async () => {
    process.env.META_CAPI_PIXEL_ID = '1234567890';
    process.env.META_CAPI_TOKEN = 'token-de-prueba';
    const fetchMock = jest.fn(async () => ({ ok: true }));
    const realFetch = global.fetch;
    (global as any).fetch = fetchMock;
    try {
      const { service } = setup();
      await service.startContact({ session: TOKEN, companyName: 'Doña Rosa', phone: '3001234567', accept: true }, {}, { ip: '181.1.2.3', userAgent: 'Android', fbp: 'fb.1.1700000000000.123456' });
      await flush();
      const call = (fetchMock.mock.calls as any[]).find(([url]) => String(url).includes('graph.facebook.com'));
      expect(call[0]).toBe('https://graph.facebook.com/v25.0/1234567890/events');
      const body = JSON.parse(call[1].body);
      expect(body.data[0]).toMatchObject({ event_name: 'Lead', event_id: `lead-${TOKEN}`, action_source: 'website' });
      expect(body.data[0].user_data.ph[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(body)).not.toContain('3001234567');
    } finally {
      (global as any).fetch = realFetch;
    }
  });
});

describe('Embudo detallado', () => {
  it('cuenta cada pantalla y cada pregunta una vez por persona, con % de abandono y tiempo', async () => {
    const { service, db } = setup();
    const t = (n: number) => `sesion-embudo-detalle-${String(n).padStart(4, '0')}`;
    for (let i = 1; i <= 4; i++) await service.event({ session: t(i), type: 'registro_abierto' });
    for (let i = 1; i <= 3; i++) await service.event({ session: t(i), type: 'presentacion_vista' });
    for (let i = 1; i <= 2; i++) {
      await service.event({ session: t(i), type: 'pregunta_vista', questionNo: 1, questionId: 'tipo' });
      await service.event({ session: t(i), type: 'pregunta_vista', questionNo: 1 }); // recargó: no cuenta doble
    }
    await service.event({ session: t(1), type: 'pregunta_respondida', questionNo: 1, progress: { tipo: 'Restaurante o comidas', inventada: 'x' } });
    // Tiempo de la pregunta 1: 40 s
    const vista = db.signupEvent.find((e: any) => e.type === 'pregunta_vista' && e.sessionId === db.signupSession[0].id)!;
    vista.at = new Date(Date.now() - 40_000);
    // Tipos y números inválidos se ignoran
    await service.event({ session: t(1), type: 'hackeo' });
    await service.event({ session: t(1), type: 'pregunta_vista', questionNo: 9 });

    const r = await service.tracker.list({});
    const pre = Object.fromEntries(r.detail.pre.map((p: any) => [p.type, p.count]));
    expect(pre).toMatchObject({ registro_abierto: 4, presentacion_vista: 3, formulario_visto: 0 });
    expect(r.detail.questions[0]).toMatchObject({ n: 1, viewed: 2, answered: 1, dropPct: 50 });
    expect(r.detail.questions[0].avgSeconds).toBeGreaterThanOrEqual(39);
    expect(r.detail.questions[1]).toMatchObject({ n: 2, viewed: 0, answered: 0, dropPct: null });
    // El avance queda guardado (solo preguntas conocidas) y el panel dice en qué pregunta va
    const s1 = r.sessions.find((x: any) => x.answersMap.tipo);
    expect(s1.answersMap).toEqual({ tipo: 'Restaurante o comidas' });
    expect(r.sessions.find((x: any) => x.questionNo === 1 && !x.answersMap.tipo).stepLabel).toBe('Respondiendo preguntas · pregunta 1 de 5');
  });

  it('desglosa y filtra por fuente: anuncio de Meta, grupos por ciudad, orgánico y directo', async () => {
    const { service } = setup();
    await service.event({ session: 'sesion-fuente-meta-000001', type: 'registro_abierto' }, { fbclid: 'IwAR0abcdefgh' });
    await service.event({ session: 'sesion-fuente-grupo-00001', type: 'registro_abierto' }, { g: 'manizales' });
    await service.event({ session: 'sesion-fuente-grupo-00002', type: 'registro_abierto' }, { g: 'pereira' });
    await service.event({ session: 'sesion-fuente-google-0001', type: 'registro_abierto' }, { referrer: 'https://www.google.com/' });
    await service.event({ session: 'sesion-fuente-propia-0001', type: 'registro_abierto' }, { referrer: 'https://www.backoffice.store/' });
    const r = await service.tracker.list({});
    expect(Object.fromEntries(r.bySource.map((b: any) => [b.label, b.sessions]))).toEqual({
      'Anuncio de Meta': 1, 'Grupos · Manizales': 1, 'Grupos · Pereira': 1, 'Orgánico': 1, 'Directo': 1,
    });
    expect((await service.tracker.list({ source: 'GRUPOS' })).totals.sessions).toBe(2);
    expect((await service.tracker.list({ source: 'GRUPOS:pereira' })).totals.sessions).toBe(1);
    expect((await service.tracker.list({ source: 'META_AD' })).detail.pre[0].count).toBe(1);
  });

  it('la fuente se clasifica igual en los avisos', () => {
    expect(sourceOf({ g: 'cali', fbclid: 'IwAR0' }).label).toBe('Grupos · Cali');
    expect(sourceOf({ utmSource: 'instagram' }).key).toBe('META_AD');
    expect(sourceOf({ utmSource: 'grupos' }).key).toBe('GRUPOS');
    expect(sourceOf({ utmSource: 'tiktok' }).label).toBe('Campaña · tiktok');
    expect(sourceOf({ referrer: 'https://backoffice.store/precios' }).key).toBe('DIRECT');
  });
});

describe('Primer contacto del equipo', () => {
  it('marcar «Contactado» guarda quién y cuándo, una sola vez, y el panel mide el tiempo', async () => {
    const { service, db } = setup();
    // Martes 10:00 a. m. en Bogotá
    const contactAt = new Date('2026-11-24T15:00:00.000Z');
    db.signupSession.push(
      { id: 'a', token: 'ta', step: 'CONTACT', answers: 0, aiCalls: 0, aiTokens: 0, followStatus: 'NEW', createdAt: new Date(), lastSeenAt: new Date(), phone: '3001234567', contactAt },
      { id: 'b', token: 'tb', step: 'CONTACT', answers: 0, aiCalls: 0, aiTokens: 0, followStatus: 'NEW', createdAt: new Date(), lastSeenAt: new Date(), phone: '3007654321', contactAt },
    );
    jest.useFakeTimers({ now: new Date(contactAt.getTime() + 3 * 60e3), doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const v = await service.tracker.follow({ name: 'Santi' } as any, 'a', { followStatus: 'CONTACTED' });
      expect(v).toMatchObject({ firstContactBy: 'Santi', responseMinutes: 3 });
      jest.setSystemTime(new Date(contactAt.getTime() + 60 * 60e3));
      await service.tracker.follow({ name: 'Dani' } as any, 'a', { followStatus: 'MEETING' }); // no cambia el primero
    } finally {
      jest.useRealTimers();
    }
    expect(db.signupSession[0].firstContactBy).toBe('Santi');
    const r = await service.tracker.list({});
    expect(r.response).toMatchObject({ contacted: 1, waiting: 1, medianMinutes: 3, under5InHoursPct: 100, inHours: 1 });
  });

  it('horario laboral: lunes a viernes 8–6 y sábado 9–12 (Bogotá)', () => {
    expect(inBusinessHours(new Date('2026-11-24T15:00:00.000Z'))).toBe(true); // martes 10 a. m.
    expect(inBusinessHours(new Date('2026-11-25T02:00:00.000Z'))).toBe(false); // martes 9 p. m.
    expect(inBusinessHours(new Date('2026-11-28T15:00:00.000Z'))).toBe(true); // sábado 10 a. m.
    expect(inBusinessHours(new Date('2026-11-29T15:00:00.000Z'))).toBe(false); // domingo
  });
});

describe('Retomar desde el correo', () => {
  beforeAll(() => { process.env.JWT_SECRET = 'secreto-de-prueba-para-firmas-0123456789'; });

  it('el enlace está firmado y vence a las 72 horas', () => {
    const t = resumeToken('s1', Date.now());
    expect(readResumeToken(t)).toBe('s1');
    expect(readResumeToken(t, Date.now() + 73 * 3600e3)).toBeNull();
    const [body, sig] = t.split('.');
    expect(readResumeToken(`${Buffer.from('s2.9999999999').toString('base64url')}.${sig}`)).toBeNull(); // otro id con la misma firma
    expect(readResumeToken(`${body}.${'x'.repeat(sig.length)}`)).toBeNull();
    expect(readResumeToken('basura')).toBeNull();
  });

  it('a los 30 min sin actividad manda «Te quedaste en la pregunta X» una sola vez, y el enlace retoma donde iba', async () => {
    const { service, db, emails } = setup();
    const old = new Date(Date.now() - 45 * 60e3);
    db.platformSetting.push({ key: 'PUBLIC_WEB_URL', value: 'https://www.backoffice.store' });
    db.signupSession.push({
      id: 'r1', token: 'sesion-para-retomar-00001', step: 'INTERVIEW', questionNo: 3, answers: 2, aiCalls: 0, aiTokens: 0, followStatus: 'NEW',
      createdAt: old, lastSeenAt: old, email: 'rosa@gmail.com', phone: '3001234567', businessName: 'Doña Rosa',
      progressJson: JSON.stringify({ answers: { tipo: 'Restaurante o comidas', oferta: 'Almuerzos $18.000' } }),
    });
    expect(await service.sendResumeEmails()).toBe(1);
    expect(await service.sendResumeEmails()).toBe(0);
    const mail = (emails.systemSend as jest.Mock).mock.calls[0][0];
    expect(mail.subject).toBe('Te quedaste en la pregunta 3 · BackOffice');
    const link = mail.body.match(/href="([^"]+)"/)[1];
    expect(link).toMatch(/^https:\/\/www\.backoffice\.store\/registro\?retomar=/);
    expect(mail.storedBody).not.toContain('retomar='); // en la base no queda el enlace
    const t = decodeURIComponent(link.split('retomar=')[1]);
    expect(await service.resume({ t })).toEqual({
      session: 'sesion-para-retomar-00001', questionNo: 3, link: null,
      answers: { tipo: 'Restaurante o comidas', oferta: 'Almuerzos $18.000' },
      contact: { companyName: 'Doña Rosa', phone: '3001234567', email: 'rosa@gmail.com' },
    });
    await expect(service.resume({ t: 'x.y' })).rejects.toThrow(/venció o no es válido/);
  });
});

describe('Contacto rápido', () => {
  it('«Que me escriban hoy» queda en el registro y avisa al celular; sin WhatsApp no se puede', async () => {
    const { service, db, alerts } = setup();
    db.signupSession.push({ id: 'q1', token: 'sesion-contacto-rapido-01', step: 'INTERVIEW', questionNo: 2, answers: 1, aiCalls: 0, aiTokens: 0, followStatus: 'NEW', createdAt: new Date(), lastSeenAt: new Date(), phone: '3001234567', businessName: 'Doña Rosa' });
    expect(await service.quickContact({ session: 'sesion-contacto-rapido-01', kind: 'TODAY' })).toMatchObject({ ok: true, kind: 'TODAY' });
    expect(db.signupSession[0].contactPreference).toBe('TODAY');
    expect((alerts.send as jest.Mock).mock.calls[0][1]).toContain('Pidió que le escriban hoy');
    db.signupSession.push({ id: 'q2', token: 'sesion-contacto-rapido-02', step: 'STARTED', answers: 0, aiCalls: 0, aiTokens: 0, followStatus: 'NEW', createdAt: new Date(), lastSeenAt: new Date() });
    await expect(service.quickContact({ session: 'sesion-contacto-rapido-02', kind: 'TODAY' })).rejects.toMatchObject({ response: { field: 'phone' } });
    // Videollamada con una hora que no está libre
    await expect(service.quickContact({ session: 'sesion-contacto-rapido-01', kind: 'CALL', at: '2020-01-01T15:00:00.000Z' })).rejects.toMatchObject({ response: { field: 'at' } });
  });
});

describe('API de Conversiones de Meta', () => {
  it('apagada sin variables; con ellas, datos en SHA-256 y fbc armado con el fbclid', async () => {
    expect(capiConfig({})).toBeNull();
    expect(capiConfig({ META_CAPI_PIXEL_ID: 'abc', META_CAPI_TOKEN: 't' })).toBeNull();
    expect(await sendCapiEvent({ name: 'Lead', eventId: 'lead-x' }, jest.fn() as any, {})).toBe(false);
    const p = capiPayload({ name: 'CompleteRegistration', eventId: 'reg-x', phone: '300 123 4567', email: ' Rosa@Gmail.com ', firstName: 'Rosa Pérez', fbclid: 'IwAR0abc', clickAt: new Date(1700000000000) }, 1700000100000);
    expect(normalizePhone('300 123 4567')).toBe('573001234567');
    expect(p).toMatchObject({ event_name: 'CompleteRegistration', event_id: 'reg-x', event_time: 1700000100 });
    expect(p.user_data.fbc).toBe('fb.1.1700000000000.IwAR0abc');
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/rosa|3001234567/i);
  });
});

describe('Link opcional (Instagram o web)', () => {
  it('Instagram no se lee: se guarda el usuario', async () => {
    expect(await peekLink('@donarosa.co')).toMatchObject({ kind: 'social', network: 'Instagram', handle: '@donarosa.co' });
    expect(peekLine(await peekLink('instagram.com/donarosa'))).toContain('no inventes nada');
  });

  it('una web se lee (título y descripción) solo si resuelve a una dirección pública, sin seguir redirecciones', async () => {
    const html = '<html><head><title>Doña Rosa · Almuerzos</title><meta name="description" content="Almuerzos caseros a domicilio en Medellín"></head>';
    const fetchMock = jest.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const p = await peekLink('donarosa.co', fetchMock as any, async () => ['93.184.216.34']);
    expect(p).toMatchObject({ kind: 'web', title: 'Doña Rosa · Almuerzos', description: 'Almuerzos caseros a domicilio en Medellín' });
    expect((fetchMock.mock.calls[0] as any[])[1].redirect).toBe('manual');
    const internal = jest.fn();
    expect(await peekLink('intranet.local.co', internal as any, async () => ['10.0.0.5'])).toMatchObject({ kind: 'web' });
    expect(internal).not.toHaveBeenCalled();
    expect(await peekLink('https://127.0.0.1/admin', internal as any)).toMatchObject({ kind: 'web' });
    expect(internal).not.toHaveBeenCalled();
    expect(normalizeLink('javascript:alert(1)')).toBeNull();
    expect(normalizeLink('https://user:pass@x.co')).toBeNull();
    expect(['10.1.1.1', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1'].every(privateAddress)).toBe(true);
    expect(privateAddress('8.8.8.8')).toBe(false);
  });
});

describe('Avisos simultáneos', () => {
  it('si otro aviso ya creó la sesión (índice único), se actualiza esa en vez de duplicarla', async () => {
    const { service, db, prisma } = setup();
    const create = prisma.signupSession.create;
    // Simula la carrera: entre buscar y crear, el otro aviso ya la guardó
    (prisma.signupSession as any).create = jest.fn(async (args: any) => {
      await create({ data: { token: args.data.token, step: 'STARTED', lastSeenAt: new Date() } });
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });
    await service.event({ session: 'sesion-carrera-simultanea-01', type: 'registro_abierto' }, { utmSource: 'meta' });
    expect(db.signupSession.filter((s: any) => s.token === 'sesion-carrera-simultanea-01')).toHaveLength(1);
    expect(db.signupSession[0].utmSource).toBe('meta');
    expect(db.signupEvent).toHaveLength(1);
  });
});

describe('Vista para el equipo', () => {
  it('los registros de antes (sin eventos ni fuente nueva) se siguen viendo igual', () => {
    const v = SignupTracker.view({ id: 'x', step: 'PREVIEW', answers: 4, aiCalls: 1, aiTokens: 10, followStatus: 'NEW', createdAt: new Date(), lastSeenAt: new Date(), description: 'Canchas' });
    expect(v).toMatchObject({ stepLabel: 'Revisando su plan', source: 'DIRECT', answersMap: {}, responseMinutes: null, description: 'Canchas' });
  });
});
