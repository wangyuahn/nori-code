export interface ServerWorkerConfig {
  readonly launchId: string;
  readonly startedAt: string;
  readonly version: string;
  readonly homeDir: string;
  readonly lockPath: string;
  readonly host: string;
  readonly port: number;
  readonly webAssetsDir: string;
  readonly logPath: string;
  readonly parentPid: number;
}

export type ServerWorkerMessage =
  | {
      readonly type: 'starting';
      readonly launchId: string;
      readonly pid: number;
      readonly startedAt: string;
    }
  | {
      readonly type: 'ready';
      readonly launchId: string;
      readonly origin: string;
      readonly pid: number;
      readonly version: string;
    }
  | {
      readonly type: 'fatal';
      readonly launchId: string;
      readonly code: string;
      readonly message: string;
      readonly logPath: string;
    }
  | {
      readonly type: 'stopped';
      readonly launchId: string;
      readonly pid: number;
    };

export type ServerWorkerCommand = { readonly type: 'shutdown' };

export const SERVER_WORKER_CONFIG_ENV = 'NORI_DESKTOP_SERVER_WORKER_CONFIG';

export function isServerWorkerMessage(value: unknown): value is ServerWorkerMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'starting' || type === 'ready' || type === 'fatal' || type === 'stopped';
}
