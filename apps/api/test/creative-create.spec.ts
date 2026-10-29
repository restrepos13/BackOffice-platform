/**
 * Creative · «Crear para vender»: intención (reglas e IA validada), recorte con
 * créditos sin doble cobro, paso a Ads y aislamiento entre empresas.
 * Sin red: la IA y el servicio de recorte son falsos.
 */
import 'reflect-metadata';
import { PNG } from 'pngjs';
import { CreativeService } from '../src/modules/creative.module';
import { CreativeCreateService } from '../src/modules/creative-create';
import { LibraryService, assertAssetDeletable } from '../src/modules/library.module';
import { AdsCreateService } from '../src/modules/ads-create';
import { artRequestFrom, interpretIntent, normalizeAiIntent } from '../src/common/creative/intent';
import { ImageOpError, RemoveBgProvider, validateCutout } from '../src/common/creative/cutout';
import { deterministicId } from '../src/common/automation/run-signals';
import { encryptSecret } from '../src/common/crypto';
import { saveFile } from '../src/common/file-store';
import { createMockPrisma } from './helpers/mock-prisma';
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { UPLOADS_DIR } from '../src/common/file-store';

// Los archivos que esta prueba escribe en uploads/ se borran al final
const STARTED = Date.now();
afterAll(() => {
  const dir = join(UPLOADS_DIR, 'coA');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (['photoA1.png', 'design-d1-v2-abcd.png'].includes(f) || (/^design-d1-v\d+-[0-9a-f]+\.png$/.test(f) && statSync(p).mtimeMs >= STARTED) || (/^asset-[0-9a-f]+\.png$/.test(f) && statSync(p).mtimeMs >= STARTED)) unlinkSync(p);
  }
});

const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const CATALOG = [
  { id: 'p1', name: 'Tacos al pastor', price: 15000, hasImage: false },
  { id: 'p2', name: 'Quesadilla', price: 12000, hasImage: false },
];

/** PNG con un círculo opaco sobre fondo transparente (o todo opaco). */
function png(w: number, h: number, opaque = false) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 3) ** 2;
    img.data[i] = 200; img.data[i + 1] = 80; img.data[i + 2] = 40; img.data[i + 3] = opaque || inside ? 255 : 0;
  }
  // Sin filtros y con compresión mínima: con los valores por defecto un PNG de 1080 tarda ~9 s bajo jest
  return PNG.sync.write(img, { filterType: 0, deflateLevel: 1 } as any);
}

describe('intención comercial por reglas', () => {
  it('entiende producto del catálogo, destino, vigencia y formatos; pide lo que falta', () => {
    const i = interpretIntent('Quiero promocionar los tacos al pastor este fin de semana y conseguir más pedidos por WhatsApp.', CATALOG);
    expect(i).toMatchObject({ objective: 'SALES', productId: 'p1', productPrice: 15000, destination: 'WHATSAPP', offer: null, offerValidity: 'este fin de semana', callToAction: 'Pide por WhatsApp', source: 'RULES' });
    expect(i.requestedFormats).toContain('IG_POST');
    expect(i.missingInformation.map((m) => m.key)).toEqual(['photos']);
  });

  it('una oferta escrita queda por confirmar y no se publica hasta confirmarla', () => {
    const i = interpretIntent('Promo 2x1 en quesadillas hoy, que pidan por la web', CATALOG);
    expect(i).toMatchObject({ productId: 'p2', offer: expect.stringMatching(/2x1/), offerConfirmed: false, destination: 'WEBSITE' });
    expect(i.missingInformation.find((m) => m.key === 'offer')).toBeTruthy();
    // Sin confirmar: la pieza usa el precio del catálogo, no la oferta
    expect(artRequestFrom(i)).toMatchObject({ goal: 'PRODUCT', content: { price: '$12.000' } });
    expect(artRequestFrom({ ...i, offerConfirmed: true })).toMatchObject({ goal: 'PROMO', content: { price: expect.stringMatching(/2x1/) } });
  });

  it('no asocia un producto del catálogo si su nombre no aparece; sin producto lo pregunta', () => {
    const i = interpretIntent('Queremos que más gente conozca nuestro restaurante', CATALOG);
    expect(i).toMatchObject({ objective: 'AWARENESS', productId: null });
    expect(i.missingInformation.find((m) => m.key === 'product')).toMatchObject({ blocking: true });
  });
});

