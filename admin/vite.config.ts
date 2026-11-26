import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: '../server/public/admin', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8080', '/media': 'http://127.0.0.1:8080' } }
});
