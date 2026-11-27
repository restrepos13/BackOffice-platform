import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { getToken } from './lib/api';
import { loadPixelWhenIdle } from './lib/meta-pixel';
import { captureOrigin } from './lib/origin';
import { Root, SSR_DATA_ID, createQueryClient, type SsrData } from './Root';
import './styles.css';

// De dónde llegó (utm, ?g=, fbclid, referrer): se guarda en cualquier página de entrada
captureOrigin();

const queryClient = createQueryClient();
const container = document.getElementById('root')!;
const app = (
  <Root client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </Root>
);

// Página pública prerenderizada (portada, soluciones, legales): React reutiliza
// ese HTML en vez de redibujarlo. Con sesión abierta, la portada redirige al
// panel, así que ahí se descarta el HTML y se dibuja de cero.
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const prerendered = container.dataset.ssr;
if (prerendered && prerendered === path && !(path === '/' && getToken())) {
  try {
    const raw = document.getElementById(SSR_DATA_ID)?.textContent;
    const data: SsrData = raw ? JSON.parse(raw) : {};
    for (const q of data.queries ?? []) queryClient.setQueryData(q.key, q.data);
  } catch {
    /* sin datos: la página los pide al servidor */
  }
  hydrateRoot(container, app);
} else {
  // /registro llega con la pantalla de entrada ya dibujada (registro.html): lo que
  // la persona alcanzó a escribir antes de que cargara la app no se pierde
  if (container.dataset.early) {
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
    (window as unknown as { __signupEarly?: unknown }).__signupEarly = {
      companyName: val('signup-company'),
      phone: val('signup-phone'),
      email: val('signup-email'),
      submitted: !!(window as unknown as { __signupEarlySubmitted?: boolean }).__signupEarlySubmitted,
    };
  }
  container.replaceChildren();
  createRoot(container).render(app);
}

// Píxel de Meta (si VITE_META_PIXEL_ID está configurado): solo en la web pública
// (nunca con sesión abierta: el panel no se mide) y después de que la página terminó de cargar
if (!getToken() && !/^\/(app|platform|dev|courier|m|t|print)(\/|$)/.test(path) && path !== '/login') loadPixelWhenIdle();
