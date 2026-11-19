import { AdsPartnerService, accountDigits } from '../src/modules/ads-partner';
import { createMockPrisma } from './helpers/mock-prisma';

describe('Meta Ads por acceso de socio', () => {
  const USER = { id: 'u1', role: 'COMPANY_ADMIN', companyId: 'c1', name: 'Rosa', email: 'r@x.co' } as any;

  interface Opts {
    shared?: string[]; configured?: boolean; connect?: (...args: any[]) => Promise<any>;
    /** Lo que Meta devuelve para página, Instagram y píxel de la cuenta */
    promote?: string[]; clientPages?: string[]; ig?: string | null; pageIg?: string | null; pixel?: string | null; pagesFail?: boolean;
  }
  function setup(opts: Opts = {}) {
    const { prisma, db } = createMockPrisma();
    if (opts.configured !== false) {
      db.platformSetting.push({ id: 's1', key: 'META_BUSINESS_ID', value: '1834616297969984' }, { id: 's2', key: 'META_PARTNER_TOKEN', value: 'EAAB'.padEnd(60, 'z') });
    }
    const calls: string[] = [];
    const ads = {
      companyOf: jest.fn(async () => ({ id: 'c1', name: 'Panadería La 14' })),
      connectManual: jest.fn<Promise<any>, any[]>(opts.connect ?? (async (_u: any, dto: any) => ({ id: 'a1', name: 'Cuenta Panadería', externalId: dto.accountId, access: { manage: true } }))),
    };
    const alerts = { send: jest.fn(async () => true) };
    const svc = new AdsPartnerService(prisma as any, ads as any, alerts as any);
    svc.fetchImpl = async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0].replace(/https:\/\/graph\.facebook\.com\/v[\d.]+/, '')}`);
      if (url.includes('/client_ad_accounts')) return { ok: true, status: 200, json: async () => ({ data: (opts.shared ?? []).map((id) => ({ account_id: id, name: `Cuenta ${id}` })) }) };
      if (url.includes('/me?')) return { ok: true, status: 200, json: async () => ({ id: '999' }) };
      if (url.includes('/assigned_users')) return { ok: true, status: 200, json: async () => ({ success: true }) };
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('/promote_pages')) return opts.pagesFail ? { ok: false, status: 400, json: async () => ({ error: { message: 'sin permiso' } }) } : ok({ data: (opts.promote ?? []).map((id) => ({ id, name: `Página ${id}` })) });
      if (url.includes('/client_pages')) return ok({ data: (opts.clientPages ?? []).map((id) => ({ id, name: `Página ${id}` })) });
      if (url.includes('/instagram_accounts')) return ok({ data: opts.ig ? [{ id: 'ig1', username: opts.ig }] : [] });
      if (url.includes('/adspixels')) return ok({ data: opts.pixel ? [{ id: 'px1', name: opts.pixel }] : [] });
      if (/\/p\d+\?/.test(url)) return ok(opts.pageIg ? { instagram_business_account: { id: 'ig2', username: opts.pageIg } } : {});
      return { ok: false, status: 404, json: async () => ({ error: { message: 'no' } }) };
    };
    return { svc, ads, alerts, calls };
  }

  it('la cuenta ya compartida: BackOffice se asigna con control total, la conecta y avisa al celular', async () => {
    const { svc, ads, alerts, calls } = setup({ shared: ['111', '1234567890'] });
    const r = await svc.claim(USER, { accountId: 'act_1234567890' });
    expect(r).toMatchObject({ status: 'CONNECTED', readOnly: false });
    expect(calls.slice(0, 3)).toEqual(['GET /1834616297969984/client_ad_accounts', 'GET /me', 'POST /act_1234567890/assigned_users']);
    expect(ads.connectManual).toHaveBeenCalledWith(USER, { accountId: 'act_1234567890', token: 'EAAB'.padEnd(60, 'z') }, 'c1');
    expect(alerts.send).toHaveBeenCalledWith('ADS_CONNECTED', expect.stringContaining('Panadería La 14'));
  });

  it('todavía no compartida: espera, sin conectar nada ni mostrar cuentas de otros clientes', async () => {
    const { svc, ads } = setup({ shared: ['111'] });
    const r = await svc.claim(USER, { accountId: '1234567890' });
    expect(r.status).toBe('WAITING');
    expect(JSON.stringify(r)).not.toContain('111');
    expect(ads.connectManual).not.toHaveBeenCalled();
  });

  it('número inválido o conexión automática apagada: lo dice en palabras', async () => {
    await expect(setup().svc.claim(USER, { accountId: 'abc' })).rejects.toThrow(/número de tu cuenta/);
    await expect(setup({ configured: false }).svc.claim(USER, { accountId: '1234567890' })).rejects.toThrow(/aún no está activada/);
    expect(await setup({ configured: false }).svc.info(USER)).toEqual({ businessId: null, automatic: false });
  });

  it('compartida sin control total: conecta en solo lectura y lo marca', async () => {
    const { svc, alerts } = setup({ shared: ['1234567890'], connect: async () => ({ id: 'a1', name: 'Cuenta', access: { manage: false } }) });
    expect(await svc.claim(USER, { accountId: '1234567890' })).toMatchObject({ status: 'CONNECTED', readOnly: true });
    expect(alerts.send).toHaveBeenCalledWith('ADS_CONNECTED', expect.stringContaining('solo lectura'));
  });

  it('acepta el número con o sin act_ y con espacios', () => {
    expect(accountDigits(' act_123 456 ')).toBe('123456');
  });

  it('revisa página, Instagram y píxel: se asigna la página que la cuenta usa y dice qué falta', async () => {
    const { svc, calls, alerts } = setup({ shared: ['1234567890'], promote: ['p1', 'p2'], clientPages: ['p9', 'p2'], ig: null, pageIg: 'panaderia14', pixel: null });
    const r: any = await svc.claim(USER, { accountId: '1234567890' });
    expect(r.assets).toEqual({ page: { ok: true, name: 'Página p2' }, instagram: { ok: true, name: '@panaderia14' }, pixel: { ok: false } });
    expect(calls).toContain('POST /p2/assigned_users');
    expect(calls).not.toContain('POST /p9/assigned_users');
    expect(alerts.send).toHaveBeenCalledWith('ADS_CONNECTED', expect.stringContaining('Píxel falta'));
  });

  it('sin página compartida: página e Instagram faltan; si Meta no responde, queda «sin confirmar» y la cuenta igual se conecta', async () => {
    const a: any = await setup({ shared: ['1234567890'], promote: ['p1'], clientPages: [], pixel: 'Píxel tienda' }).svc.claim(USER, { accountId: '1234567890' });
    expect(a.assets).toEqual({ page: { ok: false }, instagram: { ok: false }, pixel: { ok: true, name: 'Píxel tienda' } });
    const b: any = await setup({ shared: ['1234567890'], pagesFail: true }).svc.claim(USER, { accountId: '1234567890' });
    expect(b.status).toBe('CONNECTED');
    expect(b.assets.page).toEqual({ ok: null });
  });
});
