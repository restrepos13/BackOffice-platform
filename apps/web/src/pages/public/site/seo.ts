import { useEffect } from 'react';

/**
 * Datos de búsqueda de las páginas públicas. Lo mismo se usa en dos lugares:
 * en el navegador (al pasar de una página a otra) y al compilar, cuando
 * scripts/prerender.mjs escribe cada página como HTML con su <head> completo
 * (los buscadores y los asistentes como ChatGPT o Gemini leen ese HTML).
 */

export const SITE_URL = 'https://www.backoffice.store';
export const SITE_NAME = 'BackOffice';

export interface SeoMeta {
  path: string;
  title: string;
  description: string;
}

function upsert(selector: string, create: () => HTMLElement, attr: string, value: string) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

function meta(key: 'name' | 'property', name: string, value: string) {
  upsert(`meta[${key}="${name}"]`, () => {
    const m = document.createElement('meta');
    m.setAttribute(key, name);
    return m;
  }, 'content', value);
}

/** Título, descripción y URL canónica al navegar entre páginas públicas. */
export function useSeo({ path, title, description }: SeoMeta) {
  useEffect(() => {
    const url = `${SITE_URL}${path === '/' ? '/' : path}`;
    document.title = title;
    meta('name', 'description', description);
    meta('property', 'og:title', title);
    meta('property', 'og:description', description);
    meta('property', 'og:url', url);
    meta('name', 'twitter:title', title);
    meta('name', 'twitter:description', description);
    upsert('link[rel="canonical"]', () => {
      const l = document.createElement('link');
      l.setAttribute('rel', 'canonical');
      return l;
    }, 'href', url);
  }, [path, title, description]);
}

/** Despierta el servidor mientras el visitante lee (el plan gratis de Render se duerme). */
export function useWarmApi() {
  useEffect(() => {
    const t = window.setTimeout(() => {
      void fetch('/api/health', { cache: 'no-store' }).catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(t);
  }, []);
}
