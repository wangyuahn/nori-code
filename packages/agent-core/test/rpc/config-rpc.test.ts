import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';
import type { Session } from '../../src/session';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHome(configToml?: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
  tempDirs.push(home);
  if (configToml !== undefined) {
    await writeFile(path.join(home, 'config.toml'), configToml, 'utf-8');
  }
  return home;
}

function makeCore(home: string): KimiCore {
  return new KimiCore(async () => ({}) as never, { homeDir: home });
}

const VALID_TOML = `
default_model = "k2"

[providers.kimi]
type = "kimi"
api_key = "sk-good"

[models.k2]
provider = "kimi"
model = "kimi-for-coding"
max_context_size = 128000
`;

describe('KimiCore degraded config loading', () => {
  it('reports no diagnostics for a valid config', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const config = await core.getKimiConfig({});
    expect(config.providers['kimi']).toBeDefined();
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });

  it('refuses to start when the TOML cannot be parsed at all', async () => {
    const home = await makeHome('[[[');
    // A fully unusable file means defaults-only (looks logged out), which is
    // worse than failing fast with the parse location.
    expect(() => makeCore(home)).toThrow(/Invalid TOML/);
  });

  it('starts with a partially invalid config, keeping the valid sections', async () => {
    const core = makeCore(
      await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`),
    );
    const config = await core.getKimiConfig({});
    expect(config.providers['kimi']).toBeDefined();
    expect(config.loopControl).toBeUndefined();
    const diagnostics = await core.getConfigDiagnostics({});
    expect(diagnostics.warnings).toHaveLength(1);
    expect(diagnostics.warnings[0]).toContain('loop_control');
  });

  it('saves settings by dropping invalid sections instead of locking the file', async () => {
    const home = await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const core = makeCore(home);

    const updated = await core.setKimiConfig({ thinking: { enabled: true } });
    expect(updated.thinking?.enabled).toBe(true);
    expect(updated.providers['kimi']).toBeDefined();
    expect(updated.loopControl).toBeUndefined();

    const after = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(after).toContain('enabled = true');
    expect(after).not.toContain('max_steps_per_turn');
    const diagnostics = await core.getConfigDiagnostics({});
    expect(diagnostics.warnings.some((warning) => warning.includes('loop_control'))).toBe(true);
  });

  it('rejects config writes when the file is not valid TOML', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);
    const configPath = path.join(home, 'config.toml');
    await writeFile(configPath, '[[[', 'utf-8');
    const before = await readFile(configPath, 'utf-8');

    const write = core.setKimiConfig({ thinking: { enabled: true } });
    await expect(write).rejects.toThrow(/fix it first/i);
    await expect(write).rejects.toThrow(/nori doctor/);
    await expect(write).rejects.toThrow(/Invalid TOML/);
    await expect(write).rejects.not.toThrow(/invalid_type/);

    const after = await readFile(configPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('keeps the last good config when the file breaks mid-run', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);
    const configPath = path.join(home, 'config.toml');

    await writeFile(configPath, '[[[', 'utf-8');
    const kept = await core.getKimiConfig({ reload: true });
    expect(kept.providers['kimi']).toBeDefined();
    const degraded = await core.getConfigDiagnostics({});
    expect(degraded.warnings.some((w) => w.includes('Invalid TOML'))).toBe(true);
    expect(degraded.warnings.some((w) => w.includes('previous'))).toBe(true);

    await writeFile(configPath, `[thinking]\nenabled = true\n${VALID_TOML}`, 'utf-8');
    const adopted = await core.getKimiConfig({ reload: true });
    expect(adopted.thinking?.enabled).toBe(true);
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });

  it('pushes custom agent changes into already active sessions', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const updateCustomAgents = vi.fn(async () => undefined);
    core.sessions.set('existing-session', { updateCustomAgents } as unknown as Session);

    await core.setKimiConfig({
      customAgents: {
        reviewer: {
          description: 'Review changes.',
          role: 'Find correctness bugs.',
          baseProfile: 'agent',
          enabled: true,
        },
      },
    });

    expect(updateCustomAgents).toHaveBeenCalledWith({
      reviewer: expect.objectContaining({ role: 'Find correctness bugs.' }),
    });
  });
});
