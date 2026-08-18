import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'acp-adapter',
    include: ['test/**/*.test.ts'],
    // Image fixtures use Jimp and are CPU-heavy on Windows. Parallel files
    // delay cancellation notifications and make the 5s test deadline flaky.
    fileParallelism: process.platform !== 'win32',
  },
});
