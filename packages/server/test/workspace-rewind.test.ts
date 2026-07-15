import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { captureWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from '../src/services/rewind/workspaceRewind';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('workspace rewind', () => {
  it('restores tracked and newly-created files to an earlier prompt checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nori-rewind-'));
    cleanup.push(root);
    await execFileAsync('git', ['init'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'before\n');

    const sessionId = `test-${Date.now()}`;
    await captureWorkspaceCheckpoint(sessionId, root);
    await writeFile(join(root, 'tracked.txt'), 'middle\n');
    await writeFile(join(root, 'created.txt'), 'created\n');
    await captureWorkspaceCheckpoint(sessionId, root);
    cleanup.push(join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', '.nori-code', 'rewind', sessionId));
    await writeFile(join(root, 'tracked.txt'), 'after\n');
    await rm(join(root, 'created.txt'));

    expect(await restoreWorkspaceCheckpoint(sessionId, 2)).toBe(true);
    expect((await readFile(join(root, 'tracked.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('before\n');
    await expect(readFile(join(root, 'created.txt'), 'utf8')).rejects.toThrow();
  });
});
