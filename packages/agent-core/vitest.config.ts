import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-core',
    include: ['test/**/*.{test,e2e}.ts'],
    // The agent-core suite starts many child processes and file watchers. On
    // Windows, running every file in parallel starves those processes long
    // enough to hit Vitest's 5s default and leaves killed children holding
    // temporary directories. Keep file execution serial while retaining
    // Vitest's normal intra-file isolation.
    fileParallelism: process.platform !== 'win32',
  },
});
