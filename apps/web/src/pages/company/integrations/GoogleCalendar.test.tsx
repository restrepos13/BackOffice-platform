import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarStatus } from './GoogleCalendar';

let status: CalendarStatus;
const post = vi.fn(async (path: unknown, _body?: unknown) => (String(path).endsWith('/connect') ? { url: '#google' } : { status }));
const del = vi.fn(async (..._args: unknown[]) => ({ deletedEvents: 0 }));
vi.mock('../../../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: vi.fn(async (path: string) =>
      path.startsWith('/bookings/config')
        ? { config: { resources: [{ id: 'r_1', name: 'Cancha 1', active: true }, { id: 'r_2', name: 'Cancha 2', active: true }] } }
        : status),
    post: (path: unknown, body?: unknown) => post(path, body),
    put: vi.fn(async () => status),
    delete: (...args: unknown[]) => del(...args),
  },
}));

import GoogleCalendarCard from './GoogleCalendar';

const connected = (): NonNullable<CalendarStatus['connection']> => ({
  status: 'CONNECTED', accountEmail: 'dueno@gmail.com', calendarId: 'c1', calendarName: 'Canchas', calendarTimeZone: 'America/Bogota',
  calendars: [{ id: 'c1', name: 'Canchas', primary: false }], direction: 'BOTH', blockResourceIds: [], allDayBlocks: true, importTitles: false,
  lastSyncAt: new Date().toISOString(), lastSyncStatus: 'OK', lastError: null, nextRetryAt: null, channelActive: true,
});

function mount(canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><GoogleCalendarCard q="" canWrite={canWrite} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { post.mockClear(); del.mockClear(); });
afterEach(cleanup);

describe('Tarjeta de Google Calendar', () => {
  it('sin cliente OAuth en la plataforma muestra el estado pendiente y no ofrece conectar', async () => {
    status = { configured: false, notifications: false, connection: null, conflicts: [], errors: [] };
    mount();
    expect(await screen.findByText('Pendiente de configurar')).toBeTruthy();
    expect(screen.queryByText('Conectar Google Calendar')).toBeNull();
  });

  it('configurado y sin conectar: el botón pide la URL de Google al servidor', async () => {
    status = { configured: true, notifications: true, connection: null, conflicts: [], errors: [] };
    mount();
    fireEvent.click(await screen.findByText('Conectar Google Calendar'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/calendar/google/connect', undefined));
  });

  it('conectado: muestra cuenta, calendario, avisos al instante y los espacios que bloquea', async () => {
    status = { configured: true, notifications: true, connection: connected(), conflicts: [], errors: [] };
    mount();
    expect(await screen.findByText(/dueno@gmail.com/)).toBeTruthy();
    expect(screen.getByText(/al instante/)).toBeTruthy();
    expect(await screen.findByText('Cancha 2')).toBeTruthy();
    expect(screen.getByText('Sincronizar ahora')).toBeTruthy();
  });

  it('conflictos: cada tipo ofrece solo sus salidas y se resuelven en el servidor', async () => {
    const appointment = { id: 'a1', code: 'R-ABC123', title: 'Fútbol 5', startsAt: '2026-10-24T23:00:00Z', status: 'SCHEDULED' };
    status = {
      configured: true, notifications: true, connection: connected(), errors: [],
      conflicts: [
        { id: 'k1', kind: 'EDITED_IN_GOOGLE', googleStart: '2026-10-25T01:00:00Z', appointment },
        { id: 'k2', kind: 'DELETED_IN_GOOGLE', appointment },
        { id: 'k3', kind: 'OVERLAPS_BOOKING', codes: ['R-ABC123'], startsAt: '2026-10-24T23:00:00Z', appointment: null },
      ],
    };
    mount();
    expect(await screen.findByText('Conflictos por resolver (3)')).toBeTruthy();
    fireEvent.click(screen.getByText('Usar la hora de Google'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/calendar/google/conflicts/k1/resolve', { action: 'APPLY_GOOGLE' }));
    expect(screen.getByText('Volver a ponerla en Google')).toBeTruthy();
    expect(screen.getByText('Entendido, mantener ambos')).toBeTruthy();
    expect(screen.getAllByText('Cancelar la reserva')).toHaveLength(1);
  });

  it('desconectar explica qué pasa y solo borra eventos de Google si se marca', async () => {
    status = { configured: true, notifications: true, connection: connected(), conflicts: [], errors: [] };
    mount();
    fireEvent.click(await screen.findByText('Desconectar'));
    expect(screen.getByText('Tus reservas en BackOffice no cambian.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Quitar también de Google los eventos que creó BackOffice' }));
    fireEvent.click(screen.getAllByText('Desconectar').at(-1)!);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/calendar/google?deleteCreatedEvents=1'));
  });

  it('sin permiso de escritura solo se ve el estado', async () => {
    status = { configured: true, notifications: true, connection: connected(), conflicts: [], errors: [] };
    mount(false);
    expect(await screen.findByText(/dueno@gmail.com/)).toBeTruthy();
    expect(screen.queryByText('Sincronizar ahora')).toBeNull();
    expect(screen.queryByText('Desconectar')).toBeNull();
  });
});
