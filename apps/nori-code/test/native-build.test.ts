import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { collectNativeAssets } from '../scripts/native/assets.mjs';
import { resolveTargetDeps, SUPPORTED_TARGETS } from '../scripts/native/native-deps.mjs';
import { appRoot } from '../scripts/native/paths.mjs';

describe('native node-pty assets', () => {
  it.each(SUPPORTED_TARGETS)('declares the runtime resources for %s', (target) => {
    const dep = resolveTargetDeps(target).find((candidate) => candidate.id === 'node-pty');

    expect(dep).toBeDefined();
    expect(dep?.collect).toBe('js-and-native-file');
    if (target.startsWith('win32-')) {
      expect(dep?.runtimeFileRelatives).toEqual(
        expect.arrayContaining([
          'lib/conpty_console_list_agent.js',
          'lib/worker/conoutSocketWorker.js',
          `prebuilds/${target}/conpty.node`,
          `prebuilds/${target}/conpty_console_list.node`,
          `prebuilds/${target}/pty.node`,
          `prebuilds/${target}/winpty-agent.exe`,
          `prebuilds/${target}/winpty.dll`,
          `prebuilds/${target}/conpty/conpty.dll`,
          `prebuilds/${target}/conpty/OpenConsole.exe`,
        ]),
      );
      expect(dep?.executableFileRelatives).toEqual([]);
    } else {
      expect(dep?.runtimeFileRelatives).toEqual([
        `prebuilds/${target}/pty.node`,
        `prebuilds/${target}/spawn-helper`,
      ]);
      expect(dep?.executableFileRelatives).toEqual([`prebuilds/${target}/spawn-helper`]);
    }
  });

  it('collects a complete host node-pty runtime tree into the SEA manifest', async () => {
    const target = `${process.platform}-${process.arch}`;
    expect(SUPPORTED_TARGETS).toContain(target);

    const { manifest, assets } = await collectNativeAssets({ appRoot, target });
    const nodePty = manifest.packages.find((pkg) => pkg.name === 'node-pty');
    expect(nodePty).toBeDefined();

    const relativeFiles = new Map(
      nodePty?.files.map((file) => [file.relativePath.replace('node_modules/node-pty/', ''), file]),
    );
    expect(relativeFiles.has('package.json')).toBe(true);
    expect(relativeFiles.has('lib/index.js')).toBe(true);

    if (process.platform === 'win32') {
      expect(relativeFiles.has('lib/conpty_console_list_agent.js')).toBe(true);
      expect(relativeFiles.has('lib/worker/conoutSocketWorker.js')).toBe(true);
      expect(relativeFiles.has(`prebuilds/${target}/conpty.node`)).toBe(true);
      expect(relativeFiles.has(`prebuilds/${target}/conpty_console_list.node`)).toBe(true);
      expect(relativeFiles.has(`prebuilds/${target}/winpty-agent.exe`)).toBe(true);
      expect(relativeFiles.has(`prebuilds/${target}/winpty.dll`)).toBe(true);
    } else {
      expect(relativeFiles.get(`prebuilds/${target}/spawn-helper`)?.mode).toBe(0o755);
    }

    for (const file of nodePty?.files ?? []) {
      const sourcePath = assets[file.assetKey];
      expect(sourcePath).toBeTypeOf('string');
      if (sourcePath === undefined) throw new Error(`Missing collected asset: ${file.assetKey}`);
      await access(sourcePath);
      expect((await readFile(sourcePath)).byteLength).toBeGreaterThan(0);
    }
  });

  it('loads the installed node-pty package when not running as SEA', async () => {
    const nodePty = await import('../scripts/native/node-pty-loader');
    expect(nodePty.spawn).toBeTypeOf('function');
    expect(nodePty.nodePtySpawnOptions({ cols: 80 }, 'win32')).toEqual({
      cols: 80,
      useConptyDll: true,
    });
    expect(nodePty.nodePtySpawnOptions({ cols: 80 }, 'linux')).toEqual({ cols: 80 });
  });
});
