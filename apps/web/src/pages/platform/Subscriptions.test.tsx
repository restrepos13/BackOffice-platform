import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mine: any;
let list: any;
let detail: any;
const get = vi.fn(async (path: string): Promise<unknown> => {
  if (path === '/subscriptions/me') return mine;
  if (path.startsWith('/subscriptions/coA/economics')) return {
    period: '2026-10', revenue: { measured: { COP: 150000 }, invoicesPaid: 1, invoicesPending: 0, aiPackagesSold: 0 },
    costs: { aiProviderUsd: { value: 0.5, kind: 'MEASURED' }, messagingUsd: { value: 0.01, kind: 'ESTIMATED' }, infrastructure: { value: null, kind: 'UNKNOWN', note: 'No se mide por empresa' }, promotionalCredits: { conversations: 0 } },
    margin: { valueCop: null, kind: 'UNKNOWN', note: 'Sin TRM' },
  };
  if (path.startsWith('/subscriptions/coA')) return detail;
  if (path.startsWith('/subscriptions')) return list;
  return {};
});
const post = vi.fn(async (_p: string, _b?: unknown): Promise<unknown> => ({}));
const put = vi.fn(async (_p: string, _b?: unknown): Promise<unknown> => ({}));
vi.mock('../../lib/api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), put: (p: string, b?: unknown) => put(p, b) } }));

import Subscriptions from './Subscriptions';
import { SubscriptionCard } from '../company/plan/SubscriptionCard';

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

const usage = { users: { used: 2, max: 3 }, bots: { used: 1, max: 1 }, whatsappLines: { used: 1, max: null }, ai: { mode: 'PLATFORM', period: '2026-10', includedMonthly: 100, includedUsed: 12, prepaidBalance: 0 } };

beforeEach(() => {
  mine = {
    companyId: 'coA', name: 'Aurora', status: 'ACTIVE', statusLabel: 'Activa', access: 'FULL', legacy: false,
    plan: { id: 'p', name: 'Básico', description: null, currency: 'COP', features: ['Bandeja'], includedProducts: null, maxUsers: 3, maxBots: 1, maxLines: 1, includedAiConversations: 100 },
    price: { monthly: 150000, currency: 'COP', cycle: 'MONTHLY', custom: false },
    period: { start: null, end: null }, nextCharge: { date: null, note: 'Los cobros los coordina el equipo de BackOffice (no hay débito automático).' },
    cancelAtPeriodEnd: false, canceledAt: null, trialEndsAt: null, usage,
    invoices: [], payments: [{ id: 'pm', reference: 'manual_x', provider: 'MANUAL', status: 'APPROVED', purpose: 'INVOICE', method: 'TRANSFER', amount: 150000, currency: 'COP', createdAt: '2026-10-05T00:00:00Z' }],
    events: [{ id: 'e', type: 'ACTIVATE', source: 'ADMIN', at: '2026-10-01T00:00:00Z', actor: 'Santi', reason: null, from: 'PENDING_ACTIVATION', to: 'ACTIVE' }],
    actions: ['CANCEL', 'CHANGE_PLAN_REQUEST'],
  };
  list = {
    policy: { graceDays: null, dueDays: null },
    items: [
      { id: 'coA', name: 'Aurora', status: 'PAYMENT_PENDING', statusLabel: 'Pago pendiente', legacy: false, plan: { id: 'p', name: 'Básico', line: 'WPP', active: true }, price: { monthly: 150000, currency: 'COP', cycle: 'MONTHLY', custom: false }, currentPeriodEnd: null, cancelAtPeriodEnd: false, problems: [{ key: 'OVERDUE_NO_POLICY', label: 'Factura vencida sin política de gracia definida' }] },
      { id: 'coB', name: 'Otra', status: 'ACTIVE', statusLabel: 'Activa', legacy: true, plan: null, price: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, problems: [] },
    ],
  };
  detail = { ...mine, status: 'PAYMENT_PENDING', statusLabel: 'Pago pendiente', problems: list.items[0].problems, policy: list.policy, invoices: [{ id: 'inv1', period: '2026-10', total: 150000, currency: 'COP', status: 'PENDING', issuedAt: '2026-10-01', paidAt: null }] };
  post.mockClear();
  put.mockClear();
});
afterEach(cleanup);

describe('Portal · suscripción de la empresa', () => {
  it('muestra el estado, sin fecha de cobro inventada, uso con límites y pagos; cancelar pide confirmación', async () => {
    mount(<SubscriptionCard />);
    const card = await screen.findByTestId('subscription-card');
    expect(within(card).getByText('Activa')).toBeTruthy();
    expect(within(card).getByText(/no hay débito automático/)).toBeTruthy();
    expect(within(card).getByText('Sin fecha registrada')).toBeTruthy();
    expect(within(screen.getByTestId('usage')).getByText('2 de 3')).toBeTruthy();
    expect(within(screen.getByTestId('usage')).getByText('1 (sin límite)')).toBeTruthy();
    expect(within(card).getByText(/pago manual \(TRANSFER\)/)).toBeTruthy();
    fireEvent.click(within(card).getByText('Cancelar la renovación'));
    expect(screen.getByText(/No pierdes el acceso ahora/)).toBeTruthy();
    fireEvent.click(screen.getByText('Sí, cancelar la renovación'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/subscriptions/me/cancel', { confirm: true, reason: '' }));
  });

  it('en solo lectura lo dice claramente', async () => {
    mine = { ...mine, status: 'SUSPENDED', statusLabel: 'Suspendida', access: 'READ_ONLY', actions: ['CHANGE_PLAN_REQUEST'] };
    mount(<SubscriptionCard />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/solo lectura/);
    expect(screen.queryByText('Cancelar la renovación')).toBeNull();
  });
});

describe('Plataforma · suscripciones', () => {
  it('lista estados y problemas, avisa que la política está pendiente y registra un pago manual con confirmación', async () => {
    mount(<Subscriptions />);
    const table = await screen.findByTestId('subscriptions-table');
    expect(within(table).getByText('Factura vencida sin política de gracia definida')).toBeTruthy();
    expect(within(table).getByText(/estado heredado/)).toBeTruthy();
    expect(screen.getByText('Pendiente de definir')).toBeTruthy();
    fireEvent.click(within(table).getAllByText('Ver')[0]);
    const d = await screen.findByTestId('subscription-detail');
    expect(within(await screen.findByTestId('economics')).getAllByText('estimado').length).toBeGreaterThan(0);
    fireEvent.click(within(d).getByText('Registrar pago manual'));
    fireEvent.click(screen.getByText('Verifiqué el pago: registrar'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/subscriptions/invoices/inv1/manual-payment', { method: 'TRANSFER', note: '', confirm: true }));
  });

  it('un cambio de estado exige motivo y confirmación', async () => {
    mount(<Subscriptions />);
    fireEvent.click(within(await screen.findByTestId('subscriptions-table')).getAllByText('Ver')[0]);
    await screen.findByTestId('subscription-detail');
    fireEvent.change(screen.getByLabelText('Nuevo estado'), { target: { value: 'SUSPENDED' } });
    const apply = screen.getByText('Aplicar') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Motivo (queda en el historial)'), { target: { value: 'Impago de octubre' } });
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('Aplicar'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/subscriptions/coA/transition', { to: 'SUSPENDED', reason: 'Impago de octubre', confirm: true }));
    spy.mockRestore();
  });
});
