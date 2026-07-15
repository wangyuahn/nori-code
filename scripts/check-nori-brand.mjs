import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function expectContains(path, fragment, reason) {
  if (!read(path).includes(fragment)) failures.push(`${path}: ${reason}`);
}

function forbid(path, fragments) {
  const content = read(path);
  for (const fragment of fragments) {
    if (content.includes(fragment)) failures.push(`${path}: contains forbidden ${JSON.stringify(fragment)}`);
  }
}

function filesUnder(path) {
  const absolute = join(root, path);
  const result = [];
  for (const entry of readdirSync(absolute)) {
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) result.push(...filesUnder(relative(root, child)));
    else result.push(relative(root, child));
  }
  return result;
}

const oldProductInfrastructure = [
  'moonshotai.github.io/kimi-code',
  'code.kimi.com/kimi-code/rg',
  'brew upgrade kimi-code',
  '@nori-code/kimi-code',
];

for (const path of [
  ...filesUnder('apps/nori-web/src'),
  ...filesUnder('apps/nori-desktop/src'),
  ...filesUnder('apps/nori-code/src'),
  ...filesUnder('packages/agent-core/src'),
]) {
  if (!/\.(?:ts|tsx|md|mjs|cjs)$/.test(path)) continue;
  forbid(path, oldProductInfrastructure);
}

for (const path of [...filesUnder('apps/nori-web/src'), ...filesUnder('apps/nori-desktop/src')]) {
  if (!/\.(?:ts|tsx)$/.test(path)) continue;
  forbid(path, ['Kimi Work', 'Kimi Code Web', 'Moonshot Work']);
}

forbid('apps/nori-code/src/cli/sub/doctor.ts', ['Kimi doctor']);
forbid('apps/nori-code/src/tui/constant/tips.ts', ['ask Kimi', 'Kimi Datasource', 'Kimi to']);
forbid('apps/nori-code/src/tui/utils/export-markdown.ts', ['# Kimi Session Export']);
forbid('apps/nori-code/src/tui/commands/session.ts', ['kimi-export-']);
for (const path of filesUnder('packages/agent-core/src/skill/builtin')) {
  if (path.endsWith('.md')) forbid(path, ['Kimi Code', 'kimi-code', '`kimi doctor`']);
}

for (const path of ['apps/kimi-desktop', 'apps/kimi-web', 'packages/kimi-migration-legacy']) {
  if (existsSync(join(root, path))) failures.push(`${path}: retired legacy source must not return`);
}
expectContains('apps/nori-desktop/build/icon.svg', 'aria-label="Nori N logo"', 'desktop icon must identify the Nori N');
expectContains('apps/nori-desktop/src/main/brand.ts', "NORI_PRODUCT_NAME = 'Nori Work'", 'desktop product name is not Nori Work');
expectContains('apps/nori-desktop/src/main/brand.ts', "NORI_APP_ID = 'com.nori.work'", 'desktop app id is not independent');
expectContains('apps/nori-desktop/electron-builder.config.cjs', "executableName: 'NoriWork'", 'desktop executable name is not independent');

if (failures.length > 0) {
  console.error(`Nori brand check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Nori brand check passed.');
}
