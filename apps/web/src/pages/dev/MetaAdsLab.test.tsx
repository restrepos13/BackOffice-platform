import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ApiError } = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly field?: string, readonly code?: string) {
      super(message);
    }
  },
}));

const baseStatus = () => ({
  label: 'Datos internos de desarrollo · cuenta de pruebas del equipo',
  config: { appId: '1000000000000001', appSecretSet: true, redirectUri: 'http://localhost:5173/api/dev/meta-ads/callback', redirectError: null, scopes: ['ads_read', 'business_management'], version: 'v25.0', missing: [] as string[], defaultDays: 30, readOnly: true },
  connection: { status: 'DISCONNECTED' } as Record<string, unknown>,
  stored: { CAMPAIGN: 0, ADSET: 0, AD: 0, INSIGHT: 0 },
  runs: [] as unknown[],
});

let status: any;
let statusError: InstanceType<typeof ApiError> | null = null;
let authUser: any;
let rawReply: (path: string) => unknown = () => ({});
const get = vi.fn(async (path: string): Promise<unknown> => {
  if (path.startsWith('/dev/meta-ads/status')) {
    if (statusError) throw statusError;
    return status;
  }
  if (path.startsWith('/dev/meta-ads/connect')) return { url: 'https://www.facebook.com/v25.0/dialog/oauth?client_id=1' };
  if (path.startsWith('/dev/meta-ads/accounts')) return [{ id: 'act_1000000000000002', name: 'Cuenta de pruebas', status: 'ACTIVE', currency: 'COP', timezone: 'America/Bogota', selected: false }];
  if (path.startsWith('/dev/meta-ads/insights')) return { currency: 'COP', rows: [], totals: [] };
  if (path.startsWith('/dev/meta-ads/objects')) return [];
  if (path.startsWith('/dev/meta-ads/raw')) return rawReply(path);
  return [];
});
const post = vi.fn(async (_p: string, _b?: unknown): Promise<unknown> => ({}));
vi.mock('../../lib/api', () => ({ ApiError, api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), delete: vi.fn(async () => ({ revoked: 'OK', purged: 0 })) } }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: authUser }) }));

import MetaAdsLab from './MetaAdsLab';

function mount(url = '/dev/meta-ads') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><MetaAdsLab /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  status = baseStatus();
  statusError = null;
  authUser = { id: 'dev1', role: 'DEV', name: 'Dev' };
  get.mockClear();
  post.mockClear();
});
afterEach(cleanup);

