import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * WhatsApp y las redes exigen la imagen de la vista previa con URL absoluta.
 * Render pasa PUBLIC_WEB_URL al build; Vercel, su dominio de producción.
 */
function ogBase(): string {
  const explicit = process.env.PUBLIC_WEB_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel}` : '';
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    { name: 'og-base', transformIndexHtml: (html) => html.replaceAll('%OG_BASE%', ogBase()) },
  ],
  server: {
    port: 5173,
    // Permite acceder al dev server a través de túneles ngrok (demos remotas)
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'],
    proxy: {
      '/api': {
        target: 'http://localhost:4001',
        changeOrigin: true,
      },
    },
  },
});
