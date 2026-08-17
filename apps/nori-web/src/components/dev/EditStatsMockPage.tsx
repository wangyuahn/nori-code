import { useEffect } from 'react';
import type { ModelCatalogItem, Session } from '../../api/client';
import type { ChatMessage, CodeChange, WorkBlock } from '../../hooks/useChatMessages';
import { ChatView } from '../ChatView';

const MOCK_STARTED_AT = new Date().toISOString();

const SESSION: Session = {
  id: 'mock-edit-stats-session',
  title: 'Edit +xx -xx preview',
  status: 'idle',
  created_at: MOCK_STARTED_AT,
  updated_at: MOCK_STARTED_AT,
  message_count: 2,
  metadata: { cwd: '/workspace' },
  agent_config: {
    model: 'mock/gpt-5.4',
    thinking: 'high',
    permission_mode: 'auto',
    plan_mode: false,
    main_write_enabled: true,
  },
};

const MODELS: ModelCatalogItem[] = [{
  provider: 'mock',
  model: 'mock/gpt-5.4',
  display_name: 'GPT-5.4 Mock',
  max_context_size: 200_000,
  capabilities: ['thinking', 'tool_use'],
}];

const WORK_BLOCKS: WorkBlock[] = [
  {
    id: 'edit-replace-recorded',
    type: 'tool',
    tool: {
      id: 'edit-replace-recorded',
      name: 'Edit',
      args: {
        path: 'apps/nori-web/src/components/ChatView.tsx',
        expected_tag: 'A1B2',
        line_ops: [{
          op: 'swap',
          start: 42,
          end: 46,
          content: [
            'const summary = summarizeToolCall(tool, tr);',
            'const recordedDiff = tool.id ? codeChanges.find(change => change.operationId === tool.id)?.diff : undefined;',
            'const failed = isToolCallFailed(tool.name, tool.result);',
            'const hasDetails = buildToolCallDetailSections(tool, detailOptions).length > 0;',
            'const statusLabel = tool.result === undefined ? tr("Running", "运行中") : tr("Done", "完成");',
          ].join('\n'),
        }],
      },
      result: '[apps/nori-web/src/components/ChatView.tsx#C3D4]\nApplied 1 line operation to apps/nori-web/src/components/ChatView.tsx.',
    },
  },
  {
    id: 'edit-insert',
    type: 'tool',
    tool: {
      id: 'edit-insert',
      name: 'Edit',
      args: {
        path: 'src/auth/session.ts',
        expected_tag: '11AA',
        line_ops: [{
          op: 'insert_post',
          line: 8,
          content: 'export function restoreSession() {\n  return readStoredToken();\n}\n',
        }],
      },
      result: '[src/auth/session.ts#22BB]\nApplied 1 line operation to src/auth/session.ts.',
    },
  },
  {
    id: 'edit-delete',
    type: 'tool',
    tool: {
      id: 'edit-delete',
      name: 'Edit',
      args: {
        path: 'src/legacy/unused.ts',
        expected_tag: '33CC',
        line_ops: [{ op: 'del', start: 10, end: 12 }],
      },
      result: '[src/legacy/unused.ts#44DD]\nApplied 1 line operation to src/legacy/unused.ts.',
    },
  },
  {
    id: 'edit-placeholder',
    type: 'tool',
    tool: {
      id: 'edit-placeholder',
      name: 'Edit',
      args: {
        path: 'apps/nori-web/src/styles/nori-theme.css',
        expected_tag: '55EE',
        line_ops: [{ op: 'swap', start: 1, end: 1, content: 'background:#050510;' }],
      },
      result: '[apps/nori-web/src/styles/nori-theme.css#66FF]\nApplied 1 line operation to apps/nori-web/src/styles/nori-theme.css.',
    },
  },
  {
    id: 'edit-ops-only',
    type: 'tool',
    tool: {
      id: 'edit-ops-only',
      name: 'Edit',
      args: {
        path: 'src/utils/format.ts',
        expected_tag: '77AA',
        line_ops: [{ op: 'swap', start: 4, end: 4, content: 'export function pad(value: string): string {\n  return value.padStart(2, "0");}' }],
      },
      result: '[src/utils/format.ts#88BB]\nApplied 1 line operation to src/utils/format.ts.',
    },
  },
];

