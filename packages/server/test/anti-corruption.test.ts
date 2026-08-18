

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const daemonSrc = resolve(here, '..', 'src');

function findMatches(pattern: RegExp): string[] {
  const matches: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && pattern.test(readFileSync(path, 'utf8'))) {
        matches.push(path);
      }
    }
  };
  visit(daemonSrc);
  return matches;
}

describe('packages/server/src anti-corruption', () => {
  it('has zero @nori-code/sdk / KimiHarness / createRPC / SDKRpcClient references', () => {

    expect(findMatches(/@nori-code\/sdk|KimiHarness\b|createRPC\b|SDKRpcClient\b/)).toEqual([]);
  });

  it('imports shared filesystem, file store, logger, and workspace services from @nori-code/agent-core', () => {
    expect(findMatches(/["']#\/services\/(fileStore|fs|logger|workspace)(\/|["'])/)).toEqual([]);
  });
});
