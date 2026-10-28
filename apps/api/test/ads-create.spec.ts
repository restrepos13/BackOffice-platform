/**
 * Crear anuncios desde Ads: revisión por código e IA, creación en pausa,
 * reintento sin duplicar, activación con tope y la semana programada.
 * Meta y la IA son falsos: nada sale a internet.
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { encode as encodeJpeg } from 'jpeg-js';
import { AdsCreateService } from '../src/modules/ads-create';
import { checkCopy, checkImage, decodeImage, measure, scoreOf } from '../src/common/ads/creative-check';
import { normalizeReview } from '../src/common/ads/creative-ai';
import { buildClientLaunch, clientDraftFrom, planHints, validateClientDraft } from '../src/common/ads/client-launch';
import { encryptSecret } from '../src/common/crypto';
import { createMockPrisma } from './helpers/mock-prisma';

const NOW = new Date('2026-10-28T15:00:00Z');
const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };

/** JPEG sintético: degradado con color (o plano, para probar contraste). */
function jpeg(w: number, h: number, opts: { flat?: number } = {}) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (opts.flat !== undefined) { data[i] = data[i + 1] = data[i + 2] = opts.flat; } else {
        data[i] = Math.round((x / w) * 255); data[i + 1] = Math.round((y / h) * 200); data[i + 2] = 120;
      }
      data[i + 3] = 255;
    }
  }
  return encodeJpeg({ data, width: w, height: h }, 85).data;
}

const DRAFT = {
  name: 'Martes de 2x1', goal: 'WHATSAPP', dailyBudget: '40.000', countries: ['CO'], advantageAudience: true, ageMin: 18,
  primaryText: '2x1 en hamburguesas todos los martes. Escríbenos por WhatsApp y reserva tu mesa.', headline: 'Martes 2x1', cta: 'WHATSAPP_MESSAGE',
};

describe('revisión por código', () => {
  it('mide la imagen y avisa de resolución, proporción y contraste', () => {
    const ok = decodeImage(jpeg(1080, 1350))!;
    const facts = measure(ok, 1000, ok.format);
    expect(facts).toMatchObject({ format: 'jpg', width: 1080, height: 1350, ratio: 0.8 });
    const items = checkImage(facts);
    expect(items.find((i) => i.key === 'proporcion')).toMatchObject({ level: 'OK' });
    expect(items.find((i) => i.key === 'resolucion')).toMatchObject({ level: 'OK' });

    const small = decodeImage(jpeg(400, 400))!;
    expect(checkImage(measure(small, 1, small.format)).find((i) => i.key === 'resolucion')).toMatchObject({ level: 'BAD' });

    const flat = decodeImage(jpeg(1080, 1080, { flat: 30 }))!;
    const flatItems = checkImage(measure(flat, 1, flat.format));
    expect(flatItems.find((i) => i.key === 'luz')).toMatchObject({ level: 'WARN', title: 'Imagen oscura' });
    expect(flatItems.find((i) => i.key === 'contraste')).toMatchObject({ level: 'WARN' });

    const wide = decodeImage(jpeg(1910, 1000))!;
    expect(checkImage(measure(wide, 1, wide.format)).find((i) => i.key === 'proporcion')).toMatchObject({ level: 'WARN' });
    expect(decodeImage(Buffer.from('no es una imagen'))).toBeNull();
  });

  it('revisa el texto: largo, dato concreto, llamado a la acción y políticas de Meta', () => {
    expect(checkCopy({ goal: 'WHATSAPP', primaryText: DRAFT.primaryText, headline: DRAFT.headline }).every((i) => i.level === 'OK')).toBe(true);
    const weak = checkCopy({ goal: 'WHATSAPP', primaryText: 'La mejor comida de la ciudad, con el mejor sabor y la mejor atención para toda tu familia y amigos que siempre quisiste probar en un lugar único https://x.co', headline: 'El mejor restaurante de toda la ciudad de Medellín' });
    expect(weak.map((i) => i.key)).toEqual(expect.arrayContaining(['texto', 'titulo', 'concreto', 'accion', 'enlace']));
    const risky = checkCopy({ goal: 'WEBSITE', primaryText: '¿Estás gordo? Pide nuestra ensalada, resultado garantizado.', headline: 'Ensaladas' });
    expect(risky.find((i) => i.key === 'atributos')).toMatchObject({ level: 'BAD', area: 'POLITICAS' });
    expect(risky.find((i) => i.key === 'promesas')).toMatchObject({ level: 'WARN' });
    expect(scoreOf(risky)).toBeLessThan(scoreOf(checkCopy({ goal: 'WHATSAPP', primaryText: DRAFT.primaryText, headline: DRAFT.headline })));
  });
});

