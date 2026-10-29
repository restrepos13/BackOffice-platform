import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let start: any;
let intentRes: any;
let proposals: any;
let failIntent = false;
let failCutout = false;
const get = vi.fn(async (p: string): Promise<unknown> => (p.startsWith('/creative/create/start') ? start : {}));
const post = vi.fn(async (p: string, body?: any): Promise<unknown> => {
  if (p.startsWith('/creative/create/intent')) {
    if (failIntent) throw new Error('La IA no respondió');
    return typeof intentRes === 'function' ? intentRes(body) : intentRes;
  }
  if (p.startsWith('/creative/art/proposals')) return proposals;
  if (p.startsWith('/creative/designs')) return { id: 'd9' };
  if (p.startsWith('/creative/create/cutout') && failCutout) throw new Error('No te quedan créditos. Se renuevan el 1 del mes; si necesitas más ahora, pide un paquete adicional en Mi plan.');
  if (p.startsWith('/creative/create/cutout')) return { created: true, credits: 1, asset: { id: 'cut1', name: 'Tacos · sin fondo', width: 400, height: 500, source: 'CUTOUT', derivedFromId: 'ph1' } };
  return {};
});
vi.mock('../../../lib/api', () => ({ api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b) }, uploadFile: vi.fn(async () => ({ asset: { id: 'up1', name: 'nueva', width: 1080, height: 1080, source: 'UPLOAD', derivedFromId: null } })) }));
vi.mock('../shared', () => ({ useCompanyScope: () => ({ ready: true, q: '', canWrite: true }), withScope: (p: string) => p }));
vi.mock('./Editor', () => ({ AssetThumb: ({ asset, onClick }: any) => <button type="button" onClick={onClick}>foto {asset.name}</button> }));
vi.mock('./ArtDirector', () => ({ DocPreview: () => <div data-testid="preview" /> }));

import CreateForSale from './CreateForSale';

