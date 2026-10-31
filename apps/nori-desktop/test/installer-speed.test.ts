import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const requireFromTest = createRequire(import.meta.url);
const beforePack = requireFromTest('../scripts/before-pack.cjs') as {
  RUNTIME_PACKAGES: string[];
  packageTarget: (root: string, packageName: string) => string;
  prunePayload: (stageRoot: string, platform: string, arch: string) => void;
  stagePackageTree: (
    packageName: string,
    requireFrom: NodeRequire,
    modulesStageDir: string,
    staged: Map<string, string>,
    ancestors?: Map<string, string>,
  ) => void;
};

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeStageDir =
  process.env['NORI_DESKTOP_SERVER_RUNTIME_DIR'] ??
  join(desktopRoot, 'resources-stage', 'server-runtime');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nori-installer-'));
  tempDirs.push(dir);
  return dir;
}

function writePackage(root: string, name: string, dependencies: Record<string, string> = {}): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js', dependencies }),
  );
  writeFileSync(join(root, 'index.js'), `module.exports = ${JSON.stringify(name)};\n`);
}

function fixturePackageRoot(source: string, name: string): string {
  return join(source, 'node_modules', ...name.split('/'));
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function duplicateNodeModulesDirs(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules' && basename(dir) === 'node_modules') {
        found.push(path);
      }
      visit(path);
    }
  };
  visit(root);
  return found;
}

