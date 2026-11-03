import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

let isPlatform = false;
const bot = {
  id: 'b1', name: 'Ana', model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.7, maxTokens: 512, systemPrompt: '', memoryEnabled: true,
  status: 'ACTIVE', personality: {}, sales: {}, replyDelayMinSec: 3, replyDelayMaxSec: 12, typingSimulation: true, engineMode: 'ORDERS', tools: [], aiSource: 'INHERIT',
  company: { name: 'Obras SAS' }, _count: { conversations: 4 },
  // Un canal sin config (como llegaba antes del arreglo) no debe romper la pantalla
  integrations: [{ id: 'i1', type: 'WHATSAPP', name: 'Ventas', status: 'CONNECTED', config: { displayPhone: '+57 300 111' }, lastSyncAt: null }, { id: 'i2', type: 'INSTAGRAM', name: 'Instagram', status: 'DISCONNECTED', lastSyncAt: null }],
};
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(async () => bot), patch: vi.fn(async () => bot), post: vi.fn(async () => ({})) } }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ canWrite: true, isPlatform }) }));
vi.mock('./shared', () => ({ useCompanyScope: () => ({ q: '', companyId: null }) }));
vi.mock('../../lib/products', () => ({ useActiveCompany: () => ({ company: { aiBillingMode: 'BYOK', products: ['AUTOMATION'] } }) }));
vi.mock('../../components/media', () => ({ ModelSelect: () => <select aria-label="modelo" /> }));
vi.mock('../../components/AgentConfig', () => ({ AgentConfig: () => null, AgentSimulator: () => null }));
vi.mock('../../components/PersonaPicker', () => ({ PersonaPicker: () => null }));
vi.mock('../../components/ScheduleCall', () => ({ default: ({ label }: { label: string }) => <button type="button">{label}</button> }));

import BotDetail from './BotDetail';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/app/bots/b1']}><Routes><Route path="/app/bots/:id" element={<BotDetail />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); isPlatform = false; });

describe('Asistente', () => {
  it('la pestaña Canales muestra cada canal (aunque no traiga configuración) y lleva a conectarlos', async () => {
    mount();
    fireEvent.click(await screen.findByText('Canales'));
    expect(screen.getByText('Ventas', { selector: 'h3' })).toBeTruthy();
    expect(screen.getByText('+57 300 111')).toBeTruthy();
    expect(screen.getByText('Instagram', { selector: 'h3' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Canales e integraciones/ })[0].getAttribute('href')).toBe('/app/integrations');
  });

  it('el cliente ve qué IA usa y quién la paga, sin poder cambiarlo; el equipo sí lo cambia', async () => {
    mount();
    fireEvent.click(await screen.findByText('Modelo IA'));
    expect(screen.getByText('Tu empresa, con su propia cuenta de IA')).toBeTruthy();
    expect(screen.getByText(/DeepInfra u OpenRouter/)).toBeTruthy();
    expect(screen.getByText('Hablar con el equipo')).toBeTruthy();
    expect(screen.queryByLabelText('modelo')).toBeNull();
    expect(screen.queryByText('Quién paga la IA de este asistente')).toBeNull();
    cleanup();
    isPlatform = true;
    mount();
    fireEvent.click(await screen.findByText('Modelo IA'));
    expect(screen.getByLabelText('modelo')).toBeTruthy();
    expect(screen.getByText('Solo equipo BackOffice')).toBeTruthy();
  });
});
