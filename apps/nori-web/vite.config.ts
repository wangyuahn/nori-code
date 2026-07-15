import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devServerToken = env.NORI_DEV_SERVER_TOKEN;
  const devServerOrigin = (env.NORI_DEV_SERVER_ORIGIN || 'http://127.0.0.1:58627').replace(/\/$/, '');

  return {
    base: './',
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: devServerOrigin,
          ws: true,
          configure(proxy) {
            if (!devServerToken) return;
            proxy.on('proxyReq', (request) => {
              request.setHeader('Authorization', 'Bearer ' + devServerToken);
            });
            proxy.on('proxyReqWs', (request) => {
              request.setHeader('Authorization', 'Bearer ' + devServerToken);
            });
          },
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
