'use strict';

const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const RUNTIME_PACKAGES = [
  'node-pty',
  'pyright',
  'typescript-language-server',
  'typescript',
  'vscode-langservers-extracted',
  'yaml-language-server',
  'bash-language-server',
  '@vue/language-server',
  'svelte-language-server',
];

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

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function packageTarget(root, packageName) {
  return resolve(root, 'node_modules', ...packageName.split('/'));
}

function resolvePackageJson(requireFrom, packageName) {
  for (const searchPath of requireFrom.resolve.paths(packageName) ?? []) {
    const candidate = resolve(searchPath, ...packageName.split('/'), 'package.json');
    if (existsSync(candidate)) return candidate;
  }
  try {
    return requireFrom.resolve(`${packageName}/package.json`);
  } catch (packageJsonError) {
    let directory;
    try {
      directory = dirname(requireFrom.resolve(packageName));
    } catch {
      throw packageJsonError;
    }
    for (let depth = 0; depth < 12; depth++) {
      const candidate = resolve(directory, 'package.json');
      if (existsSync(candidate)) {
        const packageJson = JSON.parse(readFileSync(candidate, 'utf8'));
        if (packageJson.name === packageName) return candidate;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw packageJsonError;
  }
}

function stagePackageTree(
  packageName,
  requireFrom,
  modulesStageDir,
  staged,
  ancestors = new Map(),
) {
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson(requireFrom, packageName);
  } catch (error) {
    throw new Error(`Unable to resolve server runtime package ${packageName}: ${error.message}`);
  }
  packageJsonPath = realpathSync(packageJsonPath);
  const packageRoot = dirname(packageJsonPath);
  const target = packageTarget(modulesStageDir, packageName);
  const existingRoot = staged.get(target);
  if (existingRoot !== undefined) {
    if (existingRoot !== packageRoot) {
      throw new Error(
        `Conflicting server runtime package versions for ${packageName}: ` +
          `${existingRoot} and ${packageRoot}.`,
      );
    }
    return;
  }
  staged.set(target, packageRoot);

  mkdirSync(dirname(target), { recursive: true });
  cpSync(packageRoot, target, { recursive: true });

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const packageRequire = createRequire(packageJsonPath);
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const nextAncestors = new Map(ancestors);
  nextAncestors.set(packageName, packageRoot);
  const childModulesDir = resolve(target, 'node_modules');
  for (const dependency of Object.keys(dependencies).sort()) {
    if (nextAncestors.get(dependency) === packageRoot) continue;
    try {
      stagePackageTree(
        dependency,
        packageRequire,
        childModulesDir,
        staged,
        nextAncestors,
      );
    } catch (error) {
      if (packageJson.optionalDependencies?.[dependency] !== undefined) continue;
      throw error;
    }
  }
}

exports.default = async function beforePack(context) {
  const desktopRoot = resolve(__dirname, '..');
  const workspaceRoot = resolve(desktopRoot, '..', '..');
  const stageRoot = resolve(desktopRoot, 'resources-stage');
  const runtimeStageDir = resolve(stageRoot, 'server-runtime');
  const workerPath = resolve(desktopRoot, 'out', 'server-worker.cjs');
  const manifestPath = resolve(desktopRoot, 'out', 'server-worker.manifest.json');
  const desktopPackage = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'));

  if (!existsSync(workerPath) || !existsSync(manifestPath)) {
    throw new Error('Built server worker is missing. Run `pnpm -C apps/nori-desktop build` first.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.version !== desktopPackage.version) {
    throw new Error(
      `Server worker version ${String(manifest.version)} does not match ` +
        `Nori Work ${desktopPackage.version}.`,
    );
  }
  if (manifest.sha256 !== sha256(workerPath)) {
    throw new Error('Server worker hash does not match its build manifest. Rebuild Nori Work.');
  }
  assertFreshArtifact(workerPath, [
    resolve(workspaceRoot, 'package.json'),
    resolve(workspaceRoot, 'pnpm-lock.yaml'),
    resolve(workspaceRoot, 'apps', 'nori-desktop', 'package.json'),
    resolve(workspaceRoot, 'apps', 'nori-desktop', 'src'),
    resolve(workspaceRoot, 'packages', 'server', 'src'),
    resolve(workspaceRoot, 'packages', 'agent-core', 'src'),
  ], 'pnpm -C apps/nori-desktop build');

  rmSync(resolve(stageRoot, 'bin'), { recursive: true, force: true });
  rmSync(runtimeStageDir, { recursive: true, force: true });
  mkdirSync(runtimeStageDir, { recursive: true });
  cpSync(workerPath, resolve(runtimeStageDir, 'server-worker.cjs'));
  cpSync(manifestPath, resolve(runtimeStageDir, 'server-worker.manifest.json'));

  const requireFromAgentCore = createRequire(
    resolve(workspaceRoot, 'packages', 'agent-core', 'package.json'),
  );
  const staged = new Map();
  for (const packageName of RUNTIME_PACKAGES) {
    stagePackageTree(packageName, requireFromAgentCore, runtimeStageDir, staged);
  }
  console.log(
    `[before-pack] staged server worker ${desktopPackage.version} with ` +
      `${String(staged.size)} runtime packages -> ${runtimeStageDir}`,
  );

  const webSourceDir = resolve(desktopRoot, '..', 'nori-web', 'dist');
  const webStageDir = resolve(stageRoot, 'nori-web', 'dist');
  if (!existsSync(webSourceDir)) {
    throw new Error(
      `Built nori-web assets not found at ${webSourceDir}. ` +
        'Build them first: `pnpm -C apps/nori-web build`.',
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

  void context;
};
