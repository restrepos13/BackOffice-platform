import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupProfile } from '../../lib/setup';
import type { Preview } from './signup-helpers';

/**
 * Registro autoservicio (4 pasos) con el servidor simulado: entrevista,
 * corrección de respuestas, propuesta, productos, revisión y creación.
 */

const postWithRetry = vi.fn();
const adopt = vi.fn();
const navigate = vi.fn();

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly field?: string, readonly code?: string) { super(message); }
  }
  return {
    ApiError,
    postWithRetry: (...args: unknown[]) => postWithRetry(...args),
    api: {
      get: vi.fn(async () => ({
        profiles: [{ key: 'RESERVAS', label: 'Reservas y alquiler de espacios' }],
        needs: [{ key: 'RESERVAS', label: 'Reservas, citas o turnos' }],
        intake: ['WhatsApp'],
        complexity: [],
        products: [
          { key: 'AUTOMATION', name: 'BackOffice Automation', short: 'Automation', summary: 'a' },
          { key: 'CREATIVE', name: 'BackOffice Creative', short: 'Creative', summary: 'b' },
          { key: 'ADS', name: 'BackOffice Ads Intelligence', short: 'Ads Intelligence', summary: 'c' },
        ],
      })),
      post: vi.fn(async (_p: string, body: { setup: SetupProfile }) => body.setup),
    },
  };
});
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: null, loading: false, adopt }) }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate }));

import { ApiError } from '../../lib/api';
import Signup from './Signup';

const setup: SetupProfile = {
  version: 1, source: 'SELF_SERVICE',
  business: { profileKey: 'RESERVAS', label: 'Reservas y alquiler de espacios', activity: 'Canchas de fútbol 5' },
  answers: { offer: '', intake: ['WhatsApp'], manualTasks: [], timeConsuming: [], needs: ['RESERVAS'], automate: [], humanApproval: [], wantsContent: null, wantsAds: null, integrations: ['Excel'] },
  signals: { stages: 2, people: 2, areas: [], dailyVolume: 20 },
  complexity: { level: 'SIMPLE', computed: 'SIMPLE', score: 1, reasons: ['pocas etapas'], override: null },
  products: { selected: ['AUTOMATION'], recommended: ['AUTOMATION'], reasons: { AUTOMATION: ['Trabajas con reservas'] } },
  capabilities: [
    { key: 'AGENDA', label: 'Reservas por el chat con disponibilidad real', product: 'AUTOMATION', status: 'AVAILABLE', note: 'Se activa al configurar tus espacios.', included: true, why: 'Tus clientes reservan' },
    { key: 'RECORDATORIOS', label: 'Recordatorios y seguimiento', product: 'AUTOMATION', status: 'PARTIAL', note: 'Fuera de 24 h necesita plantilla.', included: true, why: 'Avisar antes' },
    { key: 'PROCESOS', label: 'Procesos internos de varias etapas', product: 'AUTOMATION', status: 'PLANNED', note: 'Llega en la próxima fase.', included: true, why: 'Tienes pasos internos' },
  ],
  agentCallId: null, updatedAt: '', updatedBy: null,
};

const preview = (over: Partial<Preview> = {}): Preview => ({
  rubro: 'SERVICIOS', rubroLabel: 'Servicios',
  company: { name: 'Canchas El Golazo', city: 'Medellín', summary: '' },
  proposal: { products: [], schedule: null, delivery: null, faqs: [], assistant: { name: 'Sofi', tone: 'cercano', style: '', welcome: 'Hola, ¿qué cancha quieres?', instructions: '' } },
  blueprint: { businessType: 'Canchas sintéticas', needs: [{ title: 'Reservas sin cruces', solution: 'El asistente revisa los turnos libres.' }], modules: ['agenda'], pipeline: null, clientData: [], assistantFlow: [], quickReplies: [], followUps: [] },
  setup, mode: 'ai', ...over,
});

