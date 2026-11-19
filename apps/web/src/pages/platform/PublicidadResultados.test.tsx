import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Funnel, Results } from './PublicidadResultados';

const put = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: (p: string, b?: unknown) => put(p, b), delete: vi.fn() } }));
vi.mock('../../components/charts', () => ({ AdsSpendChart: (p: any) => <p data-testid="chart">{p.resultsLabel}: {p.data.length} días</p> }));

import { ResultsView, todayInZone } from './PublicidadResultados';
import { visitOrigin } from '../public/signup-helpers';
import { KeepAwakeView, type KeepAwakeStatus } from './KeepAwake';

const zero: Funnel = { visits: 0, started: 0, completed: 0, companies: 0, paying: 0, revenue: 0 };
const nul = { ctr: null, cpc: null, cpm: null, costPerSignup: null, cac: null, roas: null };
const video = { plays3s: 4000, p25: 2000, p50: 1200, p75: 800, p100: 500, thruplay: 900 };
const metrics = { spend: 60000, impressions: 20000, reach: 9000, frequency: 2.2, linkClicks: 300, video };

function results(over: Partial<Results> = {}): Results {
  return {
    range: { preset: '7', since: '2026-11-11', until: '2026-11-17', days: 7, timezone: 'America/Bogota' },
    connected: true,
    account: { id: 'act_1397864565500673', name: 'BackOffice Ads COP', currency: 'COP', timezone: 'America/Bogota', status: 1 },
    error: null,
    cachedAt: new Date().toISOString(),
    currency: 'COP',
    totals: { spend: 60000, metaSpend: 60000, manualSpend: 0, impressions: 20000, reach: 9000, frequency: 2.2, linkClicks: 300, funnel: { visits: 3, started: 2, completed: 1, companies: 1, paying: 1, revenue: 150000 }, derived: { ctr: 1.5, cpc: 200, cpm: 3000, costPerSignup: 60000, cac: 60000, roas: 2.5 }, visitsAll: 4, revenueOtherCurrency: false },
    daily: [{ date: '2026-11-16', spend: 40000, results: 1 }],
    campaigns: [{
      id: '52637929268760', name: 'BO · Tráfico registro · Pymes CO · Prueba 3 días', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_TRAFFIC',
      delivery: { code: 'ACTIVE', label: 'Activa', tone: 'ok', reason: null }, launchId: null, utms: ['prueba_3dias_registro'], manualUtms: [],
      metrics, funnel: { visits: 3, started: 2, completed: 1, companies: 1, paying: 1, revenue: 150000 }, unmatchedAds: zero,
      derived: { ctr: 1.5, cpc: 200, cpm: 3000, costPerSignup: 60000, cac: 60000, roas: 2.5 },
      pace: { budgetType: 'LIFETIME', budget: 90000, spent: 60000, consumedPct: 66.7, startDate: '2026-11-15', endDate: '2026-11-18', daysLeft: 1, projected: 80000 },
      endsAt: '2026-11-18T05:00:00Z',
      ads: [
        { id: '52637946173360', name: 'Reel caricatura', utmContent: 'reel_caricatura', link: null, delivery: { code: 'ACTIVE', label: 'Activa', tone: 'ok', reason: null }, metrics, funnel: { visits: 3, started: 2, completed: 1, companies: 1, paying: 1, revenue: 150000 }, derived: { ctr: 1.5, cpc: 200, cpm: 3000, costPerSignup: 60000, cac: 60000, roas: 2.5 } },
        { id: '52637946173361', name: 'Imagen precio', utmContent: null, link: null, delivery: { code: 'REJECTED', label: 'Rechazada', tone: 'bad', reason: 'Texto engañoso' }, metrics: { ...metrics, spend: 0, linkClicks: 0 }, funnel: zero, derived: nul },
      ],
    }],
    unattributed: [{ utmSource: 'meta', utmMedium: 'paid_social', utmCampaign: 'promo_noviembre', utmContent: null, utmId: null, fbclid: false, funnel: { ...zero, visits: 2, completed: 1 }, manualSpend: 0 }],
    signups: [{ id: 's1', createdAt: '2026-11-16T15:00:00.000Z', companyId: 'co1', companyName: 'Panadería La 14', rubro: 'comidas', status: 'PAGÓ', campaignId: '52637929268760', campaignName: 'BO · Tráfico registro · Pymes CO · Prueba 3 días', adId: '52637946173360', adName: 'Reel caricatura', via: 'utm del enlace del anuncio en Meta', utmCampaign: 'prueba_3dias_registro', utmContent: 'reel_caricatura' }],
    alerts: [{ kind: 'REJECTED', severity: 'bad', title: 'Meta rechazó el anuncio «Imagen precio»', detail: 'Texto engañoso', campaignId: '52637929268760' }],
    thresholds: { spendWithoutSignup: 50000, maxFrequency: 3, minLinkCtr: 0.8, minImpressionsForCtr: 1000, endingHours: 24 },
    mappings: {},
    manual: [],
    ...over,
  };
}

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}
const noop = () => undefined;

