import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { appRoot } from './paths.mjs';

const execFileAsync = promisify(execFile);

export function commandForExecFile(command, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(command)) {
    return { command, args };
  }
  const shellCommand = [command, ...args]
    .map((arg) => `"${String(arg).replaceAll('"', '""')}"`)
    .join(' ');
  return {
    command: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    options: { windowsVerbatimArguments: true },
  };
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

export async function run(command, args, options = {}) {
  const exec = commandForExecFile(command, args);
  try {
    const { stdout, stderr } = await execFileAsync(exec.command, exec.args, {
      cwd: appRoot,
      maxBuffer: 1024 * 1024 * 16,
      ...exec.options,
      ...options,
    });
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  } catch (error) {
    const details = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Command failed: ${basename(command)} ${args.join(' ')}\n${details}`);
  }
}

export async function tryRun(command, args, options = {}) {
  const exec = commandForExecFile(command, args);
  try {
    await execFileAsync(exec.command, exec.args, {
      cwd: appRoot,
      maxBuffer: 1024 * 1024 * 16,
      ...exec.options,
    });
  } catch (error) {
    const details = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    console.warn(`Warning: ${basename(command)} ${args.join(' ')} failed.\n${details}`);
  }
}