describe('intención con IA: se valida, nunca se cree a ciegas', () => {
  const rules = interpretIntent('Quiero vender más tacos al pastor por WhatsApp', CATALOG);
  it('descarta ofertas, productos y vigencias que el usuario no escribió', () => {
    const ai = normalizeAiIntent({ objective: 'SALES', productId: 'p2', offer: '20% de descuento', offerValidity: 'hasta el domingo', audience: 'familias', destination: 'WHATSAPP', productPrice: 1 }, rules, CATALOG);
    expect(ai).toMatchObject({ source: 'AI', productId: 'p1', offer: null, offerValidity: null, audience: 'familias', productPrice: 15000 });
  });
  it('valores inválidos o respuesta basura → quedan las reglas', () => {
    expect(normalizeAiIntent({ objective: 'HACKEAR', destination: 'MARTE' }, rules, CATALOG)).toMatchObject({ objective: 'SALES', destination: 'WHATSAPP' });
    expect(normalizeAiIntent('texto', rules, CATALOG)).toBe(rules);
  });
});

describe('recorte: validación del resultado', () => {
  it('acepta un PNG con transparencia real y rechaza uno opaco, vacío o de otra proporción', () => {
    expect(validateCutout(png(400, 500), { width: 400, height: 500 }).transparent).toBeGreaterThan(0.1);
    expect(() => validateCutout(png(400, 500, true))).toThrow(ImageOpError);
    expect(() => validateCutout(Buffer.from('nada'))).toThrow(/PNG válido/);
    expect(() => validateCutout(png(400, 400), { width: 400, height: 800 })).toThrow(/no corresponde/);
  });
});

/* ── Servicio con base simulada (sin índices, como Atlas) ── */

function world(opts: { aiKey?: boolean; credits?: number; ads?: boolean } = {}) {
  const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: true });
  const products = (ads: boolean) => JSON.stringify({ CREATIVE: { enabled: true }, ADS: { enabled: ads } });
  const social = JSON.stringify({ social: { enabled: true, credits: opts.credits ?? 3 } });
  db.company.push(
    { id: 'coA', name: 'Taquería Lúa', slug: 'lua', addonsJson: social, productsJson: products(opts.ads ?? true), currency: 'COP', timezone: 'America/Bogota', deepinfraApiKey: opts.aiKey ? encryptSecret('di-key-123456') : null },
    { id: 'coB', name: 'Otra', slug: 'otra', addonsJson: social, productsJson: products(true), currency: 'COP', timezone: 'America/Bogota' },
  );
  for (const p of CATALOG) db.product.push({ ...p, companyId: 'coA', active: true, imageFile: null });
  db.brandAsset.push(
    { id: 'photoA1', companyId: 'coA', kind: 'IMAGE', name: 'Tacos', fileName: 'photoA1.png', mimeType: 'image/png', sizeBytes: 10, width: 400, height: 500, source: 'UPLOAD', createdAt: new Date() },
    { id: 'photoB1', companyId: 'coB', kind: 'IMAGE', name: 'Ajena', fileName: 'photoB1.png', mimeType: 'image/png', sizeBytes: 10, width: 400, height: 500, source: 'UPLOAD', createdAt: new Date() },
  );
  const audit = { log: jest.fn(async () => undefined) };
  const creative = new CreativeService(prisma as any, audit as any);
  const library = new LibraryService(prisma as any, audit as any);
  const chat = jest.fn(async () => ({ content: JSON.stringify({ objective: 'SALES', productId: 'p1', destination: 'WHATSAPP', audience: 'oficinas', offer: '50% off' }), inputTokens: 300, outputTokens: 60, model: 'm' }));
  const svc = new CreativeCreateService(prisma as any, audit as any, creative, library, { chat, transcribe: jest.fn() } as any);
  const cutoutCalls: number[] = [];
  let cutoutResult: () => Promise<Buffer> = async () => png(400, 500);
  svc.cutoutProvider = async () => ({ key: 'FAKE', label: 'falso', removeBackground: async () => { cutoutCalls.push(1); return cutoutResult(); } });
  return { svc, db, prisma, chat, audit, cutoutCalls, setCutout: (f: () => Promise<Buffer>) => { cutoutResult = f; } };
}

