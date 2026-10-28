import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdsSetup, LaunchRow } from './PublicidadLanzar';

const get = vi.fn(async (_path: string): Promise<unknown> => launches);
const post = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}));
const put = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}));
const upload = vi.fn(async (): Promise<unknown> => ({ hash: 'h1' }));
vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly field?: string, readonly code?: string, readonly errors?: string[]) { super(message); }
  }
  return {
    ApiError,
    uploadFile: () => upload(),
    api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), put: (p: string, b?: unknown) => put(p, b), delete: vi.fn(async () => ({})) },
  };
});

import { LaunchList, LaunchWizard } from './PublicidadLanzar';
import { ApiError } from '../../lib/api';

const SETUP: AdsSetup = {
  connected: true,
  account: { id: 'act_1', name: 'BackOffice Ads', currency: 'COP', timezone: 'America/Bogota', status: 1 },
  prefs: { pageId: '555', pageName: 'BackOffice', maxDailyBudget: 100000 },
  pages: [],
  pagesError: null,
  landingBase: 'https://app.backoffice.co',
};
const row = (over: Partial<LaunchRow> = {}): LaunchRow => ({
  id: 'l1', createdAt: '2026-10-27T15:00:00.000Z', createdBy: 'Santi', status: 'PAUSED', processing: false, goalLabel: 'Registros en la web',
  accountId: 'act_1', currency: 'COP', utmCampaign: 'crm-nov', link: 'https://app.backoffice.co/registro?utm_campaign=crm-nov',
  ids: { campaign: '1', adset: '2', creative: '3', ad: '4' }, error: null,
  draft: { name: 'CRM Nov', goal: 'SIGNUPS', dailyBudget: 50000, countries: ['CO'], headline: 'Prueba' }, history: [], ...over,
});
let launches: LaunchRow[] = [];

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => { launches = []; get.mockClear(); post.mockClear(); put.mockClear(); });
afterEach(cleanup);

describe('Lanzar campaña', () => {
  it('muestra uno por uno los errores del servidor y no deja crear sin una revisión válida', async () => {
    post.mockRejectedValueOnce(new ApiError('Revisa', 400, undefined, undefined, ['Sube la imagen del anuncio', 'El presupuesto diario supera el tope']));
    mount(<LaunchWizard setup={SETUP} onCreated={() => undefined} />);
    expect((screen.getByText('Crear en Meta (en pausa)') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Revisar'));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Sube la imagen del anuncio')).toBeTruthy();
    expect(within(alert).getByText('El presupuesto diario supera el tope')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/platform/ads/launches/preview', expect.anything());
  });

  it('WhatsApp usa su propio botón; Advantage+ oculta edad máxima y género', () => {
    mount(<LaunchWizard setup={SETUP} onCreated={() => undefined} />);
    expect(screen.queryByLabelText('Edad máxima')).toBeNull();
    fireEvent.click(screen.getByLabelText('Público Advantage+ (Meta lo amplía)'));
    expect(screen.getByText('Edad máxima')).toBeTruthy();
    expect(screen.getByText('Género')).toBeTruthy();
    fireEvent.click(screen.getByText('Conversaciones por WhatsApp'));
    expect(screen.getByDisplayValue('Enviar mensaje de WhatsApp')).toBeTruthy();
    expect(within(screen.getByTestId('ad-preview')).getByText('Enviar mensaje')).toBeTruthy();
  });

  it('después de revisar, crea solo tras confirmar y envía confirm=true', async () => {
    post.mockImplementation(async (path: string) => path.endsWith('/preview')
      ? { valid: true, errors: [], account: { id: 'act_1', name: 'BackOffice Ads', currency: 'COP' }, summary: { goal: 'Registros en la web', utmCampaign: 'crm', link: 'https://app.backoffice.co/registro?utm_campaign=crm', dailyBudget: 30000, maxDailyBudget: 100000, pageId: '555', status: 'PAUSED' } }
      : row());
    const onCreated = vi.fn();
    mount(<LaunchWizard setup={SETUP} onCreated={onCreated} />);
    fireEvent.change(screen.getByPlaceholderText('CRM WhatsApp · Noviembre'), { target: { value: 'CRM' } });
    fireEvent.change(screen.getByPlaceholderText('30.000'), { target: { value: '30.000' } });
    fireEvent.click(screen.getByText('Revisar'));
    expect(await screen.findByText('Esto se creará en Meta')).toBeTruthy();
    expect(screen.getByText(/no gasta nada hasta que lo actives/)).toBeTruthy();
    fireEvent.click(screen.getByText('Crear en Meta (en pausa)'));
    expect(post).not.toHaveBeenCalledWith('/platform/ads/launches', expect.anything());
    fireEvent.click(await screen.findByText('Sí, crear en pausa'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = post.mock.calls.find((c) => c[0] === '/platform/ads/launches')![1] as any;
    expect(body.confirm).toBe(true);
    expect(body.draft).toMatchObject({ name: 'CRM', dailyBudget: '30.000', countries: ['CO'] });
    post.mockReset();
  });
});

describe('Lanzamientos', () => {
  it('activar pide confirmación con el gasto diario y envía confirm=true', async () => {
    launches = [row()];
    post.mockResolvedValueOnce(row({ status: 'ACTIVE' }));
    mount(<LaunchList setup={SETUP} />);
    fireEvent.click(await screen.findByText('Activar'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/al día/).textContent).toMatch(/50\.000/);
    fireEvent.click(within(dialog).getByText('Sí, activar'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/platform/ads/launches/l1/activate', { confirm: true }));
  });

  it('uno fallido ofrece reintentar y dice cuántos pasos quedaron; uno activo se pausa pero no se archiva', async () => {
    launches = [
      row({ id: 'f1', status: 'FAILED', ids: { campaign: '1' }, error: 'Meta: Invalid parameter' }),
      row({ id: 'a1', status: 'ACTIVE', draft: { ...row().draft, name: 'Activa' } }),
    ];
    mount(<LaunchList setup={SETUP} />);
    expect(await screen.findByText('Reintentar')).toBeTruthy();
    expect(screen.getByText(/Creado: 1 de 4 pasos/)).toBeTruthy();
    expect(screen.getByText('Meta: Invalid parameter')).toBeTruthy();
    const active = screen.getByText('Activa', { selector: 'p' }).closest('div.border-2') as HTMLElement;
    expect(within(active).getByText('Pausar')).toBeTruthy();
    expect(within(active).queryByText('Archivar')).toBeNull();
  });
});
