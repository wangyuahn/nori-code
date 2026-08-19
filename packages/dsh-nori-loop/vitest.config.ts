import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dsh-nori-loop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