describe('runtime staging', () => {
  it('stages dependencies flat into the shared node_modules and dedupes diamonds', () => {
    const source = makeTempDir();
    const stage = makeTempDir();
    // pnpm 布局：alpha 的 node_modules 全部是指向共享物理包的符号链接，
    // 所以 cpSync 的符号链接过滤器会跳过它们，staged alpha 不带内嵌副本。
    writePackage(fixturePackageRoot(source, 'alpha'), 'alpha', { beta: '*', shared: '*' });
    writePackage(fixturePackageRoot(source, 'beta'), 'beta', { shared: '*' });
    writePackage(fixturePackageRoot(source, 'shared'), 'shared');
    mkdirSync(fixturePackageRoot(source, 'alpha/node_modules'), { recursive: true });
    symlinkSync(
      fixturePackageRoot(source, 'beta'),
      fixturePackageRoot(source, 'alpha/node_modules/beta'),
      'junction',
    );
    symlinkSync(
      fixturePackageRoot(source, 'shared'),
      fixturePackageRoot(source, 'alpha/node_modules/shared'),
      'junction',
    );

    const staged = new Map<string, string>();
    beforePack.stagePackageTree('alpha', createRequire(join(source, 'package.json')), stage, staged);

    const alphaDir = join(stage, 'node_modules', 'alpha');
    const betaDir = join(stage, 'node_modules', 'beta');
    const sharedDir = join(stage, 'node_modules', 'shared');
    expect(existsSync(alphaDir)).toBe(true);
    expect(existsSync(betaDir)).toBe(true);
    expect(existsSync(sharedDir)).toBe(true);
    expect(duplicateNodeModulesDirs(stage)).toEqual([]);
    // 平铺 + 按 package.json 路径去重：shared 只落盘一份。
    expect(staged.size).toBe(3);
    // Node 解析从 beta 目录向上走到共享 node_modules。
    expect(createRequire(join(betaDir, 'package.json')).resolve('shared')).toBe(
      join(sharedDir, 'index.js'),
    );
    expect(createRequire(join(alphaDir, 'package.json')).resolve('beta')).toBe(
      join(betaDir, 'index.js'),
    );
  });

  it('terminates on dependency cycles', () => {
    const source = makeTempDir();
    const stage = makeTempDir();
    writePackage(fixturePackageRoot(source, 'alpha'), 'alpha', { beta: '*' });
    writePackage(fixturePackageRoot(source, 'beta'), 'beta', { alpha: '*' });
    // pnpm 布局：alpha 通过符号链接依赖 beta；beta 对 alpha 的依赖向上解析。
    mkdirSync(fixturePackageRoot(source, 'alpha/node_modules'), { recursive: true });
    symlinkSync(
      fixturePackageRoot(source, 'beta'),
      fixturePackageRoot(source, 'alpha/node_modules/beta'),
      'junction',
    );

    const staged = new Map<string, string>();
    beforePack.stagePackageTree('alpha', createRequire(join(source, 'package.json')), stage, staged);

    expect(staged.size).toBe(2);
    expect(
      createRequire(join(stage, 'node_modules', 'beta', 'package.json')).resolve('alpha'),
    ).toBe(join(stage, 'node_modules', 'alpha', 'index.js'));
  });

  it('skips pnpm symlinked dependencies instead of dereferencing them into the staged tree', () => {
    const source = makeTempDir();
    const stage = makeTempDir();
    writePackage(fixturePackageRoot(source, 'alpha'), 'alpha', { beta: '*', shared: '*' });
    writePackage(fixturePackageRoot(source, 'alpha/node_modules/beta'), 'beta');
    writePackage(fixturePackageRoot(source, 'shared'), 'shared');
    // pnpm 布局：alpha/node_modules 里是指向共享物理目录的符号链接。
    symlinkSync(
      fixturePackageRoot(source, 'shared'),
      fixturePackageRoot(source, 'alpha/node_modules/shared'),
      'junction',
    );

    const staged = new Map<string, string>();
    beforePack.stagePackageTree('alpha', createRequire(join(source, 'package.json')), stage, staged);

    // 符号链接没有被解引用成嵌套目录，shared 由依赖闭包平铺落盘。
    expect(existsSync(join(stage, 'node_modules', 'alpha', 'node_modules', 'shared'))).toBe(false);
    expect(existsSync(join(stage, 'node_modules', 'shared', 'index.js'))).toBe(true);
  });

  it('nests a conflicting version under its consumer instead of aborting', () => {
    const source = makeTempDir();
    const stage = makeTempDir();
    writePackage(fixturePackageRoot(source, 'web1'), 'web1', { typescript: '*' });
    writePackage(fixturePackageRoot(source, 'web2'), 'web2', { typescript: '*' });
    // pnpm 布局：版本不同所以有两份物理包，通过符号链接挂到各自消费者下。
    writePackage(fixturePackageRoot(source, 'ts-v1'), 'typescript');
    writePackage(fixturePackageRoot(source, 'ts-v2'), 'typescript');
    for (const web of ['web1', 'web2']) {
      mkdirSync(fixturePackageRoot(source, `${web}/node_modules`), { recursive: true });
    }
    symlinkSync(
      fixturePackageRoot(source, 'ts-v1'),
      fixturePackageRoot(source, 'web1/node_modules/typescript'),
      'junction',
    );
    symlinkSync(
      fixturePackageRoot(source, 'ts-v2'),
      fixturePackageRoot(source, 'web2/node_modules/typescript'),
      'junction',
    );

    const staged = new Map<string, string>();
    beforePack.stagePackageTree('web1', createRequire(join(source, 'package.json')), stage, staged);
    beforePack.stagePackageTree('web2', createRequire(join(source, 'package.json')), stage, staged);

    const topTs = join(stage, 'node_modules', 'typescript');
    const nestedTs = join(stage, 'node_modules', 'web2', 'node_modules', 'typescript');
    expect(existsSync(join(topTs, 'package.json'))).toBe(true);
    expect(existsSync(join(nestedTs, 'package.json'))).toBe(true);
    expect(createRequire(join(nestedTs, 'package.json')).resolve('typescript')).toBe(
      join(nestedTs, 'index.js'),
    );
  });

  it('keeps scoped packages under their scope directory', () => {
    expect(beforePack.packageTarget(join('C:\\', 'runtime'), '@vue/language-server')).toBe(
      join('C:\\', 'runtime', 'node_modules', '@vue', 'language-server'),
    );
    // Windows 上 resolve 会给根相对路径补上当前盘符，所以只比较结构尾部。
    expect(beforePack.packageTarget('/runtime', 'node-pty')).toBe(
      resolve('/runtime', 'node_modules', 'node-pty'),
    );
  });

  it('prunes pdb/map files and foreign node-pty prebuilds per target platform', () => {
    for (const [platform, arch, expected] of [
      ['win32', 'x64', ['win32-x64']],
      ['darwin', 'arm64', ['darwin-arm64']],
      // electron-builder passes the numeric Arch enum: 1 is x64, 4 is universal.
      ['win32', 1, ['win32-x64']],
      ['darwin', 4, ['darwin-arm64', 'darwin-x64']],
    ] as const) {
      const stage = makeTempDir();
      const prebuilds = join(stage, 'node_modules', 'node-pty', 'prebuilds');
      for (const target of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']) {
        mkdirSync(join(prebuilds, target), { recursive: true });
        writeFileSync(join(prebuilds, target, 'pty.node'), target);
      }
      writeFileSync(join(stage, 'keep.js'), 'ok');
      writeFileSync(join(stage, 'debug.pdb'), 'x');
      writeFileSync(join(stage, 'worker.js.map'), 'x');
      writeFileSync(join(stage, 'bundle.map'), 'x');

      beforePack.prunePayload(stage, platform, arch);

      expect(readdirSync(prebuilds).sort()).toEqual([...expected]);
      expect(walkFiles(stage).filter(file => /\.(pdb|map)$/.test(file))).toEqual([]);
      for (const target of expected) {
        expect(readFileSync(join(prebuilds, target, 'pty.node'), 'utf8')).toBe(target);
      }
    }
  });
});

