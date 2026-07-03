/**
 * `kimi migrate` — a bare, flagless subcommand that delegates to a host
 * handler. The migration UI is the native pi-tui screen, covered separately
 * by `migration-screen.test.ts`.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerMigrateCommand } from '#/migration/command';

describe('registerMigrateCommand', () => {
  it('adds a flagless migrate subcommand to the program', () => {
    const program = new Command('kimi');
    registerMigrateCommand(program, () => {});
    const sub = program.commands.find((c) => c.name() === 'migrate');
    expect(sub).toBeDefined();
    expect(sub!.description()).toContain('Migrate');
    expect(sub!.options).toHaveLength(0);
  });

  it('invokes the host handler when `migrate` runs', () => {
    const program = new Command('kimi');
    const onMigrate = vi.fn();
    registerMigrateCommand(program, onMigrate);
    program.parse(['migrate'], { from: 'user' });
    expect(onMigrate).toHaveBeenCalledTimes(1);
  });
});
