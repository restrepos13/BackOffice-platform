/**
 * Tres productos independientes (Automation, Creative, Ads Intelligence):
 *  - qué tiene activo cada empresa (con compatibilidad para las anteriores),
 *  - el servidor exige el producto en cada endpoint (no solo el menú),
 *  - Ads Intelligence funciona sin Creative (sube y gestiona sus recursos),
 *  - Creative no necesita Ads, Automation no necesita ninguno de los dos,
 *  - aislamiento entre empresas en la biblioteca compartida y en el Radar.
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProductsGuard, PRODUCTS_KEY } from '../src/auth/products.guard';
import { activeProducts, hasProduct, productsExplicit, readProducts, withProductRequest, withProducts } from '../src/common/products';
import { videoInfo } from '../src/common/media-info';
import { CreativeController, CreativeService } from '../src/modules/creative.module';
import { AdsController, AdsPublicController, AdsService } from '../src/modules/ads.module';
import { ConversationsController } from '../src/modules/conversations.module';
import { CampaignsController } from '../src/modules/campaigns.module';
import { BillingController } from '../src/modules/billing.module';
import { PaymentsController } from '../src/modules/payments.module';
import { CatalogController, CustomersController } from '../src/modules/catalog.module';
import { CompaniesController } from '../src/modules/companies.module';
import { SocialController } from '../src/modules/social.module';
import { MarketingController } from '../src/modules/marketing.module';
import { OpportunitiesController, OpportunitiesService } from '../src/modules/opportunities.module';
import { LibraryController, LibraryService } from '../src/modules/library.module';
import { ProductsController, ProductsService } from '../src/modules/products.module';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn(async () => undefined) };
const only = (...keys: string[]) => JSON.stringify(Object.fromEntries(['AUTOMATION', 'CREATIVE', 'ADS'].map((k) => [k, { enabled: keys.includes(k) }])));

const ADS_ONLY = { id: 'uAds', name: 'Ads', email: 'a@x', role: 'COMPANY_ADMIN' as const, companyId: 'coAds' };
const CREATIVE_ONLY = { id: 'uCre', name: 'Cre', email: 'c@x', role: 'COMPANY_ADMIN' as const, companyId: 'coCre' };
const AUTO_ONLY = { id: 'uAut', name: 'Aut', email: 't@x', role: 'COMPANY_ADMIN' as const, companyId: 'coAut' };
const BOTH = { id: 'uBoth', name: 'Both', email: 'b@x', role: 'COMPANY_ADMIN' as const, companyId: 'coBoth' };
const DEV = { id: 'd', name: 'Dev', email: 'd@x', role: 'DEV' as const, companyId: null };

function world() {
  const { prisma, db } = createMockPrisma();
  db.company.push(
    { id: 'coAds', name: 'Solo Ads', planId: null, productsJson: only('ADS'), currency: 'COP', timezone: 'America/Bogota' },
    { id: 'coCre', name: 'Solo Creative', planId: null, productsJson: only('CREATIVE'), currency: 'COP', timezone: 'America/Bogota' },
    { id: 'coAut', name: 'Solo Automation', planId: null, productsJson: only('AUTOMATION'), currency: 'COP', timezone: 'America/Bogota' },
    { id: 'coBoth', name: 'Creative y Ads', planId: 'p1', productsJson: only('CREATIVE', 'ADS', 'AUTOMATION'), currency: 'COP', timezone: 'America/Bogota' },
    { id: 'coLegacy', name: 'Anterior con plan', planId: 'p1', currency: 'COP' },
    { id: 'coLegacyNoPlan', name: 'Anterior sin plan', planId: null, currency: 'COP' },
  );
  const ads = new AdsService(prisma as any, audit as any);
  return {
    prisma, db, ads,
    creative: new CreativeService(prisma as any, audit as any),
    library: new LibraryService(prisma as any, audit as any),
    products: new ProductsService(prisma as any, audit as any),
    opps: new OpportunitiesService(prisma as any, audit as any, ads),
  };
}

/** PNG mínimo (cabecera) con contenido distinto según `salt` (para no deduplicar). */
function png(w: number, h: number, salt = 0): any {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  b.writeUInt32BE(salt, 40);
  return { buffer: b, size: b.length, originalname: 'foto.png', mimetype: 'image/png' };
}

