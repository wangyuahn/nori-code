import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { createNoriProvidersFromConfig } from '../../src/session/nori-providers';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Nori filesystem memory provider', () => {
  it('recursively searches notes under the vault without a note type filter', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'analysis'), { recursive: true });
    await writeFile(
      join(vault, 'analysis', 'coder-write.md'),
      [
        '---',
        'title: "Bug: coder_write_enabled in nori.yaml is dead config"',
        'type: analysis',
        '---',
        '',
        'The coder_write_enabled field must be read from nori.yaml.',
      ].join('\n'),
      'utf-8',
    );

    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      root,
    );
    if (providers === null) throw new Error('expected providers');

    const results = await providers.memory.multiRetrieve(['coder_write_enabled']);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Bug: coder_write_enabled in nori.yaml is dead config',
      path: 'analysis/coder-write.md',
    });
  });

  it('maps plural note type filters to singular note directories', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'review'), { recursive: true });
    await writeFile(
      join(vault, 'review', 'rendering.md'),
      [
        '---',
        'title: "Rendering pipeline review"',
        'type: review',
        '---',
        '',
        'The rendering pipeline can black screen when shell output is not sanitized.',
      ].join('\n'),
      'utf-8',
    );

    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      root,
    );
    if (providers === null) throw new Error('expected providers');

    const results = await providers.memory.multiRetrieve(['black screen'], {
      type_filter: ['reviews'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe('review/rendering.md');
  });

  it('matches title, frontmatter, and file path, not only body text', async () => {
    const root = await tempRoot();
    const vault = join(root, 'nori-vault');
    await mkdir(join(vault, 'decision'), { recursive: true });
    await writeFile(
      join(vault, 'decision', 'generic-crawler.md'),
      [
        '---',
        'title: "Generic Crawler architecture decision"',
        'type: decision',
        'tags: [crawler]',
        '---',
        '',
        'Implementation notes are intentionally generic.',
      ].join('\n'),
      'utf-8',
    );

    const providers = createNoriProvidersFromConfig(
      { obsidian: { vault_path: './nori-vault' } },
      root,
    );
    if (providers === null) throw new Error('expected providers');

    const results = await providers.memory.multiRetrieve(['Generic Crawler'], {
      type_filter: ['decisions'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Generic Crawler architecture decision');
  });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nori-memory-'));
  tempDirs.push(dir);
  return dir;
}
