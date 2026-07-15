import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  deps: {
    neverBundle: [
      '@agentclientprotocol/sdk',
      '@nori-code/agent-core',
      '@nori-code/sdk',
      '@nori-code/kosong',
      '@nori-code/kaos',
    ],
  },
});