describe('revisión con IA (respuesta validada)', () => {
  it('acepta un JSON útil, recorta y descarta lo que no sirve', () => {
    const r = normalizeReview({ resumen: 'Buen anuncio', puntaje: 14, lo_que_funciona: ['Oferta clara'], mejoras: [{ aspecto: 'imagen', problema: 'Oscura', sugerencia: 'Aclárala', prioridad: 'alta' }, { problema: 'sin sugerencia' }], riesgo_politicas: { nivel: 'bajo' } });
    expect(r).toMatchObject({ score: 10, improvements: [{ area: 'imagen', priority: 'ALTA' }], policyRisk: { level: 'BAJO' } });
    expect(normalizeReview({ nada: true })).toBeNull();
    expect(normalizeReview('texto')).toBeNull();
  });
});

describe('armado del anuncio', () => {
  const ctx = { currency: 'COP', timezone: 'America/Bogota', pageId: '1234567', maxDailyBudget: 50000, today: '2026-10-28' };

  it('todo se crea en pausa y la web lleva UTM', () => {
    const d = clientDraftFrom({ ...DRAFT, goal: 'WEBSITE', websiteUrl: 'https://restaurante.co/reservas?mesa=1', cta: 'ORDER_NOW', startDate: '2026-10-30', endDate: '2026-11-06' });
    expect(validateClientDraft(d, { ...ctx, hasImage: true })).toEqual([]);
    const plan = buildClientLaunch(d, { ...ctx, imageHash: 'abc' });
    expect([plan.campaign.status, plan.adset.status, plan.ad.status]).toEqual(['PAUSED', 'PAUSED', 'PAUSED']);
    expect(plan.link).toBe('https://restaurante.co/reservas?mesa=1&utm_source=meta&utm_medium=paid&utm_campaign=martes-de-2x1');
    expect(plan.adset).toMatchObject({ daily_budget: '40000', start_time: '2026-10-30T00:00:00-0500', end_time: '2026-11-06T23:59:00-0500' });
  });

  it('valida tope, página, web segura e imagen', () => {
    const d = clientDraftFrom({ ...DRAFT, goal: 'WEBSITE', websiteUrl: 'http://restaurante.co', dailyBudget: '90.000' });
    const e = validateClientDraft(d, { ...ctx, pageId: null, hasImage: false });
    expect(e.join(' | ')).toMatch(/página.*\| .*supera tu tope.*https:\/\/.*imagen/);
  });

  it('recomendaciones por historial: costo por resultado, rango esperado y mejores días', () => {
    expect(planHints([], 'WHATSAPP', 40000).basis).toMatch(/no tiene historial suficiente/);
    const rows = Array.from({ length: 28 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
      const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
      return { date, spend: 10000, conversations: wd === 5 || wd === 6 ? 6 : 2, linkClicks: 0 };
    });
    const h = planHints(rows, 'WHATSAPP', 40000);
    expect(h.costPerResult).toBeGreaterThan(0);
    expect(h.expected!.low).toBeLessThan(h.expected!.high);
    expect(h.bestDays).toEqual(expect.arrayContaining(['viernes', 'sábado']));
  });
});

/* ── Servicio con Meta e IA falsos ── */

