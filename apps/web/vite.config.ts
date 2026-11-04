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

/** React y el enrutador cambian poco: van en su propio archivo y el navegador los conserva entre versiones. */
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|scheduler|react-router|react-router-dom|@tanstack\/[^/]+)\//.test(id)) return 'vendor';
  // Los íconos se comparten entre muchas pantallas: juntos, en vez de decenas de archivos diminutos
  if (/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?lucide-react\//.test(id)) return 'icons';
  return undefined;
}

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    react(),
    tailwindcss(),
    { name: 'og-base', transformIndexHtml: (html: string) => html.replaceAll('%OG_BASE%', ogBase()) },
  ],
  build: isSsrBuild
    ? // Prerender de las páginas públicas (scripts/prerender.mjs): se ejecuta en Node al compilar
      { outDir: 'dist-ssr', emptyOutDir: true, copyPublicDir: false }
    : { manifest: true, rollupOptions: { output: { manualChunks: vendorChunk } } },
  server: {
    // VITE_PORT / VITE_API_TARGET permiten un entorno aislado (piloto) junto al de siempre
    port: Number(process.env.VITE_PORT) || 5173,
    // Permite acceder al dev server a través de túneles ngrok (demos remotas)
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'],
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:4001',
        changeOrigin: true,
      },
    },
  },
}));
