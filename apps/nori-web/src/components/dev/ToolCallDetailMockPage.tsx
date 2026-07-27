import { useEffect } from 'react';
import type { ModelCatalogItem, Session } from '../../api/client';
import type { ChatMessage, CodeChange, WorkBlock } from '../../hooks/useChatMessages';
import { ChatView } from '../ChatView';

const MOCK_STARTED_AT = new Date().toISOString();

const SESSION: Session = {
  id: 'mock-tool-call-detail-session',
  title: 'Tool call detail preview',
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
    id: 'mock-edit-tool',
    type: 'tool',
    tool: {
      id: 'mock-edit-tool',
      name: 'Edit',
      args: {
        path: 'apps/nori-web/src/components/ChatView.tsx',
        expected_tag: 'A1B2',
        line_ops: [
          { op: 'swap', start: 42, end: 44, content: 'const summary = summarizeToolCall(tool, tr);\nconst failed = isToolCallFailed(tool.name, tool.result);\nconst hasDetails = buildToolCallDetailSections(tool).length > 0;' },
          { op: 'del', start: 88, end: 89 },
        ],
      },
      result: 'Updated apps/nori-web/src/components/ChatView.tsx (+3 -2)',
    },
  },
  {
    id: 'mock-browser-tool',
    type: 'tool',
    tool: {
      id: 'mock-browser-tool',
      name: 'Browser',
      args: {
        action: 'navigate',
        url: 'https://example.com/docs/api',
        tab_id: 'tab-1',
      },
      result: 'Navigated to https://example.com/docs/api\nTitle: API Reference · Example Docs\nSnapshot: 24 interactive elements, 3 scroll regions.',
    },
  },
];

const MESSAGES: ChatMessage[] = [
  {
    id: 'mock-user-message',
    role: 'user',
    text: '请修改 ChatView 并打开文档页核对 API 说明。',
    createdAt: MOCK_STARTED_AT,
  },
  {
    id: 'mock-assistant-message',
    role: 'assistant',
    text: '已完成代码修改，并在浏览器中打开了文档页面进行核对。',
    workBlocks: WORK_BLOCKS,
    createdAt: new Date(Date.now() + 12_000).toISOString(),
  },
];

const CODE_CHANGES: CodeChange[] = [{
  operationId: 'mock-edit-tool',
  agentId: 'main',
  operation: 'edit',
  path: 'apps/nori-web/src/components/ChatView.tsx',
  diff: [
    '-const summary = summarizeToolCall(tool, tr);',
    '-return <div className={`compact-tool-call tool-${tool.name.toLowerCase()}`} title={tool.result?.slice(0, 600)}>',
    '+const summary = summarizeToolCall(tool, tr);',
    '+const failed = isToolCallFailed(tool.name, tool.result);',
    '+const hasDetails = buildToolCallDetailSections(tool, detailOptions).length > 0;',
    '-',
    '-',
  ].join('\n'),
  occurredAt: MOCK_STARTED_AT,
}];

export function ToolCallDetailMockPage() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const element of document.querySelectorAll('.chat-work-process, .expandable-tool-call')) {
        if (element instanceof HTMLDetailsElement) element.open = true;
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, []);

  return <div className="tool-call-detail-mock-page">
    <header className="exit-plan-mock-header">
      <span className="exit-plan-mock-brand">Nori Work</span>
      <strong>Tool call details</strong>
      <span className="exit-plan-mock-status">Edit + Browser preview</span>
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