describe('Crear · intención y materiales', () => {
  it('sin IA interpreta por reglas; con IA la usa, la valida y registra el consumo como BYOK', async () => {
    const noAi = world();
    const r1 = await noAi.svc.intent(A, { description: 'Quiero vender tacos al pastor por WhatsApp', assetIds: ['photoA1'] });
    expect(r1.ai.used).toBe(false);
    expect(r1.intent).toMatchObject({ source: 'RULES', productId: 'p1', assetIds: ['photoA1'] });

    const withAi = world({ aiKey: true });
    const r2 = await withAi.svc.intent(A, { description: 'Quiero vender tacos al pastor por WhatsApp' });
    expect(r2.intent).toMatchObject({ source: 'AI', audience: 'oficinas', offer: null }); // la oferta inventada se descarta
    expect(withAi.db.aiUsageEvent).toEqual([expect.objectContaining({ billedTo: 'BYOK', companyId: 'coA' })]);
    // La descripción va como dato delimitado, no como instrucción
    expect(JSON.stringify((withAi.chat.mock.calls[0] as any)[0].messages)).toContain('<descripcion>');
  });

  it('si la IA falla, sigue con reglas y lo dice', async () => {
    const w = world({ aiKey: true });
    w.chat.mockRejectedValueOnce(new Error('boom'));
    const r = await w.svc.intent(A, { description: 'Quiero vender tacos al pastor por WhatsApp' });
    expect(r.ai).toMatchObject({ used: false, note: expect.stringMatching(/reglas/) });
    expect(r.intent.source).toBe('RULES');
  });

  it('la confirmación de la oferta la da la persona; valida textos y rechaza imágenes de otra empresa', async () => {
    const w = world();
    const r = await w.svc.intent(A, { description: 'Promo 2x1 en quesadillas hoy', overrides: { offerConfirmed: true, destination: 'WHATSAPP' } });
    expect(r.intent).toMatchObject({ offerConfirmed: true, destination: 'WHATSAPP' });
    expect(r.art.goal).toBe('PROMO');
    await expect(w.svc.intent(A, { description: 'corto' })).rejects.toThrow(/frase/);
    await expect(w.svc.intent(A, { description: 'x'.repeat(700) })).rejects.toThrow(/hasta/);
    await expect(w.svc.intent(A, { description: 'Quiero vender tacos al pastor', assetIds: ['photoB1'] })).rejects.toThrow(/no es de tu biblioteca/);
  });

  it('el punto de partida dice qué hay y qué falta, sin bloquear por la marca', async () => {
    const w = world();
    const s: any = await w.svc.start(A);
    expect(s.materials.photos.map((p: any) => p.id)).toEqual(['photoA1']);
    expect(s.brand).toMatchObject({ colorsConfirmed: false, note: expect.stringMatching(/provisional/) });
    expect(s.ai.available).toBe(false);
    expect(s.ads).toMatchObject({ contracted: true, connected: false });
  });
});

describe('Crear · quitar el fondo', () => {
  beforeEach(async () => {
    // El original existe en el almacenamiento de la empresa
    await saveFile(null, 'coA', 'photoA1.png', png(400, 500, true), 'image/png');
  });

  it('crea un derivado PNG sin tocar el original y cobra una sola vez', async () => {
    const w = world();
    const r: any = await w.svc.removeBackground(A, { assetId: 'photoA1' });
    expect(r).toMatchObject({ created: true, credits: expect.any(Number), asset: { source: 'CUTOUT', derivedFromId: 'photoA1', mimeType: 'image/png' } });
    expect(w.db.brandAsset.find((a: any) => a.id === 'photoA1')).toMatchObject({ source: 'UPLOAD', mimeType: 'image/png' });
    const moves = w.db.creativeCreditMove.map((m: any) => m.kind);
    expect(moves).toEqual(['RESERVE', 'COMMIT']);
    // Repetir: reutiliza el recorte, sin otra llamada ni otro cobro
    const again: any = await w.svc.removeBackground(A, { assetId: 'photoA1' });
    expect(again.created).toBe(false);
    expect(w.cutoutCalls).toHaveLength(1);
    expect(w.db.creativeCreditMove).toHaveLength(2);
    // El original no se puede borrar mientras su recorte dependa de él
    await expect(assertAssetDeletable(w.prisma, 'coA', 'photoA1')).rejects.toThrow(/recorte que depende/);
  });

  it('un resultado inválido no se guarda y devuelve los créditos', async () => {
    const w = world();
    w.setCutout(async () => png(400, 500, true));
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).rejects.toThrow(/no quitó el fondo.*No se cobraron/);
    expect(w.db.brandAsset.filter((a: any) => a.source === 'CUTOUT')).toHaveLength(0);
    expect(w.db.creativeCreditMove.map((m: any) => m.kind)).toEqual(['RESERVE', 'RELEASE']);
    // Se puede reintentar (otra llave) y esta vez sale bien
    w.setCutout(async () => png(400, 500));
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).resolves.toMatchObject({ created: true });
  });

  it('sin saldo no llama al servicio; sin proveedor dice que no está configurado', async () => {
    const poor = world({ credits: 0 });
    await expect(poor.svc.removeBackground(A, { assetId: 'photoA1' })).rejects.toMatchObject({ response: { code: 'NO_CREDITS' } });
    expect(poor.cutoutCalls).toHaveLength(0);
    const none = world();
    none.svc.cutoutProvider = async () => null;
    await expect(none.svc.removeBackground(A, { assetId: 'photoA1' })).rejects.toMatchObject({ response: { code: 'NOT_CONFIGURED' } });
  });

  it('dos recortes simultáneos de la misma foto: uno se procesa, el otro espera', async () => {
    const w = world();
    let release!: () => void;
    w.setCutout(() => new Promise((ok) => { release = () => ok(png(400, 500)); }));
    const first = w.svc.removeBackground(A, { assetId: 'photoA1' });
    await new Promise((r) => setTimeout(r, 5));
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).rejects.toThrow(/ya se está procesando/);
    release();
    await expect(first).resolves.toMatchObject({ created: true });
    expect(w.db.creativeCreditMove.filter((m: any) => m.kind === 'RESERVE')).toHaveLength(1);
  });

  it('una empresa no puede recortar fotos de otra', async () => {
    const w = world();
    await expect(w.svc.removeBackground(B, { assetId: 'photoA1' })).rejects.toThrow(/no encontrada/);
  });
});

