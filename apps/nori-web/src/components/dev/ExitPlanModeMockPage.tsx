import { useRef, useState } from 'react';
import type { ApprovalRequest, ModelCatalogItem, Session } from '../../api/client';
import type { ChatMessage, WorkBlock } from '../../hooks/useChatMessages';
import { ChatView } from '../ChatView';

const TOOL_CALL_ID = 'mock-exit-plan-mode-tool';
const APPROVAL_ID = 'mock-exit-plan-mode-approval';
const MOCK_STARTED_AT = new Date().toISOString();
const MOCK_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const PLAN = `# ExitPlanMode implementation plan

1. Inspect the current approval event and tool-call rendering path.
2. Add a dedicated ExitPlanMode renderer that keeps the full plan readable.
3. Show a direct approval control without duplicating the plan in the permission dock.
4. Collapse the plan automatically after approval while keeping it available for review.
5. Verify pending, approved, revised, and historical states.

## Validation target

- The render path remains linear: $T(n) = O(n)$.
- The approval state follows:

$$
S_{next} = f(S_{current}, decision)
$$

> Only the Plan disclosure is collapsed after approval; the final model output remains visible.`;

const SESSION: Session = {
  id: 'mock-exit-plan-mode-session',
  title: 'ExitPlanMode UI preview',
  status: 'running',
  created_at: MOCK_STARTED_AT,
  updated_at: MOCK_STARTED_AT,
  message_count: 2,
  metadata: { cwd: 'C:/Users/sudden/Desktop/nori-code' },
  agent_config: {
    model: 'mock/gpt-5.4',
    thinking: 'high',
    permission_mode: 'manual',
    plan_mode: true,
    main_write_enabled: false,
  },
};

const MODELS: ModelCatalogItem[] = [{
  provider: 'mock',
  model: 'mock/gpt-5.4',
  display_name: 'GPT-5.4 Mock',
  max_context_size: 200_000,
  capabilities: ['thinking', 'tool_use'],
}];

const MESSAGES: ChatMessage[] = [
  {
    id: 'mock-user-message',
    role: 'user',
    text: '先给出完整实施计划，得到我的允许后再开始修改。',
    createdAt: MOCK_STARTED_AT,
  },
  {
    id: 'mock-assistant-message',
    role: 'assistant',
    text: '我已经检查了相关调用链，下面提交实施计划等待确认。',
    createdAt: MOCK_STARTED_AT,
  },
];

interface ExitPlanModeMockSnapshot {
  pendingApprovals: ApprovalRequest[];
  workBlocks: WorkBlock[];
  streaming: string;
}

class ExitPlanModeMockBackend {
  private snapshot: ExitPlanModeMockSnapshot = createPendingSnapshot();

  getSnapshot(): ExitPlanModeMockSnapshot {
    return this.snapshot;
  }

  async resolveApproval(
    approvalId: string,
    decision: 'approved' | 'rejected' | 'cancelled',
    options?: { feedback?: string; selectedLabel?: string },
  ): Promise<ExitPlanModeMockSnapshot> {
    if (approvalId !== APPROVAL_ID) throw new Error('Unknown mock approval');
    await new Promise(resolve => window.setTimeout(resolve, 180));

    const outcome = decision === 'approved'
      ? `Plan approved.\n\n## Approved Plan:\n${PLAN}`
      : `Plan ${options?.selectedLabel === 'Revise' ? 'sent back for revision' : 'rejected'}.${options?.feedback ? `\n\nFeedback: ${options.feedback}` : ''}`;
    this.snapshot = {
      pendingApprovals: [],
      workBlocks: [{
        id: 'mock-plan-tool-block',
        type: 'tool',
        tool: { id: TOOL_CALL_ID, name: 'ExitPlanMode', args: { plan: PLAN }, result: outcome },
      }],
      streaming: decision === 'approved'
        ? '计划已批准，正在按计划进入执行阶段。'
        : '计划未获批准，正在等待下一步指示。',
    };
    return this.snapshot;
  }
}

function createPendingSnapshot(): ExitPlanModeMockSnapshot {
  return {
    pendingApprovals: [{
      approval_id: APPROVAL_ID,
      session_id: SESSION.id,
      tool_call_id: TOOL_CALL_ID,
      tool_name: 'ExitPlanMode',
      action: 'Review the implementation plan before execution',
      tool_input_display: {
        kind: 'plan_review',
        plan: PLAN,
        path: 'C:/Users/sudden/Desktop/nori-code/.nori-code/plans/exit-plan-mode.md',
      },
      created_at: MOCK_STARTED_AT,
      expires_at: MOCK_EXPIRES_AT,
    }],
    workBlocks: [{
      id: 'mock-plan-tool-block',
      type: 'tool',
      tool: { id: TOOL_CALL_ID, name: 'ExitPlanMode', args: { plan: PLAN } },
    }],
    streaming: '',
  };
}

export function ExitPlanModeMockPage() {
  const backendRef = useRef<ExitPlanModeMockBackend | null>(null);
  backendRef.current ??= new ExitPlanModeMockBackend();
  const [snapshot, setSnapshot] = useState(() => backendRef.current!.getSnapshot());

  return <div className="exit-plan-mock-page">
    <header className="exit-plan-mock-header">
      <span className="exit-plan-mock-brand">Nori Work</span>
      <strong>ExitPlanMode</strong>
      <span className="exit-plan-mock-status">Mock backend</span>
    </header>
    <main className="exit-plan-mock-content">
      <ChatView
        session={SESSION}
        messages={MESSAGES}
        streaming={snapshot.streaming}
        thinking=""
        workBlocks={snapshot.workBlocks}
        isStreaming
        models={MODELS}
        modelsLoading={false}
        modelError={null}
        pendingApprovals={snapshot.pendingApprovals}
        onResolveApproval={async (approvalId, decision, options) => {
          setSnapshot(await backendRef.current!.resolveApproval(approvalId, decision, options));
        }}
        onSendMessage={() => false}
        onAbort={() => false}
        onRefreshModels={() => undefined}
        onModelChange={() => undefined}
        onThinkingChange={() => undefined}
        onPermissionChange={() => undefined}
        onTaskModeChange={() => undefined}
        onRunSlashCommand={() => false}
        onMainWriteChange={() => undefined}
      />
    </main>
  </div>;
}
