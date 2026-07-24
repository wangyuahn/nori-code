'use strict';

// electron-builder `beforePack` hook.
//
// Each electron-builder run targets one (platform, arch). We stage the matching
// prebuilt Nori SEA backend into `resources-stage/bin/<target>/` so that the
// `extraResources` rule copies exactly that one binary into the packaged app's
// resources. sea-path.ts resolves `<resources>/bin/<target>/nori[.exe]` at
// runtime, where <target> is `${process.platform}-${process.arch}`.
//
// We also stage the built nori-web assets into `resources-stage/nori-web/dist`
// so the packaged app contains `<resources>/nori-web/dist/index.html`.

const { existsSync, rmSync, mkdirSync, cpSync, readdirSync, statSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

// electron-builder Arch enum -> Node `process.arch` name.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function newestMtime(paths) {
  let newest = 0;
  const visit = (path) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
  };
  for (const path of paths) visit(path);
  return newest;
}

function assertFreshArtifact(artifact, inputs, buildCommand) {
  const artifactMtime = statSync(artifact).mtimeMs;
  const inputMtime = newestMtime(inputs);
  if (artifactMtime + 1_000 < inputMtime) {
    throw new Error(
      `Refusing to package stale artifact ${artifact}. ` +
        `Its source inputs are newer; rebuild with \`${buildCommand}\` first.`,
    );
  }
}

exports.default = async function beforePack(context) {
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
  const archName = ARCH_NAMES[context.arch];
  if (archName === undefined) {
    throw new Error(`Unsupported arch for packaging: ${String(context.arch)}`);
  }
  const target = `${platform}-${archName}`;
  const exe = platform === 'win32' ? 'nori.exe' : 'nori';

  const desktopRoot = resolve(__dirname, '..');
  const workspaceRoot = resolve(desktopRoot, '..', '..');
  const stageRoot = resolve(desktopRoot, 'resources-stage');

  // Stage SEA binary.
  const seaDir = resolve(desktopRoot, '..', 'nori-code', 'dist-native', 'bin', target);
  const seaExe = join(seaDir, exe);
  if (!existsSync(seaExe)) {
    throw new Error(
      `Bundled Nori server not found for ${target} at ${seaExe}. ` +
        `Build it for this platform first: \`pnpm -C apps/nori-code build:native:sea\` ` +
        `(CI builds the SEA on each platform runner before packaging).`,
    );
  }
  const desktopPackage = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf-8'));
  const nativeVersionPath = `${seaExe}.version`;
  if (!existsSync(nativeVersionPath)) {
    throw new Error(
      `Native version marker not found at ${nativeVersionPath}. ` +
        'Rebuild the native SEA before packaging.',
    );
  }
  const nativeVersion = readFileSync(nativeVersionPath, 'utf-8').trim();
  if (nativeVersion !== desktopPackage.version) {
    throw new Error(
      `Native SEA version ${nativeVersion} does not match Nori Work ${desktopPackage.version}. ` +
        'Rebuild the native SEA and desktop app from the same checkout.',
    );
  }
  const packageInputs = readdirSync(resolve(workspaceRoot, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => [
      resolve(workspaceRoot, 'packages', entry.name, 'package.json'),
      resolve(workspaceRoot, 'packages', entry.name, 'src'),
    ]);
  assertFreshArtifact(seaExe, [
    resolve(workspaceRoot, 'package.json'),
    resolve(workspaceRoot, 'pnpm-lock.yaml'),
    resolve(workspaceRoot, 'apps', 'nori-code', 'package.json'),
    resolve(workspaceRoot, 'apps', 'nori-code', 'src'),
    resolve(workspaceRoot, 'apps', 'nori-code', 'scripts', 'native'),
    ...packageInputs,
  ], 'pnpm -C apps/nori-code build:native:sea');

  const binStageDir = resolve(stageRoot, 'bin', target);
  rmSync(binStageDir, { recursive: true, force: true });
  mkdirSync(binStageDir, { recursive: true });
  cpSync(seaDir, binStageDir, { recursive: true });
  console.log(`[before-pack] staged Nori server (${target}) -> ${binStageDir}`);

  // Stage nori-web dist assets.
  const webSourceDir = resolve(desktopRoot, '..', 'nori-web', 'dist');
  const webStageDir = resolve(stageRoot, 'nori-web', 'dist');
  if (!existsSync(webSourceDir)) {
    throw new Error(
      `Built nori-web assets not found at ${webSourceDir}. ` +
        `Build them first: \`pnpm -C apps/nori-web build\`.`,
    );
  }
  assertFreshArtifact(resolve(webSourceDir, 'index.html'), [
    resolve(workspaceRoot, 'apps', 'nori-web', 'package.json'),
    resolve(workspaceRoot, 'apps', 'nori-web', 'index.html'),
    resolve(workspaceRoot, 'apps', 'nori-web', 'src'),
    resolve(workspaceRoot, 'apps', 'nori-web', 'vite.config.ts'),
  ], 'pnpm -C apps/nori-web build');
  rmSync(webStageDir, { recursive: true, force: true });
  mkdirSync(webStageDir, { recursive: true });
  cpSync(webSourceDir, webStageDir, { recursive: true });
  console.log(`[before-pack] staged nori-web assets -> ${webStageDir}`);
};
