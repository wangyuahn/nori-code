import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanVault, updateVaultNote } from '#/routes/vault';

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

  it('exposes frontmatter write timestamps and sorts newest write first', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'nori-vault-'));
    tempDirs.push(vault);
    await mkdir(join(vault, 'analysis'), { recursive: true });
    await writeFile(join(vault, 'analysis', 'older.md'), [
      '---',
      'title: Older',
      'type: analysis',
      'created_at: "2026-08-01T08:00:00.000Z"',
      'updated_at: "2026-08-01T08:00:00.000Z"',
      'date: 2026-08-01',
      '---',
      '',
      'Older body',
    ].join('\n'), 'utf8');
    await writeFile(join(vault, 'analysis', 'newer.md'), [
      '---',
      'title: Newer',
      'type: analysis',
      'created_at: "2026-08-10T04:15:00.000Z"',
      'updated_at: "2026-08-11T09:30:00.000Z"',
      'date: 2026-08-10',
      '---',
      '',
      'Newer body',
    ].join('\n'), 'utf8');

    expect(scanVault(vault).map(note => note.title)).toEqual(['Newer', 'Older']);
    expect(scanVault(vault)[0]).toEqual(expect.objectContaining({
      created_at: '2026-08-10T04:15:00.000Z',
      updated_at: '2026-08-11T09:30:00.000Z',
    }));
  });
});

describe('vault note updates', () => {
  it('rejects a stale browser draft after an external editor changes the raw Markdown', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'nori-vault-'));
    tempDirs.push(vault);
    await mkdir(join(vault, 'analysis'), { recursive: true });
    const notePath = join(vault, 'analysis', 'external-edit.md');
    const initialTime = new Date('2026-08-02T08:00:00.000Z');
    await writeFile(notePath, [
      '---',
      'title: External edit',
      'updated_at: 2026-08-02T08:00:00.000Z',
      '---',
      '',
      'Initial body',
    ].join('\n'), 'utf8');
    await utimes(notePath, initialTime, initialTime);
    const opened = scanVault(vault)[0]!;

    await writeFile(notePath, [
      '---',
      'title: External edit',
      'updated_at: 2026-08-02T08:00:00.000Z',
      '---',
      '',
      'External editor body',
    ].join('\n'), 'utf8');
    const externalTime = new Date('2026-08-03T09:00:00.000Z');
    await utimes(notePath, externalTime, externalTime);

    const result = updateVaultNote(vault, opened.path, {
      content: 'Stale browser draft',
      expected_updated_at: opened.updated_at,
      expected_content_hash: opened.content_hash,
    });

    expect(result.status).toBe('conflict');
    expect(await readFile(notePath, 'utf8')).toContain('External editor body');
  });

  it('preserves created_at, refreshes updated_at, and rejects stale expected_updated_at', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'nori-vault-'));
    tempDirs.push(vault);
    await mkdir(join(vault, 'decision'), { recursive: true });
    const notePath = join(vault, 'decision', 'architecture.md');
    await writeFile(notePath, [
      '---',
      'title: Architecture',
      'type: decision',
      'created_at: "2026-08-01T08:00:00.000Z"',
      'updated_at: "2026-08-02T08:00:00.000Z"',
      'date: 2026-08-01',
      'tags:',
      '  - boundary',
      '---',
      '',
      'Original body',
    ].join('\n'), 'utf8');

    const conflict = updateVaultNote(vault, 'decision/architecture', {
      content: 'stale edit',
      expected_updated_at: '2026-08-01T08:00:00.000Z',
    }, new Date('2026-08-17T01:00:00.000Z'));
    expect(conflict.status).toBe('conflict');

    const updated = updateVaultNote(vault, 'decision/architecture', {
      title: 'Architecture v2',
      content: 'Updated body',
      tags: ['sdk'],
      expected_updated_at: '2026-08-02T08:00:00.000Z',
    }, new Date('2026-08-17T01:00:00.000Z'));
    expect(updated.status).toBe('updated');
    if (updated.status !== 'updated') return;

    expect(updated.note).toEqual(expect.objectContaining({
      title: 'Architecture v2',
      created_at: '2026-08-01T08:00:00.000Z',
      updated_at: '2026-08-17T01:00:00.000Z',
      tags: ['sdk'],
    }));
    expect(updated.note.content).toContain('Updated body');

    const raw = await readFile(notePath, 'utf8');
    expect(raw).toMatch(/created_at:\s*"?2026-08-01T08:00:00\.000Z"?/);
    expect(raw).toMatch(/updated_at:\s*"?2026-08-17T01:00:00\.000Z"?/);
    expect(raw).toContain('title: Architecture v2');
  });
});
