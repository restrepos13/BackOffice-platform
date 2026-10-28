import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const zero = { spend: 0, impressions: 0, clicks: 0, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0, ctr: null, cpc: null, cpm: null, platformRoas: null, days: 7 };
const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc1', provider: 'META', mode: 'REAL', externalId: 'act_90011', name: 'Cuenta Aurora', currency: 'COP', status: 'CONNECTED', lastSyncAt: '2026-10-27T10:00:00Z',
  lastError: null, dataAgeHours: 2, stale: false, hasToken: true, lastSyncStatus: 'OK', credential: 'Guardada cifrada · no se muestra', scopes: ['manual'], ...over,
});
let overview: any;
let actions: any[] = [];
let revenue: any;
let leads: any[] = [];
let syncs: any[] = [];
let partnerBusinessId: string | null = null;

const get = vi.fn(async (path: string): Promise<unknown> => {
  if (path.startsWith('/ads/overview')) return overview;
  if (path.startsWith('/ads/accounts/acc1/syncs')) return syncs;
  if (path.startsWith('/ads/accounts')) return overview.accounts;
  if (path.startsWith('/ads/providers')) return [{ key: 'META', label: 'Meta Ads', capabilities: {}, missing: [], oauth: false, partnerBusinessId }, { key: 'GOOGLE', label: 'Google Ads', capabilities: {}, missing: ['Developer token'], oauth: false }];
  if (path.startsWith('/ads/settings')) return { autonomy: 'RECOMMEND', globalPause: false, autoActions: [], maxDailyBudget: null, maxDataAgeHours: 6 };
  if (path.startsWith('/ads/rules')) return { rules: [], metrics: { SPEND: { label: 'Gasto', unit: 'money' } } };
  if (path.startsWith('/ads/actions')) return actions;
  if (path.startsWith('/ads/revenue')) return revenue;
  if (path.startsWith('/ads/leads')) return leads;
  if (path.startsWith('/terms/status')) return { required: false };
  return [];
});
const post = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}));
vi.mock('../../../lib/api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), put: vi.fn(), delete: vi.fn() } }));
vi.mock('../shared', () => ({
  useCompanyScope: () => ({ ready: true, q: '', canWrite: true, companyId: null, isPlatform: false }),
  withScope: (p: string) => p,
  PickCompany: () => null,
}));
// Usuario de la empresa; por defecto ya vio el recorrido de Ads
let authUser: any;
const markTourSeen = vi.fn();
vi.mock('../../../lib/auth', () => ({ useAuth: () => ({ user: authUser, markTourSeen }) }));
vi.mock('../../../components/opportunities/Opportunities', () => ({ OpportunityList: () => <p>Radar</p> }));
vi.mock('../../../components/charts', () => ({ AdsSpendChart: (p: any) => <p data-testid="chart">{p.showResults ? 'con resultados' : 'solo gasto'}</p> }));

import AdsHome from './AdsHome';

function mount(tab: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/ads?tab=${tab}`]}><AdsHome /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  overview = {
    mode: 'REAL', modes: { real: 1, demo: 0 }, days: 30, period: { current: { since: '2026-09-28', until: '2026-10-27' }, previous: { since: '2026-08-29', until: '2026-09-27' } },
    currency: 'COP', mixedCurrencies: false, accounts: [account()], comparable: true, insufficient: false,
    totals: { ...zero, spend: 900000, results: null, costPerResult: null, reach: null, frequency: null }, previous: zero,
    deltas: { spend: 10, results: null, costPerResult: null, ctr: null, cpc: null, cpm: null },
    notes: ['El periodo mezcla campañas con objetivos distintos (clics en el enlace, conversaciones iniciadas): no hay un costo por resultado único. Míralo por campaña.'],
    resultLabel: null, daily: [],
    campaigns: [{ ...zero, id: 'c1', externalId: '11100', name: 'Chats', status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', dailyBudget: 30000, spend: 600000, results: 120, costPerResult: 5000, resultLabel: 'conversaciones iniciadas', reach: null, frequency: null }],
    configuredDailyBudget: 30000, openFindings: 0, pendingActions: 0, executedActions: 0,
  };
  authUser = { id: 'u1', role: 'COMPANY_ADMIN', toursJson: JSON.stringify({ ads: '2026-10-01T00:00:00Z' }) };
  markTourSeen.mockClear();
  partnerBusinessId = null;
  actions = [];
  leads = [];
  syncs = [];
  post.mockClear();
});
afterEach(cleanup);

describe('Ads · resultados', () => {
  it('con objetivos mezclados no muestra un costo único, explica por qué y la gráfica es solo de gasto', async () => {
    mount('resumen');
    const notes = await screen.findByTestId('metric-notes');
    expect(within(notes).getByText(/objetivos distintos/)).toBeTruthy();
    expect(screen.getByText('Objetivos distintos: míralos por campaña')).toBeTruthy();
    expect(screen.getByTestId('chart').textContent).toBe('solo gasto');
    // Sin alcance reportado no aparecen tarjetas ni columna de alcance
    expect(screen.queryByText('Alcance (personas)')).toBeNull();
    expect(screen.queryByText('Alcance · frec.')).toBeNull();
    expect(screen.getByText('conversaciones iniciadas')).toBeTruthy();
  });

  it('el alcance y la frecuencia aparecen solo cuando la plataforma los reportó', async () => {
    overview.totals = { ...overview.totals, results: 120, costPerResult: 5000, reach: 4000, frequency: 2.5 };
    overview.resultLabel = 'conversaciones iniciadas';
    overview.notes = [];
    overview.campaigns[0] = { ...overview.campaigns[0], reach: 4000, frequency: 2.5 };
    mount('resumen');
    expect(await screen.findByText('Alcance (personas)')).toBeTruthy();
    expect(screen.getByText('2,5 veces')).toBeTruthy();
    expect(screen.getByText('Alcance · frec.')).toBeTruthy();
    expect(screen.getByTestId('chart').textContent).toBe('con resultados');
  });
});

describe('Ads · cuentas', () => {
  it('muestra la sincronización incompleta, el siguiente intento, la credencial enmascarada y el historial', async () => {
    overview.accounts = [account({ lastSyncStatus: 'PARTIAL', lastErrorKind: 'RATE_LIMIT', errorHelp: 'La plataforma pidió esperar (límite o falla temporal). Se reintenta sola.', lastError: 'User request limit reached', nextSyncAt: '2026-10-27T16:00:00Z' })];
    syncs = [{ id: 'r1', trigger: 'CRON', status: 'PARTIAL', startedAt: '2026-10-27T15:00:00Z', finishedAt: null, error: 'User request limit reached', help: 'Se reintenta sola.', counts: { since: '2026-10-20', until: '2026-10-27', chunks: 2, chunksOk: 1, entities: 0, insights: 14 } }];
    mount('cuentas');
    expect(await screen.findByText('Última sincronización incompleta')).toBeTruthy();
    expect(screen.getByText(/próximo intento/)).toBeTruthy();
    expect(screen.getByText(/Se reintenta sola\. \(User request limit reached\)/)).toBeTruthy();
    expect(screen.getByText(/Credencial: Guardada cifrada · no se muestra/)).toBeTruthy();
    fireEvent.click(screen.getByText('Historial de sincronizaciones'));
    const h = await screen.findByTestId('sync-history');
    expect(within(h).getByText('Incompleta')).toBeTruthy();
    expect(within(h).getByText(/1\/2 tramos/)).toBeTruthy();
    // Google sin integración real: pendiente, nunca "disponible"
    expect(screen.getByText('Pendiente de habilitar')).toBeTruthy();
  });
});

describe('Ads · acciones', () => {
  it('distingue sugerencia, aprobación, resultado y ofrece reintentar lo que falló', async () => {
    actions = [
      { id: 'p1', source: 'RULE', action: 'RECOMMEND_PAUSE', status: 'APPROVED', kind: 'SUGGESTION', entityName: 'Ad web', actor: 'Autopilot', approvedBy: 'Rosa', approvedAt: '2026-10-27T15:00:00Z', createdAt: '2026-10-27T14:00:00Z', error: null, reversible: false, data: { rule: 'Gasto alto' }, mode: 'REAL', execution: { id: 'x1', status: 'FAILED', error: 'La conexión con la plataforma venció', decidedAt: null } },
      { id: 'x1', source: 'RULE', action: 'PAUSE', status: 'FAILED', kind: 'EXECUTION', entityName: 'Ad web', actor: 'Rosa', approvedBy: null, createdAt: '2026-10-27T15:00:00Z', error: 'La conexión con la plataforma venció', reversible: true, data: {}, mode: 'REAL', retryable: true },
      { id: 'a1', source: 'RULE', action: 'ALERT', status: 'EXECUTED', kind: 'INFO', entityName: 'Chats', actor: 'Autopilot', createdAt: '2026-10-27T13:00:00Z', error: null, reversible: false, data: {}, mode: 'REAL' },
    ];
    post.mockResolvedValueOnce({ status: 'EXECUTED' });
    mount('autopilot');
    const sug = await screen.findByTestId('action-p1');
    expect(within(sug).getByText('Aprobada')).toBeTruthy();
    expect(within(sug).getByText(/Aprobada por Rosa/)).toBeTruthy();
    expect(within(sug).getByText(/Resultado: Falló · La conexión con la plataforma venció/)).toBeTruthy();
    expect(within(screen.getByTestId('action-a1')).getByText('Informativa')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('action-x1')).getByText('Reintentar'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/ads/actions/x1/retry', { confirm: false }));
  });
});

describe('Ads · leads y ventas', () => {
  it('muestra los estados de atribución con su evidencia y los formularios que esperan permiso', async () => {
    revenue = {
      period: { since: '2026-09-28', until: '2026-10-27' }, connected: true, currency: 'COP', campaigns: [],
      totals: { spend: 0, leads: 0, qualified: 0, customers: 0, sales: 0, revenue: 0, costPerLead: null, costPerQualified: null, cac: null, roas: null },
      unattributedAds: 0, businessRevenue: 0, method: 'Atribución directa por identificadores',
      attribution: {
        counts: { ATTRIBUTED: 1, PARTIAL: 1, UNATTRIBUTED: 0 },
        rules: { ATTRIBUTED: 'Trae el ID…', PARTIAL: 'Hay evidencia…', UNATTRIBUTED: 'Sin identificador…' },
        recent: [
          { contactId: 'k1', name: 'Ana', createdAt: '2026-10-20T12:00:00Z', state: 'ATTRIBUTED', via: 'WHATSAPP_REFERRAL', adId: '42200', adName: 'Ad chat', adsetName: 'S2', campaignName: 'Chats', evidence: 'ID del anuncio 42200 en el primer mensaje' },
          { contactId: 'k2', name: 'Beto', createdAt: '2026-10-20T12:00:00Z', state: 'PARTIAL', via: 'LEAD_FORM', adId: '77777', adName: null, adsetName: null, campaignName: null, evidence: 'ese anuncio no está en las cuentas conectadas' },
        ],
      },
      leadForms: { received: 1, withContact: 0, pendingPermission: 1, errors: 0 },
    };
    leads = [{ id: 'l1', status: 'PENDING_PERMISSION', error: 'Falta el permiso leads_retrieval', leadgenId: '880001', formId: '1', adId: '42200', adName: 'Ad chat', contactId: null, fieldNames: [], receivedAt: '2026-10-27T15:00:00Z' }];
    post.mockResolvedValueOnce({ status: 'PENDING_PERMISSION', error: 'Sigue faltando el permiso' });
    mount('leads');
    const table = await screen.findByTestId('attribution-table');
    expect(within(table).getByText('Atribuido')).toBeTruthy();
    expect(within(table).getByText('Chats · S2 · Ad chat')).toBeTruthy();
    expect(within(table).getByText('Parcial')).toBeTruthy();
    expect(within(table).getByText('Desconocido')).toBeTruthy();
    expect(await screen.findByText('Falta permiso')).toBeTruthy();
    fireEvent.click(screen.getByText('Pedir datos otra vez'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/ads/leads/l1/fetch', undefined));
  });
});

describe('Ads · recorrido guiado', () => {
  it('la primera vez explica Ads paso a paso y al terminar queda marcado como visto', async () => {
    authUser = { id: 'u1', role: 'COMPANY_ADMIN', toursJson: null };
    mount('resumen');
    const dialog = await screen.findByRole('dialog', { name: 'Recorrido de Ads Intelligence' });
    expect(within(dialog).getByText('Así funciona Ads Intelligence')).toBeTruthy();
    expect(within(dialog).getByText(/nada cambia en tu cuenta de Meta sin que tú lo apruebes/)).toBeTruthy();
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      seen.push(within(screen.getByRole('dialog', { name: 'Recorrido de Ads Intelligence' })).getByRole('heading').textContent ?? '');
      fireEvent.click(screen.getByText('Siguiente →'));
    }
    expect(seen).toEqual(expect.arrayContaining(['4. Crear anuncios', '5. Programación semanal', '7. Tú decides']));
    expect(screen.getByText('Listo')).toBeTruthy();
    fireEvent.click(screen.getByText('Empezar ✓'));
    expect(markTourSeen).toHaveBeenCalledWith('ads');
    expect(screen.queryByRole('dialog', { name: 'Recorrido de Ads Intelligence' })).toBeNull();
  });

  it('si ya lo vio no aparece solo, pero «¿Cómo funciona?» lo vuelve a mostrar sin marcar nada', async () => {
    mount('resumen');
    await screen.findByTestId('metric-notes');
    expect(screen.queryByRole('dialog', { name: 'Recorrido de Ads Intelligence' })).toBeNull();
    fireEvent.click(screen.getByText('¿Cómo funciona?'));
    expect(await screen.findByRole('dialog', { name: 'Recorrido de Ads Intelligence' })).toBeTruthy();
    fireEvent.click(screen.getByText('Saltar recorrido'));
    expect(screen.queryByRole('dialog', { name: 'Recorrido de Ads Intelligence' })).toBeNull();
    expect(markTourSeen).not.toHaveBeenCalled();
  });
});

describe('Ads · conexión con Meta', () => {
  it('guía para conectar con permisos completos y muestra qué puede hacer cada cuenta', async () => {
    overview.accounts = [
      account({ access: { verified: true, read: true, manage: true, missing: [], tasks: ['MANAGE'], accountRoleLimited: false } }),
      account({ id: 'acc2', name: 'Cuenta B', access: { verified: true, read: true, manage: false, missing: ['ads_management', 'business_management'], tasks: [], accountRoleLimited: false } }),
    ];
    mount('cuentas');
    expect(await screen.findByText('Permisos completos')).toBeTruthy();
    expect(screen.getByText('Solo lectura')).toBeTruthy();
    expect(screen.getByText(/Faltan: ads_management, business_management/)).toBeTruthy();
    const guide = screen.getByTestId('guide-token');
    for (const scope of ['ads_management', 'ads_read', 'business_management']) expect(within(guide).getByText(scope)).toBeTruthy();
    expect(screen.getByText(/nunca te pide la contraseña de Facebook/)).toBeTruthy();
  });

  it('con el ID de BackOffice configurado, recomienda dar acceso de socio sin compartir credenciales', async () => {
    partnerBusinessId = '1234567890';
    mount('cuentas');
    const guide = await screen.findByTestId('guide-partner');
    expect(within(guide).getByText('1234567890')).toBeTruthy();
    expect(within(guide).getByText(/No compartes contraseñas ni tokens/)).toBeTruthy();
    fireEvent.click(screen.getByText('Conectar con un token de tu negocio'));
    expect(screen.getByTestId('guide-token')).toBeTruthy();
  });
});
