/**
 * Google Drive → Biblioteca, con Google simulado (sin red): conexión cifrada
 * con drive.file, selector de Google, validación de tipo y tamaño, sin
 * duplicar y sin tocar otras empresas.
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
  db.platformSetting.push({ key: 'GOOGLE_CLIENT_ID', value: '123456789012-abc.apps.googleusercontent.com' }, { key: 'GOOGLE_CLIENT_SECRET', value: 'csecret' });
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
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'acc', refresh_token: 'ref-secret', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email' });
    if (url.includes('/oauth2/v2/userinfo')) return json({ email: 'obras@constructora.co' });
    const m = /\/drive\/v3\/files\/([\w-]+)/.exec(url);
    if (m) {
      const f = files[m[1]];
      if (!f) return json({ error: { message: 'not found' } }, 404);
      if (url.includes('alt=media')) return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => new Uint8Array(f.bytes).buffer };
      return json({ id: m[1], name: f.name, mimeType: f.mimeType, size: String(f.bytes.length), });
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
  it('conecta solo con drive.file (nunca todo el Drive), guarda la autorización cifrada y no la expone', async () => {
    const w = world();
    const start = await w.svc.start(A);
    expect(start.url).toContain(encodeURIComponent('https://www.googleapis.com/auth/drive.file'));
    expect(start.url).not.toMatch(/drive\.readonly|auth%2Fdrive(&|%20|$)/);
    expect(await connect(w)).toMatch(/\/app\/biblioteca\?drive=listo$/);
    const row: any = w.db.integration.find((i: any) => i.type === 'GOOGLE_DRIVE');
    expect(row.configJson).not.toContain('ref-secret');
    expect(decryptSecret(JSON.parse(row.configJson).refreshTokenEnc)).toBe('ref-secret');
    const s = await w.svc.status(A);
    expect(s).toMatchObject({ connected: true, email: 'obras@constructora.co' });
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

  it('el selector recibe un token de corta duración y el número de proyecto, nunca la autorización guardada', async () => {
    const w = world();
    await expect(w.svc.picker(A)).rejects.toThrow(/Conecta primero/);
    await connect(w);
    const p = await w.svc.picker(A);
    expect(p).toEqual({ accessToken: 'acc', appId: '123456789012', developerKey: null });
    expect(JSON.stringify(p)).not.toContain('ref-secret');
    w.db.platformSetting.push({ key: 'GOOGLE_PICKER_API_KEY', value: 'pick-key' });
    expect((await w.svc.picker(A))!.developerKey).toBe('pick-key');
    // Otra empresa no puede pedir el token de esta
    await expect(w.svc.picker(B)).rejects.toThrow(/Conecta primero/);
  });

  it('trae a la biblioteca lo elegido en el selector sin duplicar y sin escribir en Drive', async () => {
    const w = world();
    await connect(w);
    const r = await w.svc.import(A, { fileIds: ['f1'] });
    expect(r.results).toEqual([expect.objectContaining({ fileId: 'f1', ok: true, duplicate: false })]);
    expect(w.db.brandAsset).toEqual([expect.objectContaining({ companyId: 'coA', source: 'DRIVE', externalId: 'f1', mimeType: 'image/png' })]);
    const again = await w.svc.import(A, { fileIds: ['f1'] });
    expect(again.results[0]).toMatchObject({ ok: true, duplicate: true });
    expect(w.db.brandAsset).toHaveLength(1);
    // Nada se escribe en Drive: solo lecturas
    expect(w.calls.filter((c) => /drive\/v3/.test(c)).every((c) => c.startsWith('GET'))).toBe(true);
  });

  it('rechaza tipos no permitidos y archivos que Drive no da', async () => {
    const w = world();
    await connect(w);
    const r = await w.svc.import(A, { fileIds: ['f3', 'nope'] });
    expect(r.results.map((x: any) => x.ok)).toEqual([false, false]);
    expect(r.results[0].error).toMatch(/Solo imágenes/);
    expect(w.db.brandAsset).toHaveLength(0);
    // Otra empresa sin Drive conectado no puede traer nada
    await expect(w.svc.import(B, { fileIds: ['f1'] })).rejects.toThrow(/Conecta primero/);
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
    await expect(w2.svc.picker(A)).rejects.toThrow(/Conecta primero/);
  });
});
