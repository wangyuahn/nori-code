import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarness } from '@nori-code/sdk';

import { smokeIdentityFromEnv, runPromptToEnd } from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const explicitHomeDir = process.env['KIMI_SDK_AUTH_SMOKE_HOME'];
  const explicitWorkDir = process.env['KIMI_SDK_AUTH_SMOKE_WORK_DIR'];
  const homeDir = explicitHomeDir ?? (await mkdtemp(join(tmpdir(), 'kimi-sdk-auth-smoke-home-')));
  const workDir = explicitWorkDir ?? (await mkdtemp(join(tmpdir(), 'kimi-sdk-auth-smoke-work-')));
  const apiKey = process.env['NORI_API_KEY'];
  const prompt =
    process.env['KIMI_SDK_AUTH_SMOKE_PROMPT'] ?? 'Reply with exactly: Kimi SDK auth smoke ok';
  const harness = createKimiHarness({ homeDir, identity: smokeIdentityFromEnv() });

  process.stdout.write(`home: ${homeDir}\n`);
  process.stdout.write(`workDir: ${workDir}\n`);

  try {
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('Set NORI_API_KEY before running the SDK auth smoke test.');
    }
    harness.auth.setApiKey(apiKey);
    const status = await harness.auth.status();
    if (status[0]?.hasToken !== true) {
      throw new Error('API-key auth status did not report the configured key');
    }
    process.stdout.write(`provider: ${status[0]?.providerName ?? 'api-key'}\n`);
    const config = await harness.getConfig({ reload: true });
    if (config.defaultModel === undefined) {
      throw new Error('Set default_model in config.toml before running the SDK auth smoke test.');
    }

    const session = await harness.createSession({
      workDir,
      model: config.defaultModel,
    });
    const ended = await runPromptToEnd(session, prompt);
    if (ended.type !== 'turn.ended' || ended.reason !== 'completed') {
      throw new Error(`Expected completed turn, got ${ended.type}`);
    }

    process.stdout.write(`auth smoke passed: ${session.id}\n`);
  } finally {
    await harness.close();
    if (explicitHomeDir === undefined) {
      await rm(homeDir, { recursive: true, force: true });
    }
    if (explicitWorkDir === undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
