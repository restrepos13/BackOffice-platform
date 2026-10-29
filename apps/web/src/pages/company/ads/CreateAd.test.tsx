import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const full = { verified: true, read: true, manage: true, missing: [], tasks: ['MANAGE'], accountRoleLimited: false };
let setup: any;
let launches: any[];
let week: any;
const get = vi.fn(async (path: string): Promise<unknown> => {
  if (path.startsWith('/ads/create/setup')) return setup;
  if (path.startsWith('/ads/create/launches')) return launches;
  if (path.startsWith('/ads/create/week')) return week;
  if (path.startsWith('/library/assets/a1')) return { id: 'a1', name: 'Tacos fin de semana · v2', width: 1080, height: 1080, available: true, designId: 'd1', kind: 'IMAGE' };
  return {};
});
const post = vi.fn(async (path: string, _b?: unknown): Promise<unknown> => {
  if (path.startsWith('/ads/create/review')) return review;
  if (path.startsWith('/ads/create/preview')) return { valid: true, errors: [], summary: { goal: 'Mensajes por WhatsApp', dailyBudget: 40000, startDate: '2026-10-30', endDate: '2026-11-06', link: null }, hints: setup.hints.WHATSAPP };
  if (path.startsWith('/ads/create/launches')) return { id: 'l1', status: 'PAUSED', draft: { name: 'Martes 2x1', dailyBudget: 40000 }, ids: {}, error: null };
  return {};
});
const upload = vi.fn(async () => ({ asset: { id: 'asset1', name: 'hamburguesa', width: 1080, height: 1350 } }));
vi.mock('../../../lib/api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), put: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) }, uploadFile: () => upload() }));
vi.mock('../../../lib/creative', () => ({ authedBlobUrl: async () => 'blob:x' }));
vi.mock('../shared', () => ({ useCompanyScope: () => ({ ready: true, q: '', canWrite: true }), withScope: (p: string) => p }));

let review: any;
import { CreateAd } from './CreateAd';
import { Week } from './Week';

const mount = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);

beforeEach(() => {
  setup = {
    accounts: [{ id: 'acc1', name: 'Aurora', externalId: 'act_1', currency: 'COP', access: full }],
    account: { id: 'acc1', name: 'Aurora', externalId: 'act_1', currency: 'COP', timezone: 'America/Bogota', access: full },
    pages: [{ id: '555', name: 'Aurora Página', instagramUserId: '178' }], pagesError: null,
    goals: [{ key: 'WHATSAPP', label: 'Mensajes por WhatsApp', resultLabel: 'conversaciones' }, { key: 'WEBSITE', label: 'Visitas a tu web (reservas o pedidos)', resultLabel: 'clics al enlace' }],
    ctas: [{ key: 'ORDER_NOW', label: 'Pedir ahora' }], maxDailyBudget: 50000, today: '2026-10-28',
    ai: { available: false, provider: 'DeepInfra', model: 'm', note: 'Tu empresa no tiene configurado un proveedor de IA. La revisión se hará solo con reglas.' },
    hints: { WHATSAPP: { costPerResult: 5000, expected: null, bestDays: ['viernes', 'sábado'], basis: 'Calculado con tus últimos 30 días.' }, WEBSITE: { costPerResult: null, expected: null, bestDays: [], basis: 'Sin historial.' } },
  };
  launches = [];
  review = {
    code: { score: 86, facts: { width: 1080, height: 1350 }, items: [{ key: 'proporcion', level: 'OK', area: 'IMAGEN', title: 'Proporción vertical 4:5', detail: 'Ocupa buen espacio.' }, { key: 'texto', level: 'WARN', area: 'TEXTO', title: 'Texto largo', detail: 'Se corta.', fix: 'Acórtalo.' }] },
    ai: { status: 'NO_KEY', message: 'Sin proveedor de IA configurado: esta revisión es solo por reglas.' },
  };
  post.mockClear();
});
afterEach(cleanup);

