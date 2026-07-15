import { describe, expect, it } from 'vitest';

import { configResponseSchema, patchConfigRequestSchema } from '../rest/config';

describe('config REST schemas', () => {
  it('accepts memory secrets in patches', () => {
    const parsed = patchConfigRequestSchema.parse({
      memory: {
        vector_enabled: true,
        provider_type: 'openai',
        base_url: 'https://embeddings.example.test/v1',
        api_key: 'secret',
        model: 'text-embedding-test',
        custom_headers: { 'X-Tenant': 'team-a' },
      },
    });

    expect(parsed.memory?.api_key).toBe('secret');
  });

  it('exposes only redacted memory configuration in responses', () => {
    const parsed = configResponseSchema.parse({
      providers: {},
      memory: {
        vector_enabled: true,
        provider_type: 'openai_responses',
        base_url: 'https://embeddings.example.test/v1',
        model: 'text-embedding-test',
        has_api_key: true,
        api_key: 'must-not-survive',
        custom_headers: { Authorization: 'must-not-survive' },
      },
    });

    expect(parsed.memory).toEqual({
      vector_enabled: true,
      provider_type: 'openai_responses',
      base_url: 'https://embeddings.example.test/v1',
      model: 'text-embedding-test',
      has_api_key: true,
    });
  });
});
