import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoneAlertsView, type AlertsStatus } from './PhoneAlerts';

const labels = {
  SIGNUP_CONTACT: 'Alguien empezó el registro y dejó su WhatsApp',
  SIGNUP_DONE: 'Alguien terminó el registro (empresa nueva)',
  SIGNUP_ABANDONED: 'Alguien dejó el registro a mitad (30 min sin volver)',
  CLIENT_LOGIN: 'Un cliente inició sesión',
  ADS_CONNECTED: 'Un cliente conectó su cuenta publicitaria',
};
const base: AlertsStatus = {
  configured: false, botName: null, botLink: null, linked: false, chatName: null,
  events: { SIGNUP_CONTACT: true, SIGNUP_DONE: true, SIGNUP_ABANDONED: true, CLIENT_LOGIN: true, ADS_CONNECTED: true }, labels, lastSent: null,
};
const handlers = () => ({ onToken: vi.fn(), onLink: vi.fn(), onEvents: vi.fn(), onTest: vi.fn(), onDisconnect: vi.fn() });

afterEach(cleanup);

describe('Registros · avisos al celular', () => {
  it('sin configurar: guía en 3 pasos; vincular y elegir avisos esperan al paso anterior', () => {
    const h = handlers();
    render(<PhoneAlertsView data={base} busy={false} {...h} />);
    const box = screen.getByTestId('phone-alerts');
    expect(box.textContent).toContain('@BotFather');
    expect((within(box).getByRole('button', { name: 'Vincular' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(box).getByLabelText(/Token del bot/), { target: { value: `123456789:${'A'.repeat(35)}` } });
    fireEvent.click(within(box).getByRole('button', { name: 'Guardar' }));
    expect(h.onToken).toHaveBeenCalledWith(`123456789:${'A'.repeat(35)}`);
  });

  it('vinculado: muestra a dónde llegan, deja apagar un aviso y mandar una prueba', () => {
    const h = handlers();
    render(<PhoneAlertsView data={{ ...base, configured: true, linked: true, botName: 'avisos_bot', botLink: 'https://t.me/avisos_bot', chatName: 'Santi', lastSent: { at: new Date().toISOString(), event: 'SIGNUP_DONE', ok: true } }} busy={false} {...h} />);
    expect(screen.getByText('Llegan a Telegram · Santi')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Configurar' }));
    fireEvent.click(screen.getByLabelText('Un cliente inició sesión'));
    expect(h.onEvents).toHaveBeenCalledWith({ CLIENT_LOGIN: false });
    fireEvent.click(screen.getByRole('button', { name: 'Enviarme una prueba' }));
    expect(h.onTest).toHaveBeenCalled();
  });
});
