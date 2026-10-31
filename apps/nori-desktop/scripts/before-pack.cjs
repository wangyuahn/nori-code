'use strict';

const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} = require('node:fs');
const { dirname, basename, join, resolve } = require('node:path');

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

// 返回 dir 在 staged 树里的上一级安装层：即"包含当前目录的 node_modules"所在层。
// runtimeStageDir/node_modules/a/node_modules/b 的层链是
// [b 目录, a 目录, runtimeStageDir]。
function upLevel(dir) {
  if (basename(dir) === 'node_modules') return dirname(dir);
  if (basename(dirname(dir)) === 'node_modules') return dirname(dirname(dir));
  return dirname(dir);
}

function stagePackageTree(
  packageName,
  requireFrom,
  consumerDir,
  staged,
  ancestors = new Map(),
  stageRoot = null,
) {
  // 首次调用的 consumerDir 即 staged 树的根（runtimeStageDir）。
  if (stageRoot === null) stageRoot = consumerDir;
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson(requireFrom, packageName);
  } catch (error) {
    throw new Error(`Unable to resolve server runtime package ${packageName}: ${error.message}`);
  }
  packageJsonPath = realpathSync(packageJsonPath);
  const packageRoot = dirname(packageJsonPath);
  // pnpm 把同名包在不同依赖分支里解析到不同的物理目录，所以环必须按解析出的
  // package.json 路径判断：按包名比较 root 在循环依赖里永远不相等，会无限递归。
  if (ancestors.has(packageJsonPath)) return;

  // 从 consumerDir 向上逐层检查：npm 语义的最近优先 + 能提则提。
  // - 某层已有同物理目录的副本 → 去重结束；
  // - 某层已有不同版本 → 只能嵌套在 consumer 自己的 node_modules 里，
  //   放更高层会被错误版本拦截；
  // - 全链都没有 → 提到最顶层（runtimeStageDir/node_modules）。
  let level = consumerDir;
  let placement = null;
  for (;;) {
    const target = packageTarget(level, packageName);
    const existingRoot = staged.get(target);
    if (existingRoot !== undefined) {
      if (existingRoot === packageRoot) return;
      placement = packageTarget(consumerDir, packageName);
      break;
    }
    if (level === stageRoot) {
      placement = target;
      break;
    }
    level = upLevel(level);
  }

  const target = placement;
  if (staged.has(target)) return;
  staged.set(target, packageRoot);

  mkdirSync(dirname(target), { recursive: true });
  // pnpm 包目录里的 node_modules 是指向 .pnpm 物理目录的符号链接。原样复制会把
  // 链接目标的内容整个嵌套进 staged 树（一层层解引用），路径深度轻松超过
  // Windows MAX_PATH，NSIS CopyFiles 到 $INSTDIR 时直接失败回滚（exit 2）。
  // 冲突嵌套由上面的层链算法在需要时显式创建；这里跳过符号链接本身，
  // 包自带的真实 node_modules（bundledDependencies vendored 目录）仍原样保留。
  cpSync(packageRoot, target, {
    recursive: true,
    filter: (source) => !lstatSync(source).isSymbolicLink(),
  });

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const packageRequire = createRequire(packageJsonPath);
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const nextAncestors = new Map(ancestors);
  nextAncestors.set(packageJsonPath, packageRoot);
  for (const dependency of Object.keys(dependencies).sort()) {
    if (nextAncestors.has(dependency)) continue;
    try {
      stagePackageTree(dependency, packageRequire, target, staged, nextAncestors, stageRoot);
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

  prunePayload(
    stageRoot,
    context.electronPlatformName ?? process.platform,
    context.arch ?? process.arch,
  );
};

// electron-builder hands beforePack a numeric Arch enum (0 ia32, 1 x64, 2 armv7l,
// 3 arm64, 4 universal) while node-pty names its prebuild folders after the
// arch string.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

function prebuildTargets(platform, arch) {
  const name = typeof arch === 'number' ? ARCH_NAMES[arch] : arch;
  if (name === 'universal') return new Set([`${platform}-x64`, `${platform}-arm64`]);
  return new Set([`${platform}-${name}`]);
}

function prunePayload(stageRoot, platform, arch) {
  const keptPrebuilds = prebuildTargets(platform, arch);
  let pruned = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'prebuilds' && directory.endsWith('node-pty')) {
          for (const prebuild of readdirSync(path, { withFileTypes: true })) {
            if (prebuild.isDirectory() && !keptPrebuilds.has(prebuild.name)) {
              rmSync(join(path, prebuild.name), { recursive: true, force: true });
              pruned++;
            }
          }
          // 保留平台的 prebuild 目录里也有 .pdb 调试符号，仍要继续向下清理。
          visit(path);
          continue;
        }
        visit(path);
        continue;
      }
      if (path.endsWith('.pdb') || path.endsWith('.map')) {
        rmSync(path, { force: true });
        pruned++;
      }
    }
  };
  visit(stageRoot);
  console.log(`[before-pack] pruned ${String(pruned)} payload entries from ${stageRoot}`);
}

exports.RUNTIME_PACKAGES = RUNTIME_PACKAGES;
exports.packageTarget = packageTarget;
exports.prunePayload = prunePayload;
exports.stagePackageTree = stagePackageTree;