describe('Crear · de Creative a Ads', () => {
  async function designWith(w: ReturnType<typeof world>, opts: { exported?: boolean; version?: number } = {}) {
    const file = 'design-d1-v2-abcd.png';
    if (opts.exported !== false) await saveFile(null, 'coA', file, png(1080, 1080, true), 'image/png');
    w.db.creativeDesign.push({ id: 'd1', companyId: 'coA', name: 'Tacos fin de semana', format: 'IG_POST', version: opts.version ?? 2, docJson: '{}', exportFile: opts.exported === false ? null : file, exportMime: 'image/png', createdAt: new Date(), updatedAt: new Date() });
  }

  it('lleva la exportación a la biblioteca y abre Ads con la imagen; repetir no duplica', async () => {
    const w = world();
    await designWith(w);
    const r: any = await w.svc.toAds(A, 'd1');
    expect(r.asset).toMatchObject({ source: 'DESIGN', designId: 'd1' });
    expect(r.ads.url).toBe(`/app/ads?tab=nueva&asset=${r.asset.id}&design=d1`);
    const again: any = await w.svc.toAds(A, 'd1');
    expect(again.asset.id).toBe(r.asset.id);
    expect(w.db.brandAsset.filter((a: any) => a.designId === 'd1')).toHaveLength(1);
  });

  it('sin exportar, con exportación vieja, de otra empresa o sin Ads contratado', async () => {
    const w = world();
    await designWith(w, { exported: false });
    await expect(w.svc.toAds(A, 'd1')).rejects.toThrow(/Exporta el diseño/);
    const stale = world();
    await designWith(stale, { version: 3 });
    await expect(stale.svc.toAds(A, 'd1')).rejects.toThrow(/cambió después de exportarlo/);
    const ok = world();
    await designWith(ok);
    await expect(ok.svc.toAds(B, 'd1')).rejects.toThrow(/no encontrado/);
    const noAds = world({ ads: false });
    await designWith(noAds);
    const r: any = await noAds.svc.toAds(A, 'd1');
    expect(r.ads).toMatchObject({ contracted: false, url: null, note: expect.stringMatching(/no tiene Ads/) });
  });

  it('Ads guarda de qué diseño salió el anuncio, rechaza una imagen ajena al diseño y no activa nada', async () => {
    const w = world();
    await designWith(w);
    const { asset }: any = await w.svc.toAds(A, 'd1');
    w.db.adAccount.push({ id: 'acc1', companyId: 'coA', provider: 'META', mode: 'REAL', externalId: 'act_1', name: 'Lúa', currency: 'COP', timezone: 'America/Bogota', status: 'CONNECTED', tokenEnc: encryptSecret('EAAG'.padEnd(40, 'x')), scopesJson: JSON.stringify(['ads_management', 'ads_read', 'business_management']), createdAt: new Date() });
    w.db.adSettings.push({ id: 's1', companyId: 'coA', maxDailyBudget: 50000 });
    const ads = new AdsCreateService(w.prisma as any, w.audit as any);
    const posts: string[] = [];
    let n = 0;
    ads.fetchImpl = (async (url: string, init?: any) => {
      const path = new URL(url).pathname.replace(/^\/v[\d.]+/, '');
      if (init?.method === 'POST') posts.push(`${path} ${new URLSearchParams(init.body).get('status') ?? ''}`);
      const body = path.endsWith('/adimages') ? { images: { x: { hash: 'H' } } } : init?.method === 'POST' ? { id: String(++n) } : { data: [] };
      return { ok: true, status: 200, json: async () => body };
    }) as any;
    const draft = { name: 'Tacos finde', goal: 'WHATSAPP', dailyBudget: '30.000', countries: ['CO'], primaryText: 'Tacos al pastor. Escríbenos por WhatsApp.', headline: 'Tacos' };
    await expect(ads.create(A, { confirm: true, accountId: 'acc1', pageId: '5550001', assetId: 'photoA1', designId: 'd1', draft })).rejects.toThrow(/no corresponde a ese diseño/);
    const l: any = await ads.create(A, { confirm: true, accountId: 'acc1', pageId: '5550001', assetId: asset.id, designId: 'd1', draft });
    expect(l).toMatchObject({ status: 'PAUSED', designId: 'd1' });
    expect(posts.some((p) => p.endsWith('ACTIVE'))).toBe(false);
    // La pieza sabe dónde se usó y no inventa resultados
    const usage: any = await w.svc.adUsage(A, 'd1');
    expect(usage.launches).toEqual([expect.objectContaining({ status: 'PAUSED', results: null, resultsNote: expect.stringMatching(/no ha estado activo/) })]);
    // Y la imagen ya no se puede borrar mientras el anuncio exista
    await expect(assertAssetDeletable(w.prisma, 'coA', asset.id)).rejects.toThrow(/lo usa un anuncio/);
  });
});

