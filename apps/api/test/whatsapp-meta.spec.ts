/**
 * WhatsApp por Meta directo (Cloud API, sin intermediarios): conexión con el
 * registro integrado, plantillas (validación, creación, sincronización y
 * avisos de Meta), envío de plantillas fuera de las 24 h y lo que Meta le
 * cobra a la empresa. Ninguna prueba llama a Meta: el fetch es simulado.
 */
import { decryptSecret, encryptSecret } from '../src/common/crypto';
import { messagingWindow } from '../src/common/inbox/window';
import { META_BILLING_NOTICE, costFromPricing, metaCategoryOf, metaRatesFor, META_RATES_USD } from '../src/common/whatsapp/meta-rates';
import {
  applyTemplateWebhook, buildTemplateComponents, cleanParam, createMetaTemplate, marketingSignals, mergeRemoteTemplates,
  metaNameFor, metaTemplateRef, orderedParams, parseMetaTemplateRef, sendMetaTemplate, validateTemplateDraft,
} from '../src/common/whatsapp/meta-templates';
import { TEMPLATE_LIBRARY } from '../src/common/whatsapp/template-library';
import { readSignupSession } from '../src/common/whatsapp/embedded-signup';
import { WhatsappMetaService } from '../src/modules/whatsapp-meta.module';
import { TwilioService } from '../src/modules/twilio.module';
import { WebhooksService } from '../src/modules/webhooks.module';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const ADMIN = { sub: 'u1', id: 'u1', role: 'COMPANY_ADMIN', companyId: 'co1', name: 'Ana' } as any;
const OTHER = { sub: 'u2', id: 'u2', role: 'COMPANY_ADMIN', companyId: 'co2', name: 'Beto' } as any;

/** fetch simulado: responde según la ruta y guarda cada llamada. */
function fakeMeta(handler: (url: string, init: any) => { status?: number; body: any }) {
  const calls: Array<{ url: string; method: string; body: any; auth: string | null }> = [];
  const fn = (async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization ?? null });
    const r = handler(url, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as any;
  }) as any as typeof fetch;
  return { fn, calls };
}

const draft = (o: Record<string, any> = {}) => ({
  key: 'recordatorio_cita', category: 'UTILIDAD' as const,
  body: 'Hola, te recordamos tu cita: {{1}}, el {{2}}. Respóndenos si no puedes asistir.',
  examples: ['Consulta', 'martes 3 p. m.'], ...o,
});

