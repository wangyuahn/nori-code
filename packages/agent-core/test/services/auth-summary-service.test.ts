import { describe, expect, it } from 'vitest';

import type { KimiConfig } from '../../src/config';
import { AuthTokenMissingError } from '../../src/services/authSummary/authSummary';
import { AuthSummaryService, firstUsableModelId, resolveReadyModelId } from '../../src/services/authSummary/authSummaryService';

function config(partial: Partial<KimiConfig> & Pick<KimiConfig, 'providers'>): KimiConfig {
  return partial as KimiConfig;
}

describe('resolveReadyModelId', () => {
  it('prefers the request override over a missing or stale default_model', () => {
    const ready = config({
      defaultModel: 'missing',
      providers: { x: { type: 'kimi', apiKey: 'sk-test' } },
      models: {
        x: { provider: 'x', model: 'x', maxContextSize: 1000 },
      },
    });
    expect(resolveReadyModelId(ready, 'x')).toBe('x');
    expect(resolveReadyModelId(ready)).toBe('x');
  });

  it('returns the requested id even when it does not resolve so ensureReady can 40113', () => {
    const ready = config({
      providers: { x: { type: 'kimi', apiKey: 'sk-test' } },
      models: {
        x: { provider: 'x', model: 'x', maxContextSize: 1000 },
      },
    });
    expect(resolveReadyModelId(ready, 'missing-alias')).toBe('missing-alias');
  });
});

describe('firstUsableModelId', () => {
  it('skips models whose provider has no credential', () => {
    expect(firstUsableModelId(config({
      providers: { x: { type: 'kimi' } },
      models: {
        x: { provider: 'x', model: 'x', maxContextSize: 1000 },
      },
    }))).toBeUndefined();
  });

  it('returns the first catalog model with a provider and api key', () => {
    expect(firstUsableModelId(config({
      providers: { x: { type: 'kimi', apiKey: 'sk-test' } },
      models: {
        x: { provider: 'x', model: 'x', maxContextSize: 1000 },
      },
    }))).toBe('x');
  });
});

describe('OAuth readiness', () => {
  it('does not report an OAuth-only provider ready without its cached token', async () => {
    const oauthOnly = config({
      defaultModel: 'managed:model',
      providers: { 'managed:nori-code': { type: 'kimi', oauth: { storage: 'file', key: 'managed:nori-code' } } },
      models: { 'managed:model': { provider: 'managed:nori-code', model: 'model', maxContextSize: 1000 } },
    });
    const service = Object.create(AuthSummaryService.prototype) as AuthSummaryService;
    Object.assign(service as object, {
      _readConfig: async () => oauthOnly,
      _hasCachedToken: async () => false,
    });

    expect((await service.get()).ready).toBe(false);
    await expect(service.ensureReady()).rejects.toBeInstanceOf(AuthTokenMissingError);
  });

  it('still resolves an OAuth-only model without a default so ensureReady can check its token', () => {
    expect(resolveReadyModelId(config({
      providers: { oauth: { type: 'kimi', oauth: { storage: 'file', key: 'oauth' } } },
      models: { model: { provider: 'oauth', model: 'model', maxContextSize: 1000 } },
    }))).toBe('model');
  });
});
