import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRow, Catalog, RunRow } from './Automations';

const catalog: Catalog = {
  triggers: [
    { type: 'contact.created', label: 'Se crea un contacto', record: 'contact', config: {}, fields: [
      { key: 'contact.channel', label: 'Canal del contacto', type: 'string', operators: ['eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists'] },
      { key: 'contact.tags', label: 'Etiquetas del contacto', type: 'tags', operators: ['contains', 'not_contains'] },
    ] },
    { type: 'order.status_changed', label: 'Un pedido cambia de estado (o se crea)', record: 'order', config: { toStatus: { label: 'Solo al llegar al estado', type: 'enum', options: ['listo', 'entregado'] } }, fields: [
      { key: 'order.total', label: 'Total del pedido', type: 'number', operators: ['gt', 'lt'] },
    ] },
  ],
  actions: [
    { type: 'add_tag', label: 'Agregar etiqueta al contacto', needs: 'contact', config: { tag: { type: 'short', required: true } } },
    { type: 'create_follow_up', label: 'Crear un seguimiento (tarea)', needs: 'contact', config: { note: { type: 'text', required: true }, dueInHours: { type: 'hours', required: true } } },
    { type: 'assign_courier', label: 'Asignar domiciliario automático', needs: 'order', config: {} },
  ],
  limits: { rules: 10, actions: 10, text: 300, waitHours: 720, runsPerHour: { default: 60, max: 500 }, attempts: { default: 3, max: 5 } },
  stages: [{ pipelineId: null, name: 'Embudo estándar', stages: [{ key: 'CURIOSO', label: 'Curioso' }] }],
  users: [],
  courierAssignment: null,
};
const row = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', name: 'Bienvenida', description: null, status: 'ACTIVE', triggerType: 'contact.created', version: 2, legacy: false, legacyTrigger: null,
  definition: { trigger: { type: 'contact.created', config: {} }, conditions: { match: 'all', rules: [] }, actions: [{ type: 'add_tag', config: { tag: 'nuevo' } }] },
  validation: { valid: true, errors: [] }, stats: { runs30d: 3, failed30d: 1, lastRun: { id: 'r1', status: 'FAILED', createdAt: new Date().toISOString() } }, ...over,
});
const run = (i: number, over: Partial<RunRow> = {}): RunRow => ({
  id: `r${i}`, automationId: 'a1', automationName: 'Bienvenida', automationVersion: 2, status: 'COMPLETED', triggerType: 'contact.created', sourceType: 'contact', sourceId: `contacto${i}`,
  attempts: 1, maxAttempts: 3, createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0, i)).toISOString(), startedAt: null, finishedAt: null, nextRetryAt: null, error: null, stepsDone: 1, ...over,
});

let automations: AutomationRow[] = [];
let runPages: Record<string, { items: RunRow[]; nextCursor: string | null }> = {};
const get = vi.fn(async (path: string): Promise<unknown> => {
  if (path.startsWith('/automations/catalog')) return catalog;
  if (path.startsWith('/automations/runs/')) return { ...run(1, { status: 'RETRYABLE', error: { message: 'Mongo no respondió', attempt: 1 } }), eventId: 'contact.created:x', steps: [{ index: 0, type: 'add_tag', status: 'DONE', at: '' }, { index: 1, type: 'create_follow_up', status: 'FAILED', at: '', error: 'Mongo no respondió' }], conditions: [] };
  if (path.startsWith('/automations/runs')) return runPages[new URL(`http://x${path}`).searchParams.get('before') ?? ''] ?? { items: [], nextCursor: null };
  if (path.startsWith('/automations')) return automations;
  return {};
});
const post = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}));
const patch = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}));
vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly field?: string, readonly code?: string, readonly errors?: string[]) { super(message); }
  }
  return { ApiError, api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b), put: vi.fn(), delete: vi.fn() } };
});
vi.mock('./shared', async (orig) => ({
  ...(await orig<typeof import('./shared')>()),
  useCompanyScope: () => ({ ready: true, q: '', canWrite: true, companyId: null, isPlatform: false }),
}));

import Automations from './Automations';
import { ApiError } from '../../lib/api';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Automations /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { automations = []; runPages = {}; post.mockClear(); patch.mockClear(); });
afterEach(cleanup);

describe('Automatizaciones · lista', () => {
  it('muestra métricas reales del motor y nunca las del seed; las anteriores se marcan sin motor y no se activan', async () => {
    automations = [row(), row({ id: 'old', name: 'Recordatorio 24h', status: 'DRAFT', triggerType: null, version: 0, legacy: true, legacyTrigger: 'Cita agendada', definition: {}, validation: { valid: false, errors: [] }, stats: { runs30d: 0, failed30d: 0, lastRun: null } })];
    mount();
    expect(await screen.findByText('Bienvenida')).toBeTruthy();
    expect(screen.getByText('Anterior · sin motor')).toBeTruthy();
    expect(screen.getByText(/Cita agendada/)).toBeTruthy();
    expect(screen.queryByText(/99,2|99\.2|%/)).toBeNull();
    const old = screen.getByText('Recordatorio 24h').closest('div')!.parentElement!;
    expect(within(old).queryByText('Activar')).toBeNull();
    expect(screen.getAllByText('Datos reales del motor (no incluye cifras de demostración).').length).toBe(2);
  });
});

