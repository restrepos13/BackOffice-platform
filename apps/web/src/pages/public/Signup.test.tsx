import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupProfile } from '../../lib/setup';
import type { Preview } from './signup-helpers';

/**
 * Registro con el servidor simulado: contacto primero (una sola pantalla), las
 * 5 preguntas que se responden tocando, el adelanto, la propuesta (una sola
 * llamada de IA), productos, revisión y creación; retomar desde el correo.
 */

// Cada prueba recorre el registro completo: con toda la suite en paralelo puede pasar de 5 s
vi.setConfig({ testTimeout: 15_000 });

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
import { VOLUME_QUESTION } from './signup/questions';

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

function server(opts: { preview?: Preview; createError?: unknown; resume?: unknown } = {}) {
  postWithRetry.mockImplementation(async (path: string) => {
    if (path === '/public/signup/preview') return opts.preview ?? preview();
    if (path === '/public/signup/resume') {
      if (opts.resume instanceof Error) throw opts.resume;
      return opts.resume;
    }
    if (path === '/public/signup') {
      if (opts.createError) throw opts.createError;
      return { token: 't', user: { id: 'u' } };
    }
    throw new Error(`ruta inesperada ${path}`);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const posted = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse(init.body));
const events = () => posted('/api/public/signup/event').map((b) => (b.questionNo ? `${b.type}:${b.questionNo}` : b.type));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Signup /></MemoryRouter></QueryClientProvider>);
}

function fillContact(company = 'Canchas El Golazo', phone = '3001234567') {
  fireEvent.change(screen.getByLabelText('Nombre de tu negocio'), { target: { value: company } });
  fireEvent.change(screen.getByLabelText('Tu WhatsApp'), { target: { value: phone } });
  fireEvent.click(screen.getByRole('button', { name: /Empezar mi diagnóstico/ }));
}

