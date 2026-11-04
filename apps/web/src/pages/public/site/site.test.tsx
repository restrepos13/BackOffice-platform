import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOME, HOME_FAQ, PAGES, pageByPath } from './content';
import { SITE_PAGE_PATHS } from './paths';
import { estimateSavings } from './SavingsCalculator';
import { pages } from '../../../entry-prerender';
import MarketingPage from './MarketingPage';
import Landing from '../Landing';

const vercel = JSON.parse(readFileSync(resolve(__dirname, '../../../../vercel.json'), 'utf8')) as { rewrites: Array<{ source: string; destination: string }> };

function mount(path: string, element: JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('páginas públicas para buscadores', () => {
  it('las rutas registradas en App coinciden con el contenido', () => {
    expect([...SITE_PAGE_PATHS].sort()).toEqual(PAGES.map((p) => p.path).sort());
  });

  it('Vercel sirve cada página prerenderizada y deja el resto a la app vacía', () => {
    const idx = (s: string) => vercel.rewrites.findIndex((r) => r.source === s);
    const catchAll = vercel.rewrites[vercel.rewrites.length - 1];
    expect(catchAll.destination).toBe('/app.html');
    for (const p of pages().filter((p) => p.path !== '/')) {
      const i = idx(p.path);
      expect(i, p.path).toBeGreaterThanOrEqual(0);
      expect(vercel.rewrites[i].destination).toBe(`${p.path}.html`);
      expect(i).toBeLessThan(vercel.rewrites.length - 1);
    }
  });

  it('títulos y descripciones caben en el resultado de Google y no se repiten', () => {
    const all = pages();
    for (const p of all) {
      expect(p.title.length, p.title).toBeLessThanOrEqual(66);
      expect(p.description.length, p.path).toBeLessThanOrEqual(160);
      expect(p.description.length, p.path).toBeGreaterThanOrEqual(70);
    }
    expect(new Set(all.map((p) => p.title)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.description)).size).toBe(all.length);
  });

  it('los enlaces relacionados apuntan a páginas que existen', () => {
    for (const p of PAGES) for (const r of p.related) expect(pageByPath(r), `${p.path} → ${r}`).toBeTruthy();
  });

  it('los datos estructurados incluyen las preguntas frecuentes y los precios solo si hay planes', () => {
    const home = pages()[0];
    const faq = home.jsonLd.find((x: any) => x['@type'] === 'FAQPage') as any;
    expect(faq.mainEntity).toHaveLength(HOME_FAQ.length);
    expect(home.jsonLd.find((x: any) => x['@type'] === 'SoftwareApplication')).not.toHaveProperty('offers');
    const withPlans = pages({ plans: [{ name: 'A', tier: null, maxLines: 1, priceSelf: 100, priceManaged: 300, includedMetaUsd: 0, highlight: false, features: [] }], modes: {} as any, addons: [], notices: {} as any });
    const app = withPlans[0].jsonLd.find((x: any) => x['@type'] === 'SoftwareApplication') as any;
    expect(app.offers).toMatchObject({ priceCurrency: 'COP', lowPrice: 100, highPrice: 300 });
  });

  it('la calculadora usa la fórmula que explica la página', () => {
    const r = estimateSavings({ chats: 40, minutes: 4, days: 26, hourCost: 10000, repetitive: 50 });
    expect(r.hours).toBeCloseTo(69.33, 1);
    expect(r.cost).toBeCloseTo(693_333, -1);
    expect(r.saved).toBeCloseTo(r.cost / 2, 0);
  });
});

describe('render de las páginas públicas', () => {
  it('cada página de contenido tiene un solo h1 y sus preguntas frecuentes', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    for (const p of PAGES) {
      mount(p.path, <MarketingPage />);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      for (const f of p.faq) expect(screen.getByText(f.q)).toBeTruthy();
      cleanup();
    }
    vi.unstubAllGlobals();
  });

  it('la portada explica qué hace y enlaza a sectores y calculadora sin depender del API', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    mount('/', <Landing />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe(HOME.title);
    expect(screen.getAllByRole('link', { name: /Restaurantes y domicilios/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /Calculadora/ }).length).toBeGreaterThan(0);
    // Sin respuesta del API, los planes muestran un texto en vez de quedar vacíos
    expect(screen.getByText(/Planes mensuales según cuántos números/)).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
