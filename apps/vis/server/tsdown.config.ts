import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { server: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  external: ['@nori-code/agent-core', '@nori-code/kosong', '@nori-code/kaos'],
});
