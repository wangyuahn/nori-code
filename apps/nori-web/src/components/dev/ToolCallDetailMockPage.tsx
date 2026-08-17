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
    id: 'mock-read-tool',
    type: 'tool',
    tool: {
      id: 'mock-read-tool',
      name: 'Read',
      args: { path: 'src/auth.ts', line_offset: 1 },
      result: 'export function login(user: string) {\n  return issueToken(user);\n}\n',
    },
  },
  {
    id: 'mock-grep-tool',
    type: 'tool',
    tool: {
      id: 'mock-grep-tool',
      name: 'Grep',
      args: { pattern: 'countActiveAgents', path: 'apps/nori-web', glob: '*.ts' },
      result: 'apps/nori-web/src/App.tsx:593:export function countActiveAgents(\napps/nori-web/test/PrimaryNavigation.test.ts:5:import { countActiveAgents }',
    },
  },
  {
    id: 'mock-write-tool',
    type: 'tool',
    tool: {
      id: 'mock-write-tool',
      name: 'Write',
      args: {
        path: 'notes/auth.md',
        content: '# Auth\n\nLogin issues a token for the given user.\n',
      },
      result: 'Wrote notes/auth.md',
    },
  },
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
    id: 'mock-bash-tool',
    type: 'tool',
    tool: {
      id: 'mock-bash-tool',
      name: 'Bash',
      args: { command: 'pnpm --filter @nori-code/nori-web exec vitest run test/tool-call-detail.test.ts' },
      result: 'Test Files  1 passed (1)\n      Tests  9 passed (9)',
    },
  },
  {
    id: 'mock-agent-tool',
    type: 'tool',
    tool: {
      id: 'mock-agent-tool',
      name: 'Agent',
      args: {
        subagent_type: 'explore',
        prompt: 'Find every authentication entry point and summarize the login flow, including token issuance and session restore.',
      },
      result: 'Auth entry points: src/auth.ts, src/session.ts. Login issues a token and restores the session from local storage.',
    },
  },
  {
    id: 'mock-websearch-tool',
    type: 'tool',
    tool: {
      id: 'mock-websearch-tool',
      name: 'WebSearch',
      args: { query: 'RFC 9110 HTTP semantics cache invalidation' },
      result: '1. RFC 9110 — HTTP Semantics\n2. Cache invalidation is the responsibility of the origin.',
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
  {
    id: 'mock-glob-tool',
    type: 'tool',
    tool: {
      id: 'mock-glob-tool',
      name: 'Glob',
      args: { pattern: '**/*.test.ts', path: 'apps/nori-web' },
      result: 'apps/nori-web/test/ChatView.test.ts\napps/nori-web/test/tool-call-detail.test.ts',
    },
  },
  {
    id: 'mock-fetch-tool',
    type: 'tool',
    tool: {
      id: 'mock-fetch-tool',
      name: 'FetchURL',
      args: { url: 'https://example.com/docs/api' },
      result: '# API Reference\n\nGET /v1/sessions returns the session list.\nPOST /v1/sessions creates a session.',
    },
  },
  {
    id: 'mock-mcp-tool',
    type: 'tool',
    tool: {
      id: 'mock-mcp-tool',
      name: 'mcp__github__create_issue',
      args: {
        title: 'Fix collaboration badge',
        body: 'The collaboration badge counted the wrong session.\nCount paused agents too.',
      },
      result: 'Created issue #12',
    },
  },
  {
    id: 'mock-todo-tool',
    type: 'tool',
    tool: {
      id: 'mock-todo-tool',
      name: 'TodoList',
      args: {
        todos: [
          { title: 'Fix collaboration badge', status: 'done' },
          { title: 'Show every tool payload', status: 'in_progress' },
        ],
      },
      result: 'Current todo list:\n  [done] Fix collaboration badge\n  [in_progress] Show every tool payload',
    },
  },
  {
    id: 'mock-memory-tool',
    type: 'tool',
    tool: {
      id: 'mock-memory-tool',
      name: 'nori_memory_search',
      args: { keywords: ['auth', 'login', 'token'] },
      result: '[score: 0.91, written: 2026-08-17T00:00:00.000Z] analysis/auth.md\nLogin issues a token and restores the session.',
    },
  },
];

const MESSAGES: ChatMessage[] = [
  {
    id: 'mock-user-message',
    role: 'user',
    text: '请修改 ChatView，并核对登录流程、搜索结果和文档页。',
    createdAt: MOCK_STARTED_AT,
  },
  {
    id: 'mock-assistant-message',
    role: 'assistant',
    text: '已完成代码修改，并核对了登录流程、搜索结果和文档页面。',
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
      <span className="exit-plan-mock-status">Every tool call expands with its full input and output</span>
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