/** Servidor: la entrevista pregunta 2 veces y termina; luego arma la propuesta. */
function server(opts: { preview?: Preview; createError?: unknown } = {}) {
  postWithRetry.mockImplementation(async (path: string, body: any) => {
    if (path === '/public/signup/interview') {
      const answers = body.messages.filter((m: any) => m.role === 'user').length;
      if (answers === 1) return { done: false, question: '¿Cuántas canchas tienes?', options: ['Una', 'Dos', 'Más de dos'], understood: 'Canchas de fútbol' };
      return { done: true, question: '', options: [], understood: 'Dos canchas' };
    }
    if (path === '/public/signup/preview') return opts.preview ?? preview();
    if (path === '/public/signup') {
      if (opts.createError) throw opts.createError;
      return { token: 't', user: { id: 'u' } };
    }
    throw new Error(`ruta inesperada ${path}`);
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Signup /></MemoryRouter></QueryClientProvider>);
}

async function answer(text: string) {
  fireEvent.change(screen.getByLabelText('Tu respuesta'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));
}

async function toProposal() {
  mount();
  await answer('Tengo dos canchas de fútbol');
  await screen.findByText('¿Cuántas canchas tienes?');
  fireEvent.click(screen.getByRole('button', { name: 'Dos' }));
  await screen.findByText('Esto es lo que entendimos');
}

beforeEach(() => {
  localStorage.clear();
  postWithRetry.mockReset();
  adopt.mockReset();
  navigate.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as any;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Registro · entrevista', () => {
  it('una pregunta a la vez, con opciones sugeridas y avance aproximado (sin prometer un número)', async () => {
    server();
    mount();
    expect(screen.getByText('Empezando')).toBeTruthy();
    expect(screen.queryByText(/Pregunta \d+ de/)).toBeNull();
    await answer('Tengo dos canchas de fútbol');
    expect(await screen.findByText('¿Cuántas canchas tienes?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Más de dos' })).toBeTruthy();
    expect(screen.getByText('Canchas de fútbol')).toBeTruthy(); // «Anotado: …»
    expect(screen.getByText('Conociendo tu negocio')).toBeTruthy();
  });

  it('corregir una respuesta retoma desde esa pregunta y no envía lo que venía después', async () => {
    server();
    mount();
    await answer('Tengo canchas');
    await screen.findByText('¿Cuántas canchas tienes?');
    fireEvent.click(screen.getByRole('button', { name: 'Corregir la respuesta 1' }));
    expect(screen.getByText(/Estás corrigiendo una respuesta/)).toBeTruthy();
    expect((screen.getByLabelText('Tu respuesta') as HTMLTextAreaElement).value).toBe('Tengo canchas');
    await answer('Tengo dos canchas sintéticas');
    await screen.findByText('¿Cuántas canchas tienes?');
    const last = postWithRetry.mock.calls.at(-1)!;
    expect(last[1].messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)).toEqual(['Tengo dos canchas sintéticas']);
  });

  it('si falla el envío la respuesta no se pierde y se puede reintentar', async () => {
    postWithRetry.mockRejectedValueOnce(new Error('Sin conexión'));
    mount();
    await answer('Tengo dos canchas');
    expect(await screen.findByText(/Sin conexión/)).toBeTruthy();
    expect(screen.getByText(/«Tengo dos canchas»/)).toBeTruthy();
    server();
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByText('¿Cuántas canchas tienes?')).toBeTruthy();
  });
});

describe('Registro · propuesta', () => {
  it('muestra el negocio, lo que resuelve y las funciones separadas por estado real', async () => {
    server();
    await toProposal();
    expect((screen.getByLabelText('Nombre de tu negocio') as HTMLInputElement).value).toBe('Canchas El Golazo');
    expect(screen.getByText('Reservas sin cruces')).toBeTruthy();
    expect(screen.getByText('Disponible desde el primer día')).toBeTruthy();
    expect(screen.getByText('Disponible en parte')).toBeTruthy();
    expect(screen.getByText('En desarrollo')).toBeTruthy();
    expect(screen.getByText('Llega en la próxima fase.')).toBeTruthy();
  });

  it('con preguntas fijas (sin IA) lo dice claramente', async () => {
    server({ preview: preview({ mode: 'guided' }) });
    await toProposal();
    expect(screen.getByText(/Nuestra IA no estuvo disponible/)).toBeTruthy();
  });

  it('sin nombre no se avanza', async () => {
    server();
    await toProposal();
    fireEvent.change(screen.getByLabelText('Nombre de tu negocio'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Elegir productos/ }));
    expect(screen.getByText('Escribe el nombre de tu negocio para seguir')).toBeTruthy();
    expect(screen.queryByText('Elige qué vas a usar')).toBeNull();
  });
});

