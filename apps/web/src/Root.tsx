import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { AuthProvider } from './lib/auth';

/**
 * Proveedores comunes. El navegador (main.tsx) y el prerender de las páginas
 * públicas (entry-prerender.tsx) usan exactamente este árbol: si difieren,
 * React no puede reutilizar el HTML prerenderizado al cargar.
 */

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false },
    },
  });
}

export function Root({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <AuthProvider>
          {children}
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                borderRadius: 0,
                border: '2px solid #1a1a1a',
                background: '#f1eeea',
                color: '#1a1a1a',
                boxShadow: '4px 4px 0 0 rgba(26,26,26,0.9)',
                fontFamily: 'Geist, sans-serif',
              },
            }}
          />
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

/** Datos que el prerender dejó en la página (por ahora, los planes públicos). */
export const SSR_DATA_ID = 'bo-ssr-data';
export type SsrData = { queries?: Array<{ key: unknown[]; data: unknown }> };
