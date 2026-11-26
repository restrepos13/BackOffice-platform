/**
 * Formularios instantáneos sin depender del aviso de Meta (importación directa
 * con el acceso de la cuenta publicitaria) y analista con IA (solo cifras que
 * salen de los datos). Meta y la IA son falsos: nada sale a la red.
 */
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

import 'reflect-metadata';
import { AdsController, AdsService } from '../src/modules/ads.module';
import { AdLeadsService } from '../src/modules/ads-leads';
import { AdsAnalystController, AdsAnalystService } from '../src/modules/ads-analyst';
import { accessFrom, metaAdsScopes } from '../src/common/ads/meta-ads-provider';
import { allowedNumbers, analystMessages, cleanQuestion, normalizeAnalysis, unknownNumbers } from '../src/common/ads/analyst';
import { leadDocId } from '../src/common/ads/leads';
import { ROLES_KEY } from '../src/auth/decorators';
import { PRODUCTS_KEY } from '../src/auth/products.guard';
import { createMockPrisma } from './helpers/mock-prisma';

const auditLog = { log: jest.fn(async () => undefined) };
const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const NOW = new Date('2026-10-27T15:00:00Z');
const TOKEN = 'EAAG'.padEnd(48, 'q');
const BASE = ['ads_read', 'ads_management', 'business_management'];
const WITH_LEADS = [...BASE, 'leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'];

const lead = (id: string, phone: string, name = 'Laura Gómez', ad = '43300') => ({
  id, created_time: '2026-10-26T14:00:00+0000', ad_id: ad, adset_id: '33300', campaign_id: '33000', form_id: '660001',
  field_data: [{ name: 'full_name', values: [name] }, { name: 'phone_number', values: [phone] }, { name: 'presupuesto', values: ['80 a 120 millones'] }],
});

