import { startServer, type RunningServer } from '@nori-code/server';

import {
  SERVER_WORKER_CONFIG_ENV,
  type ServerWorkerCommand,
  type ServerWorkerConfig,
  type ServerWorkerMessage,
} from './protocol';

function workerConfig(): ServerWorkerConfig {
  const raw = process.env[SERVER_WORKER_CONFIG_ENV];
  if (raw === undefined) throw new Error(`Missing ${SERVER_WORKER_CONFIG_ENV}.`);
  const parsed = JSON.parse(raw) as Partial<ServerWorkerConfig>;
  if (
    typeof parsed.launchId !== 'string'
    || typeof parsed.startedAt !== 'string'
    || typeof parsed.version !== 'string'
    || typeof parsed.homeDir !== 'string'
    || typeof parsed.lockPath !== 'string'
    || typeof parsed.host !== 'string'
    || typeof parsed.port !== 'number'
    || typeof parsed.webAssetsDir !== 'string'
    || typeof parsed.logPath !== 'string'
    || typeof parsed.parentPid !== 'number'
  ) {
    throw new Error(`Invalid ${SERVER_WORKER_CONFIG_ENV}.`);
  }
  return parsed as ServerWorkerConfig;
}

function post(message: ServerWorkerMessage): void {
  process.parentPort.postMessage(message);
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error && error.name === 'ServerLockedError') return 'SERVER_LOCKED';
  return error instanceof SyntaxError ? 'INVALID_WORKER_CONFIG' : 'SERVER_START_FAILED';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function main(): Promise<void> {
  let config: ServerWorkerConfig;
  try {
    config = workerConfig();
  } catch (error) {
    post({
      type: 'fatal',
      launchId: 'unknown',
      code: errorCode(error),
      message: errorMessage(error),
      logPath: '',
    });
    setImmediate(() => process.exit(1));
    return;
  }

  let running: RunningServer | undefined;
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await running?.close();
    } finally {
      post({ type: 'stopped', launchId: config.launchId, pid: process.pid });
    }
  };

  process.parentPort.on('message', (event: { data: unknown }) => {
    const command = event.data as Partial<ServerWorkerCommand>;
    if (command.type === 'shutdown') {
      void stop().finally(() => process.exit(0));
    }
  });

  const parentGuard = setInterval(() => {
    if (!pidAlive(config.parentPid)) {
      void stop().finally(() => process.exit(1));
    }
  }, 500);
  parentGuard.unref();

  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });

  try {
    running = await startServer({
      host: config.host,
      port: config.port,
      logLevel: 'info',
      launchId: config.launchId,
      startedAt: config.startedAt,
      lockPath: config.lockPath,
      lockEntry: 'nori-work/server-worker',
      webAssetsDir: config.webAssetsDir,
      coreProcessOptions: {
        homeDir: config.homeDir,
        identity: {
          userAgentProduct: 'nori-code-cli',
          version: config.version,
        },
      },
      onStarting: ({ launchId, pid, startedAt }) => {
        post({ type: 'starting', launchId, pid, startedAt });
      },
    });
    post({
      type: 'ready',
      launchId: config.launchId,
      origin: running.address,
      pid: process.pid,
      version: config.version,
    });
  } catch (error) {
    post({
      type: 'fatal',
      launchId: config.launchId,
      code: errorCode(error),
      message: errorMessage(error),
      logPath: config.logPath,
    });
    setImmediate(() => process.exit(1));
  }
}

void main();