describe('Automatizaciones · constructor', () => {
  it('solo ofrece disparadores y acciones soportados; las de pedidos no aparecen para contactos', async () => {
    mount();
    fireEvent.click(await screen.findByText('Crear la primera'));
    const trigger = screen.getByLabelText('Disparador') as HTMLSelectElement;
    expect([...trigger.options].map((o) => o.value)).toEqual(['', 'contact.created', 'order.status_changed']);
    fireEvent.change(trigger, { target: { value: 'contact.created' } });
    fireEvent.click(screen.getByText('+ Acción'));
    const action = screen.getByLabelText('Acción 1') as HTMLSelectElement;
    expect([...action.options].map((o) => o.value)).toEqual(['add_tag', 'create_follow_up']);
    expect(screen.queryByText(/WhatsApp|Enviar mensaje/i)).toBeNull();
    fireEvent.change(trigger, { target: { value: 'order.status_changed' } });
    fireEvent.click(screen.getByText('+ Acción'));
    expect([...(screen.getByLabelText('Acción 1') as HTMLSelectElement).options].map((o) => o.value)).toContain('assign_courier');
  });

  it('reordena acciones y muestra uno por uno los errores de validación del servidor', async () => {
    automations = [row()];
    patch.mockRejectedValueOnce(new ApiError('La automatización tiene errores', 400, undefined, undefined, ['Acción 2: completa «note» (máximo 300 caracteres)', 'Máximo 10 condiciones']));
    mount();
    fireEvent.click(await screen.findByText('Editar'));
    fireEvent.click(screen.getByText('+ Acción'));
    fireEvent.change(screen.getByLabelText('Acción 2'), { target: { value: 'create_follow_up' } });
    fireEvent.click(screen.getByLabelText('Subir acción 2'));
    expect((screen.getByLabelText('Acción 1') as HTMLSelectElement).value).toBe('create_follow_up');
    fireEvent.click(screen.getByText('Guardar y publicar versión'));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/completa «note»/)).toBeTruthy();
    expect(within(alert).getByText('Máximo 10 condiciones')).toBeTruthy();
    const body = patch.mock.calls[0][1] as any;
    expect(body.definition.actions.map((a: any) => a.type)).toEqual(['create_follow_up', 'add_tag']);
  });

  it('la prueba se identifica como simulación y no ejecuta nada', async () => {
    automations = [row()];
    post.mockResolvedValueOnce({ simulation: true, wouldRun: true, triggerMatches: true, conditions: { passed: true, results: [] }, actions: [{ description: 'Agregaría la etiqueta «nuevo»' }], note: 'Simulación: no se creó ninguna ejecución ni se modificó ningún dato.' });
    mount();
    fireEvent.click(await screen.findByText('Editar'));
    fireEvent.change(screen.getByLabelText('Id del registro'), { target: { value: 'ctA' } });
    fireEvent.click(screen.getByText('Simular'));
    const sim = await screen.findByTestId('simulation');
    expect(within(sim).getByText('Simulación')).toBeTruthy();
    expect(within(sim).getByText(/Agregaría la etiqueta/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/automations/simulate', expect.objectContaining({ recordId: 'ctA' }));
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('Automatizaciones · historial', () => {
  it('pagina con «Cargar más» y abre el detalle con pasos y errores', async () => {
    automations = [row()];
    runPages[''] = { items: [run(3), run(2)], nextCursor: '2026-10-27T12:00:02.000Z' };
    runPages['2026-10-27T12:00:02.000Z'] = { items: [run(1, { status: 'FAILED', error: { message: 'El contacto ya no existe en esta empresa', attempt: 1 } })], nextCursor: null };
    mount();
    fireEvent.click(await screen.findByText('Historial de ejecuciones'));
    expect(await screen.findByText('tacto3')).toBeTruthy();
    fireEvent.click(screen.getByText('Cargar más'));
    expect(await screen.findByText('El contacto ya no existe en esta empresa')).toBeTruthy();
    expect(screen.queryByText('Cargar más')).toBeNull();
    fireEvent.click(screen.getAllByText('Detalle')[0]);
    expect(await screen.findByText('Último error: Mongo no respondió')).toBeTruthy();
    expect(screen.getByText('Cancelar ejecución')).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/automations/runs/r3'));
  });
});
