import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar, { type SidebarProps } from './Sidebar';

type Key = 'AUTOMATION' | 'CREATIVE' | 'ADS';
const NAMES: Record<Key, [string, string]> = { AUTOMATION: ['BackOffice Automation', 'Automation'], CREATIVE: ['BackOffice Creative', 'Creative'], ADS: ['BackOffice Ads Intelligence', 'Ads Intelligence'] };
const MODULES = ['inbox', 'contacts', 'bots', 'automations', 'analytics', 'billing', 'team', 'orders', 'agenda', 'campaigns', 'gerencia'];

function company(products: Key[], extra: Record<string, unknown> = {}): any {
  return {
    id: 'c1', name: 'Café Aurora', status: 'ACTIVE', modules: MODULES, products, productsExplicit: true,
    productStates: (['AUTOMATION', 'CREATIVE', 'ADS'] as Key[]).map((k) => ({ key: k, name: NAMES[k][0], short: NAMES[k][1], home: '/', summary: '', enabled: products.includes(k) })),
    ...extra,
  };
}

let where = '';
function Probe() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}

function renderAt(path: string, props: Partial<SidebarProps> = {}) {
  const base: SidebarProps = {
    isPlatform: false, isArea: false, company: company(['AUTOMATION', 'CREATIVE', 'ADS']), companyName: 'Café Aurora', companyId: 'c1',
    onPickCompany: vi.fn(), collapsed: false, onToggleCollapse: vi.fn(), mobileOpen: false, onCloseMobile: vi.fn(),
    userName: 'Laura', roleLabel: 'Admin de empresa', viewer: false, onSecurity: vi.fn(), onLogout: vi.fn(),
  };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="*" element={<><Sidebar {...base} {...props} /><Probe /></>} /></Routes>
    </MemoryRouter>,
  );
}

const switcher = () => screen.getByRole('navigation', { name: 'Productos' });
const link = (name: string) => screen.queryByRole('link', { name: new RegExp(`^${name}`) });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('Selector de producto', () => {
  it('muestra los tres productos con nombre y descripción; el activo es inequívoco (no solo color)', () => {
    renderAt('/app/inbox');
    const buttons = within(switcher()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Automation'), expect.stringContaining('Creative'), expect.stringContaining('Ads Intelligence'),
    ]);
    const active = buttons.find((b) => b.getAttribute('aria-current') === 'true')!;
    expect(active.textContent).toMatch(/Automation.*\(producto activo\)/);
    expect(buttons.filter((b) => b.getAttribute('aria-current'))).toHaveLength(1);
  });

  it('cambiar de producto cambia el menú y lleva a su inicio la primera vez', () => {
    renderAt('/app/inbox');
    expect(link('Conversaciones')).toBeTruthy();
    fireEvent.click(within(switcher()).getByText('Creative'));
    expect(where).toBe('/app/creative?tab=inicio');
    expect(link('Mis diseños')).toBeTruthy();
    expect(link('Calendario')).toBeTruthy();
    expect(link('Conversaciones')).toBeNull();
  });

  it('volver a un producto retoma la pantalla en la que estabas (no el inicio)', () => {
    renderAt('/app/ads?tab=campanas');
    fireEvent.click(within(switcher()).getByText('Automation'));
    expect(where).toBe('/app');
    fireEvent.click(within(switcher()).getByText('Ads Intelligence'));
    expect(where).toBe('/app/ads?tab=campanas');
  });

  it('las opciones globales están en los tres productos', () => {
    for (const path of ['/app/inbox', '/app/creative', '/app/ads']) {
      renderAt(path);
      for (const name of ['Configuración', 'Equipo', 'Mi plan', 'Facturación', 'Consumo IA']) expect(link(name)).toBeTruthy();
      cleanup();
    }
  });

  it('en una pantalla global el menú sigue en el producto que venías usando', () => {
    renderAt('/app/ads?tab=leads');
    cleanup();
    renderAt('/app/settings');
    expect(within(switcher()).getAllByRole('button').find((b) => b.getAttribute('aria-current'))!.textContent).toMatch(/Ads Intelligence/);
    expect(link('Leads y ventas')).toBeTruthy();
  });
});