describe('Meta Ads · laboratorio interno', () => {
  it('un usuario que no es DEV no ve nada ni llama al API', async () => {
    authUser = { id: 'a', role: 'COMPANY_ADMIN', companyId: 'c1' };
    mount();
    expect(screen.getByText('Solo para desarrolladores')).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it('si el API responde 404 (integración apagada) lo explica', async () => {
    statusError = new ApiError('Not Found', 404);
    mount();
    expect(await screen.findByText('Integración interna apagada')).toBeTruthy();
    expect(screen.getByText(/META_DEV_ENABLED=1/)).toBeTruthy();
  });

  it('falta configuración: dice qué falta, la URI a registrar y no deja conectar', async () => {
    status.config.missing = ['META_DEV_APP_SECRET'];
    mount();
    expect(await screen.findByText('Falta configuración')).toBeTruthy();
    expect(screen.getByText('META_DEV_APP_SECRET')).toBeTruthy();
    expect(screen.getAllByText('http://localhost:5173/api/dev/meta-ads/callback').length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Conectar Meta Ads' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('no conectado → conectar pide la URL al backend y queda esperando autorización', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, set href(v: string) { assign(v); } }, writable: true });
    mount();
    expect(await screen.findByText('No conectado')).toBeTruthy();
    expect(screen.getByText(/datos internos de desarrollo/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar Meta Ads' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://www.facebook.com/v25.0/dialog/oauth?client_id=1'));
    expect(screen.getByRole('button', { name: 'Esperando autorización…' })).toBeTruthy();
  });

  it('token vencido o revocado: lo dice y ofrece volver a autorizar', async () => {
    status.connection = { status: 'EXPIRED', lastError: 'El token llegó a su fecha de vencimiento', scopes: ['ads_read'] };
    mount();
    expect(await screen.findByText('Token vencido')).toBeTruthy();
    expect(screen.getByText(/Meta no permite renovarlo/)).toBeTruthy();
    status.connection = { status: 'REVOKED', scopes: [] };
    cleanup();
    mount();
    expect(await screen.findByText('Autorización revocada')).toBeTruthy();
  });

  it('conectado: consulta cuentas, elige la de pruebas y sincroniza; con data: [] muestra «Sin datos disponibles»', async () => {
    status.connection = { status: 'CONNECTED', metaUserName: 'Dev Santi', scopes: ['ads_read', 'business_management'], longLived: true, tokenExpiresAt: '2026-12-29T15:00:00Z', daysLeft: 59, selectedAccountId: null };
    post.mockImplementation(async (p: string) => (p.endsWith('/sync')
      ? { runId: 'r1', status: 'OK', since: '2026-10-01', until: '2026-10-30', days: 30, counts: { CAMPAIGN: { created: 1, updated: 0, unchanged: 0, total: 1 }, INSIGHT: { created: 0, updated: 0, unchanged: 0, total: 0 } }, warnings: ['Meta respondió data: [] para Insights'], calls: 5, error: null, errorKind: null }
      : { ok: true }));
    mount();
    expect(await screen.findByText('Conectado')).toBeTruthy();
    expect(screen.getByText(/larga duración/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Consultar cuentas autorizadas' }));
    expect(await screen.findByText('Cuenta de pruebas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Elegir' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/dev/meta-ads/select', { accountId: 'act_1000000000000002' }));
    // Con la cuenta ya elegida se puede sincronizar
    status.connection = { ...status.connection, selectedAccountId: 'act_1000000000000002', selectedAccountName: 'Cuenta de pruebas' };
    cleanup();
    mount();
    await screen.findByText('Conectado');
    fireEvent.click(screen.getByRole('button', { name: '60 días' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/dev/meta-ads/sync', { days: 60 }));
    expect(await screen.findByText('Sincronización completada')).toBeTruthy();
    expect(screen.getByText(/Sin datos disponibles:/)).toBeTruthy();
  });

  it('error de sincronización visible', async () => {
    status.connection = { status: 'CONNECTED', selectedAccountId: 'act_1000000000000002', scopes: ['ads_read'] };
    status.runs = [{ id: 'r0', status: 'ERROR', days: 30, since: '2026-10-01', until: '2026-10-30', counts: {}, warnings: [], error: 'Meta pidió esperar', errorKind: 'RATE_LIMIT', startedBy: 'Dev', startedAt: '2026-10-30T15:00:00Z', finishedAt: null, callCount: 3 }];
    mount();
    expect(await screen.findByText('Error de sincronización')).toBeTruthy();
    expect(screen.getByText(/RATE_LIMIT: Meta pidió esperar/)).toBeTruthy();
  });

  it('vuelta de Meta con autorización cancelada: limpia la URL y refresca', async () => {
    mount('/dev/meta-ads?r=cancelado');
    await screen.findByText('No conectado');
    expect(get.mock.calls.filter(([p]) => p.startsWith('/dev/meta-ads/status')).length).toBeGreaterThanOrEqual(1);
  });

  it('nunca muestra tokens: el estado no los trae y la pantalla tampoco', async () => {
    status.connection = { status: 'CONNECTED', scopes: ['ads_read'] };
    const { container } = mount();
    await screen.findByText('Conectado');
    expect(container.textContent).not.toMatch(/EAA[A-Za-z0-9]{10,}|access_token|app_secret/i);
  });
});

describe('Respuestas de Meta · consulta en vivo', () => {
  const call = (over: Record<string, unknown> = {}) => ({ at: '2026-10-30T19:20:00Z', method: 'GET', request: 'GET /v25.0/act_1000000000000002/insights?level=campaign', status: 200, ms: 786, attempt: 1, rows: 0, ...over });
  const okReply = (path: string) => {
    const days = Number(new URLSearchParams(path.split('?')[1]).get('days'));
    return { ok: true, kind: 'insights', live: true, saved: false, maxRows: 25, range: { days, since: days === 60 ? '2026-09-01' : '2026-10-01', until: '2026-10-30' }, calls: [call()], body: { data: [] } };
  };

  async function openRaw() {
    status.connection = { status: 'CONNECTED', selectedAccountId: 'act_1000000000000002', scopes: ['ads_read'] };
    mount();
    await screen.findByText('Conectado');
    fireEvent.click(screen.getByRole('tab', { name: 'Respuestas de Meta' }));
    const panel = screen.getByText('Consulta en vivo · No se guarda · Máx. 25 filas').closest('div')!;
    return panel as HTMLElement;
  }

  it('se identifica como consulta en vivo, distinta del historial', async () => {
    rawReply = okReply;
    const panel = await openRaw();
    expect(panel.className).toContain('border-dashed');
    expect(within(panel).getByText(/No forma parte del historial de sincronizaciones/)).toBeTruthy();
  });

  it('por defecto usa los días de la configuración (30) y muestra el rango enviado', async () => {
    rawReply = okReply;
    const panel = await openRaw();
    fireEvent.click(within(panel).getByRole('button', { name: 'Insights' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/dev/meta-ads/raw?kind=insights&days=30'));
    expect((await screen.findByTestId('raw-range')).textContent).toBe('Rango enviado a Meta: 2026-10-01 → 2026-10-30 · 30 días seleccionados');
  });

  it('con 60 días elegidos manda days=60 y muestra 2026-09-01 → 2026-10-30', async () => {
    rawReply = okReply;
    const panel = await openRaw();
    fireEvent.click(within(panel).getByRole('button', { name: '60 días' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Insights' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/dev/meta-ads/raw?kind=insights&days=60'));
    expect((await screen.findByTestId('raw-range')).textContent).toContain('2026-09-01 → 2026-10-30 · 60 días');
  });

  it('data: [] → «0 filas», duración con unidad y «—» cuando no hay error', async () => {
    rawReply = okReply;
    const panel = await openRaw();
    fireEvent.click(within(panel).getByRole('button', { name: 'Insights' }));
    await screen.findByTestId('raw-range');
    const cell = (col: string) => panel.querySelector(`[data-col="${col}"]`)!.textContent;
    expect(screen.getByRole('columnheader', { name: 'Duración' })).toBeTruthy();
    expect(cell('http')).toBe('200');
    expect(cell('duracion')).toBe('786 ms');
    expect(cell('filas')).toBe('0 filas');
    expect(cell('error')).toBe('—');
  });

  it('error de Meta: HTTP y error en sus columnas, filas «—»', async () => {
    rawReply = () => ({ ok: false, kind: 'insights', live: true, saved: false, maxRows: 25, range: { days: 30, since: '2026-10-01', until: '2026-10-30' },
      calls: [call({ status: 400, ms: 312, rows: undefined, errorKind: 'PROVIDER', errorCode: 100, error: 'Meta: Invalid parameter' })], error: { message: 'Meta: Invalid parameter' } });
    const panel = await openRaw();
    fireEvent.click(within(panel).getByRole('button', { name: 'Insights' }));
    await screen.findByTestId('raw-range');
    const cell = (col: string) => panel.querySelector(`[data-col="${col}"]`)!.textContent;
    expect(cell('http')).toBe('400');
    expect(cell('duracion')).toBe('312 ms');
    expect(cell('filas')).toBe('—');
    expect(cell('error')).toBe('PROVIDER 100 · Meta: Invalid parameter');
  });

  it('una fila se escribe en singular', async () => {
    rawReply = (p) => ({ ...(okReply(p) as object), calls: [call({ rows: 1 })] });
    const panel = await openRaw();
    fireEvent.click(within(panel).getByRole('button', { name: 'Insights' }));
    await screen.findByTestId('raw-range');
    expect(panel.querySelector('[data-col="filas"]')!.textContent).toBe('1 fila');
  });
});
