import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CHECKPOINTS = 10;

interface WorkspaceCheckpoint {
  tree: string;
  root: string;
  createdAt: string;
}

interface RewindManifest {
  checkpoints: WorkspaceCheckpoint[];
}

export async function captureWorkspaceCheckpoint(sessionId: string, cwd: string): Promise<boolean> {
  const root = await gitRoot(cwd);
  if (!root) return false;
  const manifestPath = rewindManifestPath(sessionId);
  const tree = await createWorkspaceTree(root, dirname(manifestPath));
  const manifest = await readManifest(manifestPath);
  manifest.checkpoints.push({ tree, root, createdAt: new Date().toISOString() });
  manifest.checkpoints = manifest.checkpoints.slice(-MAX_CHECKPOINTS);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return true;
}

export async function restoreWorkspaceCheckpoint(sessionId: string, count: number): Promise<boolean> {
  const manifestPath = rewindManifestPath(sessionId);
  const manifest = await readManifest(manifestPath);
  const targetIndex = manifest.checkpoints.length - count;
  const target = manifest.checkpoints[targetIndex];
  if (!target) return false;

  const currentTree = await createWorkspaceTree(target.root, dirname(manifestPath));
  const { stdout: patch } = await git(target.root, [
    'diff', '--binary', '--full-index', '--no-ext-diff', currentTree, target.tree, '--',
  ], 128 * 1024 * 1024);
  if (patch.length > 0) await applyGitPatch(target.root, patch);

  manifest.checkpoints = manifest.checkpoints.slice(0, targetIndex);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return true;
}

export async function discardLatestWorkspaceCheckpoint(sessionId: string): Promise<void> {
  const manifestPath = rewindManifestPath(sessionId);
  const manifest = await readManifest(manifestPath);
  if (manifest.checkpoints.length === 0) return;
  manifest.checkpoints.pop();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
    return resolve(stdout.trim());
  } catch {
    return undefined;
  }
}

async function createWorkspaceTree(root: string, tempDir: string): Promise<string> {
  await mkdir(tempDir, { recursive: true });
  const indexPath = join(tempDir, `index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await git(root, ['read-tree', '--empty'], undefined, env);
    await git(root, ['add', '-A', '--', '.'], undefined, env);
    const { stdout } = await git(root, ['write-tree'], undefined, env);
    return stdout.trim();
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

async function applyGitPatch(root: string, patch: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `git apply exited with code ${String(code)}`));
    });
    child.stdin.end(patch, 'utf8');
  });
}

async function git(
  cwd: string,
  args: string[],
  maxBuffer = 16 * 1024 * 1024,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, env, encoding: 'utf8', maxBuffer, windowsHide: true });
}

async function readManifest(path: string): Promise<RewindManifest> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<RewindManifest>;
    return { checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [] };
  } catch {
    return { checkpoints: [] };
  }
}

function rewindManifestPath(sessionId: string): string {
  const safeId = sessionId.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
  return join(homedir(), '.nori-code', 'rewind', safeId, 'manifest.json');
}
