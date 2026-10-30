import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

window.scrollTo = vi.fn() as any;

import { Contact, DataDeletion, Privacy, Terms } from './Legal';
import { LEGAL_LINKS } from './legal-links';

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/privacidad" element={<Privacy />} />
        <Route path="/terminos" element={<Terms />} />
        <Route path="/eliminacion-de-datos" element={<DataDeletion />} />
        <Route path="/contacto" element={<Contact />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('páginas legales públicas', () => {
  it('cada ruta pública carga sin sesión y enlaza a las demás', () => {
    const titles: Record<string, string> = {
      '/privacidad': 'Política de privacidad',
      '/terminos': 'Términos y condiciones',
      '/eliminacion-de-datos': 'Eliminación de datos',
      '/contacto': 'Contacto',
    };
    expect(LEGAL_LINKS.map((l) => l.to).sort()).toEqual(Object.keys(titles).sort());
    for (const [path, title] of Object.entries(titles)) {
      mount(path);
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
      for (const l of LEGAL_LINKS) expect(screen.getAllByRole('link', { name: l.label }).length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it('no atribuye una sociedad inexistente: sin NIT ni razón social inventados', () => {
    for (const path of ['/privacidad', '/terminos', '/contacto']) {
      const { container } = mount(path);
      const text = container.textContent ?? '';
      expect(text).toMatch(/persona natural/);
      expect(text).toMatch(/no tiene razón social, NIT ni registro mercantil/);
      expect(text).not.toMatch(/\[(RAZÓN SOCIAL|NIT|CORREO|NÚMERO|CIUDAD)/);
      expect(text).not.toMatch(/S\.?A\.?S\b/);
      cleanup();
    }
  });

  it('la privacidad declara el uso limitado de Google y los permisos que se piden', () => {
    mount('/privacidad');
    expect(screen.getByText(/requisitos de Uso limitado/)).toBeTruthy();
    expect(screen.getByText('drive.readonly, userinfo.email')).toBeTruthy();
    expect(screen.getByText('adwords')).toBeTruthy();
  });

  it('la eliminación de datos dice que el borrado completo es manual', () => {
    mount('/eliminacion-de-datos');
    expect(screen.getAllByText(/manual/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/automáticamente/)).toBeNull();
  });

  it('contacto muestra los canales reales', () => {
    mount('/contacto');
    for (const a of screen.getAllByRole('link', { name: /\+57 310 879 0168/ })) expect(a.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/573108790168/);
    for (const a of screen.getAllByRole('link', { name: /restrepos591@gmail\.com/ })) expect(a.getAttribute('href')).toBe('mailto:restrepos591@gmail.com');
  });
});
