/**
 * `nori desktop` — start the Nori server and launch the Nori Desktop Electron app.
 *
 * Starts the background daemon (reuses an existing one if already running),
 * then spawns the Electron desktop shell. The desktop auto-detects the server
 * via the lock file — no URL/token needs to be passed.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import type { Command } from 'commander';

import { darkColors } from '#/tui/theme/colors';
import { getHostPackageRoot } from '../../version';
import type { ServerCliOptions } from './shared';

// Reuse the actual daemon-starting logic from run.ts (import at runtime to
// avoid circular deps — this file is loaded by index.ts which already imports
// run.ts transitively via web-alias.ts).

interface DesktopCliOptions extends ServerCliOptions {
  foreground?: boolean;
}

export function registerDesktopAliasCommand(program: Command): void {
  program
    .command('desktop')
    .description('Start the Nori server and open the Nori Desktop app.')
    .option(
      '--foreground',
      'Run the server in the foreground and keep this terminal attached.',
      false,
    )
    .action(async (opts: DesktopCliOptions) => {
      try {
        // Dynamic import to avoid circular deps at module load time
        const { handleRunCommand, DEFAULT_RUN_COMMAND_DEPS } = await import('./run');

        // Custom openUrl that launches Electron instead of a browser
        const openDesktop = (url: string): void => {
          const pkgRoot = getHostPackageRoot();
          const desktopDir = join(pkgRoot, '..', 'nori-desktop');

          if (!existsSync(desktopDir)) {
            process.stderr.write(
              `${chalk.hex(darkColors.warning)(
                'Nori Desktop not found:',
              )} the desktop app directory does not exist at ${desktopDir}\n` +
                `This may happen when running from a non-monorepo install (global npm install or npx).\n` +
                `Use ${chalk.bold('nori web')} instead to open the web UI: ${chalk.bold(url)}\n`,
            );
            return;
          }

          process.stdout.write(
            `${chalk.hex(darkColors.primary)('Launching Nori Desktop')} from ${desktopDir}\n`,
          );

          const child = spawn('electron', ['.'], {
            cwd: desktopDir,
            stdio: 'ignore',
            detached: true,
            shell: process.platform === 'win32',
          });

          child.on('error', (err) => {
            process.stderr.write(
              `${chalk.hex(darkColors.warning)(
                'Could not launch Nori Desktop:',
              )} ${err.message}\n` +
              `Install electron: npm install -g electron@33\n` +
              `You can also open the web UI: ${chalk.bold(url)}\n`,
            );
          });

          child.on('exit', (code, signal) => {
            if (code !== 0 || signal !== null) {
              const reason = signal !== null
                ? `signal ${signal}`
                : `exit code ${code}`;
              process.stderr.write(
                `${chalk.hex(darkColors.warning)(
                  'Nori Desktop exited unexpectedly:',
                )} ${reason}\n` +
                `Install electron: npm install -g electron@33\n` +
                `You can also open the web UI: ${chalk.bold(url)}\n`,
              );
            }
          });

          child.unref();
        };

        await handleRunCommand(
          { ...opts, open: true },
          { ...DEFAULT_RUN_COMMAND_DEPS, openUrl: openDesktop },
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
