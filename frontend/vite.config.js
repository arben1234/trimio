import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: ['es2015', 'safari13']
  },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': 'http://localhost:3001' }
  }
});
