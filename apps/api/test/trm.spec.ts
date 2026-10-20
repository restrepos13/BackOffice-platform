import { currentTrm, resetTrmCache, usdCopRate } from '../src/common/trm';
import { createMockPrisma } from './helpers/mock-prisma';

const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as any);
const NOW = new Date('2026-10-20T15:00:00Z'); // 10:00 a. m. en Bogotá

function fakeFetch(opts: { official?: boolean; market?: boolean } = {}) {
  return jest.fn((url: string) => {
    if (url.includes('datos.gov.co')) {
      if (opts.official === false) return Promise.reject(new Error('caído'));
      return json([
        { valor: '3150.00', vigenciadesde: '2026-10-21T00:00:00.000', vigenciahasta: '2026-10-21T00:00:00.000' }, // la de mañana ya publicada
        { valor: '3156.32', vigenciadesde: '2026-10-20T00:00:00.000', vigenciahasta: '2026-10-20T00:00:00.000' },
        { valor: '3174.67', vigenciadesde: '2026-10-17T00:00:00.000', vigenciahasta: '2026-10-19T00:00:00.000' },
      ]);
    }
    if (url.includes('er-api')) return opts.market === false ? Promise.reject(new Error('caído')) : json({ rates: { COP: 3170.5 } });
    if (url.includes('coinbase')) return opts.market === false ? Promise.reject(new Error('caído')) : json({ data: { rates: { COP: '3166.7' } } });
    return Promise.reject(new Error('url'));
  }) as any;
}

describe('TRM en vivo', () => {
  beforeEach(() => resetTrmCache());

  it('usa la TRM oficial vigente hoy (no la de mañana) y le suma $20', async () => {
    const { prisma, db } = createMockPrisma();
    const q = await currentTrm(prisma as any, { fetchImpl: fakeFetch(), force: true, now: NOW });
    expect(q.source).toBe('OFICIAL');
    expect(q.official).toBe(3156.32);
    expect(q.officialDate).toBe('2026-10-20');
    expect(q.market).toBe(3170.5);
    expect(q.rate).toBe(3176.32);
    // Queda guardada para cuando no haya conexión
    expect(JSON.parse((db.platformSetting.find((s: any) => s.key === 'TRM_LAST') as any).value).base).toBe(3156.32);
  });

  it('el margen lo cambian los devs', async () => {
    const { prisma, db } = createMockPrisma();
    db.platformSetting.push({ id: 'm', key: 'TRM_MARKUP_COP', value: '35' });
    const q = await currentTrm(prisma as any, { fetchImpl: fakeFetch(), force: true, now: NOW });
    expect(q.rate).toBe(3191.32);
  });

  it('si la oficial no responde usa el dólar de mercado', async () => {
    const { prisma, db } = createMockPrisma();
    const q = await currentTrm(prisma as any, { fetchImpl: fakeFetch({ official: false }), force: true, now: NOW });
    expect(q.source).toBe('MERCADO');
    expect(q.rate).toBe(3190.5);
  });

  it('sin conexión usa la última guardada y, si no hay, la de respaldo', async () => {
    const { prisma, db } = createMockPrisma();
    db.platformSetting.push({ id: 'r', key: 'USD_COP_RATE', value: '4100' });
    const down = fakeFetch({ official: false, market: false });
    let q = await currentTrm(prisma as any, { fetchImpl: down, force: true, now: NOW });
    expect(q.source).toBe('RESPALDO');
    expect(q.rate).toBe(4120);
    await currentTrm(prisma as any, { fetchImpl: fakeFetch(), force: true, now: NOW });
    q = await currentTrm(prisma as any, { fetchImpl: down, force: true, now: NOW });
    expect(q.source).toBe('GUARDADA');
    expect(q.rate).toBe(3176.32);
  });

  it('cachea 15 minutos (no consulta en cada cobro)', async () => {
    const { prisma, db } = createMockPrisma();
    const f = fakeFetch();
    await currentTrm(prisma as any, { fetchImpl: f, force: true, now: NOW });
    const calls = f.mock.calls.length;
    expect(await usdCopRate(prisma as any)).toBe(3176.32);
    expect(f.mock.calls.length).toBe(calls);
  });
});