describe('installer contract', () => {
  it('deletes only the web asset tree before copying files', () => {
    const script = readFileSync(join(desktopRoot, 'build/installer.nsh'), 'utf8');
    expect(script).toContain('RMDir /r "$INSTDIR\\resources\\nori-web"');
    expect(script).not.toContain('RMDir /r "$INSTDIR"');
  });

  it('kills the whole app process tree so the server worker releases file locks', () => {
    const script = readFileSync(join(desktopRoot, 'build/installer.nsh'), 'utf8');
    expect(script).toContain('customCheckAppRunning');
    expect(script).toContain('taskkill /f /t');
  });

  it('continues the upgrade when the old uninstaller fails', () => {
    const script = readFileSync(join(desktopRoot, 'build/installer.nsh'), 'utf8');
    expect(script).toContain('customUnInstallCheck');
  });

  it('makes the assisted uninstaller exit 0 instead of the default error level 2', () => {
    const script = readFileSync(join(desktopRoot, 'build/installer.nsh'), 'utf8');
    expect(script).toContain('customUnInstall');
    expect(script).toContain('quitSuccess');
  });

  it('keeps store compression on Windows and normal everywhere else', () => {
    const config = requireFromTest('../electron-builder.config.cjs') as { compression: string };
    expect(config.compression).toBe(process.platform === 'win32' ? 'store' : 'normal');
  });

  it('installs per-machine so the staged payload stays under MAX_PATH', () => {
    const config = requireFromTest('../electron-builder.config.cjs') as {
      nsis: { perMachine: boolean };
    };
    expect(config.nsis.perMachine).toBe(true);
  });
});

const hasStagedRuntime = existsSync(join(runtimeStageDir, 'node_modules'));

describe.skipIf(!hasStagedRuntime)('staged server-runtime payload', () => {
  it('contains no nested node_modules/node_modules tree', () => {
    expect(duplicateNodeModulesDirs(runtimeStageDir)).toEqual([]);
  });

  it('resolves every runtime package dependency from its staged location', () => {
    for (const packageName of beforePack.RUNTIME_PACKAGES) {
      const packageJsonPath = join(runtimeStageDir, 'node_modules', ...packageName.split('/'), 'package.json');
      expect(existsSync(packageJsonPath), packageName).toBe(true);
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        os?: string[];
      };
      const packageRequire = createRequire(packageJsonPath);
      const required = Object.keys(packageJson.dependencies ?? {});
      for (const dependency of required) {
        expect(
          () => packageRequire.resolve(dependency),
          `${packageName} -> ${dependency}`,
        ).not.toThrow();
      }
      // optionalDependencies 允许按平台缺失（pyright 的 fsevents 只在 macOS 上
      // 存在）。但它们若被打进来了就必须能解析，否则同样是嵌套错位。
      for (const dependency of Object.keys(packageJson.optionalDependencies ?? {})) {
        if (!existsSync(join(runtimeStageDir, 'node_modules', dependency))) continue;
        expect(
          () => packageRequire.resolve(dependency),
          `${packageName} -> optional ${dependency}`,
        ).not.toThrow();
      }
    }
  });

  it('stays within payload file-count and size budgets', () => {
    const files = walkFiles(runtimeStageDir);
    const bytes = files.reduce((total, file) => total + statSync(file).size, 0);
    // 实测正确 staging + 裁剪后是 17,330 文件 / 191 MB。嵌套错位那版是 24,340
    // 文件 / 365 MB，阈值卡在两者之间：既允许依赖自然增长，又能抓住回归。
    expect(files.length).toBeLessThanOrEqual(24000);
    expect(bytes).toBeLessThanOrEqual(330 * 1024 * 1024);
    // 遍历两万多个文件在 Windows 上要好几秒，默认 5s 不够。
  }, 30_000);

  it('keeps every staged path inside the per-machine MAX_PATH budget', () => {
    // NSIS CopyFiles 是 SHFileOperation，受 MAX_PATH(259) 限制；per-machine
    // 安装前缀 "C:\Program Files\Nori Work\resources\server-runtime\" 约 52 字符。
    // 真实版本冲突（typescript 6 vs 4.9、vscode-languageserver 9 vs 8）必须嵌套，
    // 深度减不下去，所以这里盯住相对路径预算，防回归。
    const files = walkFiles(runtimeStageDir);
    const deepest = files.reduce(
      (max, file) => Math.max(max, relative(runtimeStageDir, file).length),
      0,
    );
    expect(deepest).toBeLessThanOrEqual(185);
    // 与 electron-builder.config.cjs 的 perMachine 注释和上面的安装模式测试联动：
    // per-user 前缀约 113 字符，只有 per-machine 能容纳这个深度。
  }, 30_000);

  it('ships no pdb/map files or foreign node-pty prebuilds', () => {
    const files = walkFiles(runtimeStageDir);
    expect(files.filter(file => /\.(pdb|map)$/.test(file))).toEqual([]);
    const prebuildsDir = join(runtimeStageDir, 'node_modules', 'node-pty', 'prebuilds');
    if (existsSync(prebuildsDir)) {
      const target = `${process.platform}-${process.arch}`;
      expect(readdirSync(prebuildsDir)).toEqual([target]);
    }
  });
});