const intent = (over: Record<string, unknown> = {}) => ({
  intent: {
    objective: 'SALES', productId: 'p1', productName: 'Tacos al pastor', productPrice: 15000, productDescription: null, audience: null, destination: 'WHATSAPP',
    offer: null, offerConfirmed: false, offerValidity: 'este fin de semana', callToAction: 'Pide por WhatsApp', requestedFormats: ['IG_POST', 'IG_PORTRAIT', 'STORY'], assetIds: ['ph1'],
    missingInformation: [], source: 'RULES', ...over,
  },
  art: { goal: 'PRODUCT', content: { headline: 'Tacos al pastor', price: '$15.000', cta: 'Pide por WhatsApp', photos: ['ph1'] } },
  ai: { used: false, note: null },
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/app/creative']}>
        <Routes>
          <Route path="/app/creative" element={<CreateForSale q="" />} />
          <Route path="/app/creative/editor/:id" element={<p>Editor abierto</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  failIntent = false;
  failCutout = false;
  start = {
    materials: { photos: [{ id: 'ph1', name: 'Tacos', width: 1080, height: 1350, source: 'UPLOAD', derivedFromId: null }], catalog: [{ id: 'p1', name: 'Tacos al pastor', price: 15000, hasImage: false }] },
    brand: { hasLogo: false, colorsConfirmed: false, colors: [], note: 'Tu marca aún no tiene colores confirmados: usaremos una paleta provisional que puedes guardar después.' },
    ai: { available: false, note: 'Sin proveedor de IA configurado: entendemos tu descripción con reglas.' },
    cutout: { configured: false, provider: null, credits: 1, note: 'Quitar el fondo aún no está configurado en BackOffice.' },
    credits: { monthlyLeft: 3, extra: 0 }, ads: { contracted: true, connected: false }, limits: { description: 600, photos: 6 },
  };
  intentRes = intent();
  proposals = { proposals: [{ family: 'HERO', label: 'Producto protagonista', variant: 0, reason: 'Tu foto ocupa casi todo', omitted: [], doc: { width: 1080, height: 1080 }, composition: { family: 'HERO' }, checks: [] }], note: null, unavailable: [] };
  post.mockClear();
});
afterEach(cleanup);

const describeIt = async (text = 'Quiero promocionar los tacos al pastor este fin de semana por WhatsApp') => fireEvent.change(await screen.findByPlaceholderText(/Quiero promocionar los tacos/), { target: { value: text } });

describe('Creative · Crear para vender', () => {
  it('primer uso sin fotos: explica que se puede seguir sin foto y que la marca no bloquea', async () => {
    start.materials.photos = [];
    mount();
    expect(await screen.findByText('Todavía no tienes fotos')).toBeTruthy();
    expect(screen.getByText(/paleta provisional/)).toBeTruthy();
    expect(screen.getByText('Con reglas')).toBeTruthy();
    expect((screen.getByText('Preparar propuesta') as HTMLButtonElement).disabled).toBe(true);
  });

  it('describe, elige foto, ve lo que entendió, pide propuestas y abre el editor', async () => {
    mount();
    await describeIt();
    fireEvent.click(await screen.findByText('foto Tacos'));
    fireEvent.click(screen.getByText('Preparar propuesta'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/creative/create/intent', expect.objectContaining({ assetIds: ['ph1'] })));
    const box = await screen.findByTestId('intent');
    expect(within(box).getByText('Vender más')).toBeTruthy();
    expect(within(box).getByText(/precio confirmado/)).toBeTruthy();
    fireEvent.click(screen.getByText('Ver propuestas'));
    expect(await screen.findByText('Producto protagonista')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/creative/art/proposals', expect.objectContaining({ goal: 'PRODUCT', content: expect.objectContaining({ price: '$15.000' }) }));
    fireEvent.click(screen.getByText('Versión vertical'));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/creative/art/proposals', expect.objectContaining({ format: 'IG_PORTRAIT' })));
    fireEvent.click(await screen.findByText('Editar esta'));
    expect(await screen.findByText('Editor abierto')).toBeTruthy();
  });

  it('una oferta escrita queda sin publicar hasta que la persona la confirma', async () => {
    intentRes = (body: any) => intent({ offer: '2x1', offerConfirmed: body?.overrides?.offerConfirmed === true, missingInformation: body?.overrides?.offerConfirmed ? [] : [{ key: 'offer', question: 'Confirma que la oferta «2x1» es real y vigente antes de publicarla.', blocking: false }] });
    mount();
    await describeIt('Promo 2x1 en tacos al pastor hoy');
    fireEvent.click(await screen.findByText('Preparar propuesta'));
    expect(await screen.findByText(/Sin confirmar no la ponemos en la pieza/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/creative/create/intent', expect.objectContaining({ overrides: expect.objectContaining({ offerConfirmed: true }) })));
  });

  it('si falta el producto, lo pide y no deja seguir', async () => {
    intentRes = intent({ productId: null, productName: null, productPrice: null, missingInformation: [{ key: 'product', question: '¿Qué producto o servicio quieres mostrar?', blocking: true }] });
    mount();
    await describeIt('Queremos que más gente nos conozca');
    fireEvent.click(await screen.findByText('Preparar propuesta'));
    expect(await screen.findByText(/Completa lo marcado/)).toBeTruthy();
    expect((screen.getByText('Ver propuestas') as HTMLButtonElement).disabled).toBe(true);
  });

  it('un error no borra lo escrito ni las fotos elegidas', async () => {
    failIntent = true;
    mount();
    await describeIt('Quiero vender tacos al pastor por WhatsApp');
    fireEvent.click(await screen.findByText('foto Tacos'));
    fireEvent.click(screen.getByText('Preparar propuesta'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((screen.getByPlaceholderText(/Quiero promocionar los tacos/) as HTMLTextAreaElement).value).toBe('Quiero vender tacos al pastor por WhatsApp');
    expect(JSON.parse(sessionStorage.getItem('bo_creative_create_draft')!)).toMatchObject({ selected: ['ph1'] });
  });

  it('quitar fondo: sin proveedor lo dice; con proveedor muestra el costo y reemplaza la foto por el recorte', async () => {
    mount();
    fireEvent.click(await screen.findByText('foto Tacos'));
    expect(screen.getByText(/aún no está configurado/)).toBeTruthy();
    cleanup();
    sessionStorage.clear();
    start.cutout = { configured: true, provider: 'remove.bg', credits: 1 };
    mount();
    fireEvent.click(await screen.findByText('foto Tacos'));
    expect(screen.getByText(/Usa 1 crédito\(s\) · te quedan 3/)).toBeTruthy();
    fireEvent.click(screen.getByText('Quitar fondo a la primera foto'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/creative/create/cutout', { assetId: 'ph1' }));
  });

  it('un error queda a la vista con «Reintentar» y al reintentar sigue el flujo', async () => {
    failIntent = true;
    mount();
    await describeIt();
    fireEvent.click(await screen.findByText('Preparar propuesta'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/La IA no respondió.*siguen aquí/);
    failIntent = false;
    fireEvent.click(within(alert).getByText('Reintentar'));
    expect(await screen.findByTestId('intent')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('si cambia la descripción o las fotos después de interpretar, no deja seguir con datos viejos', async () => {
    mount();
    await describeIt();
    fireEvent.click(await screen.findByText('Preparar propuesta'));
    await screen.findByTestId('intent');
    expect((screen.getByText('Ver propuestas') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('foto Tacos'));
    expect(await screen.findByTestId('stale')).toBeTruthy();
    expect((screen.getByText('Ver propuestas') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Volver a interpretar'));
    await waitFor(() => expect(screen.queryByTestId('stale')).toBeNull());
    expect(post).toHaveBeenLastCalledWith('/creative/create/intent', expect.objectContaining({ assetIds: ['ph1'] }));
  });

  it('sin créditos para quitar el fondo: lo dice, enlaza a Mi plan y la foto sigue elegida', async () => {
    failCutout = true;
    start.cutout = { configured: true, provider: 'remove.bg', credits: 1 };
    mount();
    fireEvent.click(await screen.findByText('foto Tacos'));
    fireEvent.click(screen.getByText('Quitar fondo a la primera foto'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/No te quedan créditos/);
    expect(within(alert).getByText('Ver Mi plan').getAttribute('href')).toBe('/app/mi-plan');
    expect(JSON.parse(sessionStorage.getItem('bo_creative_create_draft')!)).toMatchObject({ selected: ['ph1'] });
  });
});