describe('Registro · productos, revisión y creación', () => {
  it('lo recomendado viene marcado y se explica; sin ninguno no se avanza', async () => {
    server();
    await toProposal();
    fireEvent.click(screen.getByRole('button', { name: /Elegir productos/ }));
    await screen.findByText('Elige qué vas a usar');
    const automation = screen.getByRole('checkbox', { name: /Automation/ }) as HTMLInputElement;
    expect(automation.checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Ads Intelligence/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: /Creative/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Trabajas con reservas/)).toBeTruthy();
    fireEvent.click(automation);
    fireEvent.click(screen.getByRole('button', { name: /Revisar y crear cuenta/ }));
    expect(screen.getByText('Elige al menos un producto para seguir.')).toBeTruthy();
  });

  it('elegir varios productos llega a la revisión con lo que se conecta después, y se crea con esa selección', async () => {
    server();
    await toProposal();
    fireEvent.click(screen.getByRole('button', { name: /Elegir productos/ }));
    await screen.findByText('Elige qué vas a usar');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ads Intelligence/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar y crear cuenta/ }));
    await screen.findByText('Revisa y crea tu cuenta');
    const summary = screen.getByRole('region', { name: 'Resumen de tu cuenta' });
    expect(within(summary).getByText('Automation')).toBeTruthy();
    expect(within(summary).getByText('Ads Intelligence')).toBeTruthy();
    expect(within(summary).getByText('Tu número de WhatsApp')).toBeTruthy();
    expect(within(summary).getByText('Google Calendar (opcional)')).toBeTruthy();
    expect(within(summary).getByText('Tu cuenta publicitaria de Meta')).toBeTruthy();
    expect(within(summary).getByText(/Tus otros programas \(Excel\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Laura Gómez' } });
    fireEvent.change(screen.getByLabelText(/Tu WhatsApp/), { target: { value: '3001234567' } });
    fireEvent.change(screen.getByLabelText(/Tu correo/), { target: { value: 'laura@gmail.com' } });
    fireEvent.change(screen.getByLabelText(/Crea una contraseña/), { target: { value: 'Golazo2026!' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Acepto los/ }));
    fireEvent.click(screen.getByRole('button', { name: /Crear mi empresa/ }));
    await waitFor(() => expect(adopt).toHaveBeenCalled());
    const body = postWithRetry.mock.calls.find((c) => c[0] === '/public/signup')![1];
    expect(body.setup.products.selected).toEqual(['AUTOMATION', 'ADS']);
    expect(body.company).toEqual({ name: 'Canchas El Golazo', city: 'Medellín' });
    expect(navigate).toHaveBeenCalledWith('/app/bienvenida', { replace: true });
  });

  it('volver entre pasos no pierde lo elegido; los errores del servidor se muestran en su campo', async () => {
    server({ createError: new ApiError('Ese correo ya tiene una cuenta. Entra con él o usa otro.', 409, 'email', 'EMAIL_TAKEN') });
    await toProposal();
    fireEvent.click(screen.getByRole('button', { name: /Elegir productos/ }));
    await screen.findByText('Elige qué vas a usar');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ads Intelligence/ }));
    fireEvent.click(screen.getByRole('button', { name: /Atrás/ }));
    await screen.findByText('Esto es lo que entendimos');
    fireEvent.click(screen.getByRole('button', { name: /Elegir productos/ }));
    await screen.findByText('Elige qué vas a usar');
    expect((screen.getByRole('checkbox', { name: /Ads Intelligence/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Revisar y crear cuenta/ }));
    await screen.findByText('Revisa y crea tu cuenta');
    // Validación local primero: sin datos no llama al servidor
    fireEvent.click(screen.getByRole('button', { name: /Crear mi empresa/ }));
    expect(screen.getByText('Escribe tu nombre')).toBeTruthy();
    expect(postWithRetry.mock.calls.some((c) => c[0] === '/public/signup')).toBe(false);
    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Laura Gómez' } });
    fireEvent.change(screen.getByLabelText(/Tu WhatsApp/), { target: { value: '3001234567' } });
    fireEvent.change(screen.getByLabelText(/Tu correo/), { target: { value: 'laura@gmail.com' } });
    fireEvent.change(screen.getByLabelText(/Crea una contraseña/), { target: { value: 'Golazo2026!' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Acepto los/ }));
    fireEvent.click(screen.getByRole('button', { name: /Crear mi empresa/ }));
    expect(await screen.findByRole('link', { name: 'Entrar con ese correo' })).toBeTruthy();
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe('Registro · avance guardado', () => {
  it('ofrece seguir donde iba; un borrador del registro anterior (3 pasos) abre en la cuenta', async () => {
    localStorage.setItem('bo_signup_v2', JSON.stringify({
      step: 3, savedAt: Date.now(), interviewDone: true,
      messages: [{ role: 'assistant', content: 'Hola' }, { role: 'user', content: 'Canchas' }],
      preview: preview(), form: { companyName: 'Canchas El Golazo', city: '', name: 'Laura', email: '', phone: '', accept: false },
    }));
    mount();
    expect(screen.getByText(/Tienes un registro a medias de Canchas El Golazo/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Seguir donde iba/ })); });
    expect(await screen.findByText('Revisa y crea tu cuenta')).toBeTruthy();
    expect((screen.getByLabelText(/Tu nombre/) as HTMLInputElement).value).toBe('Laura');
    expect((screen.getByLabelText(/Crea una contraseña/) as HTMLInputElement).value).toBe(''); // nunca se guarda
  });
});