function world(opts: { aiKey?: boolean; scopes?: string[]; failAt?: string } = {}) {
  const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: true });
  db.company.push({ id: 'coA', name: 'Hamburguesas Aurora', slug: 'aurora', currency: 'COP', timezone: 'America/Bogota', productsJson: JSON.stringify({ ADS: { enabled: true } }), deepinfraApiKey: opts.aiKey ? encryptSecret('di-key-123456') : null });
  db.adAccount.push({ id: 'acc1', companyId: 'coA', provider: 'META', mode: 'REAL', externalId: 'act_90011', name: 'Aurora', currency: 'COP', timezone: 'America/Bogota', status: 'CONNECTED', tokenEnc: encryptSecret('EAAG'.padEnd(40, 'x')), scopesJson: JSON.stringify(opts.scopes ?? ['ads_management', 'ads_read', 'business_management']), createdAt: NOW });
  db.adSettings.push({ id: 's1', companyId: 'coA', maxDailyBudget: 50000, autonomy: 'ANALYSIS', globalPause: false, autoActionsJson: '[]', maxDataAgeHours: 6 });
  const calls: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  let failAt = opts.failAt;
  let n = 0;
  const fetchImpl = async (url: string, init?: any) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const p = method === 'GET' ? u.searchParams : new URLSearchParams(init?.body ?? '');
    const params: Record<string, string> = {};
    p.forEach((v, k) => { if (k !== 'access_token' && k !== 'bytes') params[k] = v; });
    const path = u.pathname.replace(/^\/v[\d.]+/, '');
    calls.push({ method, path, params });
    let body: any = { data: [] };
    if (path === '/me/accounts') body = { data: [{ id: '5550001', name: 'Aurora Página', instagram_business_account: { id: '1784000' } }] };
    else if (failAt && path.endsWith(failAt)) { body = { error: { code: 2, message: 'Service temporarily unavailable' } }; failAt = undefined; }
    else if (path.endsWith('/adimages')) body = { images: { 'x.jpg': { hash: 'HASH1', width: 1080, height: 1350 } } };
    else if (method === 'POST' && /\/(campaigns|adsets|adcreatives|ads)$/.test(path)) body = { id: String(1000 + ++n) };
    else if (method === 'POST') body = { success: true };
    const status = body?.error ? 400 : 200;
    return { ok: status < 400, status, json: async () => body } as any;
  };
  const chat = jest.fn(async () => ({ content: JSON.stringify({ lo_que_ves: 'Una hamburguesa', resumen: 'Clara y apetitosa', puntaje: 8, lo_que_funciona: ['Oferta concreta'], mejoras: [{ aspecto: 'texto', problema: 'Largo', sugerencia: 'Acórtalo', prioridad: 'media' }], riesgo_politicas: { nivel: 'bajo' } }), inputTokens: 1200, outputTokens: 300, model: 'm' }));
  const audit = { log: jest.fn(async () => undefined) };
  const svc = new AdsCreateService(prisma as any, audit as any, { chat, transcribe: jest.fn() } as any);
  svc.fetchImpl = fetchImpl as any;
  svc.now = () => NOW;
  const img = jpeg(1080, 1350);
  jest.spyOn(svc as any, 'assetBytes').mockImplementation(async (...args: unknown[]) => {
    if (args[1] !== 'asset1') throw new BadRequestException('Imagen no encontrada en tu biblioteca');
    return { asset: { id: 'asset1', mimeType: 'image/jpeg' }, buffer: img };
  });
  return { svc, db, calls, chat, audit };
}

const BODY = { accountId: 'acc1', pageId: '5550001', instagramUserId: '1784000', assetId: 'asset1', draft: DRAFT };

