import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const convo = (over: Record<string, unknown> = {}) => ({
  id: 'c1', companyId: 'coA', channel: 'WHATSAPP', status: 'OPEN', needsAttention: false, botPaused: false, attendedByName: null, unreadCount: 2,
  lastMessageAt: '2026-10-27T15:00:00Z', contact: { id: 'ct1', name: 'Laura', phone: '+573001112233', stage: 'CURIOSO' },
  integration: { id: 'tw', name: 'Línea Twilio' }, messages: [{ id: 'm1', content: 'hola' }], assignedToId: null, assignedToName: null, ...over,
});

let page: any;
let windowState: any;
let messages: any[];
let notes: any[];
const calls: string[] = [];
const get = vi.fn(async (path: string): Promise<unknown> => {
  calls.push(`GET ${path}`);
  if (path.startsWith('/conversations/inbox')) return path.includes('cursor=') ? { items: [convo({ id: 'c9', contact: { id: 'x', name: 'Pedro', stage: 'CURIOSO' } })], nextCursor: null, counts: page.counts } : page;
  if (path.startsWith('/conversations/channels')) return [{ id: 'tw', name: 'Línea Twilio', type: 'WHATSAPP', provider: 'TWILIO', state: 'PENDING_VERIFICATION', label: 'Pendiente de verificación', detail: null, verifiedAt: null }];
  if (path.startsWith('/conversations/assignees')) return [{ id: 'uA', name: 'Ana' }, { id: 'uB', name: 'Beto' }];
  if (/\/conversations\/c1\/messages/.test(path)) return { items: messages, hasOlder: false, oldest: messages[0]?.createdAt ?? null };
  if (/\/conversations\/c1\/notes/.test(path)) return { items: notes, hasOlder: false };
  if (/\/conversations\/c1\/window/.test(path)) return windowState;
  if (/\/conversations\/c1\?messages=none/.test(path)) return convo();
  if (path.startsWith('/integrations')) return [];
  if (path.startsWith('/quick-replies')) return [];
  return [];
});
const post = vi.fn(async (path: string, body?: unknown): Promise<unknown> => { calls.push(`POST ${path} ${JSON.stringify(body ?? {})}`); return {}; });
const patch = vi.fn(async (path: string, body?: unknown): Promise<unknown> => { calls.push(`PATCH ${path} ${JSON.stringify(body ?? {})}`); return { assignedToName: 'Beto' }; });
vi.mock('../../lib/api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b), delete: vi.fn() } }));
let liveHandler: ((e: any) => void) | null = null;
let reconnectHandler: (() => void) | null = null;
vi.mock('../../lib/events', () => ({ useLiveEvents: (_c: unknown, h: (e: any) => void, _e: boolean, r: () => void) => { liveHandler = h; reconnectHandler = r; return 'live'; } }));
vi.mock('./shared', () => ({ useCompanyScope: () => ({ ready: true, q: '', canWrite: true, companyId: null, isPlatform: false }), withScope: (p: string) => p, PickCompany: () => null }));
vi.mock('./Agenda', () => ({ AppointmentModal: () => null, FollowUpModal: () => null }));
vi.mock('../../components/ChatInsights', () => ({ default: () => null }));
vi.mock('../../components/media', () => ({ MediaImage: () => null, MessageFile: () => null }));

import Inbox from './Inbox';

function mount(path = '/app/inbox') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Inbox /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  page = { items: [convo()], nextCursor: 'c1cursor', counts: { unread: 3, mine: 1, unassigned: 4, attention: 0 } };
  windowState = { mode: 'FREE_TEXT', provider: 'TWILIO', channel: 'WHATSAPP', withinWindow: true, lastInboundAt: '2026-10-27T14:00:00Z', expiresAt: '2026-10-28T14:00:00Z', reason: null, templates: [], channelState: null };
  messages = [
    { id: 'm1', direction: 'IN', author: 'CONTACT', content: 'hola', createdAt: '2026-10-27T14:00:00Z' },
    { id: 'm2', direction: 'OUT', author: 'AGENT', authorName: 'Ana', content: 'Te escribo', deliveryStatus: 'FAILED', deliveryError: 'Meta: número inválido', createdAt: '2026-10-27T14:05:00Z' },
    { id: 'm3', direction: 'OUT', author: 'AGENT', content: '¿Sigues ahí?', deliveryStatus: 'UNCERTAIN', deliveryError: 'Sin confirmación', createdAt: '2026-10-27T14:10:00Z' },
    { id: 'm4', direction: 'OUT', author: 'BOT', content: 'prueba', deliveryStatus: 'SIMULATED', createdAt: '2026-10-27T14:11:00Z' },
  ];
  notes = [{ id: 'n1', authorId: 'uA', authorName: 'Ana', body: 'Pidió factura', createdAt: '2026-10-27T14:07:00Z' }];
  calls.length = 0;
  post.mockClear();
  patch.mockClear();
});
afterEach(cleanup);