beforeEach(() => put.mockClear());
afterEach(cleanup);

describe('Publicidad · Resultados', () => {
  it('muestra la cuenta que se lee, las alertas arriba y las tarjetas con montos en COP sin decimales', () => {
    mount(<ResultsView data={results()} query={{ range: '7' }} onQuery={noop} onRefresh={noop} refreshing={false} onStatus={noop} />);
    expect(screen.getByTestId('ads-account').textContent).toMatch(/BackOffice Ads COP · act_1397864565500673 · COP · America\/Bogota/);
    expect(within(screen.getByTestId('ads-alerts')).getByText('Meta rechazó el anuncio «Imagen precio»')).toBeTruthy();
    expect(screen.getByText('Costo por registro').parentElement!.textContent).toMatch(/\$\s?60\.000/);
    expect(screen.getAllByText('ROAS')[0].parentElement!.textContent).toContain('2,5x');
    expect(screen.getByTestId('chart').textContent).toBe('Registros: 1 días');
  });

  it('la campaña se despliega con ritmo, embudo y la comparación de sus anuncios; sin datos muestra «—»', () => {
    mount(<ResultsView data={results()} query={{ range: '7' }} onQuery={noop} onRefresh={noop} refreshing={false} onStatus={noop} />);
    const table = screen.getByTestId('ads-campaigns');
    expect(within(table).getByText(/67 % del presupuesto · 1 días restantes/)).toBeTruthy();
    fireEvent.click(within(table).getByLabelText('Ver anuncios'));
    expect(screen.getByText('Proyección al cierre').nextSibling!.textContent).toMatch(/\$\s?80\.000/);
    const reel = screen.getByText('Reel caricatura').closest('tr')!;
    expect(reel.textContent).toContain('mejor costo por registro');
    const img = screen.getByText('Imagen precio').closest('tr')!;
    expect(img.textContent).toContain('Texto engañoso');
    expect(within(img).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(img.textContent).not.toMatch(/Infinity|NaN/);
  });

  it('lo sin atribuir se puede asignar a una campaña (mapeo manual)', async () => {
    mount(<ResultsView data={results()} query={{ range: '7' }} onQuery={noop} onRefresh={noop} refreshing={false} onStatus={noop} />);
    const table = screen.getByTestId('ads-unattributed');
    expect(table.textContent).toContain('utm_campaign=promo_noviembre');
    fireEvent.change(within(table).getByLabelText('Campaña para promo_noviembre'), { target: { value: '52637929268760' } });
    fireEvent.click(within(table).getByText('Asignar'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/platform/ads/mappings', { campaignId: '52637929268760', utmCampaign: 'promo_noviembre' }));
  });

  it('registros con su campaña, su anuncio y enlace a la empresa en el panel', () => {
    mount(<ResultsView data={results()} query={{ range: '7' }} onQuery={noop} onRefresh={noop} refreshing={false} onStatus={noop} />);
    const table = screen.getByTestId('ads-signups');
    expect(within(table).getByText('Panadería La 14').closest('a')!.getAttribute('href')).toBe('/platform/companies/co1');
    expect(table.textContent).toContain('BO · Tráfico registro · Pymes CO · Prueba 3 días · Reel caricatura');
    expect(within(table).getByText('PAGÓ')).toBeTruthy();
  });

  it('error de Meta en palabras, rango personalizado y vacío sin campañas', () => {
    const onQuery = vi.fn();
    mount(<ResultsView data={results({ error: { kind: 'TOKEN', message: 'El token de Meta venció.' }, campaigns: [], alerts: [] })} query={{ range: 'custom', since: '2026-11-01', until: '2026-11-10' }} onQuery={onQuery} onRefresh={noop} refreshing={false} onStatus={noop} />);
    expect(screen.getByRole('alert').textContent).toContain('El token de Meta venció.');
    expect(screen.getByText('Ninguna campaña gastó ni trajo registros en este rango.')).toBeTruthy();
    fireEvent.click(screen.getByText('Aplicar'));
    expect(onQuery).toHaveBeenCalledWith({ range: 'custom', since: '2026-11-01', until: '2026-11-10' });
    fireEvent.click(screen.getByText('Hoy'));
    expect(onQuery).toHaveBeenLastCalledWith({ range: 'today' });
  });

  it('«hoy» sale de la zona de la cuenta, no de UTC', () => {
    expect(todayInZone('America/Bogota', new Date('2026-11-17T03:30:00Z'))).toBe('2026-11-16');
  });
});

describe('Registro · origen de la visita', () => {
  beforeEach(() => sessionStorage.clear());

  it('guarda utm_medium, utm_content, utm_id, fbclid y la primera página; descarta lo dinámico sin reemplazar', () => {
    const o = visitOrigin('?utm_source=meta&utm_medium=paid_social&utm_campaign=prueba_3dias_registro&utm_content=reel_caricatura&utm_id=52637929268760&fbclid=IwAR0abc', '/registro');
    expect(o).toEqual({ utmSource: 'meta', utmMedium: 'paid_social', utmCampaign: 'prueba_3dias_registro', utmContent: 'reel_caricatura', utmId: '52637929268760', fbclid: 'IwAR0abc', landingPath: '/registro?utm_source=meta&utm_medium=paid_social&utm_campaign=prueba_3dias_registro&utm_content=reel_caricatura&utm_id=52637929268760&fbclid=IwAR0abc' });
    // Pasos siguientes sin parámetros: se recuerda lo de la llegada
    expect(visitOrigin('', '/registro')).toMatchObject({ utmCampaign: 'prueba_3dias_registro' });
    sessionStorage.clear();
    expect(visitOrigin('?utm_id={{campaign.id}}&utm_campaign=x', '/registro')).toEqual({ utmCampaign: 'x', landingPath: '/registro?utm_id={{campaign.id}}&utm_campaign=x' });
  });
});

describe('Publicidad · despertador del servidor', () => {
  const base: KeepAwakeStatus = {
    mode: 'AUTO', url: 'https://x.onrender.com', active: true, reason: 'Automático: hay anuncios entregando en Meta.', campaigns: ['BO · Registro'],
    lastCheckAt: new Date().toISOString(), lastPing: { at: new Date().toISOString(), ok: true, ms: 120 }, updatedAt: null, updatedBy: null,
  };

  it('muestra el modo elegido, el estado y la campaña que lo mantiene despierto; cambiar de modo avisa', () => {
    const onMode = vi.fn();
    mount(<KeepAwakeView data={base} onMode={onMode} saving={false} />);
    const box = screen.getByTestId('keep-awake');
    expect(within(box).getByRole('radio', { name: 'Con campaña activa' }).getAttribute('aria-checked')).toBe('true');
    expect(box.textContent).toContain('Despierto');
    expect(box.textContent).toContain('Entregando: BO · Registro');
    expect(box.textContent).toContain('120 ms');
    fireEvent.click(within(box).getByRole('radio', { name: 'Con campaña activa' }));
    expect(onMode).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole('radio', { name: 'Siempre' }));
    expect(onMode).toHaveBeenCalledWith('ON');
  });

  it('apagado y con el último llamado caído lo dice en palabras', () => {
    mount(<KeepAwakeView data={{ ...base, mode: 'OFF', active: false, campaigns: [], reason: 'Apagado: el servidor se duerme tras 15 min sin visitas.', lastPing: { at: new Date().toISOString(), ok: false, ms: 20000, error: 'timeout' } }} onMode={noop} saving={false} />);
    const box = screen.getByTestId('keep-awake');
    expect(box.textContent).toContain('Puede dormirse');
    expect(box.textContent).toContain('Último llamado falló');
    expect(box.textContent).toContain('timeout');
  });
});
