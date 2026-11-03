/**
 * Google Drive → Biblioteca, con Google simulado (sin red): conexión cifrada,
 * solo la carpeta elegida, validación de tipo y tamaño, sin duplicar y sin
 * tocar otras empresas.
 */
import 'reflect-metadata';
import { PNG } from 'pngjs';
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DriveService } from '../src/modules/drive.module';
import { LibraryService } from '../src/modules/library.module';
import { decryptSecret } from '../src/common/crypto';
import { signState } from '../src/common/meta-publish';
import { UPLOADS_DIR } from '../src/common/file-store';
import { createMockPrisma } from './helpers/mock-prisma';

const STARTED = Date.now();
afterAll(() => {
  const dir = join(UPLOADS_DIR, 'coA');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (/^asset-[0-9a-f]+\.png$/.test(f) && statSync(join(dir, f)).mtimeMs >= STARTED) unlinkSync(join(dir, f));
});

const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const png = () => PNG.sync.write(new PNG({ width: 40, height: 30 }), { filterType: 0, deflateLevel: 1 } as any);

function world() {
  const { prisma, db } = createMockPrisma();
  const products = JSON.stringify({ CREATIVE: { enabled: true }, ADS: { enabled: false } });
  db.company.push({ id: 'coA', name: 'Constructora', slug: 'a', productsJson: products }, { id: 'coB', name: 'Otra', slug: 'b', productsJson: products });
  db.platformSetting.push({ key: 'GOOGLE_CLIENT_ID', value: 'cid' }, { key: 'GOOGLE_CLIENT_SECRET', value: 'csecret' });
  const audit = { log: jest.fn(async () => undefined) };
  const library = new LibraryService(prisma as any, audit as any);
  const svc = new DriveService(prisma as any, audit as any, library);
  const calls: string[] = [];
  const files: Record<string, { name: string; mimeType: string; parents: string[]; bytes: Buffer }> = {
    f1: { name: 'obra-cocina.png', mimeType: 'image/png', parents: ['fold1'], bytes: png() },
    f2: { name: 'otra-carpeta.png', mimeType: 'image/png', parents: ['other'], bytes: png() },
    f3: { name: 'planos.pdf', mimeType: 'application/pdf', parents: ['fold1'], bytes: Buffer.from('%PDF') },
  };
  const json = (body: any, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
  svc.fetchImpl = (async (url: string, init?: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'acc', refresh_token: 'ref-secret', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email' });
    if (url.includes('/oauth2/v2/userinfo')) return json({ email: 'obras@constructora.co' });
    if (url.includes('/drive/v3/files?')) {
      const q = new URL(url).searchParams.get('q') ?? '';
      if (q.includes('folder')) return json({ files: [{ id: 'fold1', name: 'Fotos de obras' }] });
      const parent = /'([\w-]+)' in parents/.exec(q)?.[1];
      return json({ files: Object.entries(files).filter(([, f]) => f.parents.includes(parent!) && f.mimeType !== 'application/pdf').map(([id, f]) => ({ id, name: f.name, mimeType: f.mimeType, size: String(f.bytes.length) })) });
    }
    const m = /\/drive\/v3\/files\/([\w-]+)/.exec(url);
    if (m) {
      const f = files[m[1]];
      if (!f) return json({ error: { message: 'not found' } }, 404);
      if (url.includes('alt=media')) return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => new Uint8Array(f.bytes).buffer };
      return json({ id: m[1], name: f.name, mimeType: f.mimeType, size: String(f.bytes.length), parents: f.parents });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
    return json({ error: { message: 'inesperado' } }, 500);
  }) as any;
  return { svc, db, calls, audit };
}

async function connect(w: ReturnType<typeof world>) {
  const state = signState({ c: 'coA', u: 'uA', k: 'gdrive' }, process.env.JWT_SECRET ?? 'dev');
  return w.svc.callback('code', state);
}

describe('Google Drive · Biblioteca', () => {
  it('conecta con permiso de solo lectura, guarda la autorización cifrada y no la expone', async () => {
    const w = world();
    const start = await w.svc.start(A);
    expect(start.url).toContain(encodeURIComponent('https://www.googleapis.com/auth/drive.readonly'));
    expect(start.url).not.toContain('drive.file');
    expect(await connect(w)).toMatch(/\/app\/biblioteca\?drive=elegir$/);
    const row: any = w.db.integration.find((i: any) => i.type === 'GOOGLE_DRIVE');
    expect(row.configJson).not.toContain('ref-secret');
    expect(decryptSecret(JSON.parse(row.configJson).refreshTokenEnc)).toBe('ref-secret');
    const s = await w.svc.status(A);
    expect(s).toMatchObject({ connected: true, email: 'obras@constructora.co', folder: null });
    expect(JSON.stringify(s)).not.toMatch(/Enc|secret/);
    // Otra empresa no ve esta conexión
    expect((await w.svc.status(B)).connected).toBe(false);
  });

  it('un estado firmado para otra cosa (o falsificado) no conecta nada', async () => {
    const w = world();
    expect(await w.svc.callback('code', signState({ c: 'coA', u: 'uA', k: 'gcal' }, process.env.JWT_SECRET ?? 'dev'))).toMatch(/drive=error/);
    expect(await w.svc.callback('code', 'falso')).toMatch(/drive=error/);
    expect(w.db.integration).toHaveLength(0);
  });

  it('elige carpeta, lista solo imágenes y videos y trae a la biblioteca sin duplicar', async () => {
    const w = world();
    await connect(w);
    expect((await w.svc.folders(A))!.folders).toEqual([{ id: 'fold1', name: 'Fotos de obras' }]);
    await w.svc.selectFolder(A, { folderId: 'fold1', folderName: 'Fotos de obras' });
    const list = await w.svc.files(A);
    expect(list!.files.map((f: any) => f.id)).toEqual(['f1']);
    const r = await w.svc.import(A, { fileIds: ['f1'] });
    expect(r.results).toEqual([expect.objectContaining({ fileId: 'f1', ok: true, duplicate: false })]);
    expect(w.db.brandAsset).toEqual([expect.objectContaining({ companyId: 'coA', source: 'DRIVE', externalId: 'f1', mimeType: 'image/png' })]);
    expect((await w.svc.files(A))!.files[0].imported).toBe(true);
    const again = await w.svc.import(A, { fileIds: ['f1'] });
    expect(again.results[0]).toMatchObject({ ok: true, duplicate: true });
    expect(w.db.brandAsset).toHaveLength(1);
    // Nada se escribe en Drive: solo lecturas
    expect(w.calls.filter((c) => /drive\/v3/.test(c)).every((c) => c.startsWith('GET'))).toBe(true);
  });

  it('no trae archivos de fuera de la carpeta elegida ni tipos no permitidos', async () => {
    const w = world();
    await connect(w);
    await w.svc.selectFolder(A, { folderId: 'fold1', folderName: 'Fotos' });
    const r = await w.svc.import(A, { fileIds: ['f2', 'f3', 'nope'] });
    expect(r.results.map((x: any) => x.ok)).toEqual([false, false, false]);
    expect(r.results[0].error).toMatch(/no está en la carpeta/);
    expect(r.results[1].error).toMatch(/Solo imágenes/);
    expect(w.db.brandAsset).toHaveLength(0);
  });

  it('sin la app de Google configurada lo dice; desconectar revoca y borra la autorización', async () => {
    const w = world();
    w.db.platformSetting.length = 0;
    const prev = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    await expect(w.svc.start(A)).rejects.toThrow(/no está habilitado/);
    expect((await w.svc.status(A)).available).toBe(false);
    if (prev) process.env.GOOGLE_CLIENT_ID = prev;
    const w2 = world();
    await connect(w2);
    await w2.svc.disconnect(A);
    expect(w2.db.integration).toHaveLength(0);
    expect(w2.calls.some((c) => c.includes('oauth2.googleapis.com/revoke'))).toBe(true);
    await expect(w2.svc.files(A)).rejects.toThrow(/Conecta primero/);
  });
});
