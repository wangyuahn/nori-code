

import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveNoriHome } from '../home';


export const NORI_SERVER_LABEL = 'com.nori.server';


export const NORI_SERVER_PLIST_FILENAME = `${NORI_SERVER_LABEL}.plist`;


export const NORI_SERVER_SYSTEMD_UNIT = 'nori-server.service';


export const NORI_SERVER_TASK_NAME = 'NoriServer';


export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', NORI_SERVER_PLIST_FILENAME);
}


export function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', NORI_SERVER_SYSTEMD_UNIT);
}


export function supervisorLogPath(): string {
  return join(resolveNoriHome(), 'server', 'server.log');
}


export function installPlanPath(): string {
  return join(resolveNoriHome(), 'server', 'install.json');
}


export function guiDomain(uid: number = process.getuid?.() ?? 0): string {
  return `gui/${uid}`;
}
