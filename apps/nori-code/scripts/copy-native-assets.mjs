import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const source = resolve(repoRoot, 'packages/pi-tui/native');
const target = resolve(appRoot, 'native');

// pi-tui ships platform-specific native helpers only for darwin/win32;
// Linux has no native helper, so there is nothing to copy for it.
const PLATFORMS = ['darwin', 'win32'];

async function assertPrebuilds(platform) {
  const dir = resolve(source, platform, 'prebuilds');
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error(
      `pi-tui native prebuilds were not found at ${dir}. Build or restore packages/pi-tui first.`,
    );
  }
  return dir;
}

try {
  await rm(target, { recursive: true, force: true });
} catch (e) {
  if (e.code !== 'EPERM') throw e;
  // File is locked (e.g. Windows .node loaded by a process); continue.
  console.warn(`Warning: Could not remove ${target}, some files may be locked.`);
}
await mkdir(target, { recursive: true });

for (const platform of PLATFORMS) {
  const srcPrebuilds = await assertPrebuilds(platform);
  const dstPrebuilds = resolve(target, platform, 'prebuilds');
  try {
    await cp(srcPrebuilds, dstPrebuilds, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    console.warn(`Warning: Could not copy native assets to ${dstPrebuilds}, some files may be locked.`);
  }
}

console.log(`Copied pi-tui native prebuilds to ${target}`);
