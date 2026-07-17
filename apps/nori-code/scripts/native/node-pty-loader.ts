import { createRequire } from 'node:module';

import { loadNativePackage } from '../../src/native/native-require';

type NodePtyModule = typeof import('node-pty');

const packageName = ['node', 'pty'].join('-');
const fallbackRequire = createRequire(import.meta.url);
const nodePty =
  loadNativePackage<NodePtyModule>(packageName) ??
  (fallbackRequire(packageName) as NodePtyModule);

export function nodePtySpawnOptions<T extends object>(
  options: T,
  platform: NodeJS.Platform = process.platform,
): T & { useConptyDll?: boolean } {
  return platform === 'win32' ? { ...options, useConptyDll: true } : options;
}

export const spawn = ((
  file: Parameters<NodePtyModule['spawn']>[0],
  args: Parameters<NodePtyModule['spawn']>[1],
  options: Parameters<NodePtyModule['spawn']>[2],
) => nodePty.spawn(file, args, nodePtySpawnOptions(options))) as NodePtyModule['spawn'];
export default nodePty;
