import { describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

/**
 * 权限模式是整个会话的一个设置，不是每个窗口各自一份：用户选了 auto，主智能体和
 * 所有成员（包括二层成员和之后新招的人）都要是 auto。
 */
function createSessionRpc(): SDKSessionRPC {
  return new Proxy({}, { get: () => vi.fn() }) as SDKSessionRPC;
}

function contextProfile(): ResolvedAgentProfile {
  return { name: 'context-profile', systemPrompt: () => 'test', tools: [] };
}

async function teamSession(id: string) {
  const session = new Session({
    id,
    kaos: createFakeKaos({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(0),
    }),
    homedir: '/tmp/kimi-session',
    rpc: createSessionRpc(),
    initializeMainAgent: false,
  });
  const main = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
  const hire = (leader: string, name: string) =>
    session.createAgent(
      { type: 'sub' },
      {
        kind: 'team',
        parentAgentId: leader,
        teamLeaderAgentId: leader,
        profile: contextProfile(),
        teamIdentity: { name, mandate: `${name} works`, role: 'member' },
      },
    );
  return { session, main, hire };
}

describe('session-wide permission mode', () => {
  it('applies one mode to the main agent and every team member, at any depth', async () => {
    const { session, main, hire } = await teamSession('test-session-permission-tree');
    try {
      const lead = await hire(main.id, 'Lead');
      const member = await hire(lead.id, 'Member');
      const modes = () =>
        [main, lead, member].map(entry => entry.agent.permission.mode);
      expect(modes()).toEqual(['manual', 'manual', 'manual']);

      session.applySessionPermissionMode('auto');
      expect(modes()).toEqual(['auto', 'auto', 'auto']);

      // 之后新招的人也从会话级模式起步，不用再点一次下拉框。
      const late = await hire(lead.id, 'Late');
      expect(late.agent.permission.mode).toBe('auto');

      session.applySessionPermissionMode('manual');
      expect([...modes(), late.agent.permission.mode])
        .toEqual(['manual', 'manual', 'manual', 'manual']);
    } finally {
      await session.close();
    }
  });

  it('routes a per-agent setPermission call through the whole session', async () => {
    const { session, main, hire } = await teamSession('test-session-permission-rpc');
    try {
      const lead = await hire(main.id, 'Lead');
      // 用户是在成员窗口里改的，但主智能体也要跟着变。
      await new SessionAPIImpl(session).setPermission({ agentId: lead.id, mode: 'yolo' });
      expect([main.agent.permission.mode, lead.agent.permission.mode]).toEqual(['yolo', 'yolo']);
    } finally {
      await session.close();
    }
  });

  it('keeps a member read-only-manual while its lead is in Discuss', async () => {
    const { session, main, hire } = await teamSession('test-session-permission-discuss');
    try {
      const member = await hire(main.id, 'Member');
      await main.agent.discussMode.enter();
      session.applySessionPermissionMode('auto');
      // Discuss 期间成员只读，这是讨论轮次的约束，不是用户的权限选择。
      expect(main.agent.permission.mode).toBe('auto');
      expect(member.agent.permission.mode).toBe('manual');

      main.agent.discussMode.exit();
      session.applySessionPermissionMode('auto');
      expect(member.agent.permission.mode).toBe('auto');
    } finally {
      await session.close();
    }
  });
});