/** Meta falso: una campaña de mensajes y una de formularios; los permisos y los leads se pueden cambiar en caliente. */
function setup(initial: { scopes?: string[]; leads?: any[]; leadsError?: any } = {}) {
  const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: true });
  db.company.push({ id: 'coA', name: 'Aurora Lotes', slug: 'aurora', planId: 'p1', currency: 'COP', industry: 'Inmobiliaria' }, { id: 'coB', name: 'Otra', slug: 'otra', planId: 'p1', currency: 'COP' });
  const state = { scopes: initial.scopes ?? BASE, leads: initial.leads ?? [], leadsError: initial.leadsError ?? null as any };
  const calls: Array<{ path: string; params: URLSearchParams }> = [];
  const fetchImpl = async (url: string, init?: any) => {
    const u = new URL(url);
    const params = (init?.method ?? 'GET') === 'GET' ? u.searchParams : new URLSearchParams(init?.body ?? '');
    const p = u.pathname.replace(/^\/v[\d.]+/, '');
    calls.push({ path: p, params });
    const respond = (body: any) => {
      const status = body?.__status ?? (body?.error ? 400 : 200);
      return { ok: status < 400, status, json: async () => body };
    };
    if (p === '/me/adaccounts') return respond({ data: [{ account_id: '90011', name: 'Real A', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1 }] });
    if (p === '/me/permissions') return respond({ data: state.scopes.map((permission) => ({ permission, status: 'granted' })) });
    if (p.endsWith('/campaigns')) return respond({ data: [{ id: '22200', name: 'Chats lotes', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }, { id: '33000', name: 'Formulario lotes', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] });
    if (p.endsWith('/adsets')) return respond({ data: [{ id: '32200', name: 'S2', campaign_id: '22200', status: 'ACTIVE', effective_status: 'ACTIVE' }, { id: '33300', name: 'S3', campaign_id: '33000', status: 'ACTIVE', effective_status: 'ACTIVE' }] });
    if (p.endsWith('/ads')) return respond({ data: [{ id: '42200', name: 'Ad chat', campaign_id: '22200', adset_id: '32200', status: 'ACTIVE', effective_status: 'ACTIVE' }, { id: '43300', name: 'Ad formulario', campaign_id: '33000', adset_id: '33300', status: 'ACTIVE', effective_status: 'ACTIVE' }] });
    if (p.endsWith('/insights')) {
      if (params.get('level') === 'account') return respond({ data: [{ reach: '4000', impressions: '10000', frequency: '2.5' }] });
      if (params.get('level') === 'campaign') return respond({ data: [] });
      const range = JSON.parse(params.get('time_range') ?? '{}');
      const out: any[] = [];
      for (let d = range.since; d <= range.until; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) {
        out.push({ ad_id: '42200', adset_id: '32200', campaign_id: '22200', date_start: d, spend: '20000', impressions: '700', reach: '500', clicks: '10', inline_link_clicks: '0', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' }] });
        out.push({ ad_id: '43300', adset_id: '33300', campaign_id: '33000', date_start: d, spend: '15000', impressions: '900', reach: '700', clicks: '20', inline_link_clicks: '5', actions: [{ action_type: 'lead', value: '1' }] });
      }
      return respond({ data: out });
    }
    if (p === '/43300/leads') return respond(state.leadsError ?? { data: state.leads });
    if (/^\/\d+\/leads$/.test(p)) return respond({ data: [] });
    const one = state.leads.find((l) => p === `/${l.id}`);
    if (one) return respond(state.leadsError ?? one);
    return respond({ data: [] });
  };
  const leads = new AdLeadsService(prisma as any);
  leads.now = () => NOW;
  leads.fetchImpl = fetchImpl as any;
  const svc = new AdsService(prisma as any, auditLog as any, leads);
  svc.now = () => NOW;
  svc.fetchImpl = fetchImpl as any;
  return { prisma, db, svc, leads, state, calls };
}

const connect = (w: ReturnType<typeof setup>) => w.svc.connectManual(A, { accountId: '90011', token: TOKEN });

describe('Ads · permisos de formularios', () => {
  it('la conexión dice si puede leer formularios y qué falta', () => {
    expect(accessFrom(BASE)).toMatchObject({ read: true, manage: true, leads: false, leadsMissing: ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'] });
    expect(accessFrom(WITH_LEADS)).toMatchObject({ leads: true, leadsMissing: [] });
    expect(accessFrom(['manual']).leads).toBeNull(); // conexión vieja sin verificar: no se afirma nada
  });

  it('al conectar con Facebook solo se piden los permisos extra que el equipo habilitó', () => {
    expect(metaAdsScopes('')).toEqual(BASE);
    expect(metaAdsScopes('leads_retrieval, pages_show_list  pages_manage_ads')).toEqual([...BASE, 'leads_retrieval', 'pages_show_list', 'pages_manage_ads']);
    expect(metaAdsScopes('leads_retrieval,<script>,ADS_READ;drop')).toEqual([...BASE, 'leads_retrieval']); // nada raro llega a la URL
  });

  it('sin leads_retrieval no se pide ningún formulario a Meta y queda dicho por qué', async () => {
    const w = setup({ leads: [lead('880010', '+57 300 111 2233')] });
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    expect(w.calls.some((c) => c.path.endsWith('/leads'))).toBe(false);
    const r = await w.svc.importLeadsNow(A);
    expect(r).toMatchObject({ status: 'NO_PERMISSION', found: 0, created: 0 });
    expect(w.db.adLead).toHaveLength(0);
    expect(await w.leads.status('coA')).toMatchObject({ connected: true, canRead: false, missing: ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'] });
  });

  it('cuando Meta concede el permiso, la siguiente sincronización lo detecta sin reconectar y trae los formularios', async () => {
    const w = setup({ leads: [lead('880010', '+57 300 111 2233')] });
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    expect(w.db.contact).toHaveLength(0);
    w.state.scopes = WITH_LEADS; // el equipo otorga leads_retrieval en Meta
    await w.svc.sync(A, acc.id, 'coA');
    expect(JSON.parse(w.db.adAccount[0].scopesJson)).toEqual(expect.arrayContaining(['leads_retrieval']));
    expect(w.db.adLead).toHaveLength(1);
    expect(w.db.adLead[0]).toMatchObject({ id: leadDocId('880010'), status: 'FETCHED', adId: '43300', adsetId: '33300', campaignId: '33000', formId: '660001' });
    expect(w.db.contact[0]).toMatchObject({ companyId: 'coA', name: 'Laura Gómez', phone: '+573001112233', channel: 'META_ADS' });
    expect(JSON.parse(w.db.contact[0].originJson)).toMatchObject({ kind: 'AD', via: 'LEAD_FORM', sourceId: '43300', leadgenId: '880010' });
    expect((await w.leads.status('coA')).canRead).toBe(true);
  });
});

describe('Ads · importación de formularios', () => {
  async function ready(leads: any[] = [lead('880010', '+57 300 111 2233'), lead('880011', '+57 301 222 3344', 'Pedro Ruiz')]) {
    const w = setup({ scopes: WITH_LEADS, leads });
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    return { ...w, acc };
  }

  it('solo consulta anuncios de campañas de formularios o que ya reportaron leads; repetir no duplica', async () => {
    const w = await ready();
    const asked = () => w.calls.filter((c) => c.path.endsWith('/leads')).map((c) => c.path);
    expect([...new Set(asked())]).toEqual(['/43300/leads']); // el anuncio de chats no se consulta
    expect(w.db.adLead).toHaveLength(2);
    expect(w.db.contact).toHaveLength(2);
    const again = await w.svc.importLeadsNow(A);
    expect(again).toMatchObject({ status: 'OK', found: 2, created: 0, contacts: 0 });
    expect(w.db.adLead).toHaveLength(2);
    expect(w.db.contact).toHaveLength(2);
    expect(JSON.stringify(w.db.adLead)).not.toContain('Laura'); // los datos personales viven en el contacto
    expect(JSON.stringify(again)).not.toContain('cursor');
  });

  it('la primera importación mira 60 días; las siguientes, desde la última completa (con margen)', async () => {
    const w = await ready();
    const since = (i: number) => JSON.parse(w.calls.filter((c) => c.path === '/43300/leads')[i].params.get('filtering')!)[0].value * 1000;
    expect(since(0)).toBe(NOW.getTime() - 60 * 86400e3);
    await w.svc.importLeadsNow(A);
    expect(since(1)).toBe(NOW.getTime() - 30 * 60e3);
  });

  it('un lead que llegó por aviso sin datos se completa en la importación', async () => {
    const w = setup({ scopes: WITH_LEADS, leads: [lead('880010', '+57 300 111 2233')] });
    const acc = await connect(w);
    w.db.adLead.push({ id: leadDocId('880010'), companyId: 'coA', leadgenId: '880010', pageId: '5550001', adId: '43300', status: 'PENDING_PERMISSION', error: 'Falta permiso', fieldNamesJson: '[]', receivedAt: NOW });
    await w.svc.sync(A, acc.id, 'coA');
    expect(w.db.adLead).toHaveLength(1);
    expect(w.db.adLead[0]).toMatchObject({ status: 'FETCHED', error: null });
    expect(w.db.contact).toHaveLength(1);
  });

  it('si Meta niega el permiso al leer, no se guarda nada inventado y la marca no avanza', async () => {
    const w = setup({ scopes: WITH_LEADS, leads: [lead('880010', '+57 300 111 2233')], leadsError: { error: { code: 200, message: 'Requires leads_retrieval permission' }, __status: 403 } });
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    expect(w.db.adLead).toHaveLength(0);
    expect(w.db.contact).toHaveLength(0);
    const st = await w.leads.status('coA');
    expect(st.lastImport).toMatchObject({ status: 'NO_PERMISSION' });
    expect(st.lastImport!.error).toMatch(/leads_retrieval/);
    w.state.leadsError = null;
    await w.svc.importLeadsNow(A);
    expect(w.db.contact).toHaveLength(1); // al arreglarse, se trae todo lo del periodo
  });

  it('un contacto que ya existía conserva su primer origen y no se duplica', async () => {
    const w = setup({ scopes: WITH_LEADS, leads: [lead('880010', '+57 300 111 2233')] });
    w.db.contact.push({ id: 'old', companyId: 'coA', name: 'Laura', phone: '+573001112233', originJson: JSON.stringify({ kind: 'DIRECT' }) });
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    expect(w.db.contact).toHaveLength(1);
    expect(JSON.parse(w.db.contact[0].originJson).kind).toBe('DIRECT');
    expect(w.db.adLead[0].contactId).toBe('old');
  });

  it('la empresa B no importa ni ve los formularios de A; el reloj de 10 minutos solo corre para quien tiene el permiso', async () => {
    const w = await ready();
    await expect(w.svc.importLeadsNow(B)).rejects.toThrow(/Conecta primero/);
    expect(await w.leads.list('coB')).toEqual([]);
    expect(await w.leads.status('coB')).toMatchObject({ connected: false, canRead: false, lastImport: null });
    const before = w.calls.length;
    w.db.adAccount[0].scopesJson = JSON.stringify(BASE);
    await w.svc.leadTick();
    expect(w.calls.length).toBe(before); // sin permiso guardado: ni una llamada a Meta
  });

  it('rutas: leer estado es de lectura, importar es de administración, todo dentro de Ads', () => {
    const roles = (name: string) => Reflect.getMetadata(ROLES_KEY, (AdsController.prototype as any)[name]);
    expect(roles('leadStatus')).toContain('COMPANY_VIEWER');
    expect(roles('leadImport')).not.toContain('COMPANY_VIEWER');
    expect(Reflect.getMetadata(PRODUCTS_KEY, AdsController)).toEqual(['ADS']);
  });
});

describe('Ads · analista con IA', () => {
  const ctx: any = {
    business: 'Aurora Lotes', industry: 'Inmobiliaria', demo: false,
    period: { since: '2026-10-13', until: '2026-11-11', days: 30, previousSince: '2026-09-13', previousUntil: '2026-10-12' }, comparable: true,
    totals: { spend: '1.121.883 COP', ctr: '4,43 %', conversations: '272', leads: '24' }, changes: { spend: '+21,6 %' }, notes: [],
    campaigns: [{ name: 'Chats lotes', spend: '800.000 COP', shareOfSpend: '71,3 %', results: '272', costPerResult: '2.941 COP' }], ads: [], findings: [], crm: null,
    budget: { activeDaily: '40.000 COP', cap: null },
  };

  it('las cifras se comparan sin separadores y solo valen las que están en los datos', () => {
    const allowed = allowedNumbers(ctx);
    expect(unknownNumbers('Gastaste 1.121.883 COP con CTR de 4,43 % y 272 conversaciones en 30 días', allowed)).toEqual([]);
    expect(unknownNumbers('Gastaste 1,1 millones y el costo fue 4.125', allowed)).toEqual(['1,1', '4.125']);
    expect(unknownNumbers('Haz 3 anuncios nuevos en 7 días', allowed)).toEqual([]); // conteos pequeños no son métricas
  });

  it('descarta lo que cite cifras inventadas y conserva el resto', () => {
    const n = normalizeAnalysis({
      titular: 'Los chats concentran el gasto', resumen: 'Gastaste 1.121.883 COP. El costo real fue 9.999 COP por venta. El CTR es 4,43 %.',
      funciona: [{ que: 'Chats lotes trae conversaciones', evidencia: '272 con costo de 2.941 COP' }, { que: 'Inventado', evidencia: 'ROAS de 8,7x' }],
      no_funciona: [],
      acciones: [
        { titulo: 'Subir el presupuesto de Chats lotes', por_que: 'Tiene el mejor costo', como: 'Hazlo de a poco y mira 3 días', prioridad: 'alta', gasta: false },
        { titulo: 'Pausar anuncio caro', por_que: 'Cuesta 55.555 COP', como: 'Pausarlo', prioridad: 'media' },
      ],
      vigilar: ['La frecuencia'], falta_medir: ['Ventas por campaña: regístralas en el CRM'],
    }, ctx)!;
    expect(n.analysis.summary).toBe('Gastaste 1.121.883 COP. El CTR es 4,43 %.');
    expect(n.analysis.working).toHaveLength(1);
    expect(n.analysis.actions).toHaveLength(1);
    expect(n.analysis.actions[0]).toMatchObject({ priority: 'ALTA', spends: true }); // subir presupuesto siempre queda marcado como gasto
    expect(n.dropped).toBe(3);
    expect(n.unknown).toEqual(expect.arrayContaining(['9.999', '8,7', '55.555']));
    expect(normalizeAnalysis({ titular: 'x' }, ctx)).toBeNull();
    expect(normalizeAnalysis('texto suelto', ctx)).toBeNull();
  });

  it('la instrucción lleva los datos, la pregunta y, al corregir, las cifras rechazadas', () => {
    const m = analystMessages(ctx, '¿Qué campaña pauso?', ['9.999']);
    expect(m[0].content).toMatch(/SOLO cifras que aparezcan en el JSON/);
    expect(m[1].content).toContain('1.121.883 COP');
    expect(m[1].content).toContain('¿Qué campaña pauso?');
    expect(m[1].content).toContain('9.999');
    expect(cleanQuestion('  ¿Por qué\nsubió el costo?  ')).toBe('¿Por qué subió el costo?');
    expect(cleanQuestion('ok')).toBeNull();
    expect(cleanQuestion('x'.repeat(900))!.length).toBe(300);
  });

  function analystWorld(reply: (messages: any[]) => string, opts: { ai?: boolean } = { ai: true }) {
    const w = setup({ scopes: BASE });
    const asked: any[][] = [];
    const svc = new AdsAnalystService(w.prisma as any, w.svc as any);
    svc.now = () => NOW;
    (svc as any).textAi = {
      route: async () => (opts.ai ? { kind: 'EMPRESA', session: {} } : { kind: 'NINGUNA', reason: 'sin llave' }),
      describe: async () => ({ source: opts.ai ? 'EMPRESA' : 'NINGUNA', trial: null }),
      knownNames: async () => [], reserveGeneric: jest.fn(), releaseGeneric: jest.fn(),
      complete: async (_c: any, _r: any, req: any) => {
        asked.push(req.messages);
        return { content: reply(req.messages), source: 'EMPRESA', model: 'modelo-de-prueba', billedTo: 'BYOK' };
      },
    };
    return { ...w, analyst: svc, asked };
  }

  it('arma el contexto solo con agregados: ni teléfonos ni nombres de contactos', async () => {
    const w = analystWorld(() => '{}');
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    w.db.contact.push({ id: 'c1', companyId: 'coA', name: 'Laura Privada', phone: '+573001112233', stage: 'nuevo', createdAt: NOW, originJson: JSON.stringify({ kind: 'AD', sourceId: '42200' }) });
    const { ctx: built } = await w.analyst.context(A, { days: '30' });
    const text = JSON.stringify(built);
    expect(built!.campaigns.map((c) => c.name)).toEqual(expect.arrayContaining(['Chats lotes', 'Formulario lotes']));
    expect(built!.totals.spend).toMatch(/COP$/);
    expect(built!.crm).not.toBeNull();
    expect(text).not.toContain('Laura');
    expect(text).not.toContain('3001112233');
    expect(text).not.toContain(TOKEN);
  });

  it('guarda el análisis general; una pregunta se responde sin reemplazarlo; B no ve el de A', async () => {
    const w = analystWorld((messages) => JSON.stringify({
      titular: 'Los chats funcionan', resumen: 'La campaña Chats lotes concentra las conversaciones.', funciona: [], no_funciona: [],
      acciones: [{ titulo: 'Revisar Formulario lotes', por_que: 'Trae pocos leads', como: 'Cambiar la imagen del anuncio', prioridad: 'media', gasta: false }],
      vigilar: [], falta_medir: [], ...(String(messages[1].content).includes('Pregunta de la persona') ? { respuesta: 'Pausa el que no trae resultados.' } : {}),
    }));
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    const r: any = await w.analyst.analyze(A, { days: 30 });
    expect(r).toMatchObject({ status: 'OK', model: 'modelo-de-prueba', source: 'EMPRESA', dropped: 0, question: null });
    expect((await w.analyst.last(A, {})).last!.analysis.headline).toBe('Los chats funcionan');
    const q: any = await w.analyst.analyze(A, { days: 30, question: '¿Qué anuncio pauso?' });
    expect(q.analysis.answer).toBe('Pausa el que no trae resultados.');
    expect(w.db.platformSetting.filter((x: any) => String(x.key).startsWith('ads:analysis:'))).toHaveLength(1);
    expect((await w.analyst.last(B, {})).last).toBeNull();
    await expect(w.analyst.analyze(A, { question: 'ok' })).rejects.toThrow(/pregunta/);
  });

  it('si la IA inventa cifras se le pide corregir una vez; sin IA o sin datos lo dice y no llama a nadie', async () => {
    let n = 0;
    const w = analystWorld(() => (++n === 1
      ? JSON.stringify({ titular: 'Resumen', resumen: 'Gastaste 987.654.321 COP.', acciones: [] })
      : JSON.stringify({ titular: 'Resumen', resumen: 'El gasto está concentrado en Chats lotes.', acciones: [] })));
    const acc = await connect(w);
    await w.svc.sync(A, acc.id, 'coA');
    const r: any = await w.analyst.analyze(A, {});
    expect(w.asked).toHaveLength(2);
    expect(String(w.asked[1][1].content)).toContain('987.654.321');
    expect(r.analysis.summary).toBe('El gasto está concentrado en Chats lotes.');

    const noData = analystWorld(() => '{}');
    expect(await noData.analyst.analyze(A, {})).toMatchObject({ status: 'NO_DATA' });
    expect(noData.asked).toHaveLength(0);

    const noAi = analystWorld(() => '{}', { ai: false });
    const acc2 = await connect(noAi);
    await noAi.svc.sync(A, acc2.id, 'coA');
    expect(await noAi.analyst.analyze(A, {})).toMatchObject({ status: 'NO_AI' });
    expect(noAi.asked).toHaveLength(0);
  });

  it('rutas: ver el análisis es de lectura; pedirlo (gasta IA) es de administración y dentro de Ads', () => {
    const roles = (name: string) => Reflect.getMetadata(ROLES_KEY, (AdsAnalystController.prototype as any)[name]);
    expect(roles('last')).toContain('COMPANY_VIEWER');
    expect(roles('analyze')).not.toContain('COMPANY_VIEWER');
    expect(Reflect.getMetadata(PRODUCTS_KEY, AdsAnalystController)).toEqual(['ADS']);
  });
});
