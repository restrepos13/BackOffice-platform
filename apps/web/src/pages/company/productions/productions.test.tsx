import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationGroups } from '../../../layouts/navigation';

/** Pantallas de Producciones contra una API simulada (los permisos los decide el servidor). */

const calls: Array<{ method: string; path: string; body?: any }> = [];
let responses: Record<string, any> = {};
let failNext: string | null = null;
const respond = (method: string) => async (path: string, body?: any) => {
  calls.push({ method, path, body });
  if (failNext && path.includes(failNext)) {
    failNext = null;
    throw new Error('Escribe el motivo');
  }
  const key = Object.keys(responses).find((k) => path.startsWith(k));
  return key ? responses[key] : {};
};
vi.mock('../../../lib/api', () => ({
  ApiError: class extends Error {},
  api: { get: (p: string) => respond('GET')(p), post: (p: string, b?: any) => respond('POST')(p, b), put: (p: string, b?: any) => respond('PUT')(p, b), patch: (p: string, b?: any) => respond('PATCH')(p, b) },
}));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (m: string) => toastError(m) } }));
vi.mock('../shared', () => ({
  useCompanyScope: () => ({ ready: true, q: '', canWrite: true, companyId: 'coA', isPlatform: false }),
  PickCompany: () => null,
  withScope: (p: string) => p,
}));

import ProductionsList from './List';
import ProductionsHome from './Home';
import ProductionDetail from './Detail';

const team = (permissions: string[]) => ({ profiles: [], permissionLabels: {}, users: [{ id: 'u1', name: 'Booker de prueba', role: 'COMPANY_VIEWER', opsProfile: 'BOOKER', effectiveProfile: 'BOOKER', permissions }], me: { profile: 'BOOKER', permissions } });
const detail = (permissions: string[], extra: Record<string, any> = {}) => ({
  production: { id: 'p1', code: 'PR-0001', title: 'Prueba', clientName: 'Marca de prueba', brand: null, channel: 'WHATSAPP', status: 'NUEVA', statusLabel: 'Nueva', priority: 'NORMAL', ownerId: null, ownerName: null, version: 1, isTest: true, requestedDate: null, nextAction: null },
  brief: {}, briefFields: [{ key: 'description', label: 'Descripción de la solicitud', group: 'Solicitud', kind: 'long' }], durations: ['Jornada completa'],
  missing: { toComplete: [{ key: 'description', label: 'Descripción de la solicitud' }], toQuote: [{ key: 'description', label: 'Descripción de la solicitud' }], configStatus: 'PENDING' },
  transitions: [{ status: 'BRIEF_INCOMPLETO', label: 'Brief incompleto', needsReason: false, needsEvidence: false }, { status: 'CANCELADA', label: 'Cancelada', needsReason: true, needsEvidence: false }],
  tasks: [], issues: [], assignments: [], events: [{ id: 'e1', type: 'created', actorType: 'USER', actorName: 'Booker', summary: 'Solicitud PR-0001 creada', createdAt: '2026-10-23T15:00:00Z' }],
  quotes: [], ai: null, permissions, serviceTypes: [{ key: 'MODEL', label: 'Modelos' }], holdHours: null, ...extra,
});

function mount(ui: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/productions/:id" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { calls.length = 0; responses = {}; failNext = null; toastError.mockClear(); });
afterEach(cleanup);

describe('Navegación', () => {
  it('Producciones solo aparece en empresas con esa sección', () => {
    const titles = (modules: string[]) => automationGroups({ products: ['AUTOMATION'], modules }).map((g) => g.title);
    expect(titles(['inbox'])).not.toContain('Producciones');
    expect(titles(['inbox', 'productions'])).toContain('Producciones');
  });
});

describe('Inicio y listado', () => {
  it('sin datos muestra estados vacíos y cifras en cero (nada inventado)', async () => {
    responses = {
      '/productions/overview': { counts: { open: 0, unassigned: 0, briefIncomplete: 0, quotesPendingApproval: 0, overdueTasks: 0, upcoming: 0, openIssues: 0, testRecords: 0 }, byStatus: [], upcoming: [], overdueTasks: [], openIssues: [] },
      '/productions/team': team(['view', 'edit']),
    };
    mount(<ProductionsHome />);
    expect(await screen.findByText('Aún no hay solicitudes')).toBeTruthy();
    expect(screen.getByText('Ninguna vencida.')).toBeTruthy();
  });

  it('buscar y filtrar piden al servidor; crear envía la solicitud real', async () => {
    responses = { '/productions/team': team(['view', 'edit', 'assign']), '/productions?': { total: 0, page: 1, pageSize: 25, items: [] }, '/productions': { production: { id: 'p9' } } };
    mount(<ProductionsList />);
    await screen.findByText('Sin solicitudes');
    fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'PR-0007' } });
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'INSTAGRAM' } });
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.path.includes('q=PR-0007') && c.path.includes('channel=INSTAGRAM'))).toBe(true));
    fireEvent.click(screen.getAllByText(/Nueva solicitud|Crear la primera/)[0]);
    const client = await screen.findByText('Cliente o marca');
    fireEvent.change(client.closest('label')!.querySelector('input')!, { target: { value: 'Marca de prueba' } });
    fireEvent.click(screen.getByText('Crear solicitud'));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/productions')?.body).toMatchObject({ clientName: 'Marca de prueba', channel: 'WHATSAPP' }));
  });
});