/** MP4 mínimo: ftyp + moov(mvhd 15 s, trak/tkhd 1080×1920). */
function mp4(): any {
  const box = (type: string, body: Buffer) => {
    const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8, 0); h.write(type, 4, 'latin1');
    return Buffer.concat([h, body]);
  };
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1'));
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(15000, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(1080 << 16 >>> 0, 76); tkhd.writeUInt32BE((1920 << 16) >>> 0, 80);
  const buffer = Buffer.concat([ftyp, box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', box('tkhd', tkhd))]))]);
  return { buffer, size: buffer.length, originalname: 'reel.mp4', mimetype: 'video/mp4' };
}

describe('Productos · qué tiene activo cada empresa', () => {
  it('las empresas anteriores siguen igual: Automation siempre; Creative y Ads con plan', () => {
    expect(activeProducts({ planId: 'p1' })).toEqual(['AUTOMATION', 'CREATIVE', 'ADS']);
    expect(activeProducts({ planId: null })).toEqual(['AUTOMATION']);
    expect(productsExplicit({ planId: 'p1' })).toBe(false);
  });

  it('con la elección guardada manda lo guardado (con o sin plan)', () => {
    expect(activeProducts({ planId: 'p1', productsJson: only('ADS') })).toEqual(['ADS']);
    expect(activeProducts({ planId: null, productsJson: only('CREATIVE') })).toEqual(['CREATIVE']);
    expect(hasProduct({ planId: 'p1', productsJson: only('ADS') }, 'AUTOMATION')).toBe(false);
  });

  it('activar/desactivar deja fechas y no inventa estados; un JSON roto cae en la regla anterior', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const json = withProducts({ planId: 'p1' }, { ADS: false }, now);
    const s = readProducts({ planId: 'p1', productsJson: json });
    expect([s.AUTOMATION.enabled, s.CREATIVE.enabled, s.ADS.enabled]).toEqual([true, true, false]);
    expect(s.ADS.until).toBe(now.toISOString());
    expect(activeProducts({ planId: null, productsJson: '{roto' })).toEqual(['AUTOMATION']);
  });

  it('pedir un producto con la regla anterior NO congela la regla (si después elige plan, se activa)', () => {
    const json = withProductRequest({ planId: null }, 'CREATIVE', 'Ana');
    expect(productsExplicit({ planId: null, productsJson: json })).toBe(false);
    expect(readProducts({ planId: null, productsJson: json }).CREATIVE.requestedAt).toBeTruthy();
    expect(hasProduct({ planId: 'p1', productsJson: json }, 'CREATIVE')).toBe(true);
  });
});

describe('Productos · el servidor exige el producto en cada endpoint', () => {
  const reflector = new Reflector();
  function can(user: any, ctrl: any, method: string, prisma: any) {
    const guard = new ProductsGuard(reflector, prisma);
    const ctx: any = { getHandler: () => ctrl.prototype[method], getClass: () => ctrl, switchToHttp: () => ({ getRequest: () => ({ user }) }) };
    return guard.canActivate(ctx);
  }

  it('cada controlador declara su producto (lo común queda sin marcar)', () => {
    const of = (ctrl: any, method?: string) => reflector.getAllAndOverride(PRODUCTS_KEY, [method ? ctrl.prototype[method] : () => undefined, ctrl]) ?? [];
    expect(of(ConversationsController)).toEqual(['AUTOMATION']);
    expect(of(CampaignsController)).toEqual(['AUTOMATION']);
    expect(of(CustomersController)).toEqual(['AUTOMATION']);
    expect(of(CreativeController)).toEqual(['CREATIVE']);
    expect(of(SocialController)).toEqual(['CREATIVE']);
    expect(of(MarketingController)).toEqual(['CREATIVE']);
    expect(of(AdsController)).toEqual(['ADS']);
    expect(of(LibraryController)).toEqual(['CREATIVE', 'ADS']);
    expect(of(LibraryController, 'link')).toEqual(['ADS']);
    expect(of(LibraryController, 'fromDesign')).toEqual(['CREATIVE']);
    expect(of(OpportunitiesController)).toEqual(['AUTOMATION', 'CREATIVE', 'ADS']);
    expect(of(PaymentsController, 'config')).toEqual(['AUTOMATION']);
    // Comunes: cuenta, plan, cobro, catálogo del negocio y los propios productos
    for (const c of [BillingController, CompaniesController, CatalogController, ProductsController]) expect(of(c)).toEqual([]);
    expect(of(PaymentsController, 'list')).toEqual([]);
  });

  it('solo Ads: entra a Publicidad y a la biblioteca; Creative, Automation y crear desde diseño, no', async () => {
    const { prisma } = world();
    await expect(can(ADS_ONLY, AdsController, 'accounts', prisma)).resolves.toBe(true);
    await expect(can(ADS_ONLY, LibraryController, 'upload', prisma)).resolves.toBe(true);
    await expect(can(ADS_ONLY, LibraryController, 'link', prisma)).resolves.toBe(true);
    await expect(can(ADS_ONLY, CreativeController, 'designs', prisma)).rejects.toThrow(ForbiddenException);
    await expect(can(ADS_ONLY, LibraryController, 'fromDesign', prisma)).rejects.toThrow(ForbiddenException);
    await expect(can(ADS_ONLY, ConversationsController, 'detail', prisma)).rejects.toThrow(ForbiddenException);
    await expect(can(ADS_ONLY, BillingController, 'summary', prisma)).resolves.toBe(true);
  });

  it('solo Creative: su producto y la biblioteca, sin Publicidad, vínculos a anuncios ni Automation', async () => {
    const { prisma } = world();
    await expect(can(CREATIVE_ONLY, CreativeController, 'designs', prisma)).resolves.toBe(true);
    await expect(can(CREATIVE_ONLY, LibraryController, 'list', prisma)).resolves.toBe(true);
    await expect(can(CREATIVE_ONLY, AdsController, 'accounts', prisma)).rejects.toThrow(ForbiddenException);
    await expect(can(CREATIVE_ONLY, LibraryController, 'link', prisma)).rejects.toThrow(ForbiddenException);
    await expect(can(CREATIVE_ONLY, CampaignsController, 'list', prisma)).rejects.toThrow(ForbiddenException);
  });

  it('solo Automation: conversaciones y campañas sin Creative ni Ads', async () => {
    const { prisma } = world();
    await expect(can(AUTO_ONLY, ConversationsController, 'detail', prisma)).resolves.toBe(true);
    await expect(can(AUTO_ONLY, CampaignsController, 'list', prisma)).resolves.toBe(true);
    await expect(can(AUTO_ONLY, PaymentsController, 'config', prisma)).resolves.toBe(true);
    await expect(can(AUTO_ONLY, CreativeController, 'designs', prisma)).rejects.toThrow(ForbiddenException);
    await expect(can(AUTO_ONLY, AdsController, 'accounts', prisma)).rejects.toThrow(ForbiddenException);
    await expect(can(AUTO_ONLY, LibraryController, 'list', prisma)).rejects.toThrow(ForbiddenException);
  });

  it('la respuesta dice qué falta (código y producto); a una empresa anterior sin plan le pide plan', async () => {
    const { prisma } = world();
    const err: any = await (can(AUTO_ONLY, AdsController, 'accounts', prisma) as Promise<boolean>).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'PRODUCT_INACTIVE', products: ['ADS'], needsPlan: false });
    const legacy = { ...AUTO_ONLY, companyId: 'coLegacyNoPlan' };
    const err2: any = await (can(legacy, CreativeController, 'designs', prisma) as Promise<boolean>).catch((e) => e);
    expect(err2.getResponse()).toMatchObject({ needsPlan: true });
    expect(err2.message).toMatch(/plan/);
  });

  it('plataforma administra cualquier empresa; lo público no pide producto; un usuario sin empresa no pasa', async () => {
    const { prisma } = world();
    await expect(can(DEV, AdsController, 'accounts', prisma)).resolves.toBe(true);
    await expect(can(undefined, AdsPublicController, 'callback', prisma)).resolves.toBe(true);
    await expect(can({ ...ADS_ONLY, companyId: null }, AdsController, 'accounts', prisma)).rejects.toThrow(ForbiddenException);
  });

  it('las empresas anteriores con plan mantienen los tres productos', async () => {
    const { prisma } = world();
    const legacy = { ...BOTH, companyId: 'coLegacy' };
    for (const [c, m] of [[ConversationsController, 'detail'], [CreativeController, 'designs'], [AdsController, 'accounts']] as const) {
      await expect(can(legacy, c, m, prisma)).resolves.toBe(true);
    }
  });
});

