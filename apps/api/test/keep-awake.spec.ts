import { BadRequestException } from '@nestjs/common';
import { KeepAwakeService, selfUrl } from '../src/modules/keep-awake';
import { createMockPrisma } from './helpers/mock-prisma';

const DEV = { id: 'd1', role: 'DEV', companyId: null, name: 'Santi', email: 's@b.dev' } as any;
const RENDER = { RENDER_EXTERNAL_URL: 'https://backoffice-platform-90ic.onrender.com' } as any;

function setup(live: { id: string; name: string; campaign: string }[] | null, env: any = RENDER) {
  const { prisma } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const ads = { deliveringNow: jest.fn(async () => live) };
  const svc = new KeepAwakeService(prisma as any, audit as any, ads as any);
  const calls: string[] = [];
  svc.fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  svc.env = env;
  return { svc, ads, audit, calls };
}

describe('despertador del servidor', () => {
  it('por defecto es automático: con anuncios entregando se llama a sí mismo por la URL pública', async () => {
    const { svc, calls } = setup([{ id: '1', name: 'Conjunto', campaign: 'BO · Registro' }]);
    await svc.tick();
    expect(calls).toEqual(['https://backoffice-platform-90ic.onrender.com/api/health']);
    const s = await svc.status();
    expect(s).toMatchObject({ mode: 'AUTO', active: true, campaigns: ['BO · Registro'], lastPing: { ok: true } });
  });

  it('automático sin campañas entregando: no llama y deja dormir', async () => {
    const { svc, calls } = setup([]);
    await svc.tick();
    expect(calls).toEqual([]);
    expect((await svc.status()).reason).toMatch(/se deja dormir/);
  });

  it('automático sin poder leer Meta: despierto por las dudas', async () => {
    const { svc, calls } = setup(null);
    await svc.tick();
    expect(calls).toHaveLength(1);
    expect((await svc.status()).reason).toMatch(/no se pudo leer Meta/);
  });

  it('encendido siempre llama sin mirar Meta; apagado nunca; el cambio queda auditado', async () => {
    const { svc, ads, audit, calls } = setup([]);
    const on = await svc.setMode(DEV, 'on');
    expect(on).toMatchObject({ mode: 'ON', active: true, updatedBy: 'Santi' });
    expect(calls).toHaveLength(1);
    expect(ads.deliveringNow).not.toHaveBeenCalled();
    const off = await svc.setMode(DEV, 'OFF');
    expect(off).toMatchObject({ mode: 'OFF', active: false });
    expect(calls).toHaveLength(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform.keep_awake', detail: 'OFF' }));
    await expect(svc.setMode(DEV, 'quizás')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fuera de Render no llama a nada; una caída del ping queda registrada sin romper', async () => {
    const local = setup(null, {});
    await local.svc.setMode(DEV, 'ON');
    expect(local.calls).toEqual([]);
    expect((await local.svc.status()).url).toBeNull();

    const { svc } = setup(null);
    svc.fetchImpl = async () => { throw new Error('timeout'); };
    await svc.setMode(DEV, 'ON');
    expect((await svc.status()).lastPing).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('solo acepta URLs https (KEEP_AWAKE_URL manda sobre la de Render)', () => {
    expect(selfUrl({ RENDER_EXTERNAL_URL: 'https://x.onrender.com/' } as any)).toBe('https://x.onrender.com');
    expect(selfUrl({ KEEP_AWAKE_URL: 'https://api.backoffice.store', RENDER_EXTERNAL_URL: 'https://x.onrender.com' } as any)).toBe('https://api.backoffice.store');
    expect(selfUrl({ KEEP_AWAKE_URL: 'http://inseguro' } as any)).toBeNull();
  });
});

describe('pauta propia · anuncios entregando ahora', () => {
  it('descarta conjuntos con fecha de fin vencida y sin cuenta conectada devuelve null', async () => {
    const { MetaAdsService } = await import('../src/modules/meta-ads.module');
    const { prisma } = createMockPrisma();
    const svc = new MetaAdsService(prisma as any, { log: async () => undefined } as any);
    expect(await svc.deliveringNow()).toBeNull();
    await prisma.platformSetting.create({ data: { key: 'META_ADS_CONFIG', value: JSON.stringify({ accountId: 'act_1', token: 'EAAB'.padEnd(40, 'z') }) } });
    svc.clock = () => new Date('2026-11-19T15:00:00Z');
    let asked = '';
    svc.fetchImpl = async (url: string) => {
      asked = url;
      return { ok: true, status: 200, json: async () => ({ data: [
        { id: 'a', name: 'Vigente', end_time: '2026-11-21T23:59:00-0500', campaign: { name: 'BO · Registro' } },
        { id: 'b', name: 'Vencido', end_time: '2026-11-18T23:59:00-0500', campaign: { name: 'Vieja' } },
        { id: 'c', name: 'Sin fin', campaign: { name: 'Siempre' } },
      ] }) } as any;
    };
    expect((await svc.deliveringNow())!.map((a) => a.campaign)).toEqual(['BO · Registro', 'Siempre']);
    expect(decodeURIComponent(asked)).toContain('effective_status=["ACTIVE"]');
  });
});
