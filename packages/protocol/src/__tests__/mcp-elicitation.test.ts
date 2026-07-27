import { describe, expect, it } from 'vitest';

import {
  mcpElicitationRequestSchema,
  mcpElicitationResponseSchema,
} from '../mcp-elicitation';

const base = {
  elicitation_id: '01JELICITATION',
  session_id: 'session-1',
  request_id: 'rpc-7',
  server_name: 'example-server',
  message: 'Provide connection settings',
  status: 'pending' as const,
  created_at: '2026-07-24T10:00:00.000Z',
};

describe('MCP elicitation protocol', () => {
  it('preserves every supported form field shape', () => {
    const result = mcpElicitationRequestSchema.parse({
      ...base,
      mode: 'form',
      requested_schema: {
        type: 'object',
        required: ['email'],
        properties: {
          enabled: { type: 'boolean', default: true },
          email: { type: 'string', format: 'email', minLength: 3 },
          retries: { type: 'integer', minimum: 0, maximum: 10 },
          region: {
            type: 'string',
            oneOf: [{ const: 'cn', title: 'China' }],
          },
          scopes: {
            type: 'array',
            items: { type: 'string', enum: ['read', 'write'] },
          },
        },
      },
    });

    expect(result.mode).toBe('form');
    if (result.mode === 'form') {
      expect(result.requested_schema.properties['region']).toHaveProperty('oneOf');
      expect(result.requested_schema.properties['scopes']).toHaveProperty('items');
    }
  });

  it('accepts URL mode and rejects invalid URLs', () => {
    expect(mcpElicitationRequestSchema.parse({
      ...base,
      mode: 'url',
      server_elicitation_id: 'oauth-1',
      url: 'https://example.com/authorize',
    }).mode).toBe('url');

    expect(() => mcpElicitationRequestSchema.parse({
      ...base,
      mode: 'url',
      server_elicitation_id: 'oauth-1',
      url: 'not-a-url',
    })).toThrow();
  });

  it('limits accepted response content to MCP primitive values', () => {
    expect(mcpElicitationResponseSchema.parse({
      action: 'accept',
      content: { name: 'Nori', retries: 2, enabled: true, scopes: ['read'] },
    }).action).toBe('accept');
    expect(() => mcpElicitationResponseSchema.parse({
      action: 'accept',
      content: { nested: { unsafe: true } },
    })).toThrow();
  });
});
