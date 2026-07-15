import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@nori-code/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
      '@nori-code/oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'kimi-sdk',
    env: {
      NORI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts'],
  },
});
