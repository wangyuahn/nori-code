import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const appRoot = import.meta.dirname;
const common = {
  format: ['cjs'] as const,
  platform: 'node' as const,
  target: 'node20',
  outDir: 'out',
  dts: false,
  fixedExtension: true,
  alias: {
    '@': resolve(appRoot, 'src'),
  },
};

export default defineConfig([
  {
    ...common,
    entry: { main: 'src/main/index.ts', preload: 'src/preload/index.ts' },
    clean: true,
    deps: {
      alwaysBundle: [/^@nori-code\/server(?:\/.*)?$/],
      neverBundle: ['electron'],
    },
  },
  {
    ...common,
    entry: { 'server-worker': 'src/server/worker.ts' },
    clean: false,
    plugins: [rawTextPlugin()],
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: ['electron', 'node-pty'],
    },
    outputOptions: {
      codeSplitting: false,
    },
  },
]);
