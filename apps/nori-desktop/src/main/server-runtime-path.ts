import { join } from 'node:path';

import { app } from 'electron';

export function resolveServerWorkerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'server-runtime', 'server-worker.cjs')
    : join(app.getAppPath(), 'out', 'server-worker.cjs');
}

export function resolveServerWebAssetsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'nori-web', 'dist')
    : join(app.getAppPath(), '..', 'nori-web', 'dist');
}

export function resolveServerModulesDir(): string | undefined {
  return app.isPackaged
    ? join(process.resourcesPath, 'server-runtime', 'node_modules')
    : join(app.getAppPath(), '..', '..', 'packages', 'agent-core', 'node_modules');
}
