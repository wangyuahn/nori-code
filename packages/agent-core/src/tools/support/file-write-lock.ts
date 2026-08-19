import type { Kaos } from '@nori-code/kaos';

interface LockState {
  readonly done: Promise<void>;
  release: () => void;
}

export interface FileWriteLockContext {
  /**
   * True when another write operation for this exact file was already active
   * when this operation entered the queue.
   */
  readonly waited: boolean;
}

const locks = new Map<string, LockState>();

/**
 * Serialize all agent-core writes for one normalized file path.
 *
 * The registry is process-wide on purpose: each Agent creates its own Write
 * and Edit tool instances, including Team Agents, but they still share the
 * same runtime. Different files use different queue entries and therefore do
 * not block one another.
 */
export async function withFileWriteLock<T>(
  kaos: Pick<Kaos, 'name' | 'pathClass'>,
  path: string,
  operation: (context: FileWriteLockContext) => Promise<T>,
): Promise<T> {
  const key = lockKey(kaos, path);
  const previous = locks.get(key);
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, { done, release });

  if (previous !== undefined) {
    await previous.done;
  }

  try {
    return await operation({ waited: previous !== undefined });
  } finally {
    release();
    if (locks.get(key)?.done === done) {
      locks.delete(key);
    }
  }
}

function lockKey(kaos: Pick<Kaos, 'name' | 'pathClass'>, path: string): string {
  const normalizedPath = path.replaceAll('\\', '/').replaceAll(/\/+/g, '/');
  const comparablePath =
    kaos.pathClass() === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  return `${kaos.name}:${comparablePath}`;
}
