/**
 * postbuild: copy tsdown's `.mjs`/`.d.mts` outputs to the `.js`/`.d.ts`
 * names the DeepSeek Harness deployment loader expects (lib/index.js).
 */
import { copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
for (const file of readdirSync(lib)) {
  if (file.endsWith('.mjs')) copyFileSync(join(lib, file), join(lib, file.replace(/\.mjs$/, '.js')));
  if (file.endsWith('.d.mts')) copyFileSync(join(lib, file), join(lib, file.replace(/\.d\.mts$/, '.d.ts')));
}
