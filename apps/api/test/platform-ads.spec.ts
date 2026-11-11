import { BadRequestException, ConflictException } from '@nestjs/common';
import { MetaAdsService } from '../src/modules/meta-ads.module';
import { buildLaunch, draftFrom, parseAmount, validateLaunch, zoneOffset } from '../src/common/ads/launch';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const DEV = { id: 'd1', role: 'DEV', companyId: null, name: 'Santi', email: 's@b.dev' } as any;
const TOKEN = 'EAAB'.padEnd(40, 'z');
const CTX = { currency: 'COP', timezone: 'America/Bogota', pageId: '5550001', instagramUserId: null, landingBase: 'https://app.backoffice.co', maxDailyBudget: 100000, today: '2026-10-27' };
const DRAFT = {
  name: 'Lanzamiento CRM Noviembre', goal: 'SIGNUPS', dailyBudget: '50.000', countries: ['co'], advantageAudience: true, ageMin: 21, ageMax: 50, gender: 'ALL',
  primaryText: 'Ordena tus ventas por WhatsApp en un solo lugar.', headline: 'Prueba BackOffice gratis', cta: 'SIGN_UP', imageHash: 'hash123',
};

describe('lanzamiento · armado determinista', () => {
  it('registros: tráfico a /registro con UTM, Advantage+ sin edad máxima, COP sin decimales y todo en pausa', () => {
    const d = draftFrom({ ...DRAFT, extra: 'ignorado' });
    expect(d).not.toHaveProperty('extra');
    expect(d.countries).toEqual(['CO']);
    expect(d.dailyBudget).toBe(50000);
    expect(validateLaunch(d, CTX)).toEqual([]);
    const p = buildLaunch(d, CTX);
    expect(p.utmCampaign).toBe('lanzamiento-crm-noviembre');
    expect(p.link).toBe('https://app.backoffice.co/registro?utm_source=meta&utm_medium=paid&utm_campaign=lanzamiento-crm-noviembre');
    expect(p.campaign).toMatchObject({ objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: '[]' });
    expect(p.adset).toMatchObject({ daily_budget: '50000', optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS', destination_type: 'WEBSITE', status: 'PAUSED' });
    expect(p.adset).not.toHaveProperty('promoted_object');
    const targeting = JSON.parse(p.adset.targeting);
    expect(targeting).toEqual({ geo_locations: { countries: ['CO'] }, age_min: 21, targeting_automation: { advantage_audience: 1 } });
    const spec = JSON.parse(p.creative.object_story_spec);
    expect(spec.page_id).toBe('5550001');
    expect(spec.link_data).toMatchObject({ link: p.link, image_hash: 'hash123', call_to_action: { type: 'SIGN_UP', value: { link: p.link } } });
    expect(p.ad.status).toBe('PAUSED');
  });

  it('WhatsApp: interacción con destino WHATSAPP, página promocionada y botón de WhatsApp', () => {
    const p = buildLaunch(draftFrom({ ...DRAFT, goal: 'WHATSAPP', cta: 'SIGN_UP' }), CTX);
    expect(p.campaign.objective).toBe('OUTCOME_ENGAGEMENT');
    expect(p.adset).toMatchObject({ optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP', promoted_object: JSON.stringify({ page_id: '5550001' }) });
    const link = JSON.parse(p.creative.object_story_spec).link_data;
    expect(link).toMatchObject({ link: 'https://api.whatsapp.com/send', call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } });
    expect(p.link).toBeNull();
  });

  it('público manual: edad máxima y género; fechas con la zona de la cuenta; USD en centavos', () => {
    const d = draftFrom({ ...DRAFT, advantageAudience: false, ageMin: 30, ageMax: 55, gender: 'FEMALE', startDate: '2026-11-01', endDate: '2026-11-15', dailyBudget: '20' }, 'USD');
    const p = buildLaunch(d, { ...CTX, currency: 'USD' });
    expect(JSON.parse(p.adset.targeting)).toMatchObject({ age_min: 30, age_max: 55, genders: [2], targeting_automation: { advantage_audience: 0 } });
    expect(p.adset.daily_budget).toBe('2000');
    expect(p.adset.start_time).toBe('2026-11-01T00:00:00-0500');
    expect(p.adset.end_time).toBe('2026-11-15T23:59:00-0500');
    expect(zoneOffset('Europe/Madrid', '2026-07-01')).toBe('+0200');
  });

  it('lee montos según la moneda: en COP el punto separa miles, en USD es decimal', () => {
    expect(parseAmount('50.000', 'COP')).toBe(50000);
    expect(parseAmount('$ 1,250,000', 'COP')).toBe(1250000);
    expect(parseAmount('20.50', 'USD')).toBe(20.5);
    expect(parseAmount('1.234,56', 'USD')).toBe(1234.56);
    expect(parseAmount('1,500', 'USD')).toBe(1500);
    expect(parseAmount(35000, 'COP')).toBe(35000);
  });

  it('valida página, tope, edades de Advantage+, fechas, textos e imagen', () => {
    const errs = (over: any, ctx: any = {}) => validateLaunch(draftFrom({ ...DRAFT, ...over }), { ...CTX, ...ctx });
    expect(errs({}, { pageId: null })).toContain('Elige la página de Facebook que publica el anuncio (Configuración)');
    expect(errs({}, { maxDailyBudget: null })).toContain('Define primero el tope de presupuesto diario (Configuración)');
    expect(errs({ dailyBudget: '150000' }).join()).toMatch(/supera el tope/);
    expect(errs({ ageMin: 30 }).join()).toMatch(/Advantage\+ la edad mínima va de 18 a 25/);
    expect(errs({ startDate: '2026-10-01' })).toContain('La fecha de inicio ya pasó');
    expect(errs({ startDate: '2026-11-01', endDate: '2026-11-01' })).toContain('La fecha de fin debe ser al menos un día después del inicio');
    expect(errs({ imageHash: '', headline: '', cta: 'COMPRAR_YA' })).toEqual(expect.arrayContaining(['Sube la imagen o el video del anuncio', 'Escribe el título del anuncio', 'Elige el botón del anuncio']));
    expect(errs({ countries: ['XYZ'] })).toContain('Elige al menos un país');
  });
});

/** Meta falso: responde según la ruta y guarda cada llamada (sin red real). */
function fakeMeta(opts: { failOn?: string } = {}) {
  const calls: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  let n = 0;
  const fetchImpl = async (url: string, init?: any) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const params = Object.fromEntries(method === 'GET' ? u.searchParams : new URLSearchParams(init.body));
    const path = u.pathname.replace(/^\/v[\d.]+/, '');
    calls.push({ method, path, params });
    const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
    if (opts.failOn && method === 'POST' && path.endsWith(opts.failOn)) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 100, message: 'Invalid parameter' } }) };
    }
    if (method === 'GET' && path === '/act_1234567') return ok({ name: 'BackOffice Ads', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1 });
    if (method === 'GET' && path === '/me/accounts') return ok({ data: [{ id: '5550001', name: 'BackOffice', instagram_business_account: { id: '7770001' } }] });
    if (method === 'GET' && path.endsWith('/campaigns')) return ok({ data: [{ id: '9000001', name: 'Lanzamiento CRM Noviembre', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_TRAFFIC' }] });
    if (method === 'GET' && path.endsWith('/insights')) return ok({ data: [{ campaign_id: '9000001', spend: '90000' }] });
    if (method === 'POST' && path.endsWith('/adimages')) return ok({ images: { 'x.png': { hash: 'abc123hash', width: 1080, height: 1080 } } });
    if (method === 'POST' && /\/act_\d+\/(campaigns|adsets|adcreatives|ads)$/.test(path)) return ok({ id: String(9000001 + n++) });
    if (method === 'POST') return ok({ success: true });
    return ok({});
  };
  return { calls, fetchImpl };
}

async function setup(meta = fakeMeta()) {
  const { prisma, db } = createMockPrisma();
  db.platformSetting.push({ id: 'ps1', key: 'PUBLIC_WEB_URL', value: 'https://app.backoffice.co' });
  const audit = { log: jest.fn(async () => undefined) };
  const ads = new MetaAdsService(prisma as any, audit as any);
  ads.fetchImpl = meta.fetchImpl as any;
  await ads.connect(DEV, { accountId: 'act_1234567', token: TOKEN });
  await ads.savePrefs(DEV, { pageId: '5550001', pageName: 'BackOffice', maxDailyBudget: '100.000' });
  meta.calls.length = 0;
  return { ads, db, audit, calls: meta.calls, prisma };
}

const posts = (calls: Array<{ method: string; path: string; params: Record<string, string> }>) => calls.filter((c) => c.method === 'POST');

describe('lanzamiento · servicio con Meta falso', () => {
  it('la revisión no toca Meta ni guarda nada; crear exige confirmación y deja los 4 pasos en pausa', async () => {
    const { ads, db, calls, audit } = await setup();
    const prev = await ads.preview(DRAFT);
    expect(prev.valid).toBe(true);
    expect(prev.summary).toMatchObject({ utmCampaign: 'lanzamiento-crm-noviembre', status: 'PAUSED', dailyBudget: 50000 });
    expect(posts(calls)).toHaveLength(0);
    expect(db.platformSetting.some((r: any) => r.key.startsWith('META_ADS_LAUNCH:'))).toBe(false);

    await expect(ads.createLaunch(DEV, { draft: DRAFT })).rejects.toBeInstanceOf(BadRequestException);
    const l = await ads.createLaunch(DEV, { draft: DRAFT, confirm: true });
    expect(l.status).toBe('PAUSED');
    expect(posts(calls).map((c) => c.path)).toEqual(['/act_1234567/campaigns', '/act_1234567/adsets', '/act_1234567/adcreatives', '/act_1234567/ads']);
    expect(posts(calls).every((c) => c.path.endsWith('adcreatives') || c.params.status === 'PAUSED')).toBe(true);
    expect(posts(calls)[1].params.campaign_id).toBe(l.ids.campaign);
    expect(JSON.parse(posts(calls)[3].params.creative)).toEqual({ creative_id: l.ids.creative });
    expect(l.ids).toEqual({ campaign: '9000001', adset: '9000002', creative: '9000003', ad: '9000004' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ads.launch.create' }));
    // El token nunca queda en el lanzamiento ni en lo que ve el navegador
    expect(JSON.stringify(db.platformSetting)).not.toContain(TOKEN);
    expect(JSON.stringify(ads.view(l))).not.toContain(TOKEN);
  });

  it('si falla un paso queda FALLIDO con lo creado; el reintento sigue desde ahí sin duplicar la campaña', async () => {
    const { ads } = await setup(fakeMeta({ failOn: '/adsets' }));
    const l = await ads.createLaunch(DEV, { draft: DRAFT, confirm: true });
    expect(l.status).toBe('FAILED');
    expect(l.ids).toEqual({ campaign: '9000001' });
    expect(l.error).toMatch(/Invalid parameter/);
    expect(l.history.at(-1)?.event).toBe('Falló en el paso 2 de 4');
    // Meta ya responde bien: el reintento solo crea lo que faltaba
    const fixed = fakeMeta();
    ads.fetchImpl = fixed.fetchImpl as any;
    const r = await ads.retryLaunch(DEV, l.id);
    expect(r.status).toBe('PAUSED');
    expect(r.ids.campaign).toBe('9000001');
    expect(posts(fixed.calls).map((c) => c.path)).toEqual(['/act_1234567/adsets', '/act_1234567/adcreatives', '/act_1234567/ads']);
    await expect(ads.retryLaunch(DEV, l.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza nombres repetidos y lanzamientos que no pasan la validación', async () => {
    const { ads } = await setup();
    await ads.createLaunch(DEV, { draft: DRAFT, confirm: true });
    const err = await ads.createLaunch(DEV, { draft: { ...DRAFT, name: 'lanzamiento crm  noviembre' }, confirm: true }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().errors.join()).toMatch(/Ya hay un lanzamiento con ese nombre/);
    const err2 = await ads.createLaunch(DEV, { draft: { ...DRAFT, name: 'Otra', dailyBudget: '500.000' }, confirm: true }).catch((e) => e);
    expect(err2.getResponse().errors.join()).toMatch(/supera el tope/);
  });

  it('activar exige confirmación y el tope vigente; activa anuncio, conjunto y campaña en ese orden', async () => {
    const { ads, calls, audit } = await setup();
    const l = await ads.createLaunch(DEV, { draft: DRAFT, confirm: true });
    calls.length = 0;
    await expect(ads.activateLaunch(DEV, l.id, {})).rejects.toBeInstanceOf(BadRequestException);
    await ads.savePrefs(DEV, { pageId: '5550001', maxDailyBudget: '40000' });
    await expect(ads.activateLaunch(DEV, l.id, { confirm: true })).rejects.toThrow(/supera el tope diario actual/);
    await ads.savePrefs(DEV, { pageId: '5550001', maxDailyBudget: '100000' });
    calls.length = 0;
    const a = await ads.activateLaunch(DEV, l.id, { confirm: true });
    expect(a.status).toBe('ACTIVE');
    expect(posts(calls).map((c) => `${c.path}:${c.params.status}`)).toEqual(['/9000004:ACTIVE', '/9000002:ACTIVE', '/9000001:ACTIVE']);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ads.launch.activate' }));
    await expect(ads.archiveLaunch(DEV, l.id)).rejects.toThrow(/Pausa la campaña/);
    const p = await ads.pauseLaunch(DEV, l.id);
    expect(p.status).toBe('PAUSED');
    await ads.archiveLaunch(DEV, l.id);
    expect((await ads.launches()).find((x) => x.id === l.id)?.status).toBe('ARCHIVED');
  });

  it('presupuesto: bajar no pide confirmación; subir sí; nunca por encima del tope; se envía en la moneda de Meta', async () => {
    const { ads, calls } = await setup();
    const l = await ads.createLaunch(DEV, { draft: DRAFT, confirm: true });
    calls.length = 0;
    const down = await ads.setLaunchBudget(DEV, l.id, { dailyBudget: '30.000' });
    expect(down.draft.dailyBudget).toBe(30000);
    expect(posts(calls)[0]).toMatchObject({ path: '/9000002', params: expect.objectContaining({ daily_budget: '30000' }) });
    await expect(ads.setLaunchBudget(DEV, l.id, { dailyBudget: '60000' })).rejects.toThrow(/confirma/);
    await expect(ads.setLaunchBudget(DEV, l.id, { dailyBudget: '200000', confirm: true })).rejects.toThrow(/Supera el tope/);
    const up = await ads.setLaunchBudget(DEV, l.id, { dailyBudget: '60000', confirm: true });
    expect(up.draft.dailyBudget).toBe(60000);
  });

  it('dos operaciones a la vez sobre el mismo lanzamiento: la segunda espera (candado)', async () => {
    const { ads, db } = await setup();
    const l = await ads.createLaunch(DEV, { draft: DRAFT, confirm: true });
    const row = db.platformSetting.find((r: any) => r.key === `META_ADS_LAUNCH:${l.id}`)!;
    row.value = JSON.stringify({ ...JSON.parse(row.value), lockUntil: new Date(Date.now() + 60_000).toISOString() });
    await expect(ads.activateLaunch(DEV, l.id, { confirm: true })).rejects.toBeInstanceOf(ConflictException);
    expect(ads.view(JSON.parse(row.value)).processing).toBe(true);
  });

  it('la tabla de campañas: activar pide confirmación y el cruce usa el utm del lanzamiento', async () => {
    const { ads, db, calls } = await setup();
    const l = await ads.createLaunch(DEV, { draft: DRAFT, confirm: true });
    await expect(ads.setStatus(DEV, '9000001', 'ACTIVE')).rejects.toThrow(/confirma/);
    await ads.setStatus(DEV, '9000001', 'ACTIVE', true);
    expect((await ads.launches())[0].status).toBe('ACTIVE');
    db.signupSession.push(
      { id: 's1', step: 'DONE', utmSource: 'meta', utmCampaign: 'lanzamiento-crm-noviembre', createdAt: new Date() },
      { id: 's2', step: 'PREVIEW', utmSource: 'meta', utmCampaign: 'lanzamiento-crm-noviembre', createdAt: new Date() },
    );
    const r: any = await ads.overview({ days: '30' });
    expect(r.campaigns[0]).toMatchObject({ id: '9000001', launchId: l.id, signups: 2, companies: 1, costPerCompany: 90000 });
    // Usa la versión configurable de la API, no una fija vencida
    expect(calls.some((c) => c.path === '/act_1234567/insights')).toBe(true);
  });

  it('imágenes: solo JPG o PNG reales; devuelve el hash de Meta', async () => {
    const { ads, calls } = await setup();
    await expect(ads.uploadImage(DEV, { buffer: Buffer.from('<svg></svg>'), size: 11 })).rejects.toThrow(/JPG o PNG/);
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]);
    const r = await ads.uploadImage(DEV, { buffer: png, size: png.length });
    expect(r).toEqual({ hash: 'abc123hash', width: 1080, height: 1080 });
    expect(posts(calls)[0].params.bytes).toBe(png.toString('base64'));
  });

  it('configuración: lista páginas con su Instagram y exige un tope válido', async () => {
    const { ads } = await setup();
    const s: any = await ads.setup();
    expect(s.pages).toEqual([{ id: '5550001', name: 'BackOffice', instagramUserId: '7770001' }]);
    expect(s.account).toMatchObject({ currency: 'COP', timezone: 'America/Bogota' });
    expect(s.landingBase).toBe('https://app.backoffice.co');
    await expect(ads.savePrefs(DEV, { pageId: '5550001', maxDailyBudget: '0' })).rejects.toThrow(/tope/);
    await expect(ads.savePrefs(DEV, { pageId: 'abc', maxDailyBudget: '1000' })).rejects.toThrow(/solo números/);
  });
});

describe('lanzamiento · anuncio de video', () => {
  const VIDEO = { ...DRAFT, name: 'Video automatizaciones', imageHash: '', videoId: '880001' };
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(32)]);

  /** Meta falso con video: sube a /advideos y responde el estado según la lista. */
  function videoMeta(states: string[]) {
    const base = fakeMeta();
    const hosts: string[] = [];
    let i = 0;
    const fetchImpl = async (url: string, init?: any) => {
      const u = new URL(url);
      hosts.push(u.host);
      const path = u.pathname.replace(/^\/v[\d.]+/, '');
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
      if (init?.method === 'POST' && path.endsWith('/advideos')) {
        base.calls.push({ method: 'POST', path, params: { source: String(init.body.get('source')?.size ?? 0) } });
        return ok({ id: '880001' });
      }
      if ((init?.method ?? 'GET') === 'GET' && path === '/880001') {
        base.calls.push({ method: 'GET', path, params: {} });
        const st = states[Math.min(i++, states.length - 1)];
        return ok({ status: { video_status: st }, picture: 'https://scontent.example/miniatura.jpg', length: 28.4 });
      }
      return base.fetchImpl(url, init);
    };
    return { calls: base.calls, fetchImpl, hosts };
  }

  it('armado: video_data con el video, el texto, el botón y la portada; sin imagen ni video no pasa', () => {
    const d = draftFrom(VIDEO);
    expect(d.videoId).toBe('880001');
    expect(validateLaunch(d, CTX)).toEqual([]);
    expect(draftFrom({ ...VIDEO, videoId: 'abc; drop' })).not.toHaveProperty('videoId');
    expect(validateLaunch(draftFrom({ ...VIDEO, videoId: '' }), CTX)).toContain('Sube la imagen o el video del anuncio');

    const p = buildLaunch(d, CTX, { videoThumb: 'https://scontent.example/miniatura.jpg' });
    expect(p.format).toBe('VIDEO');
    const spec = JSON.parse(p.creative.object_story_spec);
    expect(spec).not.toHaveProperty('link_data');
    expect(spec.video_data).toMatchObject({
      video_id: '880001', message: VIDEO.primaryText, title: VIDEO.headline, image_url: 'https://scontent.example/miniatura.jpg',
      call_to_action: { type: 'SIGN_UP', value: { link: p.link } },
    });
    // Con portada subida manda esa y no la miniatura de Meta
    const conPortada = JSON.parse(buildLaunch(draftFrom({ ...VIDEO, imageHash: 'hash123' }), CTX, { videoThumb: 'https://x/y.jpg' }).creative.object_story_spec).video_data;
    expect(conPortada.image_hash).toBe('hash123');
    expect(conPortada).not.toHaveProperty('image_url');
    // WhatsApp: el botón abre el chat
    const wa = JSON.parse(buildLaunch(draftFrom({ ...VIDEO, goal: 'WHATSAPP' }), CTX).creative.object_story_spec).video_data;
    expect(wa.call_to_action.type).toBe('WHATSAPP_MESSAGE');
    // El de imagen sigue igual
    expect(buildLaunch(draftFrom(DRAFT), CTX).format).toBe('IMAGE');
  });

  it('subida: solo MP4 o MOV reales, por el host de video, y devuelve el ID', async () => {
    const meta = videoMeta(['ready']);
    const { ads, audit } = await setup(meta as any);
    await expect(ads.uploadVideo(DEV, { buffer: Buffer.from('esto no es un video'), size: 19 })).rejects.toThrow(/MP4 o MOV/);
    await expect(ads.uploadVideo(DEV, { buffer: mp4, size: 65 * 1024 * 1024 })).rejects.toThrow(/64 MB/);
    meta.hosts.length = 0;
    expect(await ads.uploadVideo(DEV, { buffer: mp4, size: mp4.length })).toEqual({ id: '880001' });
    expect(meta.hosts).toEqual(['graph-video.facebook.com']);
    expect(posts(meta.calls)[0]).toMatchObject({ path: '/act_1234567/advideos', params: { source: String(mp4.length) } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ads.video' }));
    expect(await ads.videoStatus('880001')).toMatchObject({ ready: true, seconds: 28, thumb: 'https://scontent.example/miniatura.jpg' });
    await expect(ads.videoStatus('../me')).rejects.toThrow(/solo números/);
  });

  it('lanzar: espera a que Meta procese el video y usa su miniatura; todo queda en pausa', async () => {
    const meta = videoMeta(['processing', 'processing', 'ready']);
    const { ads, calls } = await setup(meta as any);
    const waits: number[] = [];
    ads.wait = async (ms) => { waits.push(ms); };
    const l = await ads.createLaunch(DEV, { draft: VIDEO, confirm: true });
    expect(l.status).toBe('PAUSED');
    expect(waits).toHaveLength(2);
    const creative = posts(calls).find((c) => c.path.endsWith('/adcreatives'))!;
    expect(JSON.parse(creative.params.object_story_spec).video_data).toMatchObject({ video_id: '880001', image_url: 'https://scontent.example/miniatura.jpg' });
    expect(ads.view(l)).toMatchObject({ status: 'PAUSED' });
  });

  it('si el video no alcanza a procesarse queda FALLIDO sin creativo; al reintentar continúa sin duplicar', async () => {
    const meta = videoMeta(['processing']);
    const { ads } = await setup(meta as any);
    ads.wait = async () => undefined;
    const l = await ads.createLaunch(DEV, { draft: VIDEO, confirm: true });
    expect(l.status).toBe('FAILED');
    expect(l.error).toMatch(/procesando el video/);
    expect(Object.keys(l.ids)).toEqual(['campaign', 'adset']);
    const listo = videoMeta(['ready']);
    ads.fetchImpl = listo.fetchImpl as any;
    const r = await ads.retryLaunch(DEV, l.id);
    expect(r.status).toBe('PAUSED');
    expect(posts(listo.calls).map((c) => c.path)).toEqual(['/act_1234567/adcreatives', '/act_1234567/ads']);
  });

  it('video que Meta rechaza: error claro para volver a subirlo', async () => {
    const { ads } = await setup(videoMeta(['error']) as any);
    ads.wait = async () => undefined;
    const l = await ads.createLaunch(DEV, { draft: VIDEO, confirm: true });
    expect(l.status).toBe('FAILED');
    expect(l.error).toMatch(/no pudo procesar el video/);
  });
});