const MESSAGES: ChatMessage[] = [
  {
    id: 'mock-user-message',
    role: 'user',
    text: '核对 Edit 工具行上的 +xx -xx 是否和真实改动一致。',
    createdAt: MOCK_STARTED_AT,
  },
  {
    id: 'mock-assistant-message',
    role: 'assistant',
    text: '已用 recorded diff 统计增删行；没有 diff 时回退到 line_ops。',
    workBlocks: WORK_BLOCKS,
    createdAt: new Date(Date.now() + 8_000).toISOString(),
  },
];

const CODE_CHANGES: CodeChange[] = [
  {
    operationId: 'edit-replace-recorded',
    agentId: 'main',
    operation: 'edit',
    path: 'apps/nori-web/src/components/ChatView.tsx',
    diff: [
      '-const failed = isToolCallFailed(tool.name, tool.result);',
      '-const hasDetails = buildToolCallDetailSections(tool).length > 0;',
      '+const recordedDiff = tool.id ? codeChanges.find(change => change.operationId === tool.id)?.diff : undefined;',
      '+const failed = isToolCallFailed(tool.name, tool.result);',
      '+const hasDetails = buildToolCallDetailSections(tool, detailOptions).length > 0;',
    ].join('\n'),
    occurredAt: MOCK_STARTED_AT,
  },
  {
    operationId: 'edit-insert',
    agentId: 'main',
    operation: 'edit',
    path: 'src/auth/session.ts',
    diff: [
      '+export function restoreSession() {',
      '+  return readStoredToken();',
      '+}',
      '+',
    ].join('\n'),
    occurredAt: MOCK_STARTED_AT,
  },
  {
    operationId: 'edit-delete',
    agentId: 'main',
    operation: 'edit',
    path: 'src/legacy/unused.ts',
    diff: [
      '-export const leftover = true;',
      '-export const staleFlag = false;',
      '-export const unusedHelper = () => undefined;',
    ].join('\n'),
    occurredAt: MOCK_STARTED_AT,
  },
  {
    operationId: 'edit-placeholder',
    agentId: 'main',
    operation: 'edit',
    path: 'apps/nori-web/src/styles/nori-theme.css',
    diff: '- [original line 1 replaced]\n+background:#050510;',
    occurredAt: MOCK_STARTED_AT,
  },
];

export function EditStatsMockPage() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const element of document.querySelectorAll('.chat-work-process')) {
        if (element instanceof HTMLDetailsElement) element.open = true;
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, []);

  return <div className="tool-call-detail-mock-page">
    <header className="exit-plan-mock-header">
      <span className="exit-plan-mock-brand">Nori Work</span>
      <strong>Edit +xx -xx</strong>
      <span className="exit-plan-mock-status">ChatView +3 -2 · insert +4 -0 · delete +0 -3 · placeholder +1 -1 · ops-only +2 -1</span>
    </header>
    <main className="exit-plan-mock-content">
      <ChatView
        session={SESSION}
        messages={MESSAGES}
        streaming=""
        thinking=""
        isStreaming={false}
        models={MODELS}
        modelsLoading={false}
        modelError={null}
        onSendMessage={() => false}
        onAbort={() => false}
        onRefreshModels={() => undefined}
        onModelChange={() => undefined}
        onThinkingChange={() => undefined}
        onPermissionChange={() => undefined}
        onTaskModeChange={() => undefined}
        onRunSlashCommand={() => false}
        onMainWriteChange={() => undefined}
        codeChanges={CODE_CHANGES}
      />
    </main>
  </div>;
}