describe('Detalle', () => {
  it('muestra qué falta y el cambio de estado llama al endpoint de transición', async () => {
    responses = { '/productions/team': team(['view', 'edit']), '/productions/p1': detail(['view', 'edit']) };
    mount(<ProductionDetail />, '/app/productions/p1');
    expect(await screen.findByText(/Para completar el brief:/)).toBeTruthy();
    fireEvent.click(screen.getByText('→ Brief incompleto'));
    await waitFor(() => expect(calls.find((c) => c.path === '/productions/p1/transition')?.body).toMatchObject({ to: 'BRIEF_INCOMPLETO', expectedVersion: 1 }));
  });

  it('cancelar pide motivo; si el servidor rechaza, se muestra el error', async () => {
    responses = { '/productions/team': team(['view', 'edit']), '/productions/p1': detail(['view', 'edit']) };
    mount(<ProductionDetail />, '/app/productions/p1');
    fireEvent.click(await screen.findByText('→ Cancelada'));
    expect(screen.getByText('Motivo')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirmar' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByText('Motivo').closest('label')!.querySelector('textarea')!, { target: { value: 'Prueba' } });
    failNext = '/transition';
    fireEvent.click(confirm);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Escribe el motivo'));
  });

  it('solo lectura: sin botones de estado ni edición', async () => {
    responses = { '/productions/team': team(['view']), '/productions/p1': detail(['view']) };
    mount(<ProductionDetail />, '/app/productions/p1');
    await screen.findByText(/Para completar el brief:/);
    expect(screen.queryByText('→ Brief incompleto')).toBeNull();
    expect(screen.queryByText('Guardar cambios')).toBeNull();
  });

  it('cotización por aprobar: aprobar solo aparece con permiso de aprobar', async () => {
    const quote = { id: 'q1', version: 1, status: 'PENDING_APPROVAL', currency: 'COP', lines: [{ id: 'm1', category: 'MODEL', description: 'Modelo (prueba)', quantity: 1, unit: 'FULL_DAY', unitCost: null, costStatus: 'PENDING', unitPrice: 100, priceStatus: 'ESTIMATED', billing: 'INCLUDED', commission: null }], totals: { clientTotal: 100, costTotal: null, margin: null, clientDirect: 0, pending: [], complete: true }, redacted: false, diff: null };
    responses = { '/productions/team': team(['view', 'quotes']), '/productions/p1': detail(['view', 'quotes'], { quotes: [quote], production: { ...detail([]).production, status: 'COTIZACION_PENDIENTE_APROBACION', statusLabel: 'Cotización por aprobar' } }) };
    const { unmount } = mount(<ProductionDetail />, '/app/productions/p1');
    fireEvent.click(await screen.findByText('Cotizaciones'));
    expect(await screen.findByText('Esperando a quien tenga permiso de aprobar.')).toBeTruthy();
    expect(screen.queryByText('Aprobar')).toBeNull();
    unmount();
    responses['/productions/p1'] = detail(['view', 'quotes', 'approve'], { quotes: [quote] });
    mount(<ProductionDetail />, '/app/productions/p1');
    fireEvent.click(await screen.findByText('Cotizaciones'));
    fireEvent.click(await screen.findByText('Aprobar'));
    fireEvent.click(screen.getAllByText('Aprobar').at(-1)!);
    await waitFor(() => expect(calls.find((c) => c.path === '/productions/quotes/q1/decision')?.body).toMatchObject({ decision: 'APPROVE' }));
  });
});
