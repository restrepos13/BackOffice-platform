import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let invitations: unknown[] = [];
let inviteResult: unknown = null;
let inviteError: Error | null = null;
const post = vi.fn(async (path: string, _body?: unknown) => {
  if (path === '/users/invitations') {
    if (inviteError) throw inviteError;
    return inviteResult;
  }
  return {};
});
const del = vi.fn(async (_path: string) => ({}));
vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: vi.fn(async (path: string) => (path.startsWith('/users/invitations') ? invitations : [])),
    post: (path: string, body?: unknown) => post(path, body),
    patch: vi.fn(async () => ({})),
    delete: (path: string) => del(path),
  },
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'COMPANY_ADMIN' }, isPlatform: false, canWrite: true }) }));
vi.mock('./shared', async (orig) => ({
  ...(await orig<typeof import('./shared')>()),
  useCompanyScope: () => ({ ready: true, q: '', canWrite: true, companyId: null, isPlatform: false }),
}));

import Team from './Team';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Team /></MemoryRouter></QueryClientProvider>);
}

const pending = { id: 'i1', email: 'ana@cafe.co', name: 'Ana', role: 'COMPANY_VIEWER', opsProfile: null, invitedByName: 'Laura', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), status: 'PENDING' };

beforeEach(() => { post.mockClear(); del.mockClear(); invitations = []; inviteError = null; });
afterEach(cleanup);

describe('Equipo · invitaciones', () => {
  it('invitar por correo muestra el enlace una sola vez y avisa si el correo no salió', async () => {
    inviteResult = { link: 'http://x/invitacion?token=abc', emailStatus: 'QUEUED', invitation: { ...pending, email: 'ana@cafe.co' } };
    mount();
    fireEvent.click(await screen.findByText('+ Invitar por correo'));
    const send = screen.getByText('Enviar invitación').closest('button')!;
    expect(send.disabled).toBe(true);
    fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: 'ana@cafe.co' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(await screen.findByText('http://x/invitacion?token=abc')).toBeTruthy();
    expect(screen.getByText(/comparte tú este enlace/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/users/invitations', { email: 'ana@cafe.co', name: undefined, role: 'COMPANY_VIEWER' });
  });

  it('el error del servidor (límite del plan) se muestra tal cual y no aparece enlace', async () => {
    const { toast } = await import('sonner');
    const spy = vi.spyOn(toast, 'error');
    inviteError = new Error('Llegaste al límite de 2 personas de tu plan Starter. Para agregar más, habla con BackOffice.');
    mount();
    fireEvent.click(await screen.findByText('+ Invitar por correo'));
    fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: 'b@cafe.co' } });
    fireEvent.click(screen.getByText('Enviar invitación'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(inviteError!.message));
    expect(screen.queryByText(/token=/)).toBeNull();
  });

  it('lista las invitaciones y permite revocar solo las pendientes', async () => {
    invitations = [pending, { ...pending, id: 'i2', email: 'old@cafe.co', status: 'EXPIRED' }];
    mount();
    expect(await screen.findByText('Pendiente')).toBeTruthy();
    expect(screen.getByText('Vencida')).toBeTruthy();
    const revoke = screen.getAllByText('Revocar');
    expect(revoke).toHaveLength(1);
    fireEvent.click(revoke[0]);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/users/invitations/i1'));
  });

  it('crear con contraseña sigue disponible como opción secundaria', async () => {
    mount();
    fireEvent.click(await screen.findByText('Crear con contraseña'));
    expect(screen.getByText('Crear miembro con contraseña')).toBeTruthy();
  });
});
