import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../../src/session/store';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('session store titles', () => {
  it('does not expose a persisted system reminder as a session title', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'nori-session-title-'));
    tempDirs.push(homeDir);
    const store = new SessionStore(homeDir);
    const created = await store.create({ id: 'session_title_test', workDir: join(homeDir, 'work') });
    await writeFile(join(created.sessionDir, 'state.json'), JSON.stringify({
      title: '<system-reminder>Generate a title.</system-reminder>',
      isCustomTitle: false,
    }));

    expect((await store.get(created.id)).title).toBeUndefined();
  });
});