describe('Plantillas: lo que Meta revisa, revisado antes', () => {
  it('acepta una plantilla bien hecha y explica cada error en español', () => {
    expect(validateTemplateDraft(draft())).toEqual([]);
    expect(validateTemplateDraft(draft({ body: '{{1}}, tu cita es el {{2}} en el consultorio' })).join(' ')).toMatch(/empiezan o terminan con una variable/);
    expect(validateTemplateDraft(draft({ body: 'Tu cita es el día {{1}} con el doctor {{3}} en sede.' })).join(' ')).toMatch(/en orden/);
    expect(validateTemplateDraft(draft({ examples: ['Consulta'] })).join(' ')).toMatch(/ejemplo para cada variable/);
    expect(validateTemplateDraft(draft({ body: 'Hola {{1}} {{2}} gracias por venir hoy.' })).join(' ')).toMatch(/Dos variables seguidas/);
    expect(validateTemplateDraft(draft({ category: 'OTRA' as any })).join(' ')).toMatch(/categoría/);
    expect(validateTemplateDraft(draft({ buttons: ['a', 'b', 'c', 'd'] })).join(' ')).toMatch(/Máximo 3 botones/);
    expect(validateTemplateDraft(draft({ body: 'x'.repeat(1100) })).join(' ')).toMatch(/1.024/);
  });

  it('nombres válidos para Meta y parámetros sin saltos de línea ni vacíos', () => {
    expect(metaNameFor('Recordatorio de Cita!')).toBe('recordatorio_de_cita');
    expect(metaNameFor('Promoción Ñandú')).toBe('promocion_nandu');
    expect(cleanParam('  hola\n\nmundo   ')).toBe('hola mundo');
    expect(cleanParam('')).toBe('-');
    expect(orderedParams({ '2': 'martes', '1': 'Ana', x: 'no' })).toEqual(['Ana', 'martes']);
  });

  it('avisa cuando un "aviso" trae palabras promocionales (Meta lo cobraría como marketing)', () => {
    expect(marketingSignals('Tu cita es mañana. Aprovecha el 20% de descuento')).toEqual(expect.arrayContaining(['aprovecha', 'descuento']));
    expect(marketingSignals('Tu cita es mañana a las 3')).toEqual([]);
  });

  it('la biblioteca pasa la validación de Meta y respeta las variables que usan los flujos', () => {
    for (const t of TEMPLATE_LIBRARY) expect({ key: t.key, errors: validateTemplateDraft(t) }).toEqual({ key: t.key, errors: [] });
    const reminder = TEMPLATE_LIBRARY.find((t) => t.key === 'recordatorio_reserva')!;
    expect(reminder.category).toBe('UTILIDAD');
    expect(marketingSignals(reminder.body)).toEqual([]); // los avisos no llevan nada promocional
    expect(TEMPLATE_LIBRARY.filter((t) => t.category === 'UTILIDAD').every((t) => marketingSignals(t.body).length === 0)).toBe(true);
  });

  it('arma los componentes con ejemplos, pie y botones de respuesta', () => {
    const c = buildTemplateComponents({ ...draft(), footer: 'BackOffice', buttons: ['Confirmo', 'Reprogramar'] });
    expect(c[0]).toMatchObject({ type: 'BODY', example: { body_text: [['Consulta', 'martes 3 p. m.']] } });
    expect(c[1]).toEqual({ type: 'FOOTER', text: 'BackOffice' });
    expect(c[2].buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Confirmo' }, { type: 'QUICK_REPLY', text: 'Reprogramar' }]);
  });
});

describe('Plantillas: llamadas a Meta (simuladas)', () => {
  it('crear: va a la WABA de la empresa con su token, en español y con la categoría de Meta', async () => {
    const meta = fakeMeta(() => ({ body: { id: '777', status: 'PENDING', category: 'UTILITY' } }));
    const r = await createMetaTemplate({ wabaId: '111', token: 'tok-empresa', draft: draft() }, meta.fn);
    expect(r).toEqual({ id: '777', status: 'PENDING', category: 'UTILIDAD' });
    expect(meta.calls[0].url).toMatch(/\/111\/message_templates$/);
    expect(meta.calls[0].auth).toBe('Bearer tok-empresa');
    expect(meta.calls[0].body).toMatchObject({ name: 'recordatorio_cita', language: 'es', category: 'UTILITY' });
  });

  it('enviar: plantilla con sus parámetros al número del cliente; los errores salen clasificados', async () => {
    const meta = fakeMeta(() => ({ body: { messages: [{ id: 'wamid.T1' }] } }));
    const config = { provider: 'META', phoneNumberId: '555', accessToken: 'tok', sandbox: false } as any;
    expect(await sendMetaTemplate({ config, to: '+57 300 111 2233', name: 'recordatorio_reserva', language: 'es', params: ['Consulta', 'martes'] }, meta.fn)).toEqual({ id: 'wamid.T1' });
    expect(meta.calls[0].url).toMatch(/\/555\/messages$/);
    expect(meta.calls[0].body).toMatchObject({
      to: '573001112233', type: 'template',
      template: { name: 'recordatorio_reserva', language: { code: 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Consulta' }, { type: 'text', text: 'martes' }] }] },
    });
    const denied = fakeMeta(() => ({ status: 400, body: { error: { code: 132001, message: 'Template name does not exist' } } }));
    await expect(sendMetaTemplate({ config, to: '+573001112233', name: 'x', language: 'es', params: [] }, denied.fn)).rejects.toMatchObject({ outcome: 'REJECTED' });
  });

  it('referencia meta:<nombre>:<idioma> ida y vuelta (y no confunde las de Twilio)', () => {
    expect(parseMetaTemplateRef(metaTemplateRef('pedido_en_camino'))).toEqual({ name: 'pedido_en_camino', language: 'es' });
    expect(parseMetaTemplateRef('HX1234567890abcdef')).toBeNull();
  });
});

describe('Plantillas: estado que manda Meta', () => {
  const pending = () => [
    { key: 'recordatorio_reserva', name: 'Recordatorio', category: 'UTILIDAD', body: 'Hola {{1}} ok', meta: { name: 'recordatorio_reserva', language: 'es', status: 'PENDING', id: '9', requestedCategory: 'UTILIDAD', examples: ['a'], updatedAt: '' } },
    { key: 'vieja_twilio', category: 'MARKETING', contentSid: 'HX123' },
  ] as any[];

  it('aprobada → queda usable (contentSid meta:…); rechazada o pausada → deja de usarse', () => {
    const ok = applyTemplateWebhook(pending(), 'message_template_status_update', { event: 'APPROVED', message_template_id: '9', message_template_name: 'recordatorio_reserva' });
    expect(ok.hit).toMatchObject({ contentSid: 'meta:recordatorio_reserva:es', meta: { status: 'APPROVED' } });
    const paused = applyTemplateWebhook(ok.templates, 'message_template_status_update', { event: 'PAUSED', message_template_id: '9' });
    expect(paused.hit!.contentSid).toBeUndefined();
    const rejected = applyTemplateWebhook(pending(), 'message_template_status_update', { event: 'REJECTED', reason: 'PROMOTIONAL', message_template_id: '9' });
    expect(rejected.hit).toMatchObject({ meta: { status: 'REJECTED', rejectedReason: 'PROMOTIONAL' } });
    expect(rejected.templates[1]).toEqual(pending()[1]); // la de Twilio no se toca
  });

  it('si Meta cambia la categoría (aviso → marketing) se refleja y se recuerda de cuál venía', () => {
    const { hit } = applyTemplateWebhook(pending(), 'template_category_update', { message_template_id: '9', previous_category: 'UTILITY', new_category: 'MARKETING' });
    expect(hit).toMatchObject({ category: 'MARKETING', meta: { previousCategory: 'UTILIDAD' } });
  });

  it('sincronizar: estados y categorías de Meta; las que Meta ya no tiene quedan eliminadas', () => {
    const r = mergeRemoteTemplates(pending(), [{ id: '9', name: 'recordatorio_reserva', language: 'es', status: 'APPROVED', category: 'UTILIDAD' }]);
    expect(r.changed).toBe(1);
    expect(r.templates[0]).toMatchObject({ contentSid: 'meta:recordatorio_reserva:es' });
    const gone = mergeRemoteTemplates(r.templates, []);
    expect(gone.templates[0]).toMatchObject({ meta: { status: 'DELETED' } });
    expect(gone.templates[0].contentSid).toBeUndefined();
  });
});

describe('Lo que cobra Meta', () => {
  it('tarifas de referencia y propias de la empresa; el aviso de Meta manda sobre la estimación', () => {
    expect(metaRatesFor(null)).toEqual(META_RATES_USD);
    expect(metaRatesFor({ orderConfigJson: JSON.stringify({ metaRatesUsd: { MARKETING: 0.02, UTILIDAD: 'x' } }) })).toMatchObject({ MARKETING: 0.02, UTILIDAD: META_RATES_USD.UTILIDAD });
    expect(metaCategoryOf('utility')).toBe('UTILIDAD');
    expect(metaCategoryOf('authentication_international')).toBe('AUTENTICACION');
    expect(costFromPricing({ billable: true, category: 'marketing', pricing_model: 'PMP', type: 'regular' }, META_RATES_USD)).toEqual({ category: 'MARKETING', costUsd: META_RATES_USD.MARKETING });
    expect(costFromPricing({ billable: false, category: 'utility', type: 'free_customer_service' }, META_RATES_USD)).toEqual({ category: 'UTILIDAD', costUsd: 0 });
    expect(costFromPricing(undefined, META_RATES_USD)).toBeNull();
  });

  it('el aviso al cliente es claro: Meta cobra directo, sin recargo, y por qué no lo cobramos nosotros', () => {
    expect(META_BILLING_NOTICE.summary).toMatch(/no a BackOffice/);
    expect(META_BILLING_NOTICE.summary).toMatch(/ningún recargo/);
    expect(META_BILLING_NOTICE.why).toMatch(/seríamos los dueños de tu línea/);
    expect(META_BILLING_NOTICE.items.map((i) => i.category)).toEqual(['SERVICIO', 'UTILIDAD', 'MARKETING']);
  });
});

/* ── Servicio: conexión, plantillas y costos ── */

function world() {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  db.company.push({ id: 'co1', name: 'Consultorio Uno', slug: 'consultorio-uno', waTemplatesJson: '[]', orderConfigJson: '{}' });
  db.company.push({ id: 'co2', name: 'Otra', slug: 'otra', waTemplatesJson: '[]', orderConfigJson: '{}' });
  for (const [key, value] of [['META_APP_ID', '123'], ['META_APP_SECRET', 'secreto-app'], ['META_WA_CONFIG_ID', 'cfg1'], ['META_VERIFY_TOKEN', 'verif'], ['WEBHOOK_BASE_URL', 'https://api.backoffice.store']]) {
    db.platformSetting.push({ key, value });
  }
  const svc = new WhatsappMetaService(prisma as any, audit as any);
  return { prisma, db, audit, svc };
}

/** Meta simulado para el registro integrado y las plantillas. */
function signupMeta() {
  let n = 0;
  return fakeMeta((url, init) => {
    if (url.includes('/oauth/access_token')) return { body: { access_token: 'EAAtokenNegocio123456789' } };
    if (url.includes('/555?fields=')) return { body: { display_phone_number: '+57 300 111 2233', verified_name: 'Consultorio Uno', quality_rating: 'GREEN' } };
    if (url.endsWith('/subscribed_apps')) return { body: { success: true } };
    if (url.endsWith('/register')) return { body: { success: true } };
    if (url.endsWith('/message_templates') && init.method === 'POST') return { body: { id: `tpl${++n}`, status: 'PENDING', category: 'UTILITY' } };
    return { status: 404, body: { error: { message: 'ruta no simulada' } } };
  });
}

describe('Conexión con el registro integrado de Meta', () => {
  it('conecta el número a nombre de la empresa, guarda el token cifrado y manda a revisión las plantillas recomendadas', async () => {
    const w = world();
    const meta = signupMeta();
    w.svc.fetchImpl = meta.fn;
    const r = await w.svc.connect(ADMIN, { code: 'codigo-de-meta', wabaId: '111', phoneNumberId: '555' });
    const line = w.db.integration.find((i: any) => i.companyId === 'co1')!;
    const cfg = JSON.parse(line.configJson);
    expect(line.status).toBe('CONNECTED');
    expect(cfg).toMatchObject({ provider: 'META', connectedVia: 'EMBEDDED_SIGNUP', phoneNumberId: '555', wabaId: '111', displayPhone: '+57 300 111 2233', registration: { ok: true } });
    expect(line.configJson).not.toContain('EAAtokenNegocio');
    expect(decryptSecret(cfg.accessTokenEnc)).toBe('EAAtokenNegocio123456789');
    // La app queda suscrita a la WABA con la URL de webhooks de ESTA empresa
    const sub = meta.calls.find((c) => c.url.endsWith('/111/subscribed_apps'))!;
    expect(sub.body).toEqual({ override_callback_uri: 'https://api.backoffice.store/api/webhooks/consultorio-uno/whatsapp', verify_token: 'verif' });
    // El secreto de la app nunca viaja en el cuerpo ni queda en la respuesta
    expect(JSON.stringify(r)).not.toContain('secreto-app');
    expect(JSON.stringify(r)).not.toContain('EAAtokenNegocio');
    const recommended = TEMPLATE_LIBRARY.filter((t) => t.recommended).map((t) => t.key);
    expect(r.templates.created).toEqual(recommended);
    const stored = JSON.parse(w.db.company[0].waTemplatesJson);
    expect(stored.map((t: any) => t.meta.status)).toEqual(recommended.map(() => 'PENDING'));
    expect(stored.every((t: any) => !t.contentSid)).toBe(true); // en revisión: todavía no se usa
    expect(r.notice.why).toMatch(/dueños de tu línea/);
  });

  it('una línea de Twilio que pasa a Meta pierde las credenciales de Twilio', async () => {
    const w = world();
    w.db.integration.push({ id: 'l1', companyId: 'co1', type: 'WHATSAPP', status: 'CONNECTED', configJson: JSON.stringify({ provider: 'TWILIO', accountSid: 'ACx', authTokenEnc: encryptSecret('t'), fromNumber: '+57300', sandbox: true }) });
    w.svc.fetchImpl = signupMeta().fn;
    await w.svc.connect(ADMIN, { code: 'c', wabaId: '111', phoneNumberId: '555', integrationId: 'l1' });
    const cfg = JSON.parse(w.db.integration[0].configJson);
    expect(cfg.provider).toBe('META');
    expect(cfg).not.toHaveProperty('accountSid');
    expect(cfg).not.toHaveProperty('authTokenEnc');
    expect(cfg).not.toHaveProperty('sandbox');
  });

  it('no deja conectar un número que ya es de otra empresa, ni sin la configuración de la app', async () => {
    const w = world();
    w.db.integration.push({ id: 'lx', companyId: 'co2', type: 'WHATSAPP', status: 'CONNECTED', configJson: JSON.stringify({ provider: 'META', phoneNumberId: '555' }) });
    w.svc.fetchImpl = signupMeta().fn;
    await expect(w.svc.connect(ADMIN, { code: 'c', wabaId: '111', phoneNumberId: '555' })).rejects.toThrow(/otra empresa/);
    const w2 = world();
    w2.db.platformSetting.splice(w2.db.platformSetting.findIndex((s: any) => s.key === 'META_WA_CONFIG_ID'), 1);
    await expect(w2.svc.connect(ADMIN, { code: 'c', wabaId: '111', phoneNumberId: '555' })).rejects.toThrow(/aún no está habilitada/);
    expect(readSignupSession({ code: '', wabaId: '1', phoneNumberId: '2' })).toBeNull();
  });

  it('el cliente ve el aviso de cobro; qué falta configurar solo lo ve la plataforma', async () => {
    const w = world();
    w.db.platformSetting.splice(w.db.platformSetting.findIndex((s: any) => s.key === 'META_WA_CONFIG_ID'), 1);
    const forClient = await w.svc.config(ADMIN);
    expect(forClient).toMatchObject({ available: false, appId: null });
    expect(forClient).not.toHaveProperty('missing');
    expect(forClient.notice.title).toBe('Lo que Meta te cobra directo');
    const forDev = await w.svc.config({ ...ADMIN, role: 'DEV', companyId: null } as any, 'co1');
    expect(forDev.missing).toEqual(['META_WA_CONFIG_ID']);
  });
});

describe('Plantillas desde BackOffice', () => {
  function connected() {
    const w = world();
    w.db.integration.push({ id: 'l1', companyId: 'co1', type: 'WHATSAPP', status: 'CONNECTED', createdAt: new Date(), configJson: JSON.stringify({ provider: 'META', phoneNumberId: '555', wabaId: '111', accessTokenEnc: encryptSecret('tok') }) });
    return w;
  }

  it('crear una propia: valida, avisa si un aviso suena a promoción y la manda a la cuenta de la empresa', async () => {
    const w = connected();
    const meta = fakeMeta(() => ({ body: { id: 't1', status: 'PENDING', category: 'UTILITY' } }));
    w.svc.fetchImpl = meta.fn;
    await expect(w.svc.create(ADMIN, { label: 'Cita', key: 'cita', category: 'UTILIDAD', body: '{{1}} tu cita', examples: ['x'] })).rejects.toThrow(/empiezan o terminan/);
    const promo = { label: 'Cita', key: 'cita', category: 'UTILIDAD', body: 'Tu cita es el {{1}}. Aprovecha el descuento de hoy.', examples: ['martes'] };
    await expect(w.svc.create(ADMIN, promo)).rejects.toMatchObject({ response: { needsConfirmation: true } });
    expect(meta.calls).toHaveLength(0); // no salió nada a Meta sin confirmar
    const r = await w.svc.create(ADMIN, { ...promo, acceptWarnings: true });
    expect(r.template).toMatchObject({ key: 'cita', category: 'UTILIDAD', meta: { status: 'PENDING', wabaId: '111' } });
    expect(meta.calls[0].auth).toBe('Bearer tok');
    await expect(w.svc.create(ADMIN, { ...promo, acceptWarnings: true })).rejects.toThrow(/Ya tienes/);
  });

  it('sin número conectado con Meta no se puede crear; otra empresa no ve ni toca las plantillas', async () => {
    const w = world();
    await expect(w.svc.installFromLibrary(ADMIN, 'recordatorio_reserva')).rejects.toThrow(/Primero conecta/);
    const c = connected();
    c.svc.fetchImpl = fakeMeta(() => ({ body: { id: 't1', status: 'PENDING' } })).fn;
    await c.svc.installFromLibrary(ADMIN, 'recordatorio_reserva');
    const otra = await c.svc.list(OTHER);
    expect(otra.templates).toEqual([]);
    expect(otra.connected).toBe(false);
  });

  it('listar: estado, costo por mensaje según categoría y lo que falta de la biblioteca', async () => {
    const w = connected();
    w.db.company[0].waTemplatesJson = JSON.stringify([
      { key: 'reactivacion', name: 'Reactivación', category: 'MARKETING', body: 'Hola {{1}} tenemos {{2}} para ti.', contentSid: 'meta:reactivacion:es', meta: { name: 'reactivacion', language: 'es', status: 'APPROVED', requestedCategory: 'MARKETING', examples: [], updatedAt: '' } },
    ]);
    const r = await w.svc.list(ADMIN);
    expect(r.connected).toBe(true);
    expect(r.templates[0]).toMatchObject({ provider: 'META', usable: true, statusLabel: 'Aprobada', variables: 2, costPerMessageUsd: META_RATES_USD.MARKETING });
    expect(r.library.map((t: any) => t.key)).not.toContain('reactivacion');
    expect(r.notice.why).toBeTruthy();
  });

  it('sincronizar y eliminar (si Meta ya no la tiene, igual se quita)', async () => {
    const w = connected();
    w.db.company[0].waTemplatesJson = JSON.stringify([{ key: 'cita', category: 'UTILIDAD', body: 'Tu cita {{1}} ok', meta: { name: 'cita', language: 'es', status: 'PENDING', requestedCategory: 'UTILIDAD', examples: ['x'], updatedAt: '' } }]);
    w.svc.fetchImpl = fakeMeta((url) => url.includes('message_templates?fields')
      ? { body: { data: [{ id: '5', name: 'cita', language: 'es', status: 'APPROVED', category: 'UTILITY' }] } }
      : { status: 404, body: { error: { message: 'no existe' } } }).fn;
    expect(await w.svc.sync(ADMIN, 'co1')).toEqual({ changed: 1, total: 1 });
    expect(JSON.parse(w.db.company[0].waTemplatesJson)[0].contentSid).toBe('meta:cita:es');
    await w.svc.remove(ADMIN, 'cita');
    expect(JSON.parse(w.db.company[0].waTemplatesJson)).toEqual([]);
  });

  it('consumo del mes: suma lo que Meta cobra por categoría y no cuenta pruebas ni fallidos', async () => {
    const w = connected();
    w.db.conversation.push({ id: 'cv1', companyId: 'co1', contactId: 'k1', channel: 'WHATSAPP' });
    w.db.conversation.push({ id: 'cv2', companyId: 'co2', contactId: 'k2', channel: 'WHATSAPP' });
    const at = new Date();
    const m = (id: string, conv: string, cat: string, usd: number, status = 'DELIVERED') => w.db.message.push({ id, conversationId: conv, direction: 'OUT', author: 'BOT', content: '.', metaCategory: cat, metaCostUsd: usd, deliveryStatus: status, createdAt: at });
    m('a', 'cv1', 'MARKETING', 0.015);
    m('b', 'cv1', 'MARKETING', 0.015);
    m('c', 'cv1', 'UTILIDAD', 0.001);
    m('d', 'cv1', 'SERVICIO', 0);
    m('e', 'cv1', 'MARKETING', 0.015, 'SIMULATED');
    m('f', 'cv1', 'MARKETING', 0.015, 'FAILED');
    m('g', 'cv2', 'MARKETING', 0.015); // de otra empresa
    const r = await w.svc.costs(ADMIN, undefined);
    expect(r.totalUsd).toBeCloseTo(0.031);
    expect(r.byCategory.find((c: any) => c.category === 'MARKETING')).toMatchObject({ count: 2 });
    expect(r.paidTo).toBe('META');
  });
});

/* ── Envío fuera de las 24 h y avisos de Meta ── */

function inbox() {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  db.company.push({ id: 'co1', name: 'Consultorio Uno', slug: 'consultorio-uno', orderConfigJson: '{}', waTemplatesJson: JSON.stringify([
    { key: 'recordatorio_reserva', category: 'UTILIDAD', body: 'Hola, te recordamos tu cita: {{1}}, el {{2}}. ok', contentSid: 'meta:recordatorio_reserva:es', meta: { name: 'recordatorio_reserva', language: 'es', status: 'APPROVED', id: '9', requestedCategory: 'UTILIDAD', examples: [], updatedAt: '' } },
    { key: 'vieja', category: 'UTILIDAD', body: 'x {{1}}', contentSid: 'HXtwilio' },
  ]) });
  db.integration.push({ id: 'l1', companyId: 'co1', type: 'WHATSAPP', configJson: JSON.stringify({ provider: 'META', phoneNumberId: '555', wabaId: '111', accessTokenEnc: encryptSecret('tok') }) });
  db.contact.push({ id: 'k1', companyId: 'co1', name: 'María', phone: '+573001112233', channel: 'WHATSAPP' });
  db.conversation.push({ id: 'c1', companyId: 'co1', contactId: 'k1', integrationId: 'l1', channel: 'WHATSAPP', status: 'OPEN', lastMessageAt: new Date() });
  // El último mensaje del cliente fue hace 3 días: ventana cerrada
  db.message.push({ id: 'in1', conversationId: 'c1', direction: 'IN', author: 'CONTACT', content: 'hola', createdAt: new Date(Date.now() - 72 * 3600e3) });
  const svc = new TwilioService(prisma as any, audit as any, {} as any, {} as any, {} as any);
  const sent: any[] = [];
  svc.sendMetaTemplate = (async (input: any) => { sent.push(input); return { id: 'wamid.TPL' }; }) as any;
  svc.sendMeta = (async () => { throw new Error('no debe mandar texto libre fuera de la ventana'); }) as any;
  return { prisma, db, svc, sent };
}

describe('Envío por Meta directo fuera de las 24 h', () => {
  it('el recordatorio sale como plantilla aprobada, con sus variables y el costo estimado de utilidad', async () => {
    const w = inbox();
    w.db.message.push({ id: 'o1', conversationId: 'c1', direction: 'OUT', author: 'BOT', content: 'Te recordamos tu cita…', deliveryStatus: 'QUEUED', createdAt: new Date() });
    const r = await w.svc.processOutbound({ messageId: 'o1', metaCategory: 'UTILIDAD', contentSid: 'meta:recordatorio_reserva:es', contentVariables: { '1': 'Consulta', '2': '12/11 3:00 p. m.' } });
    expect(r).toMatchObject({ template: 'recordatorio_reserva' });
    expect(w.sent[0]).toMatchObject({ to: '+573001112233', name: 'recordatorio_reserva', language: 'es', params: ['Consulta', '12/11 3:00 p. m.'] });
    expect(w.db.message.find((m: any) => m.id === 'o1')).toMatchObject({ deliveryStatus: 'SENT', providerId: 'wamid.TPL', metaCategory: 'UTILIDAD', metaCostUsd: META_RATES_USD.UTILIDAD });
  });

  it('sin plantilla, o con una de Twilio en una línea de Meta, no sale y queda explicado', async () => {
    const w = inbox();
    w.db.message.push({ id: 'o2', conversationId: 'c1', direction: 'OUT', author: 'BOT', content: 'hola', deliveryStatus: 'QUEUED', createdAt: new Date() });
    await w.svc.processOutbound({ messageId: 'o2' });
    expect(w.db.message.find((m: any) => m.id === 'o2')).toMatchObject({ deliveryStatus: 'FAILED', deliveryError: expect.stringMatching(/plantilla aprobada por Meta/) });
    w.db.message.push({ id: 'o3', conversationId: 'c1', direction: 'OUT', author: 'BOT', content: 'hola', deliveryStatus: 'QUEUED', createdAt: new Date() });
    await w.svc.processOutbound({ messageId: 'o3', contentSid: 'HXtwilio' });
    expect(w.db.message.find((m: any) => m.id === 'o3')).toMatchObject({ deliveryStatus: 'FAILED', deliveryError: expect.stringMatching(/plantilla es de Twilio/) });
    expect(w.sent).toHaveLength(0);
  });

  it('la bandeja ofrece solo las plantillas de Meta en una línea de Meta', () => {
    const w = inbox();
    const win = messagingWindow({ channel: 'WHATSAPP', integration: w.db.integration[0], lastInboundAt: new Date(Date.now() - 72 * 3600e3), waTemplatesJson: w.db.company[0].waTemplatesJson });
    expect(win.mode).toBe('TEMPLATE_ONLY');
    expect(win.templates.map((t) => t.key)).toEqual(['recordatorio_reserva']);
  });
});

describe('Avisos de Meta (webhook)', () => {
  it('el costo real reemplaza la estimación: una respuesta gratuita queda en 0 aunque la plantilla tenga tarifa', async () => {
    const w = inbox();
    w.db.message.push({ id: 'o1', conversationId: 'c1', direction: 'OUT', author: 'BOT', content: '.', providerId: 'wamid.X', deliveryStatus: 'SENT', metaCategory: 'UTILIDAD', metaCostUsd: 0.001, createdAt: new Date() });
    const hooks = new WebhooksService(w.prisma as any);
    await hooks.ingestWhatsapp('consultorio-uno', { entry: [{ id: '111', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.X', status: 'delivered', pricing: { billable: false, category: 'utility', type: 'free_customer_service' } }] } }] }] });
    expect(w.db.message.find((m: any) => m.id === 'o1')).toMatchObject({ deliveryStatus: 'DELIVERED', metaCategory: 'UTILIDAD', metaCostUsd: 0 });
    // Un aviso viejo (sent después de delivered) no retrocede el estado, pero sí actualiza el costo
    await hooks.ingestWhatsapp('consultorio-uno', { entry: [{ id: '111', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.X', status: 'sent', pricing: { billable: true, category: 'marketing' } }] } }] }] });
    expect(w.db.message.find((m: any) => m.id === 'o1')).toMatchObject({ deliveryStatus: 'DELIVERED', metaCategory: 'MARKETING', metaCostUsd: META_RATES_USD.MARKETING });
  });

  it('plantilla rechazada por Meta: deja de usarse en la empresa dueña de la WABA (webhook de la app)', async () => {
    const w = inbox();
    const hooks = new WebhooksService(w.prisma as any);
    await hooks.ingestWhatsappCloud({ object: 'whatsapp_business_account', entry: [{ id: '111', changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', reason: 'INCORRECT_CATEGORY', message_template_id: '9', message_template_name: 'recordatorio_reserva' } }] }] });
    const t = JSON.parse(w.db.company[0].waTemplatesJson)[0];
    expect(t).toMatchObject({ meta: { status: 'REJECTED', rejectedReason: 'INCORRECT_CATEGORY' } });
    expect(t.contentSid).toBeUndefined();
    // Una WABA que no es de nadie no toca nada
    expect(await hooks.ingestWhatsappCloud({ entry: [{ id: '999', changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: '9' } }] }] })).toEqual({ ok: true, stored: 0 });
  });
});
