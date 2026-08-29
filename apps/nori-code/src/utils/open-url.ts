import { execFile } from 'node:child_process';

export interface OpenUrlResult {
  readonly ok: boolean;
  readonly error?: string;
}

function openersFor(url: string): ReadonlyArray<readonly [string, readonly string[]]> {
  if (process.platform === 'darwin') return [['open', [url]]];
  if (process.platform === 'win32') return [['cmd', ['/c', 'start', '', url]]];
  return [
    ['xdg-open', [url]],
    ['gio', ['open', url]],
  ];
}

function execOpener(command: string, args: readonly string[]): Promise<OpenUrlResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], (error, _stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim().length > 0 ? stderr.trim() : error.message;
        resolve({ ok: false, error: detail });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/**
 * Open a URL in the desktop browser. Tries `xdg-open` then `gio open` on Linux
 * so a missing opener is reported instead of swallowed.
 */
export async function openUrlAsync(url: string): Promise<OpenUrlResult> {
  const openers = openersFor(url);
  const failures: string[] = [];
  for (const [command, args] of openers) {
    const result = await execOpener(command, args);
    if (result.ok) return result;
    failures.push(`${command}: ${result.error ?? 'failed'}`);
    // Missing binary → try the next opener. Any other failure (no DISPLAY,
    // snap confinement, the browser refused the URL) is terminal.
    if (result.error !== undefined && !result.error.includes('ENOENT')) {
      return { ok: false, error: result.error };
    }
  }
  return { ok: false, error: failures.join('; ') };
}

export function openUrl(url: string): void {
  void openUrlAsync(url);
}