describe('crear anuncios desde Ads', () => {
  it('la preparación lista páginas, dice qué permite la conexión y aclara quién paga la IA', async () => {
    const { svc } = world();
    const s: any = await svc.setup(A, {});
    expect(s.pages).toEqual([{ id: '5550001', name: 'Aurora Página', instagramUserId: '1784000' }]);
    expect(s.account.access).toMatchObject({ manage: true });
    expect(s.ai).toMatchObject({ available: false });
    expect(s.ai.note).toMatch(/no tiene configurado un proveedor de IA/);
    const withAi: any = await world({ aiKey: true }).svc.setup(A, {});
    expect(withAi.ai.note).toMatch(/lo cobra tu proveedor directamente/);
  });

  it('sin IA la revisión es solo por código y lo dice; con IA suma recomendaciones y registra el consumo como BYOK', async () => {
    const noAi = world();
    const r1: any = await noAi.svc.review(A, BODY);
    expect(r1.ai.status).toBe('NO_KEY');
    expect(r1.code.items.length).toBeGreaterThan(3);
    expect(noAi.chat).not.toHaveBeenCalled();

    const withAi = world({ aiKey: true });
    const r2: any = await withAi.svc.review(A, BODY);
    expect(r2.ai).toMatchObject({ status: 'OK', billedTo: 'BYOK', review: { seen: 'Una hamburguesa', score: 8 } });
    // La IA recibe una copia reducida en JPEG, nunca el archivo original
    const sent = (withAi.chat.mock.calls[0] as any)[0].messages[1].content[1].image_url.url as string;
    expect(sent.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(withAi.db.aiUsageEvent).toEqual([expect.objectContaining({ companyId: 'coA', billedTo: 'BYOK', inputTokens: 1200 })]);
  });

  it('si la IA falla, queda la revisión por código con el motivo', async () => {
    const w = world({ aiKey: true });
    w.chat.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { providerStatus: 401 }));
    const r: any = await w.svc.review(A, BODY);
    expect(r.ai.status).toBe('ERROR');
    expect(r.ai.message).toMatch(/rechazó la llave.*Queda la revisión por reglas/);
    expect(r.code.score).toBeGreaterThan(0);
  });

  it('crea imagen, campaña, conjunto, creativo y anuncio, todo en pausa, y nada se activa sin confirmar', async () => {
    const { svc, calls } = world();
    await expect(svc.create(A, BODY)).rejects.toThrow(/Confirma/);
    const l: any = await svc.create(A, { ...BODY, confirm: true });
    expect(l).toMatchObject({ status: 'PAUSED', ids: { campaign: '1001', adset: '1002', creative: '1003', ad: '1004' } });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(posts).toEqual(['/act_90011/adimages', '/act_90011/campaigns', '/act_90011/adsets', '/act_90011/adcreatives', '/act_90011/ads']);
    expect(calls.filter((c) => c.method === 'POST').some((c) => c.params.status === 'ACTIVE')).toBe(false);
    const creative = calls.find((c) => c.path.endsWith('/adcreatives'))!;
    expect(JSON.parse(creative.params.object_story_spec)).toMatchObject({ page_id: '5550001', instagram_user_id: '1784000', link_data: { image_hash: 'HASH1' } });

    await expect(svc.activate(A, l.id, {})).rejects.toThrow(/confirma/);
    const before = calls.length;
    const act: any = await svc.activate(A, l.id, { confirm: true });
    expect(act.status).toBe('ACTIVE');
    // La campaña se activa al final: si algo falla antes, nada gasta
    expect(calls.slice(before).map((c) => c.path)).toEqual(['/1004', '/1002', '/1001']);
  });

  it('si Meta falla a mitad, el reintento sigue donde quedó sin duplicar la campaña', async () => {
    const { svc, calls } = world({ failAt: '/adsets' });
    const l: any = await svc.create(A, { ...BODY, confirm: true });
    expect(l).toMatchObject({ status: 'FAILED', ids: { campaign: '1001' } });
    expect(l.error).toMatch(/temporarily unavailable/);
    const r: any = await svc.retry(A, l.id);
    expect(r.status).toBe('PAUSED');
    expect(calls.filter((c) => c.path.endsWith('/campaigns'))).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith('/adimages'))).toHaveLength(1);
  });

  it('con permisos de solo lectura no intenta crear y explica qué falta', async () => {
    const { svc, calls } = world({ scopes: ['ads_read'] });
    await expect(svc.create(A, { ...BODY, confirm: true })).rejects.toThrow(/no tiene permiso para crear anuncios.*ads_management/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('no se activa por encima del tope diario', async () => {
    const { svc, db } = world();
    const l: any = await svc.create(A, { ...BODY, confirm: true });
    db.adSettings[0].maxDailyBudget = 20000;
    await expect(svc.activate(A, l.id, { confirm: true })).rejects.toThrow(/supera tu tope/);
  });

  it('dos activaciones a la vez: solo una pasa (candado)', async () => {
    const { svc } = world();
    const l: any = await svc.create(A, { ...BODY, confirm: true });
    const both = await Promise.allSettled([svc.activate(A, l.id, { confirm: true }), svc.activate(A, l.id, { confirm: true })]);
    expect(both.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });

  it('otra empresa no ve ni toca el anuncio', async () => {
    const { svc, db } = world();
    const l: any = await svc.create(A, { ...BODY, confirm: true });
    db.company.push({ id: 'coB', name: 'B', slug: 'b', productsJson: JSON.stringify({ ADS: { enabled: true } }) });
    const B = { ...A, id: 'uB', companyId: 'coB' };
    await expect(svc.activate(B, l.id, { confirm: true })).rejects.toThrow(/no encontrado/);
    expect(await svc.list(B)).toEqual([]);
  });

  it('la semana muestra los conjuntos que corren cada día y los anuncios de BackOffice aún sin sincronizar', async () => {
    const { svc, db } = world();
    db.adEntity.push(
      { id: 'e1', companyId: 'coA', accountId: 'acc1', level: 'CAMPAIGN', externalId: 'c9', name: 'Almuerzos', status: 'ACTIVE', effectiveStatus: 'ACTIVE', rawJson: '{}' },
      { id: 'e2', companyId: 'coA', accountId: 'acc1', level: 'ADSET', externalId: 's9', campaignExternalId: 'c9', name: 'Almuerzos · Medellín', status: 'ACTIVE', effectiveStatus: 'ACTIVE', dailyBudget: 30000, rawJson: JSON.stringify({ start_time: '2026-10-20T00:00:00-0500', end_time: '2026-10-29T23:59:00-0500' }) },
      { id: 'e3', companyId: 'coA', accountId: 'acc1', level: 'ADSET', externalId: 's8', campaignExternalId: 'c9', name: 'Terminado', status: 'ACTIVE', effectiveStatus: 'ACTIVE', rawJson: JSON.stringify({ start_time: '2026-09-01T00:00:00-0500', end_time: '2026-09-10T23:59:00-0500' }) },
    );
    await svc.create(A, { ...BODY, confirm: true, draft: { ...DRAFT, startDate: '2026-10-31', endDate: '2026-11-07' } });
    const w: any = await svc.week(A, {});
    expect(w.start).toBe('2026-10-26');
    expect(w.days).toHaveLength(7);
    expect(w.items.map((i: any) => [i.name, i.source, i.start, i.end])).toEqual([
      ['Almuerzos · Medellín', 'META', '2026-10-20', '2026-10-29'],
      ['Martes de 2x1', 'BACKOFFICE', '2026-10-31', '2026-11-07'],
    ]);
  });

  it('el tope diario se guarda sin tocar la autonomía del Autopilot', async () => {
    const { svc, db } = world();
    db.adSettings[0].autonomy = 'RECOMMEND';
    await svc.setBudgetCap(A, { maxDailyBudget: '80.000' });
    expect(db.adSettings[0]).toMatchObject({ maxDailyBudget: 80000, autonomy: 'RECOMMEND' });
    await expect(svc.setBudgetCap(A, { maxDailyBudget: '0' })).rejects.toThrow(/mayor a 0/);
  });
});
