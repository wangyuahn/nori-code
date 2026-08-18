import { describe, expect, it } from 'vitest';

import { formatNoriMemoryChainResult } from '../../../../src/tools/builtin/nori/memory-chain';

describe('formatNoriMemoryChainResult', () => {
  it('includes real write timestamps for each search hit', () => {
    const output = formatNoriMemoryChainResult({
      query: {
        keywords: ['boundary'],
        top_k: 10,
        include_linked: false,
        link_depth: 0,
        chain_depth: 0,
      },
      hops: [{
        index: 0,
        source: 'initial',
        keywords: ['boundary'],
        results: [
          {
            title: 'Service boundary',
            path: 'decision/service-boundary.md',
            score: 2,
            excerpt: 'Keep the SDK contract stable.',
            created_at: '2026-08-10T04:15:00.000Z',
          },
          {
            title: 'Legacy note',
            path: 'analysis/legacy.md',
            score: 1,
            excerpt: 'Older memory without a full timestamp.',
            date: '2026-07-01',
          },
        ],
      }],
      uniqueResults: [
        {
          title: 'Service boundary',
          path: 'decision/service-boundary.md',
          score: 2,
          excerpt: 'Keep the SDK contract stable.',
          created_at: '2026-08-10T04:15:00.000Z',
        },
        {
          title: 'Legacy note',
          path: 'analysis/legacy.md',
          score: 1,
          excerpt: 'Older memory without a full timestamp.',
          date: '2026-07-01',
        },
      ],
    });

    expect(output).toContain('[written: 2026-08-10 04:15 UTC]');
    expect(output).toContain('[written: 2026-07-01]');
    expect(output).not.toContain('[written: undefined]');
  });
});