describe('Bandeja · lista', () => {
  it('muestra contadores reales, el estado verificable de los canales, filtra y carga más', async () => {
    mount();
    expect(await screen.findByText('Laura')).toBeTruthy();
    expect(screen.getByTestId('inbox-counts').textContent).toMatch(/Mías abiertas: 1 · Sin responsable: 4/);
    expect(screen.getByText('No leídas (3)')).toBeTruthy();
    expect(within(await screen.findByTestId('channel-strip')).getByText('Pendiente de verificación')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filtrar por canal'), { target: { value: 'INSTAGRAM' } });
    await waitFor(() => expect(calls.some((c) => c.includes('/conversations/inbox?channel=INSTAGRAM'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Filtrar por canal'), { target: { value: '' } });
    fireEvent.click(await screen.findByText('Cargar más'));
    expect(await screen.findByText('Pedro')).toBeTruthy();
    expect(calls.some((c) => c.includes('cursor=c1cursor'))).toBe(true);
    fireEvent.click(within(screen.getByTestId('channel-strip')).getByText('Verificar'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/channels/tw/verify', undefined));
  });
});

describe('Bandeja · conversación', () => {
  it('historial con notas internas diferenciadas, estados reales de entrega y reenvío con confirmación', async () => {
    mount('/app/inbox?open=c1');
    const tl = await screen.findByTestId('timeline');
    expect(await within(tl).findByText('Pidió factura')).toBeTruthy();
    expect(within(screen.getByTestId('note')).getByText(/no la ve el cliente/)).toBeTruthy();
    expect(within(tl).getByText('Meta: número inválido')).toBeTruthy();
    expect(within(tl).getByText('Modo prueba: no salió')).toBeTruthy();
    // Orden cronológico: la nota (14:07) va entre el fallido (14:05) y el incierto (14:10)
    const text = tl.textContent ?? '';
    expect(text.indexOf('Te escribo')).toBeLessThan(text.indexOf('Pidió factura'));
    expect(text.indexOf('Pidió factura')).toBeLessThan(text.indexOf('¿Sigues ahí?'));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const resendButtons = within(tl).getAllByText('Reenviar');
    fireEvent.click(resendButtons[1]); // el incierto: pide confirmación y aquí se cancela
    expect(confirmSpy).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining('/resend'), expect.anything());
    fireEvent.click(resendButtons[0]); // el fallido sale sin confirmar
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/c1/messages/m2/resend', { confirm: false }));
    confirmSpy.mockRestore();
  });

  it('una nota interna se guarda como nota, nunca como mensaje al cliente', async () => {
    mount('/app/inbox?open=c1');
    await screen.findByTestId('timeline');
    fireEvent.click(screen.getByRole('tab', { name: 'Nota interna' }));
    fireEvent.change(screen.getByLabelText('Nota interna'), { target: { value: 'Cliente VIP' } });
    fireEvent.click(screen.getByLabelText('Guardar nota'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/c1/notes', { body: 'Cliente VIP' }));
    expect(post).not.toHaveBeenCalledWith('/conversations/c1/messages', expect.anything());
  });

  it('fuera de la ventana: no deja escribir texto libre y ofrece la plantilla con sus variables', async () => {
    windowState = { ...windowState, mode: 'TEMPLATE_ONLY', withinWindow: false, reason: 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite una plantilla aprobada.', templates: [{ key: 'retomar', name: 'Retomar', body: 'Hola {{1}}', variables: 1 }] };
    mount('/app/inbox?open=c1');
    expect(await screen.findByText(/solo permite una plantilla aprobada/)).toBeTruthy();
    expect((screen.getByLabelText('Mensaje al cliente') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar plantilla' }));
    fireEvent.change(screen.getByRole('dialog').querySelector('select')!, { target: { value: 'retomar' } });
    fireEvent.change(screen.getByLabelText('Variable {{1}}'), { target: { value: 'Laura' } });
    expect(screen.getByText('Hola Laura')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Enviar plantilla' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/c1/messages', { content: '', template: { key: 'retomar', variables: ['Laura'] } }));
  });

  it('cambia el responsable y se actualiza en vivo (también al reconectar)', async () => {
    mount('/app/inbox?open=c1');
    await screen.findByTestId('timeline');
    const select = await screen.findByLabelText('Responsable');
    await waitFor(() => expect(within(select).getByText('Beto')).toBeTruthy());
    fireEvent.change(select, { target: { value: 'uB' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/conversations/c1/assign', { assigneeId: 'uB' }));
    const before = calls.filter((c) => c.startsWith('GET /conversations/c1/notes')).length;
    act(() => liveHandler?.({ type: 'note.new', conversationId: 'c1', at: Date.now() }));
    await waitFor(() => expect(calls.filter((c) => c.startsWith('GET /conversations/c1/notes')).length).toBeGreaterThan(before));
    const inboxBefore = calls.filter((c) => c.startsWith('GET /conversations/inbox')).length;
    act(() => reconnectHandler?.());
    await waitFor(() => expect(calls.filter((c) => c.startsWith('GET /conversations/inbox')).length).toBeGreaterThan(inboxBefore));
  });
});
