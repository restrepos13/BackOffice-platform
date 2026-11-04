import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { getToken } from './lib/api';
import { Root, SSR_DATA_ID, createQueryClient, type SsrData } from './Root';
import './styles.css';

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
  container.replaceChildren();
  createRoot(container).render(app);
}
