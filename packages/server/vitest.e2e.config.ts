import { defineConfig, type UserConfig } from 'vitest/config';
import base from './vitest.config';

const shared = base as UserConfig;

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    include: ['test/**/*.e2e.test.ts'],
    exclude: [],
  },
});
