import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanVault } from '#/routes/vault';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('vault note scanning', () => {
  it('returns relative Obsidian paths and merges Related links from metadata and body', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'nori-vault-'));
    tempDirs.push(vault);
    await mkdir(join(vault, 'analysis', 'nested'), { recursive: true });
    await writeFile(join(vault, 'analysis', 'nested', 'note.md'), [
      '---',
      'title: Nested note',
      'type: analysis',
      'related:',
      '  - "[[decision/architecture|Architecture]]"',
      'links: [review/verification.md]',
      '---',
      '',
      'See [[task/implementation#Status|Implementation]].',
    ].join('\n'), 'utf8');

    expect(scanVault(vault)).toEqual([
      expect.objectContaining({
        title: 'Nested note',
        type: 'analysis',
        folder: 'analysis',
        path: 'analysis/nested/note.md',
        links: ['decision/architecture', 'review/verification', 'task/implementation'],
      }),
    ]);
  });

  it('reads notes from the legacy analyses folder without changing their canonical type', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'nori-vault-'));
    tempDirs.push(vault);
    await mkdir(join(vault, 'analyses'), { recursive: true });
    await writeFile(join(vault, 'analyses', 'legacy.md'), '# Legacy analysis\n', 'utf8');

    expect(scanVault(vault)).toEqual([
      expect.objectContaining({
        type: 'analysis',
        folder: 'analysis',
        path: 'analyses/legacy.md',
      }),
    ]);
  });
});
