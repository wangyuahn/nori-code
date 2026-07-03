/**
 * `kimi migrate` sub-command.
 *
 * A bare, flagless subcommand: it launches the native pi-tui migration screen
 * (the same one shown on first launch), then exits. The screen collects the
 * migration scope interactively, so there are no CLI options. The actual
 * launch is delegated to a host-provided handler.
 */

import type { Command } from 'commander';

export function registerMigrateCommand(parent: Command, onMigrate: () => void): void {
  parent
    .command('migrate')
    .description('Migrate data from a legacy kimi-cli installation into kimi-code.')
    .action(() => {
      onMigrate();
    });
}
