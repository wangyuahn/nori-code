/**
 * `nori server` parent command. Mounts:
 *   - `server run` (background daemon by default; `--foreground` to attach; the
 *     detached daemon child runs the same command with `--daemon`)
 *
 * The OS service-manager subcommands (`install/uninstall/start/stop/restart/
 * status`) are temporarily NOT registered — see the commented
 * `addLifecycleCommands(server)` below. Their implementation is preserved in
 * `./lifecycle.ts` + `packages/server/src/svc/*` for later re-exposure.
 *
 * The top-level `nori web` alias is registered separately via
 * `registerWebAliasCommand` so it stays at the program root.
 */

import type { Command } from 'commander';

import { registerPsCommand } from './ps';
import { registerKillCommand } from './kill';
import { buildRunCommand } from './run';
import { registerRotateTokenCommand } from './rotate-token';
import { registerDesktopAliasCommand } from './desktop-alias';
import { registerWebAliasCommand } from './web-alias';

export function registerServerCommand(program: Command): void {
  const server = program
    .command('server')
    .description('Run the local Nori server (REST + WebSocket + web UI).');

  buildRunCommand(
    server.command('run').description('Start the Nori server (background daemon; use --foreground to attach).'),
    { defaultOpen: false },
  );

  registerPsCommand(server);

  registerKillCommand(server);

  registerRotateTokenCommand(server);

  // OS service-manager commands (`install/uninstall/start/stop/restart/status`)
  // are temporarily hidden — the product now favors the on-demand background
  // daemon (`nori web`) over service-ization. The implementation still lives in
  // `./lifecycle.ts` + `packages/server/src/svc/*`; re-import
  // `addLifecycleCommands` and call it here to re-expose.
  // addLifecycleCommands(server);

  registerWebAliasCommand(program);
  registerDesktopAliasCommand(program);
}

export { registerDesktopAliasCommand, registerWebAliasCommand };
