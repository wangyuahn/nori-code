import { classifyServerIdentity, getLiveLock } from '@nori-code/server';

import { lockConnectHost } from '#/cli/sub/server/daemon';
import { serverOrigin } from '#/cli/sub/server/shared';

/**
 * When Nori Work / `nori server run` already holds the home-dir lock, warn that
 * the TUI still boots an in-process KimiCore against the same storage.
 */
export async function runningServerCoexistenceNotice(): Promise<string | undefined> {
  const lock = getLiveLock();
  if (lock === undefined) return undefined;
  const origin = serverOrigin(lockConnectHost(lock), lock.port);
  try {
    const identity = await classifyServerIdentity(origin, undefined, 500);
    if (identity === 'foreign') {
      return `Another service is bound at ${origin}. If it is not Nori, the TUI may see storage conflicts.`;
    }
    return (
      'Nori server is already running at ' +
      origin +
      '. TUI uses in-process core — avoid editing the same session in Nori Work and the terminal at once.'
    );
  } catch {
    return undefined;
  }
}
