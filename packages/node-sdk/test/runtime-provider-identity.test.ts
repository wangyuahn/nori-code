import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KimiConfig } from '@nori-code/agent-core';
import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { SDKRpcClient } from '#/index';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

function resolveRuntimeProvider(options: {
  readonly config: KimiConfig;
  readonly model?: string;
  readonly kimiRequestHeaders?: Record<string, string>;
}) {
  const manager = new ProviderManager({
    config: options.config,
    kimiRequestHeaders: options.kimiRequestHeaders,
  });
  const model = options.model ?? options.config.defaultModel;
  if (model === undefined) {
    throw new Error('No model selected');
  }
  return manager.resolveProviderConfig(model);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-provider-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime provider identity headers', () => {
  it('does not synthesize removed host identity headers', async () => {
    const homeDir = await makeTempDir();
    const client = new SDKRpcClient({
      homeDir,
      identity: {
        ...TEST_IDENTITY,
        userAgentSuffix: 'web-runtime',
      },
    });
    const core = client.core as unknown as {
      readonly kimiRequestHeaders?: Record<string, string>;
    };

    try {
      expect(core.kimiRequestHeaders).toEqual({});
    } finally {
      await client.close();
    }
  });

  it('does not add removed identity headers to the Kimi provider', async () => {
    const homeDir = await makeTempDir();
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'kimi-model',
        providers: {
          kimi: {
            type: 'kimi',
            apiKey: 'test-key',
          },
        },
        models: {
          'kimi-model': {
            provider: 'kimi',
            model: 'kimi-model',
            maxContextSize: 1000,
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
    });
    expect(resolved.provider).not.toHaveProperty('defaultHeaders');
  });

  it('lets Kimi provider customHeaders override default identity headers', async () => {
    const homeDir = await makeTempDir();
    const config: KimiConfig = {
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'test-key',
          customHeaders: {
            'User-Agent': 'Custom/1',
            'X-Msh-Version': 'override-version',
          },
        },
      },
      defaultProvider: 'kimi',
      defaultModel: 'kimi-model',
      models: {
        'kimi-model': {
          provider: 'kimi',
          model: 'kimi-model',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'Custom/1',
        'X-Msh-Version': 'override-version',
      }),
    });
  });

  it('applies only the User-Agent (no device identity headers) to non-Kimi providers', async () => {
    const homeDir = await makeTempDir();
    const config: KimiConfig = {
      providers: {
        openai: {
          type: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: 'sk-test',
        },
      },
      defaultProvider: 'openai',
      defaultModel: 'gpt-test',
      models: {
        'gpt-test': {
          provider: 'openai',
          model: 'gpt-test',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-test',
    });
    // Device identity headers (`X-Msh-*`) stay Kimi-only — must not leak to
    // third-party providers.
    const headers = (resolved.provider as { defaultHeaders?: Record<string, string> })
      .defaultHeaders;
    expect(headers).toBeUndefined();
  });
});