/** Las 5 preguntas, casi todas tocando. */
async function answerAll() {
  fireEvent.click(screen.getByRole('button', { name: 'Reservas (canchas, hospedaje)' }));
  fireEvent.change(await screen.findByLabelText('Tu respuesta'), { target: { value: 'Cancha de fútbol 5 a $90.000 la hora' } });
  fireEvent.click(screen.getByRole('button', { name: /^Continuar/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Seguir · faltan 3/ }));
  fireEvent.click(screen.getByRole('button', { name: /Tomar reservas/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Continuar/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Por horas' }));
  fireEvent.click(await screen.findByRole('button', { name: '10 a 30' }));
}

async function toProposal() {
  mount();
  fillContact();
  await answerAll();
  await screen.findByText('Esto es lo que entendimos');
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  postWithRetry.mockReset();
  adopt.mockReset();
  navigate.mockReset();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as any;
  window.history.replaceState(null, '', '/registro');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as any).__signupEarly;
});

describe('Registro · paso 0: contacto primero', () => {
  it('una sola pantalla: una frase, negocio, WhatsApp y el botón; sin pasos ni preguntas', () => {
    server();
    mount();
    expect(screen.getByRole('heading', { name: /Tu WhatsApp atendiendo solo/ })).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Tus datos de contacto' });
    const fields = within(form).getAllByRole('textbox');
    // Arriba del botón: nombre del negocio y WhatsApp (el correo es opcional y va debajo)
    expect(fields.map((f) => f.id)).toEqual(['signup-company', 'signup-phone', 'signup-email']);
    const button = within(form).getByRole('button', { name: /Empezar mi diagnóstico/ });
    expect(button.compareDocumentPosition(screen.getByLabelText(/Te mandamos el resumen/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('+57')).toBeTruthy();
    expect(screen.getByRole('link', { name: /política de tratamiento de datos/ }).getAttribute('href')).toBe('/privacidad');
    expect(screen.queryByRole('navigation', { name: 'Pasos del registro' })).toBeNull();
    expect(screen.queryByText(/Pregunta 1 de 5/)).toBeNull();
  });

  it('valida, deja el contacto sin esperar al servidor (reintenta si duerme) y pasa a la pregunta 1', async () => {
    server();
    let tries = 0;
    fetchMock.mockImplementation(async (url: string) => (url === '/api/public/signup/contact' && tries++ === 0 ? { ok: false, status: 503 } : { ok: true, status: 200 }));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      mount();
      fireEvent.click(screen.getByRole('button', { name: /Empezar mi diagnóstico/ }));
      expect(screen.getByText('Escribe el nombre de tu negocio')).toBeTruthy();
      expect(screen.getByText('Escribe tu número de WhatsApp')).toBeTruthy();
      fillContact('Canchas El Golazo', '300123');
      expect(screen.getByText(/Debe tener 10 números/)).toBeTruthy();
      expect(posted('/api/public/signup/contact')).toHaveLength(0);
      fillContact('Canchas El Golazo', '3001234567');
      expect(screen.getByText('Pregunta 1 de 5')).toBeTruthy();
      expect(screen.getByText(/5 preguntas · 2 minutos/)).toBeTruthy();
      await vi.waitFor(() => expect(posted('/api/public/signup/contact')).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(4_000); // 503 → reintenta
      const sent = posted('/api/public/signup/contact');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ companyName: 'Canchas El Golazo', phone: '300 123 4567', accept: true });
      expect(sent[1].session).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('el correo es opcional, pero si lo escribe debe estar bien', () => {
    server();
    mount();
    fireEvent.change(screen.getByLabelText(/Te mandamos el resumen/), { target: { value: 'rosa@gmail' } });
    fillContact();
    expect(screen.getByText(/A ese correo le falta algo/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Te mandamos el resumen/), { target: { value: 'rosa@gmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Empezar mi diagnóstico/ }));
    expect(screen.getByText('Pregunta 1 de 5')).toBeTruthy();
  });

  it('cada momento de la entrada deja su evento: cargó, vio, empezó a escribir y tocó Empezar', async () => {
    server();
    mount();
    fireEvent.change(screen.getByLabelText('Nombre de tu negocio'), { target: { value: 'C' } });
    fireEvent.change(screen.getByLabelText('Nombre de tu negocio'), { target: { value: 'Ca' } });
    fillContact();
    await waitFor(() => expect(events()).toContain('pregunta_vista:1'));
    const before = events().slice(0, events().indexOf('pregunta_vista:1'));
    expect([...before].sort()).toEqual(['contacto_enviado', 'formulario_empezado', 'formulario_visto', 'presentacion_vista', 'registro_abierto']);
    // Empezó a escribir: solo la primera tecla cuenta
  });

  it('lo escrito antes de que cargara la página no se pierde, y si ya tocó Empezar se envía solo', async () => {
    server();
    (window as any).__signupEarly = { companyName: 'Doña Rosa', phone: '3105551234', email: '', submitted: true };
    mount();
    expect(await screen.findByText('Pregunta 1 de 5')).toBeTruthy();
    await waitFor(() => expect(posted('/api/public/signup/contact')[0]).toMatchObject({ companyName: 'Doña Rosa', phone: '310 555 1234' }));
  });
});

describe('Registro · las 5 preguntas', () => {
  it('se responden tocando, con barra de avance, adelanto después de la 2 y una sola llamada de IA al final', async () => {
    server();
    mount();
    fillContact();
    expect(screen.getByRole('progressbar', { name: 'Avance de las preguntas' }).getAttribute('aria-valuemax')).toBe('5');
    fireEvent.click(screen.getByRole('button', { name: 'Reservas (canchas, hospedaje)' }));
    expect(await screen.findByText('Pregunta 2 de 5')).toBeTruthy();
    expect(screen.getByText('¿Qué alquilas o reservas y más o menos a qué precio?')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tu respuesta'), { target: { value: 'Cancha de fútbol 5 a $90.000 la hora' } });
    fireEvent.click(screen.getByRole('button', { name: /^Continuar/ }));
    // Adelanto: 3 viñetas como máximo, con lo que respondió
    expect(await screen.findByText('Con lo que me contaste, tu asistente podría:')).toBeTruthy();
    const bullets = screen.getAllByRole('listitem').filter((li) => li.closest('ul')?.parentElement?.textContent?.includes('Adelanto'));
    expect(bullets.length).toBeLessThanOrEqual(3);
    expect(screen.getByText(/Responder precios de cancha de fútbol 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Seguir · faltan 3/ }));
    // 3: varias opciones
    expect(screen.getByText('Pregunta 3 de 5')).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Continuar/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Tomar reservas/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pedir anticipo/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Continuar/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Por horas' }));
    expect(await screen.findByText('Pregunta 5 de 5')).toBeTruthy();
    expect(postWithRetry).not.toHaveBeenCalled(); // ninguna pregunta gasta IA
    fireEvent.click(screen.getByRole('button', { name: '10 a 30' }));
    await screen.findByText('Esto es lo que entendimos');
    expect(postWithRetry).toHaveBeenCalledTimes(1);
    const body = postWithRetry.mock.calls[0][1];
    expect(body.messages.slice(0, 2)).toEqual([{ role: 'assistant', content: '¿Cómo se llama tu negocio?' }, { role: 'user', content: 'Canchas El Golazo' }]);
    // El volumen va con el texto exacto que el servidor reconoce
    const vol = body.messages.findIndex((m: any) => m.content === VOLUME_QUESTION);
    expect(body.messages[vol + 1]).toEqual({ role: 'user', content: '10 a 30' });
    expect(body.messages.find((m: any) => m.content.startsWith('Quiero que el asistente'))?.content).toBe('Quiero que el asistente: tomar reservas, pedir anticipo');
    // Embudo: cada pregunta vista y respondida, con el avance para retomar
    expect(events()).toEqual(expect.arrayContaining(['pregunta_vista:1', 'pregunta_respondida:1', 'adelanto_visto', 'pregunta_vista:5', 'pregunta_respondida:5', 'plan_revisado']));
    const last = posted('/api/public/signup/event').find((b) => b.type === 'pregunta_respondida' && b.questionNo === 5);
    expect(last.progress).toMatchObject({ tipo: 'Reservas (canchas, hospedaje)', volumen: '10 a 30' });
  });

  it('siempre hay «Otro» con texto libre; Atrás vuelve sin perder lo respondido', async () => {
    server();
    mount();
    fillContact();
    fireEvent.click(screen.getByRole('button', { name: 'Otro' }));
    fireEvent.change(screen.getByPlaceholderText('Escribe tu tipo de negocio'), { target: { value: 'Lavadero de carros' } });
    fireEvent.click(screen.getByRole('button', { name: /^Continuar/ }));
    expect(await screen.findByText('Pregunta 2 de 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lo agrego después' }));
    fireEvent.click(await screen.findByRole('button', { name: /Atrás/ }));
    expect(screen.getByText('Pregunta 2 de 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Atrás/ }));
    expect(screen.getByText('Pregunta 1 de 5')).toBeTruthy();
    expect((screen.getByPlaceholderText('Escribe tu tipo de negocio') as HTMLInputElement).value).toBe('Lavadero de carros');
  });

  it('se puede pedir ayuda de una persona desde las preguntas', () => {
    server();
    mount();
    fillContact();
    fireEvent.click(screen.getByRole('button', { name: /¿Prefieres que te ayudemos nosotros\?/ }));
    expect(screen.getByRole('button', { name: /Que me escriban hoy/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Agendar una videollamada de 15 min/ })).toBeTruthy();
  });
});

describe('Registro · retomar', () => {
  it('el enlace del correo retoma en la pregunta donde iba, con la misma sesión', async () => {
    server({ resume: { session: 'sesion_del_correo_123456', answers: { tipo: 'Belleza o estética', oferta: 'Uñas $45.000' }, link: null, contact: { companyName: 'Uñas Bellas', phone: '3001112233', email: 'a@b.co' } } });
    window.history.replaceState(null, '', '/registro?retomar=abc.def');
    mount();
    expect(await screen.findByText('Pregunta 3 de 5')).toBeTruthy();
    expect(screen.getByText('¿Qué quieres que haga tu asistente?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Agendar citas/ })).toBeTruthy(); // opciones de belleza
    expect(localStorage.getItem('bo_signup_session')).toBe('sesion_del_correo_123456');
    expect(window.location.search).toBe('');
    expect(postWithRetry.mock.calls[0]).toEqual(['/public/signup/resume', { t: 'abc.def' }, expect.anything()]);
  });

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

  it('una entrevista vieja a medias no se retoma, pero su contacto se aprovecha', () => {
    localStorage.setItem('bo_signup_v2', JSON.stringify({
      v: 3, step: 1, savedAt: Date.now(), interviewDone: false, preview: null,
      messages: [{ role: 'assistant', content: 'Hola' }, { role: 'user', content: 'Canchas' }],
      form: { companyName: 'Canchas El Golazo', city: '', name: 'Laura', email: '', phone: '300 123 4567', accept: false },
    }));
    mount();
    expect(screen.queryByText(/Tienes un registro a medias/)).toBeNull();
    expect((screen.getByLabelText('Nombre de tu negocio') as HTMLInputElement).value).toBe('Canchas El Golazo');
    expect((screen.getByLabelText('Tu WhatsApp') as HTMLInputElement).value).toBe('300 123 4567');
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
    expect(screen.getByText(/Trabajas con reservas/)).toBeTruthy();
    fireEvent.click(automation);
    fireEvent.click(screen.getByRole('button', { name: /Revisar y crear cuenta/ }));
    expect(screen.getByText('Elige al menos un producto para seguir.')).toBeTruthy();
  });

  it('elegir varios productos llega a la revisión y se crea con esa selección y las mismas respuestas', async () => {
    server();
    await toProposal();
    fireEvent.click(screen.getByRole('button', { name: /Elegir productos/ }));
    await screen.findByText('Elige qué vas a usar');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ads Intelligence/ }));
    fireEvent.click(screen.getByRole('button', { name: /Revisar y crear cuenta/ }));
    await screen.findByText('Revisa y crea tu cuenta');
    const summary = await screen.findByRole('region', { name: 'Resumen de tu cuenta' });
    expect(within(summary).getByText('Automation')).toBeTruthy();
    expect(within(summary).getByText('Ads Intelligence')).toBeTruthy();
    expect(within(summary).getByText('Solicitado. Lo activa nuestro equipo y te avisamos.')).toBeTruthy();
    // Negocio y WhatsApp ya vienen del paso 0
    expect((screen.getByLabelText(/Tu WhatsApp/) as HTMLInputElement).value).toBe('300 123 4567');

    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Laura Gómez' } });
    fireEvent.change(screen.getByLabelText(/Tu correo/), { target: { value: 'laura@gmail.com' } });
    fireEvent.change(screen.getByLabelText(/Crea una contraseña/), { target: { value: 'Golazo2026!' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Acepto los/ }));
    fireEvent.click(screen.getByRole('button', { name: /Crear mi empresa/ }));
    await waitFor(() => expect(adopt).toHaveBeenCalled());
    const body = postWithRetry.mock.calls.find((c) => c[0] === '/public/signup')![1];
    expect(body.setup.products.selected).toEqual(['AUTOMATION']);
    expect(body.setup.products.requested).toEqual(['ADS']);
    expect(body.company).toEqual({ name: 'Canchas El Golazo', city: 'Medellín' });
    expect(body.messages).toEqual(postWithRetry.mock.calls.find((c) => c[0] === '/public/signup/preview')![1].messages);
    expect(navigate).toHaveBeenCalledWith('/app/bienvenida', { replace: true });
    expect(events()).toContain('datos_llenados');
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
    fireEvent.click(screen.getByRole('button', { name: /Crear mi empresa/ }));
    expect(screen.getByText('Escribe tu correo')).toBeTruthy();
    expect(postWithRetry.mock.calls.some((c) => c[0] === '/public/signup')).toBe(false);
    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Laura Gómez' } });
    fireEvent.change(screen.getByLabelText(/Tu correo/), { target: { value: 'laura@gmail.com' } });
    fireEvent.change(screen.getByLabelText(/Crea una contraseña/), { target: { value: 'Golazo2026!' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Acepto los/ }));
    fireEvent.click(screen.getByRole('button', { name: /Crear mi empresa/ }));
    expect(await screen.findByRole('link', { name: 'Entrar con ese correo' })).toBeTruthy();
    expect(adopt).not.toHaveBeenCalled();
  });
});
