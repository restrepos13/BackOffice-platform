import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupProfile } from '../../lib/setup';

const post = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(async () => ({
      profiles: [{ key: 'RESERVAS', label: 'Reservas y alquiler de espacios' }, { key: 'COMIDA', label: 'Comidas y bebidas' }],
      needs: [{ key: 'RESERVAS', label: 'Reservas, citas o turnos' }, { key: 'PEDIDOS', label: 'Pedidos' }],
      intake: ['WhatsApp', 'Instagram'],
      complexity: [],
      products: [
        { key: 'AUTOMATION', name: 'BackOffice Automation', short: 'Automation', summary: 'a' },
        { key: 'CREATIVE', name: 'BackOffice Creative', short: 'Creative', summary: 'b' },
        { key: 'ADS', name: 'BackOffice Ads Intelligence', short: 'Ads Intelligence', summary: 'c' },
      ],
    })),
    post: (...args: unknown[]) => post(...args),
  },
}));

import SetupEditor from './SetupEditor';

const base: SetupProfile = {
  version: 1, source: 'SELF_SERVICE',
  business: { profileKey: 'RESERVAS', label: 'Reservas y alquiler de espacios', activity: 'Canchas de fútbol 5' },
  answers: { offer: '', intake: ['WhatsApp'], manualTasks: [], timeConsuming: [], needs: ['RESERVAS'], automate: [], humanApproval: [], wantsContent: null, wantsAds: null, integrations: [] },
  signals: { stages: null, people: 2, areas: [], dailyVolume: 20 },
  complexity: { level: 'SIMPLE', computed: 'SIMPLE', score: 0, reasons: ['pocas etapas'], override: null },
  products: { selected: ['AUTOMATION'], recommended: ['AUTOMATION'], reasons: { AUTOMATION: ['Trabajas con reservas'] } },
  capabilities: [{ key: 'AGENDA', label: 'Agenda de reservas', product: 'AUTOMATION', status: 'PARTIAL', note: 'próxima fase', included: true, why: 'reservas' }],
  agentCallId: null, updatedAt: '', updatedBy: null,
};

function Host({ mode }: { mode: 'client' | 'admin' }) {
  const [v, setV] = useState(base);
  return <SetupEditor value={v} onChange={setV} mode={mode} endpoint="/public/setup/evaluate" />;
}
const renderEditor = (mode: 'client' | 'admin') => render(<QueryClientProvider client={new QueryClient()}><Host mode={mode} /></QueryClientProvider>);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  post.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Editor del perfil de incorporación', () => {
  it('muestra la complejidad, lo recomendado y el estado real de cada capacidad (lo parcial no se presenta como hecho)', async () => {
    renderEditor('client');
    expect(await screen.findByText('Recomendado')).toBeTruthy();
    expect(screen.getByText('Simple')).toBeTruthy();
    expect(screen.getByText('En parte')).toBeTruthy();
    expect(screen.queryByLabelText('Ajustar complejidad')).toBeNull(); // el cliente no ajusta la complejidad
  });

  it('elegir otro producto lo marca y el servidor recalcula (la pantalla no calcula sola)', async () => {
    post.mockResolvedValue({ ...base, complexity: { ...base.complexity, reasons: ['recalculado por el servidor'] }, products: { ...base.products, recommended: ['AUTOMATION'] } });
    renderEditor('client');
    const creative = await screen.findByRole('button', { name: /^Creative/ });
    fireEvent.click(creative);
    expect(creative.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(post).toHaveBeenCalledWith('/public/setup/evaluate', { setup: expect.objectContaining({ products: expect.objectContaining({ selected: ['AUTOMATION', 'CREATIVE'] }) }) });
    expect(await screen.findByText('recalculado por el servidor')).toBeTruthy();
    // La selección de la persona no la pisa la respuesta del servidor
    expect(screen.getByRole('button', { name: /^Creative/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('sin productos avisa que hay que elegir al menos uno', async () => {
    post.mockRejectedValue(new Error('Elige al menos un producto'));
    renderEditor('client');
    fireEvent.click(await screen.findByRole('button', { name: /^Automation/ }));
    expect(screen.getByText('Elige al menos uno.')).toBeTruthy();
  });

  it('el administrador puede ajustar la complejidad y debe dar el motivo', async () => {
    renderEditor('admin');
    const select = await screen.findByLabelText('Ajustar complejidad');
    fireEvent.change(select, { target: { value: 'COMPLEX' } });
    expect(screen.getByLabelText('Motivo del ajuste')).toBeTruthy();
    // La etiqueta pasa a «Compleja» (además de la opción de la lista) y avisa que está ajustada
    expect(screen.getAllByText('Compleja').length).toBeGreaterThan(1);
    expect(screen.getByText(/ajustada; según las respuestas sería simple/)).toBeTruthy();
  });
});
