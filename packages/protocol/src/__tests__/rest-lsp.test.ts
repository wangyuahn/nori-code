import { describe, expect, it } from 'vitest';

import { lspRequestSchema, lspResultSchema, lspStatusSchema } from '../index';

describe('LSP REST schemas', () => {
  it('accepts semantic requests and status responses', () => {
    expect(lspRequestSchema.parse({
      operation: 'hover',
      path: 'src/app.ts',
      position: { line: 4, character: 8 },
    })).toEqual({
      operation: 'hover',
      path: 'src/app.ts',
      position: { line: 4, character: 8 },
    });
    expect(lspStatusSchema.parse({
      available: true,
      running: true,
      server_id: 'typescript-language-server',
      language_id: 'typescript',
      capabilities: ['diagnostics', 'hover'],
    }).running).toBe(true);
    expect(lspResultSchema.parse({
      server_id: 'typescript-language-server',
      language_id: 'typescript',
      operation: 'diagnostics',
      result: [],
    }).result).toEqual([]);
  });

  it('rejects invalid positions and unsupported operations', () => {
    expect(lspRequestSchema.safeParse({
      operation: 'hover',
      path: 'src/app.ts',
      position: { line: -1, character: 0 },
    }).success).toBe(false);
    expect(lspRequestSchema.safeParse({ operation: 'execute', path: 'src/app.ts' }).success).toBe(false);
  });
});
