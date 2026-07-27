import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devServerOrigin = (env.NORI_DEV_SERVER_ORIGIN || 'http://127.0.0.1:58771').replace(/\/$/, '');
  const readDevServerToken = () => {
    const configured = env.NORI_DEV_SERVER_TOKEN?.trim();
    if (configured) return configured;
    const noriHome = env.NORI_CODE_HOME?.trim() || join(homedir(), '.nori-code');
    try {
      return readFileSync(join(noriHome, 'server.token'), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  };

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
            proxy.on('proxyReq', (request) => {
              const token = readDevServerToken();
              if (token) request.setHeader('Authorization', 'Bearer ' + token);
            });
            proxy.on('proxyReqWs', (request) => {
              const token = readDevServerToken();
              if (token) request.setHeader('Authorization', 'Bearer ' + token);
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
