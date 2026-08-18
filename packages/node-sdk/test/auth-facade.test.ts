import { describe, expect, it } from 'vitest';

import { KimiAuthFacade } from '#/index';

function createFacade(): KimiAuthFacade {
  return new KimiAuthFacade({
    homeDir: 'C:/tmp/nori-sdk-auth',
    configPath: 'C:/tmp/nori-sdk-auth/config.toml',
  });
}

describe('KimiAuthFacade API-key contract', () => {
  it('reports no provider until an API key is configured', async () => {
    const auth = createFacade();

    await expect(auth.status()).resolves.toEqual([]);

    auth.setApiKey('test-api-key');
    await expect(auth.status()).resolves.toEqual([
      { providerName: 'api-key', hasToken: true },
    ]);
    expect(auth.getApiKey()).toBe('test-api-key');
  });

  it('exposes the configured key through the runtime token-provider bridge', async () => {
    const auth = createFacade();
    auth.setApiKey('test-api-key');

    await expect(auth.getCachedAccessToken()).resolves.toBe('test-api-key');
    await expect(auth.resolveOAuthTokenProvider('example').getAccessToken()).resolves.toBe(
      'test-api-key',
    );
  });

  it('rejects token resolution when no API key is configured', async () => {
    const auth = createFacade();

    await expect(auth.resolveOAuthTokenProvider('example').getAccessToken()).rejects.toThrow(
      'Call setApiKey()',
    );
  });

  it('keeps OAuth-only operations explicit instead of pretending to support them', async () => {
    const auth = createFacade();

    await expect(auth.login(undefined)).rejects.toThrow('OAuth login is not supported');
    await expect(auth.getManagedUsage()).rejects.toThrow(
      'Managed usage is not available with API key auth',
    );
    await expect(
      auth.createFeedbackUploadUrl({
        feedbackId: 1,
        filename: 'example.zip',
        size: 1,
        sha256: 'sha256',
      }),
    ).resolves.toEqual({
      kind: 'error',
      message: 'Feedback upload is not available with API key auth.',
    });
  });
});
