import { homedir } from 'node:os';
import { join } from 'node:path';

/** Nori-owned data root. Never falls back to Kimi's environment or home. */
export function resolveNoriHome(homeDir?: string): string {
  if (homeDir !== undefined && homeDir.length > 0) return homeDir;
  const envHome = process.env['NORI_CODE_HOME'];
  if (envHome !== undefined && envHome.length > 0) return envHome;
  return join(homedir(), '.nori-code');
}
