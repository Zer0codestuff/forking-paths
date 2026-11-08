import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  build: { outDir: 'dist', target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  server: { fs: { allow: ['.'] } },
});
