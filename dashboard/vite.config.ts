import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.MANDOOB_API_TARGET || 'http://127.0.0.1:3000';
  const port = Number(env.MANDOOB_WEB_PORT || 5173);
  const proxy = {
    '/api': { target, changeOrigin: true },
    '/socket.io': { target, changeOrigin: true, ws: true },
  };
  return {
    plugins: [react()],
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
    server: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      // The hosted preview is proxied through a *.e2b.app host, which is not a fixed allowlist entry.
      allowedHosts: true,
      proxy,
    },
    preview: { host: '0.0.0.0', port, strictPort: true, allowedHosts: true, proxy },
  };
});
