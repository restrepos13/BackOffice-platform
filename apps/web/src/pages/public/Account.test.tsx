import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
const adopt = vi.fn();
vi.mock('../../lib/api', () => ({ ApiError: class extends Error {}, api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ adopt }) }));

import { AcceptInvitation, ForgotPassword, ResetPassword } from './Account';

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/recuperar" element={<ForgotPassword />} />
          <Route path="/restablecer" element={<ResetPassword />} />
          <Route path="/invitacion" element={<AcceptInvitation />} />
          <Route path="/" element={<p>INICIO</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const pw = () => document.querySelectorAll('input[type="password"]');

beforeEach(() => { post.mockReset(); get.mockReset(); adopt.mockReset(); });
afterEach(cleanup);

describe('Cuenta pública', () => {
  it('recuperar muestra el mensaje neutro del servidor', async () => {
    post.mockResolvedValue({ message: 'Si el correo tiene una cuenta activa, te enviamos un enlace.' });
    mount('/recuperar');
    fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: 'x@y.co' } });
    fireEvent.click(screen.getByText('Enviar enlace'));
    expect(await screen.findByText(/Si el correo tiene una cuenta activa/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/public/account/password/forgot', { email: 'x@y.co' });
  });

  it('restablecer sin token no muestra formulario; con contraseñas distintas no envía', async () => {
    mount('/restablecer');
    expect(screen.getByText(/Falta el enlace/)).toBeTruthy();
    cleanup();
    mount('/restablecer?token=t1');
    fireEvent.change(pw()[0], { target: { value: 'abcdefgh' } });
    fireEvent.change(pw()[1], { target: { value: 'abcdefgX' } });
    expect(screen.getByText('Las contraseñas no coinciden')).toBeTruthy();
    expect(screen.getByText('Guardar contraseña').closest('button')!.disabled).toBe(true);
  });

  it('restablecer muestra el error del servidor (enlace vencido o usado)', async () => {
    post.mockRejectedValue(new Error('El enlace no es válido o ya venció.'));
    mount('/restablecer?token=t1');
    fireEvent.change(pw()[0], { target: { value: 'abcdefgh' } });
    fireEvent.change(pw()[1], { target: { value: 'abcdefgh' } });
    fireEvent.click(screen.getByText('Guardar contraseña'));
    expect(await screen.findByText(/ya venció/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/public/account/password/reset', { token: 't1', password: 'abcdefgh' });
  });

  it('invitación inválida muestra aviso sin formulario', async () => {
    get.mockRejectedValue(new Error('La invitación no es válida o ya venció.'));
    mount('/invitacion?token=bad');
    expect(await screen.findByText('Esta invitación no se puede usar')).toBeTruthy();
    expect(pw()).toHaveLength(0);
  });

  it('aceptar invitación inicia sesión con la respuesta del servidor', async () => {
    get.mockResolvedValue({ companyName: 'Café Aurora', email: 'ana@cafe.co', name: 'Ana', role: 'COMPANY_VIEWER', expiresAt: new Date().toISOString() });
    post.mockResolvedValue({ token: 'jwt', user: { id: 'u9' } });
    mount('/invitacion?token=ok');
    expect(await screen.findByText('Únete a Café Aurora')).toBeTruthy();
    fireEvent.change(pw()[0], { target: { value: 'abcdefgh' } });
    fireEvent.change(pw()[1], { target: { value: 'abcdefgh' } });
    fireEvent.click(screen.getByText('Aceptar y entrar'));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith('jwt', { id: 'u9' }));
    expect(await screen.findByText('INICIO')).toBeTruthy();
  });
});
