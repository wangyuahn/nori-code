/**
 * `nori web` — open the Nori web UI.
 *
 * Shares the exact same code path as `nori server run`: it is registered via
 * the same `buildRunCommand` builder (and therefore the same `handleRunCommand`
 * handler, the same background-daemon flow, and the same ready banner) with
 * `defaultOpen` flipped to `true`. The only difference from `server run` is
 * that `web` opens the browser by default.
 */

import type { Command } from 'commander';

import { buildRunCommand } from './run';

export function registerWebAliasCommand(program: Command): void {
  buildRunCommand(
    program
      .command('web')
      .description('Open the Nori web UI (starts a background daemon if needed).'),
    { defaultOpen: true },
  );
}