describe('Según lo contratado', () => {
  it('solo Creative: Automation y Ads aparecen como no activos y llevan a ver cómo activarlos; no hay opciones de ellos', () => {
    renderAt('/app/creative', { company: company(['CREATIVE']) });
    expect(within(switcher()).getAllByRole('button')).toHaveLength(1);
    const locked = within(switcher()).getByRole('link', { name: /Automation: no activo/ });
    expect(locked.getAttribute('href')).toBe('/app/producto/automation');
    expect(within(switcher()).getByRole('link', { name: /Ads Intelligence: no activo/ })).toBeTruthy();
    expect(link('Conversaciones')).toBeNull();
    expect(link('Campañas')).toBeNull();
    expect(link('Imágenes, logos y versiones')).toBeTruthy();
  });

  it('solo Ads: su menú con la biblioteca de recursos; nada de Creative ni Automation', () => {
    renderAt('/app/ads', { company: company(['ADS']) });
    expect(link('Resultados')).toBeTruthy();
    expect(link('Autopilot y reglas')).toBeTruthy();
    expect(link('Imágenes y videos')).toBeTruthy();
    expect(link('Mis diseños')).toBeNull();
    expect(link('Asistentes IA')).toBeNull();
  });

  it('solo Automation: sin Creative ni Ads; las secciones del rubro deciden (sin "media" no hay galería)', () => {
    renderAt('/app', { company: company(['AUTOMATION']) });
    expect(link('Conversaciones')).toBeTruthy();
    expect(link('Campañas por WhatsApp')).toBeTruthy();
    expect(link('Galería para chats')).toBeNull();
    expect(link('Imágenes y videos')).toBeNull();
  });

  it('dos productos: el selector ofrece esos dos y el tercero como no activo', () => {
    renderAt('/app', { company: company(['AUTOMATION', 'ADS']) });
    expect(within(switcher()).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('Automation'), expect.stringContaining('Ads Intelligence')]);
    expect(within(switcher()).getByRole('link', { name: /Creative: no activo/ })).toBeTruthy();
  });

  it('una empresa no ve Plataforma ni Dev Tools', () => {
    renderAt('/app');
    expect(screen.queryByText('Plataforma')).toBeNull();
    expect(link('Dev Tools')).toBeNull();
  });

  it('un usuario de área ve solo su área', () => {
    renderAt('/app/area', { isArea: true, company: undefined });
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Mi área']);
    expect(screen.queryByRole('navigation', { name: 'Productos' })).toBeNull();
  });

  it('solo lectura se indica junto al usuario', () => {
    renderAt('/app', { viewer: true, roleLabel: 'Solo lectura' });
    expect(screen.getByText(/solo lectura/i)).toBeTruthy();
  });
});

describe('Plataforma', () => {
  it('sin empresa elegida: Plataforma activa, productos en espera y Dev Tools en Desarrollo', () => {
    renderAt('/platform', { isPlatform: true, company: undefined, companyId: null, companies: [] });
    const buttons = within(switcher()).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(/Plataforma/);
    expect(link('Dev Tools')).toBeTruthy();
    expect(link('Configuración')).toBeNull();
  });

  it('con empresa elegida puede pasar a sus productos y volver', () => {
    renderAt('/platform/companies', { isPlatform: true });
    fireEvent.click(within(switcher()).getByText('Automation'));
    expect(where).toBe('/app');
    fireEvent.click(within(switcher()).getByText('Plataforma'));
    expect(where).toBe('/platform/companies');
  });
});

describe('Menú contraído y responsive', () => {
  it('contraído: solo íconos, pero cada opción conserva su nombre accesible; el botón lo expande', () => {
    const onToggle = vi.fn();
    const { container } = renderAt('/app/inbox', { collapsed: true, onToggleCollapse: onToggle });
    expect(container.querySelector('aside')!.getAttribute('data-collapsed')).toBe('true');
    const conv = screen.getByRole('link', { name: 'Conversaciones' });
    expect(conv.textContent).toBe('');
    expect(conv.getAttribute('title')).toBe('Conversaciones');
    expect(within(switcher()).getByRole('button', { name: 'BackOffice Creative' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expandir menú' }));
    expect(onToggle).toHaveBeenCalled();
  });

  it('expandido: el botón de contraer existe y los nombres se ven', () => {
    const onToggle = vi.fn();
    renderAt('/app/inbox', { onToggleCollapse: onToggle });
    expect(screen.getByRole('link', { name: 'Conversaciones' }).textContent).toBe('Conversaciones');
    fireEvent.click(screen.getByRole('button', { name: 'Contraer menú' }));
    expect(onToggle).toHaveBeenCalled();
  });

  it('en el celular (menú abierto) siempre se ve expandido aunque esté guardado como contraído', () => {
    const onClose = vi.fn();
    const { container } = renderAt('/app/inbox', { collapsed: true, mobileOpen: true, onCloseMobile: onClose });
    expect(container.querySelector('aside')!.getAttribute('data-collapsed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar menú' }));
    expect(onClose).toHaveBeenCalled();
  });
});