describe('Productos · solicitudes y activación', () => {
  it('la empresa pide; plataforma activa y queda en la auditoría; la solicitud se atiende sola', async () => {
    const { products, db } = world();
    const r = await products.request(AUTO_ONLY, 'CREATIVE');
    expect(r.products.find((p: any) => p.key === 'CREATIVE')?.requestedAt).toBeTruthy();
    expect(await products.requests()).toEqual([expect.objectContaining({ companyId: 'coAut', product: 'CREATIVE' })]);
    // pedir dos veces no duplica
    expect((await products.request(AUTO_ONLY, 'CREATIVE')).already).toBe('REQUESTED');
    const after = await products.set(DEV, 'coAut', { CREATIVE: true });
    expect(after.products.filter((p: any) => p.enabled).map((p: any) => p.key)).toEqual(['AUTOMATION', 'CREATIVE']);
    expect(await products.requests()).toEqual([]);
    expect(hasProduct(db.company.find((c: any) => c.id === 'coAut')!, 'CREATIVE')).toBe(true);
    await expect(products.request(AUTO_ONLY, 'OTRO')).rejects.toThrow(/desconocido/);
  });
});

describe('Biblioteca compartida · Ads Intelligence sin Creative', () => {
  it('lee tipo, medidas y duración de un video desde sus bytes', () => {
    expect(videoInfo(mp4().buffer)).toEqual({ mime: 'video/mp4', width: 1080, height: 1920, durationSec: 15 });
    expect(videoInfo(png(10, 10).buffer)).toBeNull();
  });

  it('una empresa solo con Ads sube imágenes y videos, los ve con su procedencia y no duplica', async () => {
    const { library } = world();
    const img = await library.upload(ADS_ONLY, png(1080, 1350), { name: 'Oferta' });
    const vid = await library.upload(ADS_ONLY, mp4(), {});
    expect(img.asset).toMatchObject({ kind: 'IMAGE', originModule: 'ADS', source: 'UPLOAD', ratios: ['Vertical 4:5'] });
    expect(vid.asset).toMatchObject({ kind: 'VIDEO', mimeType: 'video/mp4', width: 1080, height: 1920, durationSec: 15, ratios: ['Historias y reels 9:16'] });
    const again = await library.upload(ADS_ONLY, png(1080, 1350), {});
    expect(again).toMatchObject({ duplicate: true, asset: { id: img.asset.id } });
    const list = await library.list(ADS_ONLY, {});
    expect(list.assets).toHaveLength(2);
    expect(list.products).toEqual({ creative: false, ads: true });
    await expect(library.upload(ADS_ONLY, { buffer: Buffer.from('<svg/>'), size: 6, originalname: 'x.svg' } as any, {})).rejects.toThrow(/Solo imágenes/);
  });

  it('vincular a un anuncio bloquea el borrado (también desde Creative) hasta desvincular', async () => {
    const { library, creative, db } = world();
    db.adEntity.push({ id: 'ad1', companyId: 'coBoth', accountId: 'acc', provider: 'META', mode: 'DEMO', level: 'AD', externalId: 'x1', name: 'Anuncio octubre', status: 'ACTIVE', syncedAt: new Date() });
    const { asset } = await library.upload(BOTH, png(1080, 1080), {});
    const link = await library.link(BOTH, asset.id, { adEntityId: 'ad1' });
    expect((await library.link(BOTH, asset.id, { adEntityId: 'ad1' })).already).toBe(true);
    const detail = await library.detail(BOTH, asset.id);
    expect(detail).toMatchObject({ locked: true, links: [expect.objectContaining({ name: 'Anuncio octubre', level: 'AD' })] });
    await expect(library.remove(BOTH, asset.id)).rejects.toThrow(/vinculado/);
    await expect(creative.deleteAsset(BOTH, asset.id)).rejects.toThrow(/vinculado/);
    await library.unlink(BOTH, asset.id, link.linkId);
    await expect(library.remove(BOTH, asset.id)).resolves.toEqual({ ok: true });
  });

  it('con Creative y Ads, lo de uno se ve en el otro; el editor de Creative no recibe videos', async () => {
    const { library, creative } = world();
    await creative.uploadAsset(BOTH, png(800, 800, 1), { kind: 'LOGO' });
    await library.upload(BOTH, mp4(), { module: 'ADS' });
    const lib = await library.list(BOTH, {});
    expect(lib.assets.map((a: any) => a.originModule).sort()).toEqual(['ADS', 'CREATIVE']);
    const editor = await creative.assets(BOTH);
    expect(editor.every((a: any) => a.mimeType.startsWith('image/'))).toBe(true);
    expect(editor).toHaveLength(1);
  });

  it('un diseño entra a la biblioteca por versión: la anterior no se toca', async () => {
    const { library, creative } = world();
    const d: any = await creative.createDesign(BOTH, { templateKey: 'producto', format: 'IG_POST' });
    await expect(library.fromDesign(BOTH, d.id)).rejects.toThrow(/Exporta/);
    await creative.uploadExport(BOTH, d.id, png(1080, 1080, 7));
    const v1 = await library.fromDesign(BOTH, d.id);
    expect(v1).toMatchObject({ created: true, asset: { source: 'DESIGN', designVersion: 1, derivedFromId: null } });
    expect((await library.fromDesign(BOTH, d.id)).created).toBe(false);
    await creative.saveDesign(BOTH, d.id, { doc: d.doc, expectedVersion: 1 });
    await creative.uploadExport(BOTH, d.id, png(1080, 1080, 8));
    const v2 = await library.fromDesign(BOTH, d.id);
    expect(v2.asset).toMatchObject({ designVersion: 2, derivedFromId: v1.asset.id });
    const detail = await library.detail(BOTH, v1.asset.id);
    expect(detail.versions.map((v: any) => v.designVersion)).toEqual([1, 2]);
    expect(detail.available).toBe(true);
  });
});

