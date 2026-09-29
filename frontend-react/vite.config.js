import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // В dev ходим на рабочий API (локальный или удалённый по env)
      '/api': { target: process.env.VITE_API_URL || 'http://localhost:3000', changeOrigin: true }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});