/* ── Segunda pasada: contrato del proveedor, estados intermedios y versiones ── */

describe('remove.bg · contrato (fetch simulado, sin red)', () => {
  const ok = png(400, 500);
  function provider(res: { status: number; body?: any; bytes?: Buffer } | 'abort' | 'network') {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url, init });
      if (res === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (res === 'network') throw new Error('ECONNRESET');
      return { ok: res.status < 300, status: res.status, json: async () => res.body ?? {}, arrayBuffer: async () => new Uint8Array(res.bytes ?? Buffer.alloc(0)).buffer };
    };
    return { p: new RemoveBgProvider('rb-secret-key', fetchImpl as any), calls };
  }

  it('envía la imagen como multipart con la llave en cabecera (nunca en la URL) y devuelve el PNG', async () => {
    const { p, calls } = provider({ status: 200, bytes: ok });
    const out = await p.removeBackground(png(400, 500, true), 'image/png');
    expect(out.equals(ok)).toBe(true);
    expect(calls[0].url).toBe('https://api.remove.bg/v1.0/removebg');
    expect(calls[0].url).not.toContain('rb-secret-key');
    expect(calls[0].init.headers['X-Api-Key']).toBe('rb-secret-key');
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect((calls[0].init.body as FormData).get('format')).toBe('png');
  });

  it.each([
    [{ status: 401 }, 'KEY'],
    [{ status: 403 }, 'KEY'],
    [{ status: 402 }, 'NO_CREDIT'],
    [{ status: 400, body: { errors: [{ title: 'Could not identify foreground in image' }] } }, 'NO_SUBJECT'],
    [{ status: 500 }, 'PROVIDER'],
    ['abort', 'TIMEOUT'],
    ['network', 'PROVIDER'],
  ] as const)('%j → %s', async (res, kind) => {
    const { p } = provider(res as any);
    await expect(p.removeBackground(png(10, 10, true), 'image/png')).rejects.toMatchObject({ kind });
  });

  it('un PNG que declara dimensiones gigantes se rechaza sin descomprimirlo', () => {
    const bomb = Buffer.from(png(4, 4));
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    expect(() => validateCutout(bomb)).toThrow(/demasiado grande/);
  });
});