describe('Biblioteca compartida · aislamiento entre empresas', () => {
  it('otra empresa no ve, no descarga, no renombra, no borra ni vincula recursos ajenos; tampoco a anuncios ajenos', async () => {
    const { library, db } = world();
    db.adEntity.push({ id: 'adAjeno', companyId: 'coBoth', accountId: 'acc', provider: 'META', mode: 'DEMO', level: 'AD', externalId: 'z', name: 'Ajeno', syncedAt: new Date() });
    const { asset } = await library.upload(ADS_ONLY, png(500, 500), {});
    await expect(library.detail(BOTH, asset.id)).rejects.toThrow(/no encontrado/);
    await expect(library.serve(BOTH, asset.id, {} as any)).rejects.toThrow(/no encontrado/);
    await expect(library.rename(BOTH, asset.id, { name: 'x' })).rejects.toThrow(/no encontrado/);
    await expect(library.remove(BOTH, asset.id)).rejects.toThrow(/no encontrado/);
    await expect(library.link(BOTH, asset.id, { adEntityId: 'adAjeno' })).rejects.toThrow(/no encontrado/);
    // con su propio recurso pero el anuncio de otra empresa
    await expect(library.link(ADS_ONLY, asset.id, { adEntityId: 'adAjeno' })).rejects.toThrow(/no encontrado/);
    // la empresa sale de la sesión: un companyId en la petición no cambia nada
    expect((await library.list(BOTH, { companyId: 'coAds' })).assets).toHaveLength(0);
    expect((await library.entities(ADS_ONLY, { companyId: 'coBoth' }))).toHaveLength(0);
  });

  it('sin Creative ni Ads no hay biblioteca; sin Creative no se crea desde un diseño', async () => {
    const { library } = world();
    await expect(library.list(AUTO_ONLY, {})).rejects.toThrow(ForbiddenException);
    await expect(library.fromDesign(ADS_ONLY, 'cualquiera')).rejects.toThrow(ForbiddenException);
  });
});

