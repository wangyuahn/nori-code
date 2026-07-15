import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness } from '#/index';
import type { KimiError } from '#/index';

import {
  SessionStore,
  encodeWorkDirKey,
  normalizeWorkDir,
  sessionIndexPath,
} from '../../agent-core/src/session/store';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-list-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSessionState(
  sessionDir: string,
  state: Record<string, unknown>,
): Promise<string> {
  const statePath = join(sessionDir, 'state.json');
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  return statePath;
}

async function writeMainWire(
  sessionDir: string,
  records: readonly Record<string, unknown>[],
): Promise<string> {
  const agentDir = join(sessionDir, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  const wirePath = join(agentDir, 'wire.jsonl');
  await writeFile(
    wirePath,
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    'utf-8',
  );
  return wirePath;
}

describe('SessionStore.list', () => {
  it('returns an empty array when the workDir bucket does not exist', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await expect(store.list({ workDir })).resolves.toEqual([]);
  });

  it('creates workDir-scoped session directories and a root session index', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const summary = await store.create({ id: 'ses_list_full', workDir });

    expect(summary).toMatchObject({
      id: 'ses_list_full',
      workDir: normalizeWorkDir(workDir),
      title: undefined,
    });
    expect(summary.sessionDir).not.toBe(join(homeDir, 'sessions', 'ses_list_full'));
    expect(basename(summary.sessionDir)).toBe('ses_list_full');
    const workdirKey = basename(dirname(summary.sessionDir));
    expect(workdirKey).toBe(encodeWorkDirKey(workDir));
    expect(workdirKey.length).toBeLessThan(70);
    expect(existsSync(join(summary.sessionDir, 'state.json'))).toBe(false);

    const indexRaw = await readFile(sessionIndexPath(homeDir), 'utf-8');
    expect(indexRaw).toContain('"sessionId":"ses_list_full"');
    expect(indexRaw).toContain(summary.sessionDir);
    expect(indexRaw).toContain(`"workDir":"${normalizeWorkDir(workDir)}"`);
  });

  it('forks a session directory, rewrites metadata, and drops reserved goal state', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const source = await store.create({ id: 'ses_fork_source', workDir });
    const sourceAgentDir = join(source.sessionDir, 'agents', 'main');
    const sourceSubagentDir = join(source.sessionDir, 'agents', 'agent-1');
    await mkdir(sourceAgentDir, { recursive: true });
    await mkdir(sourceSubagentDir, { recursive: true });
    await writeFile(join(sourceAgentDir, 'wire.jsonl'), '{"type":"context.clear"}\n', 'utf-8');
    await writeFile(join(sourceSubagentDir, 'wire.jsonl'), '{"type":"context.clear"}\n', 'utf-8');
    await writeFile(
      join(source.sessionDir, 'upcoming-goals.json'),
      `${JSON.stringify({ version: 1, goals: [{ id: 'queued-1', objective: 'source queued goal' }] })}\n`,
      'utf-8',
    );
    await writeSessionState(source.sessionDir, {
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
      title: 'Source title',
      isCustomTitle: true,
      agents: {
        main: {
          homedir: sourceAgentDir,
          type: 'main',
        },
        'agent-1': {
          homedir: sourceSubagentDir,
          type: 'subagent',
          parentAgentId: 'main',
        },
      },
      custom: {
        source: true,
        goal: {
          goalId: 'source-goal',
          objective: 'source objective',
          status: 'active',
          turnsUsed: 0,
          tokensUsed: 0,
          budgetLimits: {},
        },
      },
    });

    const fork = await store.fork({
      sourceId: source.id,
      targetId: 'ses_fork_child',
      title: 'Fork title',
      metadata: {
        child: true,
        goal: {
          goalId: 'metadata-goal',
          objective: 'metadata objective',
          status: 'active',
          turnsUsed: 0,
          tokensUsed: 0,
          budgetLimits: {},
        },
      },
    });

    const forkState = JSON.parse(await readFile(join(fork.sessionDir, 'state.json'), 'utf-8')) as {
      title?: string;
      isCustomTitle?: boolean;
      forkedFrom?: string;
      agents?: { main?: { homedir?: string } };
      custom?: Record<string, unknown>;
    };
    expect(forkState.title).toBe('Fork title');
    expect(forkState.isCustomTitle).toBe(true);
    expect(forkState.forkedFrom).toBe(source.id);
    expect(forkState.agents?.main?.homedir).toBe(
      normalizeWorkDir(join(fork.sessionDir, 'agents', 'main')),
    );
    expect(forkState.custom).toMatchObject({ source: true, child: true });
    expect(forkState.custom).not.toHaveProperty('goal');
    expect(existsSync(join(fork.sessionDir, 'upcoming-goals.json'))).toBe(false);
    expect(existsSync(join(source.sessionDir, 'upcoming-goals.json'))).toBe(true);
    const forkWire = await readFile(join(fork.sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(forkWire
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { type: 'context.clear' },
      { type: 'forked', time: expect.any(Number) },
    ]);
    const forkSubagentWire = await readFile(
      join(fork.sessionDir, 'agents', 'agent-1', 'wire.jsonl'),
      'utf-8',
    );
    expect(forkSubagentWire
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { type: 'context.clear' },
      { type: 'forked', time: expect.any(Number) },
    ]);

    const sourceState = JSON.parse(
      await readFile(join(source.sessionDir, 'state.json'), 'utf-8'),
    ) as { forkedFrom?: string };
    expect(sourceState.forkedFrom).toBeUndefined();
    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id).toSorted()).toEqual([
      source.id,
      fork.id,
    ].toSorted());
  });

  it('returns only sessions from the requested workDir bucket', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_list_a', workDir });
    await store.create({ id: 'ses_other_workdir', workDir: otherWorkDir });

    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id)).toEqual(['ses_list_a']);
  });

  it('uses the workDir bucket before the session index when sessionId is provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const local = await store.create({ id: 'ses_bucket_hit', workDir });
    await rm(sessionIndexPath(homeDir), { force: true });

    const sessions = await store.list({ workDir, sessionId: local.id });
    expect(sessions.map((session) => session.id)).toEqual([local.id]);
  });

  it('falls back to the session index when a workDir-scoped sessionId is not in that bucket', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_local', workDir });
    const other = await store.create({ id: 'ses_index_fallback', workDir: otherWorkDir });

    const sessions = await store.list({ workDir, sessionId: other.id });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: other.id,
      workDir: normalizeWorkDir(otherWorkDir),
    });
  });

  it('lists every indexed session when no filters are provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_all_a', workDir });
    await store.create({ id: 'ses_all_b', workDir: otherWorkDir });

    const sessions = await store.list();
    expect(sessions.map((session) => session.id).toSorted()).toEqual([
      'ses_all_a',
      'ses_all_b',
    ]);
  });

  it('returns an empty array when a sessionId filter is unknown', async () => {
    const homeDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await expect(store.list({ sessionId: 'ses_missing' })).resolves.toEqual([]);
  });

  it('reads title from customTitle before title', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const custom = await store.create({ id: 'ses_custom_title', workDir });
    await writeSessionState(custom.sessionDir, {
      title: 'Base Title',
      customTitle: 'Custom Title',
    });
    const fallback = await store.create({ id: 'ses_fallback_title', workDir });
    await writeSessionState(fallback.sessionDir, {
      title: 'Fallback Title',
    });

    const sessions = await store.list({ workDir });
    expect(sessions.find((session) => session.id === custom.id)?.title).toBe('Custom Title');
    expect(sessions.find((session) => session.id === fallback.id)?.title).toBe('Fallback Title');
  });

  it('keeps sessions visible when state.json is missing or malformed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_no_state', workDir });
    const malformed = await store.create({ id: 'ses_bad_state', workDir });
    await writeFile(join(malformed.sessionDir, 'state.json'), '{bad json', 'utf-8');

    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id).toSorted()).toEqual([
      'ses_bad_state',
      'ses_no_state',
    ]);
    expect(sessions.every((session) => session.title === undefined)).toBe(true);
  });

  it('summarizes main-agent usage, real user prompts, and the used model', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);
    const created = await store.create({ id: 'ses_wire_summary', workDir });
    const usage = (
      inputOther: number,
      output: number,
      inputCacheRead: number,
      inputCacheCreation: number,
    ) => ({ inputOther, output, inputCacheRead, inputCacheCreation });

    const wirePath = await writeMainWire(created.sessionDir, [
      { type: 'config.update', modelAlias: 'configured-first' },
      { type: 'turn.prompt', input: [], origin: { kind: 'user' } },
      {
        type: 'turn.prompt',
        input: [],
        origin: { kind: 'skill_activation', trigger: 'user-slash' },
      },
      { type: 'turn.prompt', input: [], origin: { kind: 'system_trigger', name: 'goal' } },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [], origin: { kind: 'user' } },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [],
          origin: { kind: 'skill_activation', trigger: 'user-slash' },
        },
      },
      { type: 'usage.record', model: 'unknown', usage: usage(1, 2, 3, 4) },
      { type: 'usage.record', model: 'used-model', usage: usage(6, 6, 6, 6) },
      { type: 'usage.record', model: 'used-model', usage: usage(6, 6, 6, 6) },
      { type: 'usage.record', model: 'less-used-later', usage: usage(10, 10, 10, 10) },
      { type: 'usage.record', model: 'broken-model', usage: { inputOther: 99 } },
      { type: 'config.update', modelAlias: 'configured-later' },
    ]);
    const subagentDir = join(created.sessionDir, 'agents', 'agent-1');
    await mkdir(subagentDir, { recursive: true });
    await writeFile(
      join(subagentDir, 'wire.jsonl'),
      `${JSON.stringify({ type: 'usage.record', model: 'subagent-model', usage: usage(1_000, 1_000, 1_000, 1_000) })}\n`,
      'utf-8',
    );

    const initialExpected = {
      messageCount: 2,
      model: 'used-model',
      usage: {
        byModel: {
          unknown: usage(1, 2, 3, 4),
          'used-model': usage(12, 12, 12, 12),
          'less-used-later': usage(10, 10, 10, 10),
        },
        total: usage(23, 24, 25, 26),
      },
    };
    expect((await store.list({ workDir }))[0]).toMatchObject(initialExpected);
    expect(await store.get(created.id)).toMatchObject(initialExpected);
    expect((await store.list({ workDir }))[0]).toMatchObject(initialExpected);

    await appendFile(
      wirePath,
      `${JSON.stringify({ type: 'usage.record', model: 'dominant-after-append', usage: usage(100, 100, 100, 100) })}\n`,
      'utf-8',
    );

    const refreshedExpected = {
      messageCount: 2,
      model: 'dominant-after-append',
      usage: {
        byModel: {
          unknown: usage(1, 2, 3, 4),
          'used-model': usage(12, 12, 12, 12),
          'less-used-later': usage(10, 10, 10, 10),
          'dominant-after-append': usage(100, 100, 100, 100),
        },
        total: usage(123, 124, 125, 126),
      },
    };
    expect((await store.list({ workDir }))[0]).toMatchObject(refreshedExpected);
    expect(await store.get(created.id)).toMatchObject(refreshedExpected);
  });

  it('falls back to historical user context messages when turn prompts are absent', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);
    const created = await store.create({ id: 'ses_context_message_count', workDir });
    await writeMainWire(created.sessionDir, [
      {
        type: 'context.append_message',
        message: { role: 'user', content: [], origin: { kind: 'user' } },
      },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [], origin: { kind: 'user' } },
      },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [], origin: { kind: 'injection', variant: 'rules' } },
      },
      {
        type: 'context.append_message',
        message: { role: 'assistant', content: [] },
      },
    ]);

    expect((await store.list({ workDir }))[0]?.messageCount).toBe(2);
  });

  it('reuses main-wire summaries until mtime or size changes', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);
    const created = await store.create({ id: 'ses_wire_cache', workDir });
    const record = (model: string) => JSON.stringify({
      type: 'usage.record',
      model,
      usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
    });
    const firstContent = record('model-a');
    const secondContent = record('model-b');
    expect(firstContent).toHaveLength(secondContent.length);
    const wirePath = join(created.sessionDir, 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const fixedTime = new Date('2030-04-18T12:00:00.000Z');
    await writeFile(wirePath, firstContent, 'utf-8');
    await utimes(wirePath, fixedTime, fixedTime);

    expect((await store.list({ workDir }))[0]?.model).toBe('model-a');

    await writeFile(wirePath, secondContent, 'utf-8');
    await utimes(wirePath, fixedTime, fixedTime);
    expect((await stat(wirePath)).size).toBe(Buffer.byteLength(firstContent));
    expect((await store.list({ workDir }))[0]?.model).toBe('model-a');

    await writeFile(wirePath, `${secondContent}\n`, 'utf-8');
    await utimes(wirePath, fixedTime, fixedTime);
    expect((await store.list({ workDir }))[0]?.model).toBe('model-b');
  });

  it('keeps listing sessions when main wire records are missing or corrupted', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);
    const missing = await store.create({ id: 'ses_wire_missing', workDir });
    const damaged = await store.create({ id: 'ses_wire_damaged', workDir });
    const wirePath = join(damaged.sessionDir, 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    await writeFile(
      wirePath,
      [
        JSON.stringify({ type: 'turn.prompt', input: [], origin: { kind: 'user' } }),
        JSON.stringify({
          type: 'usage.record',
          model: 'valid-before-damage',
          usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        }),
        '{bad json',
        JSON.stringify({ type: 'turn.prompt', input: [], origin: { kind: 'user' } }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id).toSorted()).toEqual([
      damaged.id,
      missing.id,
    ].toSorted());
    expect(sessions.find((session) => session.id === missing.id)).toMatchObject({
      messageCount: 0,
    });
    expect(sessions.find((session) => session.id === damaged.id)).toMatchObject({
      messageCount: 1,
      model: 'valid-before-damage',
      usage: {
        total: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
      },
    });
  });

  it('sorts by filesystem activity descending', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const oldSession = await store.create({ id: 'ses_old', workDir });
    const newSession = await store.create({ id: 'ses_new', workDir });
    const oldTime = new Date('2030-04-18T12:00:00Z');
    const newTime = new Date('2030-04-18T12:00:10Z');
    await writeFile(join(oldSession.sessionDir, 'wire.jsonl'), '{}\n', 'utf-8');
    await writeFile(join(newSession.sessionDir, 'wire.jsonl'), '{}\n', 'utf-8');
    await utimes(join(oldSession.sessionDir, 'wire.jsonl'), oldTime, oldTime);
    await utimes(join(newSession.sessionDir, 'wire.jsonl'), newTime, newTime);

    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id)).toEqual(['ses_new', 'ses_old']);
  });

  it('does not scan legacy flat session directories', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await mkdir(join(homeDir, 'sessions', 'ses_legacy_flat'), { recursive: true });
    await writeSessionState(join(homeDir, 'sessions', 'ses_legacy_flat'), {
      session_id: 'ses_legacy_flat',
      workspace_dir: workDir,
      custom_title: 'Legacy Flat',
    });

    const store = new SessionStore(homeDir);
    await expect(store.list({ workDir })).resolves.toEqual([]);
    await expect(store.get('ses_legacy_flat')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.not_found',
    });
  });
});

describe('KimiHarness.listSessions', () => {
  it('rejects whitespace-only workDir with request.work_dir_required', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(harness.listSessions({ workDir: '   ' })).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('lists all sessions when no payload is provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await harness.createSession({ id: 'ses_harness_all_a', workDir });
      await harness.createSession({ id: 'ses_harness_all_b', workDir: otherWorkDir });

      const sessions = await harness.listSessions();
      expect(sessions.map((session) => session.id).toSorted()).toEqual([
        'ses_harness_all_a',
        'ses_harness_all_b',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('resolves relative workDir inputs before filtering', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });
    const originalCwd = process.cwd();

    try {
      process.chdir(workDir);
      const session = await harness.createSession({ id: 'ses_relative_workdir', workDir: '.' });

      const sessions = await harness.listSessions({ workDir: '.' });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      process.chdir(originalCwd);
      await harness.close();
    }
  });

  it('lists persisted sessions after the active Session has been closed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_closed_but_listed', workDir });
      await harness.closeSession(session.id);

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });
});
