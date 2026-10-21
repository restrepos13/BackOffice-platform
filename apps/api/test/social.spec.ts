/**
 * Extra "Redes sociales con IA": créditos del mes (imagen 1, video 4), cobro en
 * la factura, generación de imágenes, plan del mes, programación y publicación
 * en Facebook / Instagram (modo prueba y Graph API simulada), y login con Meta.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { createMockPrisma } from './helpers/mock-prisma';
import { SocialService, nextSlots } from '../src/modules/social.module';
import { CompaniesService } from '../src/modules/companies.module';
import { addonInvoiceLines, refundCredits, reserveCredits, socialAddon, socialUsage } from '../src/common/social-addon';
import { buildInvoiceLines } from '../src/common/billing-engine';
import { signState, verifyState } from '../src/common/meta-publish';
import { encryptSecret } from '../src/common/crypto';
import { placeholderImage } from '../src/ai/media-gen';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 's'.repeat(32);

const audit = { log: jest.fn(async () => undefined) };
const ADMIN = { id: 'adm1', role: 'COMPANY_ADMIN', companyId: 'co1', name: 'Ana', email: 'a@x.co' } as any;
const PLATFORM = { id: 'dev1', role: 'DEV', companyId: null, name: 'Dev', email: 'd@x.co' } as any;

function reply(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function setup(opts: { addon?: boolean; credits?: number; connection?: 'sandbox' | 'real' | null } = {}) {
  const { prisma, db } = createMockPrisma();
  db.company.push({
    id: 'co1', name: 'Café Luna', timezone: 'America/Bogota', modulesJson: '["marketing"]', orderConfigJson: '{}',
    addonsJson: opts.addon === false ? null : JSON.stringify({ social: { enabled: true, price: 150000, credits: opts.credits ?? 20 } }),
  });
  if (opts.connection) {
    db.integration.push({
      id: 'int1', companyId: 'co1', type: 'META_SOCIAL', status: 'CONNECTED',
      configJson: JSON.stringify(opts.connection === 'real'
        ? { pageId: '111', pageName: 'Café Luna', igUserId: '999', igUsername: 'cafeluna', accessTokenEnc: encryptSecret('PAGE_TOKEN'), sandbox: false, method: 'OAUTH' }
        : { pageId: '111', pageName: 'Prueba', igUserId: 'prueba', sandbox: true, method: 'SANDBOX' }),
    });
  }
  const emails = { systemSend: jest.fn(async () => ({ status: 'QUEUED' })) };
  const service = new SocialService(prisma as any, audit as any, emails as any);
  return { prisma, db, service, emails };
}

afterAll(() => {
  const dir = resolve(process.cwd(), 'uploads', 'co1');
  // Solo se borran las imágenes de prueba de este archivo
  if (existsSync(dir)) for (const f of require('fs').readdirSync(dir)) if (f.startsWith('contenido-')) rmSync(join(dir, f));
});

describe('extra: créditos del mes y cobro', () => {
  it('20 créditos = 20 imágenes o 5 videos; no deja pasar el tope y devuelve si falla', async () => {
    const { prisma } = setup();
    for (let i = 0; i < 4; i++) expect(await reserveCredits(prisma, 'co1', 20, 'video', '2026-10')).toBe(true);
    for (let i = 0; i < 3; i++) expect(await reserveCredits(prisma, 'co1', 20, 'image', '2026-10')).toBe(true);
    expect(await reserveCredits(prisma, 'co1', 20, 'video', '2026-10')).toBe(false); // 19 + 4 > 20
    expect(await reserveCredits(prisma, 'co1', 20, 'image', '2026-10')).toBe(true); // 19 + 1 = 20
    expect(await reserveCredits(prisma, 'co1', 20, 'image', '2026-10')).toBe(false);
    expect(await socialUsage(prisma, 'co1', '2026-10')).toMatchObject({ images: 4, videos: 4, credits: 20 });
    // 5 videos caben justos en 20 créditos
    for (let i = 0; i < 5; i++) expect(await reserveCredits(prisma, 'co1', 20, 'video', '2026-12')).toBe(true);
    expect(await reserveCredits(prisma, 'co1', 20, 'image', '2026-12')).toBe(false);
    await refundCredits(prisma, 'co1', 'video', '2026-10');
    expect((await socialUsage(prisma, 'co1', '2026-10')).credits).toBe(16);
    // Otro mes arranca de cero
    expect(await reserveCredits(prisma, 'co1', 20, 'image', '2026-11')).toBe(true);
  });

  it('el extra entra a la factura del mes (también con plan anual) y solo plataforma lo prende', async () => {
    const company = { addonsJson: JSON.stringify({ social: { enabled: true, price: 150000, credits: 20 } }) };
    expect(addonInvoiceLines(company)).toEqual([{ concept: 'Extra · Redes sociales con IA (20 créditos/mes)', amount: 150000 }]);
    expect(addonInvoiceLines({ addonsJson: null })).toEqual([]);
    const annual = buildInvoiceLines({
      period: '2027-03', currency: 'COP', planName: 'Negocio', planPrice: 349000, adjustments: [],
      billingCycle: 'ANNUAL', annualStartPeriod: '2026-11', addons: addonInvoiceLines(company),
    });
    expect(annual.total).toBe(150000); // plan cubierto por el anual, el extra sí se cobra
    expect(annual.lines.map((l) => l.kind)).toEqual(['PLAN', 'ADDON']);
    const { prisma, db } = setup({ addon: false });
    const companies = new CompaniesService(prisma as any, audit as any);
    db.company[0] = { ...db.company[0], status: 'ACTIVE', modulesJson: '[]', limitsJson: '{}', waTemplatesJson: '[]', paymentConfigJson: '{}', einvoiceConfigJson: '{}' };
    await expect(companies.update(ADMIN, 'co1', { addons: { social: { enabled: true } } })).rejects.toBeInstanceOf(ForbiddenException);
    await companies.update(PLATFORM, 'co1', { addons: { social: { enabled: true, price: 180000, credits: 30 } } });
    expect(socialAddon(db.company[0])).toEqual({ enabled: true, price: 180000, credits: 30 });
    expect(JSON.parse(db.company[0].modulesJson)).toContain('marketing');
  });

  it('la empresa pide el extra y al equipo le llega el aviso', async () => {
    const { service, emails, db } = setup({ addon: false });
    await service.requestAddon(ADMIN);
    expect(JSON.parse(db.company[0].addonsJson).social.requestedAt).toBeTruthy();
    expect((emails.systemSend as jest.Mock).mock.calls[0][0].subject).toContain('Redes sociales con IA');
  });
});

describe('imágenes con IA', () => {
  it('genera (modo prueba), guarda el archivo con token público y gasta 1 crédito', async () => {
    const { service, db } = setup();
    db.contentPiece.push({ id: 'p1', companyId: 'co1', title: 'Café de origen', status: 'BORRADOR', type: 'POST', hashtagsJson: '[]', targetsJson: '[]' });
    const r = await service.generateImage(ADMIN, 'p1', { prompt: 'Taza de café de origen sobre mesa de madera, luz de mañana' });
    expect(r).toMatchObject({ status: 'LISTO', assetMime: 'image/svg+xml', provider: 'SIMULADO' });
    expect(db.contentPiece[0].mediaToken).toMatch(/^[a-f0-9]{36}$/);
    expect(existsSync(join(process.cwd(), 'uploads', 'co1', db.contentPiece[0].assetFile))).toBe(true);
    const pub = await service.publicAsset(db.contentPiece[0].mediaToken);
    expect(pub.mime).toBe('image/svg+xml');
    await expect(service.publicAsset('../../etc/passwd')).rejects.toThrow();
    expect((await service.status(ADMIN)).usage).toMatchObject({ images: 1, credits: 1, left: 19 });
  });

  it('sin el extra no genera; sin créditos tampoco; prompt muy corto se rechaza', async () => {
    const off = setup({ addon: false });
    off.db.contentPiece.push({ id: 'p1', companyId: 'co1', title: 'x', status: 'IDEA', hashtagsJson: '[]', targetsJson: '[]' });
    await expect(off.service.generateImage(ADMIN, 'p1', { prompt: 'una imagen bonita' })).rejects.toBeInstanceOf(ForbiddenException);
    const poor = setup({ credits: 0 });
    poor.db.contentPiece.push({ id: 'p1', companyId: 'co1', title: 'x', status: 'IDEA', hashtagsJson: '[]', targetsJson: '[]' });
    await expect(poor.service.generateImage(ADMIN, 'p1', { prompt: 'una imagen bonita' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(poor.service.generateImage(ADMIN, 'p1', { prompt: 'corto' })).rejects.toBeInstanceOf(BadRequestException);
    // Otra empresa no toca la pieza
    await expect(poor.service.generateImage({ ...ADMIN, companyId: 'co2' }, 'p1', { prompt: 'una imagen bonita' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(placeholderImage('<script>', '1:1').buffer.toString()).not.toContain('<script>');
  });
});

describe('plan del mes y programación', () => {
  it('reparte las publicaciones en los días y la hora elegidos (hora Colombia)', () => {
    const start = new Date('2026-11-02T00:00:00Z'); // lunes
    const slots = nextSlots(start, [1, 3, 5], '10:00', 4);
    expect(slots.map((d) => d.toISOString())).toEqual([
      '2026-11-02T15:00:00.000Z', '2026-11-04T15:00:00.000Z', '2026-11-06T15:00:00.000Z', '2026-11-09T15:00:00.000Z',
    ]);
  });

  it('el plan con IA crea borradores programados con texto y prompt de imagen', async () => {
    const { service, db } = setup();
    (service as any).platformText = jest.fn(async () => JSON.stringify({
      posts: [
        { title: 'Lunes de origen', copy: 'Prueba nuestro café de Huila ☕ Pide por WhatsApp', hashtags: ['#cafe'], image_prompt: 'taza de café' },
        { title: 'Detrás de la barra', copy: 'Así preparamos tu espresso', hashtags: [], image_prompt: 'barista' },
      ],
    }));
    await expect(service.plan(ADMIN, { weekdays: [] })).rejects.toBeInstanceOf(BadRequestException);
    const r = await service.plan(ADMIN, { weekdays: [1, 4], time: '09:30', count: 2, topic: 'café de origen', startDate: '2030-01-07', targets: ['instagram', 'hackear'] });
    expect(r.created).toBe(2);
    expect(db.contentPiece.map((p: any) => p.status)).toEqual(['BORRADOR', 'BORRADOR']);
    expect(db.contentPiece[0].scheduledAt.toISOString()).toBe('2030-01-07T14:30:00.000Z');
    expect(JSON.parse(db.contentPiece[0].targetsJson)).toEqual(['instagram']);
    expect(db.contentPiece[1].imagePrompt).toBe('barista');
  });

  it('programar exige texto, destino, conexión y (para Instagram) imagen', async () => {
    const { service, db } = setup();
    db.contentPiece.push({ id: 'p1', companyId: 'co1', title: 'x', copy: 'Hola', status: 'LISTO', hashtagsJson: '[]', targetsJson: '[]' });
    // Mañana a las 10:00 a. m. de Bogotá (dentro del horario permitido de la marca)
    const tomorrow = new Date(Date.now() + 86400e3);
    const future = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 15)).toISOString();
    await expect(service.schedule(ADMIN, 'p1', { scheduledAt: future, targets: ['facebook'] })).rejects.toThrow(/Conecta/);
    db.integration.push({ id: 'i', companyId: 'co1', type: 'META_SOCIAL', configJson: JSON.stringify({ pageId: '111', sandbox: true }) });
    await expect(service.schedule(ADMIN, 'p1', { scheduledAt: future, targets: ['instagram'] })).rejects.toThrow(/imagen/);
    await expect(service.schedule(ADMIN, 'p1', { scheduledAt: '2020-01-01', targets: ['facebook'] })).rejects.toThrow(/futura/);
    // Sin aprobación no se programa (ni la primera ni ninguna)
    await expect(service.schedule(ADMIN, 'p1', { scheduledAt: future, targets: ['facebook'] })).rejects.toThrow(/aprobación/);
    db.contentPiece[0].approvedAt = new Date();
    db.contentPiece[0].autoApproved = false;
    const ok = await service.schedule(ADMIN, 'p1', { scheduledAt: future, targets: ['facebook'] });
    expect(ok.status).toBe('PROGRAMADO');
    // A las 3 a. m. está fuera del horario de la marca
    const night = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 8)).toISOString();
    await expect(service.schedule(ADMIN, 'p1', { scheduledAt: night, targets: ['facebook'] })).rejects.toThrow(/horario/);
  });
});

describe('publicación en Facebook e Instagram', () => {
  it('modo prueba: marca publicado sin salir a internet', async () => {
    const { service, db } = setup({ connection: 'sandbox' });
    service.fetchImpl = jest.fn(async () => { throw new Error('no debería llamar a Meta'); }) as any;
    db.contentPiece.push({ id: 'p1', companyId: 'co1', title: 't', copy: 'Hola', status: 'PROGRAMADO', approvedAt: new Date(), autoApproved: false, hashtagsJson: '["#a"]', targetsJson: '["facebook","instagram"]', assetFile: 'x.svg', assetMime: 'image/svg+xml', mediaToken: 'a'.repeat(36), publishAttempts: 0 });
    const r = await service.publishPiece('p1');
    expect(r?.status).toBe('PUBLICADO');
    expect(JSON.parse(db.contentPiece[0].publishResultJson).instagram.sandbox).toBe(true);
  });

  it('real: foto a la página y a Instagram (contenedor + publicar); reintento no duplica', async () => {
    const { service, db } = setup({ connection: 'real' });
    const calls: string[] = [];
    let failIg = true;
    service.fetchImpl = jest.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0].replace('https://graph.facebook.com/v21.0', '')}`);
      if (url.includes('/111/photos')) return reply(200, { id: 'ph1', post_id: '111_55' });
      if (url.includes('/999/media_publish')) return failIg ? reply(400, { error: { message: 'Media not ready', code: 9007 } }) : reply(200, { id: 'ig77' });
      if (url.includes('/999/media')) return reply(200, { id: 'cont1' });
      return reply(404, { error: { message: 'no' } });
    }) as any;
    db.contentPiece.push({ id: 'p1', companyId: 'co1', title: 't', copy: 'Hola', status: 'PROGRAMADO', approvedAt: new Date(), autoApproved: false, hashtagsJson: '[]', targetsJson: '["facebook","instagram"]', assetFile: 'x.png', assetMime: 'image/png', mediaToken: 'b'.repeat(36), publishAttempts: 0 });
    const first = await service.publishPiece('p1');
    expect(first?.status).toBe('ERROR');
    expect(first?.publishError).toContain('Meta: Media not ready');
    // Al reintentar: Facebook ya estaba publicado y no se repite; IG reutiliza el contenedor
    failIg = false;
    db.contentPiece[0].status = 'PROGRAMADO';
    calls.length = 0;
    const second = await service.publishPiece('p1');
    expect(second?.status).toBe('PUBLICADO');
    expect(calls).toEqual(['POST /999/media_publish']);
    expect(JSON.parse(db.contentPiece[0].publishResultJson)).toMatchObject({ facebook: { id: '111_55' }, instagram: { id: 'ig77', containerId: 'cont1' } });
  });

  it('real: un reel queda "publicando" mientras Meta lo procesa; una imagen de prueba no se publica de verdad', async () => {
    const { service, db } = setup({ connection: 'real' });
    let status = 'IN_PROGRESS';
    service.fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/999/media_publish')) return reply(200, { id: 'reel1' });
      if (url.includes('/999/media')) return reply(200, { id: 'cont9' });
      if (url.includes('/cont9')) return reply(200, { status_code: status });
      return reply(404, {});
    }) as any;
    db.contentPiece.push({ id: 'v1', companyId: 'co1', title: 't', copy: 'Reel', status: 'PROGRAMADO', approvedAt: new Date(), autoApproved: false, hashtagsJson: '[]', targetsJson: '["instagram"]', assetFile: 'r.mp4', assetMime: 'video/mp4', mediaToken: 'c'.repeat(36), publishAttempts: 0 });
    expect((await service.publishPiece('v1'))?.status).toBe('PUBLICANDO');
    status = 'FINISHED';
    expect((await service.publishPiece('v1'))?.status).toBe('PUBLICADO');
    db.contentPiece.push({ id: 's1', companyId: 'co1', title: 't', copy: 'x', status: 'PROGRAMADO', approvedAt: new Date(), autoApproved: false, hashtagsJson: '[]', targetsJson: '["facebook"]', assetFile: 'x.svg', assetMime: 'image/svg+xml', mediaToken: 'd'.repeat(36), publishAttempts: 0 });
    const svg = await service.publishPiece('s1');
    expect(svg?.status).toBe('ERROR');
    expect(svg?.publishError).toContain('prueba');
  });
});

describe('conexión con Meta', () => {
  it('el "state" del login va firmado y vence', () => {
    const state = signState({ c: 'co1' }, 'secreto');
    expect(verifyState(state, 'secreto')).toMatchObject({ c: 'co1' });
    expect(verifyState(state, 'otro')).toBeNull();
    expect(verifyState(state.replace(/.$/, 'x'), 'secreto')).toBeNull();
    expect(verifyState(state, 'secreto', -1)).toBeNull();
  });

  it('login con Facebook: una página se conecta sola (token cifrado); varias se eligen', async () => {
    const { service, db, prisma } = setup();
    db.platformSetting.push({ key: 'META_APP_ID', value: 'app1' }, { key: 'META_APP_SECRET', value: 'sec' });
    const pages = [{ id: '111', name: 'Café Luna', access_token: 'PT1', instagram_business_account: { id: '999', username: 'cafeluna' } }];
    service.fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/oauth/access_token')) return reply(200, { access_token: 'USER' });
      if (url.includes('/me/accounts')) return reply(200, { data: pages });
      return reply(404, {});
    }) as any;
    const { url } = await service.oauthStart(ADMIN);
    expect(url).toContain('instagram_content_publish');
    const state = new URL(url).searchParams.get('state')!;
    expect(await service.oauthCallback('code1', state)).toContain('meta=ok');
    const conn = await service.connection('co1');
    expect(conn).toMatchObject({ pageId: '111', igUserId: '999', token: 'PT1', sandbox: false });
    expect(db.integration[0].configJson).not.toContain('PT1');
    // Varias páginas → elegir
    pages.push({ id: '222', name: 'Café Luna 2', access_token: 'PT2', instagram_business_account: null as any });
    expect(await service.oauthCallback('code2', state)).toContain('meta=elegir');
    expect((await service.status(ADMIN)).connection?.pendingPages?.map((p: any) => p.id)).toEqual(['111', '222']);
    await service.selectPage(ADMIN, '222');
    expect(await service.connection('co1')).toMatchObject({ pageId: '222', token: 'PT2' });
    expect(await service.oauthCallback('code', 'firma-falsa')).toContain('meta=error');
    void prisma;
  });

  it('conexión manual valida el token con Meta; en modo prueba no exige token', async () => {
    const { service } = setup();
    service.fetchImpl = jest.fn(async () => reply(400, { error: { message: 'Invalid OAuth access token' } })) as any;
    await expect(service.connectManual(ADMIN, { pageId: '123456', accessToken: 'malo' })).rejects.toThrow(/no aceptó/);
    await expect(service.connectManual(ADMIN, { pageId: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    const st = await service.connectManual(ADMIN, { pageId: '123456', sandbox: true });
    expect(st.connection).toMatchObject({ connected: true, sandbox: true });
    await service.disconnect(ADMIN);
    expect((await service.status(ADMIN)).connection).toBeNull();
  });
});