describe('Crear · recorte: fallos, reintentos y estados intermedios', () => {
  beforeEach(async () => {
    await saveFile(null, 'coA', 'photoA1.png', png(400, 500, true), 'image/png');
  });
  const cutouts = (w: ReturnType<typeof world>) => w.db.brandAsset.filter((a: any) => a.source === 'CUTOUT');

  it.each([
    ['timeout', () => Promise.reject(new ImageOpError('TIMEOUT', 'El servicio de recorte tardó demasiado.')), /tardó demasiado.*No se cobraron/],
    ['error del proveedor', () => Promise.reject(new ImageOpError('PROVIDER', 'El servicio de recorte respondió con error.')), /respondió con error.*No se cobraron/],
    ['error inesperado', () => Promise.reject(new Error('socket colgado')), /socket colgado/],
  ])('%s: no queda recorte, se devuelven los créditos y el saldo vuelve a ser el de antes', async (_n, fail, msg) => {
    const w = world({ credits: 1 });
    const creative = new CreativeService(w.prisma as any, w.audit as any);
    const before = (await creative.credits(A)).monthly.left;
    w.setCutout(fail as any);
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).rejects.toThrow(msg);
    expect(cutouts(w)).toHaveLength(0);
    expect(w.db.creativeCreditMove.map((m: any) => m.kind)).toEqual(['RESERVE', 'RELEASE']);
    expect((await creative.credits(A)).monthly.left).toBe(before);
    // El original no cambió
    expect(w.db.brandAsset.find((a: any) => a.id === 'photoA1')).toMatchObject({ fileName: 'photoA1.png', source: 'UPLOAD' });
  });

  it('con saldo justo: el recorte usa el último crédito y el siguiente pedido no llama al servicio', async () => {
    const w = world({ credits: 1 });
    await saveFile(null, 'coA', 'photoA2.png', png(400, 500, true), 'image/png');
    w.db.brandAsset.push({ id: 'photoA2', companyId: 'coA', kind: 'IMAGE', name: 'Tacos 2', fileName: 'photoA2.png', mimeType: 'image/png', sizeBytes: 10, width: 400, height: 500, source: 'UPLOAD', createdAt: new Date() });
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).resolves.toMatchObject({ created: true });
    await expect(w.svc.removeBackground(A, { assetId: 'photoA2' })).rejects.toMatchObject({ response: { code: 'NO_CREDITS' } });
    expect(w.cutoutCalls).toHaveLength(1);
    const { unlinkSync: rm } = require('fs');
    rm(join(UPLOADS_DIR, 'coA', 'photoA2.png'));
  });

  it('si se borra el recorte, se puede volver a pedir (cobra de nuevo, con otra llave)', async () => {
    const w = world();
    const r: any = await w.svc.removeBackground(A, { assetId: 'photoA1' });
    w.db.brandAsset.splice(w.db.brandAsset.findIndex((a: any) => a.id === r.asset.id), 1);
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).resolves.toMatchObject({ created: true });
    expect(w.db.creativeCreditMove.map((m: any) => m.idempotencyKey)).toEqual(['cutout:photoA1:0', 'cutout:photoA1:0:commit', 'cutout:photoA1:1', 'cutout:photoA1:1:commit']);
  });

  it('una reserva abandonada (el proceso murió a mitad) no bloquea la foto para siempre', async () => {
    const w = world();
    const key = 'cutout:photoA1:0';
    w.db.creativeCreditMove.push({ id: deterministicId('ccm', key), companyId: 'coA', kind: 'RESERVE', operation: 'IMAGE', credits: 1, bucket: 'EXTRA', idempotencyKey: key, createdAt: new Date(Date.now() - 10 * 60_000) });
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).resolves.toMatchObject({ created: true });
    expect(w.db.creativeCreditMove.map((m: any) => `${m.kind} ${m.idempotencyKey}`)).toEqual([
      `RESERVE ${key}`, `RELEASE ${key}:release`, 'RESERVE cutout:photoA1:1', 'COMMIT cutout:photoA1:1:commit',
    ]);
    // Una reserva reciente sí se respeta (está en curso)
    const w2 = world();
    w2.db.creativeCreditMove.push({ id: deterministicId('ccm', key), companyId: 'coA', kind: 'RESERVE', operation: 'IMAGE', credits: 1, bucket: 'EXTRA', idempotencyKey: key, createdAt: new Date() });
    await expect(w2.svc.removeBackground(A, { assetId: 'photoA1' })).rejects.toThrow(/ya se está procesando/);
    expect(w2.cutoutCalls).toHaveLength(0);
  });

  it('si confirmar el cobro falla después de crear el recorte, se entrega igual y no se devuelven créditos', async () => {
    const w = world();
    const create = w.prisma.creativeCreditMove.create.bind(w.prisma.creativeCreditMove);
    w.prisma.creativeCreditMove.create = async (args: any) => {
      if (String(args?.data?.idempotencyKey).endsWith(':commit')) throw new Error('Atlas caído');
      return create(args);
    };
    await expect(w.svc.removeBackground(A, { assetId: 'photoA1' })).resolves.toMatchObject({ created: true });
    expect(cutouts(w)).toHaveLength(1);
    expect(w.db.creativeCreditMove.map((m: any) => m.kind)).toEqual(['RESERVE']);
  });

  it('un recorte no se recorta otra vez y los archivos de otra empresa no se tocan', async () => {
    const w = world();
    const r: any = await w.svc.removeBackground(A, { assetId: 'photoA1' });
    await expect(w.svc.removeBackground(A, { assetId: r.asset.id })).rejects.toThrow(/ya es un recorte/);
    await expect(w.svc.removeBackground(A, { assetId: 'photoB1' })).rejects.toThrow(/no encontrada/);
    await expect(w.svc.removeBackground(A, { assetId: '' })).rejects.toThrow(/no encontrada/);
  });
});

