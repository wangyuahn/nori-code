import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Load the project nori.yaml config. Returns a parsed config object or null
 * if no config is found.
 */
export interface NoriDesktopConfig {
  projectName: string;
  vaultPath: string;
  phases: Array<{ name: string; mode: string }>;
  swarm: {
    maxConcurrency: number;
    maxSwarmDepth: number;
    coderWriteEnabled: boolean;
  };
  theme?: {
    color: string;
  };
}

export function loadNoriConfig(): NoriDesktopConfig | null {
  // Try cwd first, then project root (dev), then home directory
  const paths = [
    join(process.cwd(), 'nori.yaml'),
    join(app.getAppPath(), '..', '..', 'nori.yaml'),
    join(app.getPath('home'), '.nori-code', 'nori.yaml'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return parseNoriYaml(readFileSync(p, 'utf-8'));
      } catch {
        // continue to next path
      }
    }
  }
  return null;
}

function parseNoriYaml(content: string): NoriDesktopConfig {
  // Simple YAML parser for nori.yaml — extracts the fields we need
  const result: NoriDesktopConfig = {
    projectName: 'nori-code',
    vaultPath: './nori-vault',
    phases: [],
    swarm: { maxConcurrency: 4, maxSwarmDepth: 3, coderWriteEnabled: false },
  };

  const lines = content.split('\n');
  let section = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // Detect sections
    if (trimmed === 'project:') { section = 'project'; continue; }
    if (trimmed === 'swarm:') { section = 'swarm'; continue; }
    if (trimmed === 'theme:') { section = 'theme'; continue; }
    if (trimmed === 'phases:') { section = 'phases'; continue; }

    // Phase entries
    if (section === 'phases' && trimmed.startsWith('- name:')) {
      const name = trimmed.replace(/- name:\s*/, '').replace(/"/g, '').trim();
      result.phases.push({ name, mode: 'hybrid' });
      continue;
    }
    if (section === 'phases' && trimmed.startsWith('mode:')) {
      const last = result.phases[result.phases.length - 1];
      if (last) last.mode = trimmed.replace(/mode:\s*/, '').trim();
      continue;
    }

    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (value === undefined) continue;
    const cleanVal = value.replace(/"/g, '').trim();

    if (section === 'project') {
      if (key === 'name') result.projectName = cleanVal;
      if (key === 'vault_path') result.vaultPath = cleanVal;
    }
    if (section === 'swarm') {
      if (key === 'max_concurrency') result.swarm.maxConcurrency = parseInt(cleanVal, 10) || 4;
      if (key === 'max_swarm_depth') result.swarm.maxSwarmDepth = parseInt(cleanVal, 10) || 3;
      if (key === 'coder_write_enabled') result.swarm.coderWriteEnabled = cleanVal === 'true';
    }
    if (section === 'theme' && key === 'color') {
      result.theme = { color: cleanVal };
    }
  }

  return result;
}