describe('Ads · crear anuncio', () => {
  it('guía paso a paso, recomienda con el historial y crea en pausa con confirmación', async () => {
    mount(<CreateAd q="" />);
    fireEvent.change(await screen.findByPlaceholderText(/2x1 martes/), { target: { value: 'Martes 2x1' } });
    fireEvent.click(screen.getByText('Siguiente →'));
    expect(screen.getByText(/vinculada a tu número de WhatsApp Business/)).toBeTruthy();
    fireEvent.click(screen.getByText('Siguiente →'));
    fireEvent.change(screen.getByPlaceholderText('Ej.: 40.000'), { target: { value: '40.000' } });
    expect(within(screen.getByTestId('budget-hint')).getByText(/esperarías entre 5 y 11 conversaciones diarios/)).toBeTruthy();
    fireEvent.click(screen.getByText('Siguiente →'));
    expect(screen.getByText(/rinden mejor los/)).toBeTruthy();
    fireEvent.click(screen.getByText('Siguiente →'));
    // Sin IA lo dice claro y ofrece configurarla
    expect(screen.getByText('Solo reglas')).toBeTruthy();
    expect(screen.getByText('Configurar mi proveedor de IA')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Subir imagen publicitaria'), { target: { files: [new File(['x'], 'hamburguesa.jpg', { type: 'image/jpeg' })] } });
    await screen.findByAltText('Vista previa de hamburguesa');
    fireEvent.click(screen.getByText('Revisar anuncio'));
    const panel = await screen.findByTestId('review');
    expect(within(panel).getByText('Revisión por reglas: 86/100')).toBeTruthy();
    expect(within(panel).getByText(/no entienden la imagen ni la oferta como una IA/)).toBeTruthy();
    fireEvent.click(screen.getByText('Siguiente →'));
    fireEvent.click(screen.getByText('Verificar todo'));
    await screen.findByTestId('ready');
    fireEvent.click(screen.getByText('Crear en Meta (en pausa)'));
    expect(screen.getByText(/Todo queda en pausa/)).toBeTruthy();
    fireEvent.click(screen.getByText('Sí, crear en pausa'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/ads/create/launches', expect.objectContaining({ confirm: true, assetId: 'asset1', pageId: '555', instagramUserId: '178', accountId: 'acc1' })));
  });

  it('con IA muestra sus recomendaciones y permite usar el texto sugerido', async () => {
    setup.ai = { available: true, provider: 'DeepInfra', model: 'm', note: 'La revisión con IA usa la llave de IA de tu empresa: lo cobra tu proveedor directamente.' };
    review.ai = { status: 'OK', model: 'meta-llama/Vision', review: { summary: 'Apetitosa y clara.', score: 8, strengths: ['Oferta concreta'], improvements: [{ area: 'texto', problem: 'Muy largo', suggestion: 'Acórtalo', priority: 'MEDIA' }], suggestedCopy: { primaryText: '2x1 los martes. ¡Reserva!', headline: 'Martes 2x1' }, policyRisk: { level: 'BAJO', reason: null }, seen: 'Una hamburguesa doble' } };
    mount(<CreateAd q="" />);
    for (let i = 0; i < 4; i++) fireEvent.click(await screen.findByText('Siguiente →'));
    expect(screen.getByText('Con IA')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Subir imagen publicitaria'), { target: { files: [new File(['x'], 'h.jpg', { type: 'image/jpeg' })] } });
    await screen.findByAltText(/Vista previa/);
    fireEvent.click(screen.getByText('Revisar anuncio'));
    const panel = await screen.findByTestId('review');
    expect(within(panel).getByText(/Una hamburguesa doble/)).toBeTruthy();
    expect(within(panel).getByText(/Recomendaciones de la IA \(tu proveedor\)/)).toBeTruthy();
    fireEvent.click(within(panel).getAllByText('Usar')[0]);
    expect((screen.getByPlaceholderText(/2x1 en hamburguesas/) as HTMLTextAreaElement).value).toBe('2x1 los martes. ¡Reserva!');
  });

  it('sin permiso de gestión lo advierte y no deja crear', async () => {
    setup.account.access = { ...full, manage: false, missing: ['ads_management'] };
    mount(<CreateAd q="" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no tiene permiso para crear anuncios/);
  });

  it('lista los anuncios creados y activar pide confirmación con el gasto diario', async () => {
    launches = [{ id: 'l1', status: 'PAUSED', goalLabel: 'Mensajes por WhatsApp', draft: { name: 'Martes 2x1', dailyBudget: 40000, endDate: '2026-11-06' }, ids: { ad: '1' }, error: null, link: null, createdBy: 'A', createdAt: '', reviewScore: 86, reviewedWithAi: false, processing: false }];
    mount(<CreateAd q="" />);
    const list = await screen.findByTestId('launches');
    expect(within(list).getByText(/revisión 86\/100/)).toBeTruthy();
    fireEvent.click(within(list).getByText('Activar'));
    expect(screen.getByText(/empezará a gastar hasta/)).toBeTruthy();
    fireEvent.click(screen.getByText('Sí, activar'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/ads/create/launches/l1/activate', { confirm: true }));
  });
});

describe('Ads · programación semanal', () => {
  it('pinta cada anuncio en los días que corre, activo o en pausa', async () => {
    week = {
      today: '2026-10-28', start: '2026-10-26', previous: '2026-10-19', next: '2026-11-02', note: 'Fechas en la zona de tu cuenta.',
      days: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
      items: [
        { key: 'a', name: 'Almuerzos', campaign: 'Almuerzos', status: 'ACTIVE', start: '2026-10-20', end: '2026-10-29', dailyBudget: 30000, source: 'META' },
        { key: 'b', name: 'Martes 2x1', campaign: 'Martes 2x1', status: 'PAUSED', start: '2026-10-31', end: null, dailyBudget: 40000, source: 'BACKOFFICE' },
      ],
    };
    mount(<Week q="" />);
    const table = await screen.findByTestId('week');
    const rows = within(table).getAllByRole('row').slice(1);
    const filled = (row: HTMLElement) => within(row).getAllByRole('cell').slice(1).map((c) => (c.querySelector('div') ? 1 : 0));
    expect(filled(rows[0])).toEqual([1, 1, 1, 1, 0, 0, 0]);
    expect(filled(rows[1])).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(within(rows[1]).getByText(/Creado en BackOffice · en pausa/)).toBeTruthy();
  });
});

describe('Ads · imagen que llega desde Creative', () => {
  it('precarga la imagen del diseño y envía el diseño de origen al crear (Ads valida y crea en pausa)', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/app/ads?tab=nueva&asset=a1&design=d1']}><CreateAd q="" /></MemoryRouter></QueryClientProvider>);
    expect((await screen.findByTestId('from-creative')).textContent).toMatch(/Tacos fin de semana · v2/);
    fireEvent.change(screen.getByPlaceholderText(/2x1 martes/), { target: { value: 'Tacos finde' } });
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Siguiente →'));
    fireEvent.click(screen.getByText('Verificar todo'));
    await screen.findByTestId('ready');
    fireEvent.click(screen.getByText('Crear en Meta (en pausa)'));
    fireEvent.click(screen.getByText('Sí, crear en pausa'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/ads/create/launches', expect.objectContaining({ assetId: 'a1', designId: 'd1', confirm: true })));
  });
});