describe('Productos · cada uno funciona sin los otros', () => {
  it('Creative sin Ads: marca y diseños; Publicidad le responde que no lo tiene', async () => {
    const { creative, ads } = world();
    expect((await creative.brand(CREATIVE_ONLY)).name).toBe('Solo Creative');
    const d: any = await creative.createDesign(CREATIVE_ONLY, { templateKey: 'producto', format: 'IG_POST' });
    expect(d.id).toBeTruthy();
    await expect(ads.accounts(CREATIVE_ONLY)).rejects.toThrow(/Ads Intelligence/);
  });

  it('Ads sin Creative: conecta una cuenta de demostración y la ve; Creative le responde que no lo tiene', async () => {
    const { creative, ads } = world();
    await ads.connectDemo(ADS_ONLY, {});
    expect((await ads.accounts(ADS_ONLY)).length).toBeGreaterThan(0);
    await expect(creative.brand(ADS_ONLY)).rejects.toThrow(/Creative/);
  });

  it('Radar: cada empresa ve solo las fuentes de sus productos (ni por id)', async () => {
    const { opps, db } = world();
    const base = { status: 'NEW', severity: 'MEDIUM', evidence: 'SUFFICIENT', mode: 'REAL', title: 't', firstSeenAt: new Date(), lastSeenAt: new Date(), actionJson: '{}', decisionsJson: '[]' };
    db.opportunity.push(
      { ...base, id: 'oAds', companyId: 'coAds', source: 'ADS', dedupeKey: 'a' },
      { ...base, id: 'oCrm', companyId: 'coAds', source: 'CRM', dedupeKey: 'b' },
    );
    const list = await opps.list(ADS_ONLY, {});
    expect(list.map((o: any) => o.id)).toEqual(['oAds']);
    expect(await opps.list(ADS_ONLY, { source: 'CRM' })).toEqual([]);
    await expect(opps.move(ADS_ONLY, 'oCrm', { to: 'DISMISSED' })).rejects.toThrow(/no encontrada/);
    // Creative sin Ads ni Automation: no hay fuentes del Radar, pero sí su contexto
    await expect(opps.list(CREATIVE_ONLY, {})).rejects.toThrow(ForbiddenException);
    await expect(opps.context(CREATIVE_ONLY)).resolves.toBeTruthy();
  });
});
