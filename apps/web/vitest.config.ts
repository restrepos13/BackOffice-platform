import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Pruebas del panel (navegación y permisos en la interfaz). El servidor tiene las suyas en apps/api/test.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
});
