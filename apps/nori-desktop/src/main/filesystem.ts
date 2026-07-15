import { readFileSync, readdirSync, lstatSync, writeFileSync, watch, realpathSync } from 'node:fs';
import { resolve, relative, normalize, join, isAbsolute } from 'node:path';
import { app } from 'electron';

const ALLOWED_BASE_DIR = resolve(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '..', '..'));

const DENY_PATTERNS = [
  '.nori-code',
  '.ssh',
  // Windows
  'c:\\',
  'c:\\windows',
  'c:\\program files',
  'c:\\users',
  // Unix
  '/etc',
  '/root',
  '/home',
  '/tmp',
  '/private/',
  '/proc/',
  '/sys/',
  // macOS
  '/system',
];

function isAllowedPath(absolutePath: string): boolean {
  let resolved: string;
  try {
    resolved = realpathSync(absolutePath);
  } catch {
    return false;
  }
  const rel = relative(ALLOWED_BASE_DIR, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  const lower = resolved.toLowerCase();
  return !DENY_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink?: boolean;
  size: number;
  modifiedAt: string;
}

export function readDir(dirPath: string): FsEntry[] {
  const resolved = resolve(dirPath);
  if (!isAllowedPath(resolved)) throw new Error(`Access denied: ${dirPath}`);
  return readdirSync(resolved).map(name => {
    const fullPath = join(resolved, name);
    const stats = lstatSync(fullPath);
    return {
      name,
      path: fullPath,
      isDirectory: stats.isDirectory(),
      isSymlink: stats.isSymbolicLink(),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  });
}

export function readTextFile(filePath: string): string {
  const resolved = resolve(filePath);
  if (!isAllowedPath(resolved)) throw new Error(`Access denied: ${filePath}`);
  return readFileSync(resolved, 'utf-8');
}
