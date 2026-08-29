/**
 * `providerName` — what a provider calls itself in user-facing text.
 *
 * Each provider class hardcodes the wire protocol it speaks as its `name`
 * (`openai`, `anthropic`, …). That is fine for the official endpoints and wrong
 * for everyone else: the OpenAI Chat Completions wire is what most third-party
 * vendors implement, so an OpenRouter 403 reported itself as "Provider: openai"
 * and pointed the user at the wrong dashboard. The host passes the config key the
 * user actually chose (`[providers.openrouter]` → `openrouter`) as
 * `providerName`, and the wire name stays as the fallback when nothing is named.
 *
 * The `withThinking` / `withGenerationKwargs` cases matter because those clone a
 * provider; a name assigned in the constructor has to survive the clone or the
 * label silently reverts mid-session.
 */

import { createProvider, type ProviderConfig } from '#/providers/index';
import { describe, expect, it } from 'vitest';

const CASES: ReadonlyArray<{ config: ProviderConfig; wireName: string }> = [
  { config: { type: 'openai', model: 'gpt-4.1', apiKey: 'k' }, wireName: 'openai' },
  {
    config: { type: 'openai_responses', model: 'gpt-5', apiKey: 'k' },
    wireName: 'openai-responses',
  },
  { config: { type: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'k' }, wireName: 'anthropic' },
  { config: { type: 'google-genai', model: 'gemini-2.5-pro', apiKey: 'k' }, wireName: 'google_genai' },
  { config: { type: 'vertexai', model: 'gemini-2.5-pro', apiKey: 'k' }, wireName: 'google_genai' },
  { config: { type: 'kimi', model: 'kimi-k2', apiKey: 'k' }, wireName: 'kimi' },
];

describe('provider naming', () => {
  for (const { config, wireName } of CASES) {
    it(`${config.type} falls back to its wire name`, () => {
      expect(createProvider(config).name).toBe(wireName);
    });

    it(`${config.type} reports the host-supplied providerName`, () => {
      expect(createProvider({ ...config, providerName: 'openrouter' }).name).toBe('openrouter');
    });

    it(`${config.type} ignores a blank providerName`, () => {
      expect(createProvider({ ...config, providerName: '   ' }).name).toBe(wireName);
      expect(createProvider({ ...config, providerName: '' }).name).toBe(wireName);
    });

    it(`${config.type} keeps the name across withThinking`, () => {
      const provider = createProvider({ ...config, providerName: 'openrouter' });
      expect(provider.withThinking('low').name).toBe('openrouter');
    });
  }
});
