import type { ToolCall } from '@nori-code/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { DefaultToolApprovePermissionPolicy } from '../../../src/agent/permission/policies/default-tool-approve';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function policyContext(toolName: string, args: unknown): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    toolCalls: [
      {
        type: 'function',
        id: `call_${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('DefaultToolApprovePermissionPolicy', () => {
  const policy = new DefaultToolApprovePermissionPolicy();

  it('auto-approves CronList', () => {
    expect(policy.evaluate(policyContext('CronList', {}))).toEqual({ kind: 'approve' });
  });

  it('does not approve CronCreate', () => {
    expect(
      policy.evaluate(policyContext('CronCreate', { cron: '*/5 * * * *', prompt: 'ping' })),
    ).toBeUndefined();
  });

  it('does not approve CronDelete', () => {
    expect(policy.evaluate(policyContext('CronDelete', { id: 'job_1' }))).toBeUndefined();
  });

  it('auto-approves TeamAssign', () => {
    // Handing a track to a member has no side effect on the world by itself —
    // whatever that member then does is gated by its own policies. Delegation
    // must not need a prompt, or collaboration stalls behind approvals.
    expect(
      policy.evaluate(
        policyContext('TeamAssign', {
          assignments: [{ agent_id: 'agent-1', task: 'Check a.ts' }],
        }),
      ),
    ).toEqual({ kind: 'approve' });
  });

  it('auto-approves TeamDecide', () => {
    expect(
      policy.evaluate(policyContext('TeamDecide', { action: 'start', topic: 'Cache', statement: 'Lead first.' })),
    ).toEqual({ kind: 'approve' });
  });
});
