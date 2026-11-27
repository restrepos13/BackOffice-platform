/**
 * Píxel de Meta en la web pública. Apagado si falta VITE_META_PIXEL_ID (el ID
 * va por variable de entorno en Vercel, nunca escrito en el código).
 *
 * - Se carga DESPUÉS de que la página terminó de cargar: no le quita velocidad
 *   a la pantalla de entrada del registro.
 * - Lead (dejó el contacto) y CompleteRegistration (creó su empresa) llevan el
 *   mismo event_id que manda el servidor por la API de Conversiones: Meta los
 *   cuenta una sola vez.
 */

type Fbq = ((...args: unknown[]) => void) & { callMethod?: (...a: unknown[]) => void; queue: unknown[][]; loaded: boolean; version: string; push: Fbq };

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

export function pixelId(env: Record<string, string | undefined> = import.meta.env as any): string | null {
  const id = env.VITE_META_PIXEL_ID?.trim();
  return id && /^\d{5,20}$/.test(id) ? id : null;
}

let started = false;

/** Inyecta el píxel (una vez) y cuenta la visita. */
export function loadPixel(id = pixelId()) {
  if (!id || started || typeof window === 'undefined') return;
  started = true;
  if (!window.fbq) {
    const fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    } as Fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    window.fbq = fbq;
    window._fbq = fbq;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(s);
  }
  window.fbq!('init', id);
  window.fbq!('track', 'PageView');
}

/** Carga el píxel cuando el navegador quede libre después de cargar la página. */
export function loadPixelWhenIdle() {
  if (!pixelId() || typeof window === 'undefined') return;
  const go = () => {
    const idle = (window as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
    if (idle) idle(() => loadPixel(), { timeout: 4000 });
    else setTimeout(() => loadPixel(), 1500);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

/** Evento de conversión con event_id compartido con el servidor. */
export function pixelEvent(name: 'Lead' | 'CompleteRegistration', eventId: string, params: Record<string, unknown> = {}) {
  if (!pixelId()) return;
  loadPixel();
  try {
    window.fbq?.('track', name, params, { eventID: eventId });
  } catch {
    /* el píxel nunca rompe el registro */
  }
}

/** Cookie _fbp del píxel (si ya cargó): mejora la coincidencia en la API de Conversiones. */
export function fbpCookie(): string | undefined {
  try {
    return document.cookie.match(/(?:^|;\s*)_fbp=([^;]+)/)?.[1];
  } catch {
    return undefined;
  }
}