describe('Crear · versiones del diseño entre Creative y Ads', () => {
  async function exported(w: ReturnType<typeof world>, version: number) {
    const file = `design-d1-v${version}-abcd.png`;
    await saveFile(null, 'coA', file, png(1080, 1080, true), 'image/png');
    const d = w.db.creativeDesign.find((x: any) => x.id === 'd1');
    if (d) Object.assign(d, { version, exportFile: file });
    else w.db.creativeDesign.push({ id: 'd1', companyId: 'coA', name: 'Tacos', format: 'IG_POST', version, docJson: '{}', exportFile: file, exportMime: 'image/png', createdAt: new Date(), updatedAt: new Date() });
  }
  const account = (w: ReturnType<typeof world>) => {
    w.db.adAccount.push({ id: 'acc1', companyId: 'coA', provider: 'META', mode: 'REAL', externalId: 'act_1', name: 'Lúa', currency: 'COP', timezone: 'America/Bogota', status: 'CONNECTED', tokenEnc: encryptSecret('EAAG'.padEnd(40, 'x')), scopesJson: JSON.stringify(['ads_management', 'ads_read', 'business_management']), createdAt: new Date() });
    w.db.adSettings.push({ id: 's1', companyId: 'coA', maxDailyBudget: 50000 });
    const ads = new AdsCreateService(w.prisma as any, w.audit as any);
    let n = 0;
    ads.fetchImpl = (async (url: string, init?: any) => {
      const path = new URL(url).pathname;
      const body = path.endsWith('/adimages') ? { images: { x: { hash: 'H' } } } : init?.method === 'POST' ? { id: String(++n) } : { data: [] };
      return { ok: true, status: 200, json: async () => body };
    }) as any;
    return ads;
  };
  const draft = { name: 'Tacos finde', goal: 'WHATSAPP', dailyBudget: '30.000', countries: ['CO'], primaryText: 'Tacos al pastor. Escríbenos por WhatsApp.', headline: 'Tacos' };

  it('cada versión exportada es un recurso distinto; Ads rechaza la imagen de una versión vieja', async () => {
    const w = world();
    await exported(w, 2);
    const v2: any = await w.svc.toAds(A, 'd1');
    await exported(w, 3);
    await exported(w, 3);
    const v3: any = await w.svc.toAds(A, 'd1');
    expect(v3.asset.id).not.toBe(v2.asset.id);
    expect(w.db.brandAsset.find((a: any) => a.id === v3.asset.id)).toMatchObject({ designVersion: 3, derivedFromId: v2.asset.id });
    const ads = account(w);
    await expect(ads.create(A, { confirm: true, accountId: 'acc1', pageId: '5550001', assetId: v2.asset.id, designId: 'd1', draft })).rejects.toThrow(/cambió después de traerlo a Ads/);
    expect(w.db.adLaunch).toHaveLength(0);
    const l: any = await ads.create(A, { confirm: true, accountId: 'acc1', pageId: '5550001', assetId: v3.asset.id, designId: 'd1', draft });
    expect(w.db.adLaunch.find((x: any) => x.id === l.id)).toMatchObject({ designId: 'd1', assetId: v3.asset.id, status: 'PAUSED' });
  });

  it('Ads no acepta un diseño de otra empresa ni una imagen de otra empresa', async () => {
    const w = world();
    await exported(w, 2);
    const { asset }: any = await w.svc.toAds(A, 'd1');
    w.db.creativeDesign.push({ id: 'dB', companyId: 'coB', name: 'Ajeno', format: 'IG_POST', version: 1, docJson: '{}', exportFile: null, createdAt: new Date(), updatedAt: new Date() });
    const ads = account(w);
    await expect(ads.create(A, { confirm: true, accountId: 'acc1', pageId: '5550001', assetId: asset.id, designId: 'dB', draft })).rejects.toThrow(/Diseño no encontrado/);
    await expect(ads.create(A, { confirm: true, accountId: 'acc1', pageId: '5550001', assetId: 'photoB1', draft })).rejects.toThrow();
    expect(w.db.adLaunch).toHaveLength(0);
  });

  it('la biblioteca tampoco acepta una exportación de una versión anterior', async () => {
    const w = world();
    await exported(w, 2);
    w.db.creativeDesign[0].version = 4; // se editó después de exportar
    const library = new LibraryService(w.prisma as any, w.audit as any);
    await expect(library.fromDesign(A, 'd1')).rejects.toThrow(/cambió después de exportarlo/);
    w.db.creativeDesign[0].exportFile = 'design-d1-sin-version.png';
    await expect(library.fromDesign(A, 'd1')).rejects.toThrow(/cambió después de exportarlo/);
  });

  it('la exportación declara qué versión dibujó: si el diseño cambió entretanto, se rechaza y no reemplaza la anterior', async () => {
    const w = world();
    await exported(w, 2);
    const creative = new CreativeService(w.prisma as any, w.audit as any);
    const file = { buffer: png(1080, 1080, true), size: 1, mimetype: 'image/png' } as any;
    await expect(creative.uploadExport(A, 'd1', file, '1')).rejects.toThrow(/cambió mientras se exportaba/);
    expect(w.db.creativeDesign[0].exportFile).toBe('design-d1-v2-abcd.png');
    await expect(creative.uploadExport(A, 'd1', file, '2')).resolves.toMatchObject({ ok: true, version: 2 });
    expect(w.db.creativeDesign[0].exportFile).toMatch(/^design-d1-v2-[0-9a-f]+\.png$/);
  });

  it('el uso en anuncios suma solo lo que Meta reportó y no mira datos de otra empresa', async () => {
    const w = world();
    await exported(w, 2);
    w.db.adLaunch.push({ id: 'L1', companyId: 'coA', accountId: 'acc1', designId: 'd1', status: 'ACTIVE', draftJson: JSON.stringify({ name: 'Tacos' }), idsJson: JSON.stringify({ ad: '777' }), createdAt: new Date() });
    w.db.adLaunch.push({ id: 'L2', companyId: 'coA', accountId: 'acc1', designId: 'd1', status: 'ACTIVE', draftJson: '{}', idsJson: JSON.stringify({ ad: '888' }), createdAt: new Date(Date.now() - 1000) });
    const row = (companyId: string, externalId: string, spend: number) => ({ companyId, accountId: 'acc1', level: 'AD', externalId, date: '2026-10-20', spend, impressions: 100, clicks: 5, conversations: 2, leads: 0 });
    w.db.adInsightDaily.push(row('coA', '777', 10000), row('coA', '777', 5000), row('coB', '777', 999999));
    const u: any = await w.svc.adUsage(A, 'd1');
    expect(u.launches[0]).toMatchObject({ launchId: 'L1', results: { days: 2, spend: 15000, impressions: 200, clicks: 10, conversations: 4, leads: 0 }, resultsNote: null });
    expect(u.launches[1]).toMatchObject({ launchId: 'L2', results: null, resultsNote: expect.stringMatching(/todavía no reporta/) });
    await expect(w.svc.adUsage(B, 'd1')).rejects.toThrow(/no encontrado/);
  });
});

