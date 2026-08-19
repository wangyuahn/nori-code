import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dsh-nori-memory',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
