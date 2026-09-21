import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App';
import { AuthProvider } from './lib/auth';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
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
  </StrictMode>,
);