describe('intención con IA · textos que llegan a la pieza', () => {
  const rules = interpretIntent('Queremos que más gente conozca nuestro restaurante', CATALOG);
  it('la IA no cuela precios, descuentos ni gratuidades en el producto, el público o el llamado', () => {
    const ai = normalizeAiIntent({ objective: 'AWARENESS', productDescription: 'Almuerzo gratis', audience: 'oficinistas con 20% off', callToAction: 'Llévate un 2x1', offer: '2x1', offerValidity: 'hasta el 30 de octubre' }, { ...rules, productDescription: null, callToAction: null }, CATALOG);
    expect(ai).toMatchObject({ productDescription: null, audience: null, offer: null, offerValidity: null, productPrice: null });
    expect(ai.callToAction ?? '').not.toMatch(/2x1/);
    expect(artRequestFrom(ai).content.price).toBeUndefined();
  });
  it('sí acepta esos textos cuando la persona los escribió', () => {
    const said = interpretIntent('Almuerzo gratis para oficinistas este viernes', CATALOG);
    const ai = normalizeAiIntent({ productDescription: 'Almuerzo gratis', audience: 'oficinistas' }, { ...said, productDescription: null, audience: null }, CATALOG);
    expect(ai).toMatchObject({ productDescription: 'Almuerzo gratis', audience: 'oficinistas' });
  });
});
