/**
 * A team member's transcript must rebuild in FULL from its own wire log.
 *
 * The web UI renders a subagent's history from
 * `GET /sessions/{sid}/agents/{aid}/messages`, which reads
 * `sessionDir/agents/{aid}/wire.jsonl` through `readWireTranscript`. This test
 * drives a real team member through a scripted turn — thinking, a tool call, a
 * steered TeamDM injection — and then rebuilds the transcript the same way the
 * MessageService does, asserting nothing before the "open" moment is lost:
 * thinking, tool calls + results, assistant text, and harness injections all
 * come back, while internal TeamDM/Chat transports stay filterable.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSystemAgentRecordPersistence } from '../../src/agent/records';
import {
  isInternalTeamDirectMessage,
  readWireTranscript,
  toProtocolMessages,
} from '../../src/services';
import { testAgent } from '../agent/harness/agent';

const FILE_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: 9,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

describe('team member wire transcript rebuilds full history', () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(tmpdir(), 'kimi-member-transcript-'));
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('keeps thinking, tool calls, injections, and text from before a later open', async () => {
    const memberHomedir = path.join(sessionDir, 'agents', 'agent-member');
    const ctx = testAgent({
      homedir: memberHomedir,
      persistence: new FileSystemAgentRecordPersistence(
        path.join(memberHomedir, 'wire.jsonl'),
      ),
      kaos: {
        name: 'fake',
        osEnv: {
          osKind: 'Linux',
          osArch: 'x86_64',
          osVersion: 'test',
          shellName: 'bash',
          shellPath: '/bin/bash',
        },
        pathClass: () => 'posix',
        normpath: (p: string) => p,
        gethome: () => '/home/test',
        getcwd: () => '/workspace',
        withCwd: () => {
          throw new Error('not implemented');
        },
        withEnv: () => {
          throw new Error('not implemented');
        },
        chdir: async () => {},
        stat: async () => FILE_STAT,
        iterdir: () => {
          throw new Error('not implemented');
        },
        glob: () => {
          throw new Error('not implemented');
        },
        readBytes: () => {
          throw new Error('not implemented');
        },
        readText: async () => 'file body',
        readLines: () => {
          throw new Error('not implemented');
        },
        writeBytes: () => {
          throw new Error('not implemented');
        },
        writeText: async () => 0,
        mkdir: async () => undefined,
        exec: () => {
          throw new Error('not implemented');
        },
        execWithEnv: () => {
          throw new Error('not implemented');
        },
      } as never,
    });
    ctx.configure({ tools: ['Read'] });

    // One member turn: thinking → Read tool call → final answer. A TeamDM
    // arrives mid-turn (steered at the tool boundary) plus one harness-style
    // injection lands before the turn, like the scheduler prompts do.
    ctx.mockNextResponse(
      { type: 'think', think: 'member private reasoning' },
      { type: 'text', text: 'reading the file' },
      { type: 'function', id: 'call_read_1', name: 'Read', arguments: '{"path":"notes.txt"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'member final answer' });

    ctx.agent.context.appendSystemReminder('<task>do the work</task>', {
      kind: 'system_trigger',
      name: 'team_assignment',
    });
    ctx.emitter.once('tool.result', () => {
      ctx.agent.turn.steer(
        [{ type: 'text', text: '<system-reminder>\n[TeamDM] Lead: change of plan\n</system-reminder>' }],
        {
          kind: 'system_trigger',
          name: 'team_dm',
          speaker: { from: 'lead', speakerId: 'main', speakerName: '主代理' },
        },
      );
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start member work' }] });
    await ctx.untilTurnEnd();
    await ctx.agent.records.flush();

    const transcript = await readWireTranscript(sessionDir, 'agent-member');
    const flat = JSON.stringify(transcript.entries.map((entry) => entry.message));

    expect(flat).toContain('member private reasoning');
    expect(flat).toContain('"Read"');
    expect(flat).toContain('call_read_1');
    expect(flat).toContain('member final answer');
    expect(flat).toContain('team_assignment');

    // The steered TeamDM reached the member's model context…
    const dmEntries = transcript.entries.filter((entry) =>
      isInternalTeamDirectMessage(entry.message as Parameters<typeof isInternalTeamDirectMessage>[0]),
    );
    expect(dmEntries.length).toBeGreaterThanOrEqual(1);
    // …and is exactly the class of record the REST layer hides.
    for (const entry of dmEntries) {
      expect(isInternalTeamDirectMessage(entry.message as Parameters<typeof isInternalTeamDirectMessage>[0])).toBe(true);
    }

    // Protocol mapping keeps thinking + tool_use parts for the UI.
    const protocol = transcript.entries.flatMap((entry, index) =>
      toProtocolMessages('sess_x', index, entry.message, 1_700_000_000_000),
    );
    const roles = protocol.map((message) => message.role);
    expect(roles).toContain('assistant');
    const contentTypes = new Set(protocol.flatMap((message) => message.content.map((part) => part.type)));
    expect(contentTypes.has('thinking')).toBe(true);
    expect(contentTypes.has('tool_use')).toBe(true);
    expect(contentTypes.has('tool_result')).toBe(true);
  });
});
