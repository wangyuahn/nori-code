import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, type FsDiffResponse, type FsGitStatusResponse, type FsReadResponse, type GoalSnapshot } from '../api/client';
import type { ChatMessage, CodeChange, TodoItem } from '../hooks/useChatMessages';
import type { GitStatusRefreshOptions } from '../hooks/useFilesystem';
import { useI18n } from '../i18n';
import { FilePreview } from './FilePreview';
import { Icon } from './Icon';
import { LspPanel } from './LspPanel';

const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({ default: module.TerminalPanel })));
const BrowserPanel = lazy(() => import('./BrowserPanel').then(module => ({ default: module.BrowserPanel })));

export type InspectorTab = 'preview' | 'changes' | 'browser' | 'git' | 'lsp' | 'terminal';
const DEFAULT_INSPECTOR_TABS: InspectorTab[] = ['changes', 'preview', 'browser', 'git', 'lsp', 'terminal'];
const INSPECTOR_PINNED_KEY = 'nori-inspector-overview-pinned';

interface OpenInspectorTab {
  id: string;
  tool: InspectorTab;
}

interface WorkspaceInspectorProps {
  sessionId: string | null;
  projectPath?: string;
  path: string;
  file: FsReadResponse | null;
  loading?: boolean;
  messages: ChatMessage[];
  codeChanges: CodeChange[];
  gitStatus: FsGitStatusResponse | null;
  gitError: string | null;
  gitLoading: boolean;
  refreshGitStatus: (options?: GitStatusRefreshOptions) => Promise<FsGitStatusResponse | null>;
  refreshMessages?: () => Promise<void>;
  refreshFile?: () => void | Promise<void>;
  isStreaming: boolean;
  mainWorking?: boolean;
  activeAgentCount?: number;
  activeAgentTokens?: number;
  goal?: GoalSnapshot | null;
  todos?: TodoItem[];
  onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void>;
  onSelectFilePath?: (path: string) => void;
  initialTab?: InspectorTab;
  standalone?: boolean;
  overviewFirst?: boolean;
}

export function WorkspaceInspector({ sessionId, projectPath, path, file, loading, messages, codeChanges, gitStatus, gitError, gitLoading, refreshGitStatus, refreshMessages, refreshFile, isStreaming, mainWorking = false, activeAgentCount = 0, activeAgentTokens = 0, goal = null, todos = [], onGoalControl, onSelectFilePath, initialTab, standalone = false, overviewFirst = false }: WorkspaceInspectorProps) {
  const { tr } = useI18n();
  const initialActiveTab = standalone || !overviewFirst ? initialTab ?? 'changes' : initialTab ?? null;
  const initialActiveTabId = initialActiveTab ? `${initialActiveTab}-initial` : null;
  const [activeTabId, setActiveTabId] = useState<string | null>(initialActiveTabId);
  const [openTabs, setOpenTabs] = useState<OpenInspectorTab[]>(() => initialActiveTab ? [{ id: initialActiveTabId!, tool: initialActiveTab }] : []);
  const [tabOrder, setTabOrder] = useState<InspectorTab[]>(loadInspectorTabOrder);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [overviewPinned, setOverviewPinned] = useState(loadInspectorPinned);
  const [textChangeCount, setTextChangeCount] = useState<number>();
  const [diagnosticCount, setDiagnosticCount] = useState<number>();
  const [revealLine, setRevealLine] = useState<number>();
  const previewRefreshRef = useRef({ path: '', mutationKey: '' });
  const toolPickerRef = useRef<HTMLDivElement>(null);
  const nextTabIdRef = useRef(1);
  const activeTab = openTabs.find(item => item.id === activeTabId);
  const tab = activeTab?.tool ?? null;

  useEffect(() => {
    if (!path || standalone) return;
    setOpenTabs(previous => {
      const existing = [...previous].reverse().find(item => item.tool === 'preview');
      if (existing) {
        setActiveTabId(existing.id);
        return previous;
      }
      const created = { id: `preview-${nextTabIdRef.current++}`, tool: 'preview' as const };
      setActiveTabId(created.id);
      return [...previous, created];
    });
  }, [path, standalone]);

  useEffect(() => {
    if (!toolPickerOpen) return;
    const closePicker = (event: PointerEvent) => {
      if (!toolPickerRef.current?.contains(event.target as Node)) setToolPickerOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setToolPickerOpen(false);
    };
    document.addEventListener('pointerdown', closePicker);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closePicker);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [toolPickerOpen]);

  useEffect(() => {
    setTextChangeCount(undefined);
  }, [projectPath]);

  const latestCodeChange = codeChanges[0];
  const codeChangeRefreshKey = latestCodeChange
    ? [latestCodeChange.agentId, latestCodeChange.operation, latestCodeChange.path, latestCodeChange.occurredAt, latestCodeChange.diff].join('\u0000')
    : '';
  const toolMutationRefreshKey = latestToolMutationKey(messages) ?? '';
  const mutationRefreshKey = codeChangeRefreshKey || toolMutationRefreshKey
    ? `${codeChangeRefreshKey}\u0001${toolMutationRefreshKey}`
    : '';
  useEffect(() => {
    if (!sessionId || !mutationRefreshKey) return;
    void refreshGitStatus({ force: true });
  }, [mutationRefreshKey, refreshGitStatus, sessionId]);

  const previewMutationKey = useMemo(
    () => latestFileMutationKey(path, projectPath, codeChanges, messages),
    [codeChanges, messages, path, projectPath],
  );
  useEffect(() => {
    const normalizedPath = normalizeComparablePath(path, projectPath);
    const previous = previewRefreshRef.current;
    if (previous.path !== normalizedPath) {
      previewRefreshRef.current = { path: normalizedPath, mutationKey: previewMutationKey };
      return;
    }
    if (tab !== 'preview' || !normalizedPath || !previewMutationKey || previous.mutationKey === previewMutationKey) return;
    previewRefreshRef.current = { path: normalizedPath, mutationKey: previewMutationKey };
    void refreshFile?.();
  }, [path, previewMutationKey, projectPath, refreshFile, tab]);

  const previewFile = (targetPath: string) => {
    onSelectFilePath?.(targetPath);
    setRevealLine(undefined);
    const existing = [...openTabs].reverse().find(item => item.tool === 'preview');
    if (existing) setActiveTabId(existing.id);
    else openTab('preview');
  };
  const openTab = (item: InspectorTab) => {
    const created = { id: `${item}-${nextTabIdRef.current++}`, tool: item };
    setOpenTabs(previous => [...previous, created]);
    setActiveTabId(created.id);
    setToolPickerOpen(false);
    if (item === 'git') void refreshGitStatus();
  };
  const activateTab = (item: InspectorTab) => {
    const existing = [...openTabs].reverse().find(candidate => candidate.tool === item);
    if (!existing) {
      openTab(item);
      return;
    }
    setActiveTabId(existing.id);
    setToolPickerOpen(false);
    if (item === 'git') void refreshGitStatus();
  };
  const closeTab = (tabId: string) => {
    const itemIndex = openTabs.findIndex(item => item.id === tabId);
    const nextTabs = openTabs.filter(item => item.id !== tabId);
    setOpenTabs(nextTabs);
    if (activeTabId === tabId) setActiveTabId(nextTabs[Math.min(itemIndex, nextTabs.length - 1)]?.id ?? null);
  };
  const changeCount = textChangeCount ?? (codeChanges.length > 0 ? codeChanges.length : undefined);

  const renderTool = (tabItem: OpenInspectorTab) => {
    const item = tabItem.tool;
    if (item === 'preview') return <FilePreview path={path} file={file} loading={loading} revealLine={revealLine} onRefresh={refreshFile} />;
    if (item === 'changes') return <ChangesPanel sessionId={sessionId} projectPath={projectPath} status={gitStatus} messages={messages} codeChanges={codeChanges} onRefreshGitStatus={refreshGitStatus} onRefreshMessages={refreshMessages} onPreviewFile={onSelectFilePath ? previewFile : undefined} onCountChange={setTextChangeCount} />;
    if (item === 'git') return <GitPanel sessionId={sessionId} projectPath={projectPath} status={gitStatus} error={gitError} loading={gitLoading} onRefresh={refreshGitStatus} />;
    if (item === 'lsp') return <LspPanel sessionId={sessionId} path={path} onDiagnosticCountChange={setDiagnosticCount} onReveal={(targetPath, line) => { if (targetPath !== path) onSelectFilePath?.(targetPath); setRevealLine(line + 1); const existing = [...openTabs].reverse().find(candidate => candidate.tool === 'preview'); if (existing) setActiveTabId(existing.id); else openTab('preview'); }} />;
    // BrowserPanel owns a native WebContentsView. CSS-hidden inspector pages remain
    // mounted, so the inactive browser page must be unmounted to detach that view.
    if (item === 'browser' && activeTabId !== tabItem.id) return null;
    if (item === 'browser') return <Suspense fallback={<div className="inspector-empty"><span className="spinner"/></div>}><BrowserPanel /></Suspense>;
    const terminalTabs = openTabs.filter(candidate => candidate.tool === 'terminal');
    const reuseExistingTerminal = terminalTabs[0]?.id === tabItem.id;
    return <Suspense fallback={<div className="inspector-empty"><span className="spinner"/></div>}><TerminalPanel sessionId={sessionId} reuseExisting={reuseExistingTerminal} /></Suspense>;
  };

  const collapseInspector = () => {
    setToolPickerOpen(false);
    setActiveTabId(null);
  };
  const toggleInspectorPinned = () => {
    setOverviewPinned(previous => {
      const next = !previous;
      try { localStorage.setItem(INSPECTOR_PINNED_KEY, String(next)); } catch { /* Keep the preference in memory. */ }
      return next;
    });
  };

  return <section
    className={`workspace-inspector${tab ? ' inspector-view-open' : ' inspector-overview-open'}${!overviewPinned && !tab ? ' inspector-overview-auto-hide' : ''}${standalone ? ' standalone' : ''}`}
    onPointerLeave={event => {
      if (overviewPinned || tab !== null) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && event.currentTarget.contains(focused)) focused.blur();
    }}
  >
    {!standalone && <aside className={`inspector-navigation${tab ? ' compact' : ''}`} aria-label={tr('Inspector', '检查器')}>
      {tab === null && <header className="inspector-overview-heading"><div><span>{tr('Workspace', '工作区')}</span><strong>{tr('Tools', '工具')}</strong></div><button type="button" className={`inspector-pin-button${overviewPinned ? ' active' : ''}`} onClick={event => { toggleInspectorPinned(); if (event.detail > 0) event.currentTarget.blur(); }} title={overviewPinned ? tr('Auto-hide tool island', '自动隐藏工具岛') : tr('Keep tool island visible', '常驻工具岛')} aria-label={overviewPinned ? tr('Auto-hide tool island', '自动隐藏工具岛') : tr('Keep tool island visible', '常驻工具岛')}><Icon name="pin" size={15}/></button></header>}
      {tab === null && <WorkspaceActivitySummary mainWorking={mainWorking || isStreaming} agentCount={activeAgentCount} agentTokens={activeAgentTokens} goal={goal} todos={todos} onGoalControl={onGoalControl}/>}
      <div className="inspector-tab-list" role="tablist" aria-label={tr('Inspector tools', '检查器工具')}>
        {tabOrder.map(item => <InspectorTabButton key={item} tab={item} active={tab === item} compact={tab !== null} count={item === 'changes' ? changeCount : item === 'lsp' ? diagnosticCount : undefined} detail={inspectorTabDetail(item, { path, projectPath, sessionId, gitStatus, diagnosticCount, tr })} onClick={() => activateTab(item)} onMove={target => setTabOrder(previous => moveInspectorTab(previous, item, target))} />)}
      </div>
      {tab !== null && <button type="button" className="inspector-collapse-button" onClick={collapseInspector} title={tr('Collapse tool sidebar', '收起工具侧栏')} aria-label={tr('Collapse tool sidebar', '收起工具侧栏')}><Icon name="panel-left" size={17}/></button>}
    </aside>}
    <div className={`inspector-stage${tab ? ' open' : ''}`} aria-hidden={tab === null}>
      {!standalone && <header className="inspector-panel-tabs">
        <div className="inspector-open-tabs" role="tablist" aria-label={tr('Open inspector tools', '已打开的检查器工具')}>
          {openTabs.map((item, index) => {
            const meta = inspectorTabMeta(item.tool, tr);
            const duplicateCount = openTabs.filter(candidate => candidate.tool === item.tool).length;
            const ordinal = openTabs.slice(0, index + 1).filter(candidate => candidate.tool === item.tool).length;
            const label = duplicateCount > 1 ? `${meta.label} ${ordinal}` : meta.label;
            return <div key={item.id} className={`inspector-open-tab${activeTabId === item.id ? ' active' : ''}`} draggable onDragStart={event => event.dataTransfer.setData('text/nori-open-inspector-tab', item.id)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const source = event.dataTransfer.getData('text/nori-open-inspector-tab'); if (openTabs.some(candidate => candidate.id === source)) setOpenTabs(previous => moveOpenInspectorTab(previous, item.id, source)); }}>
              <button type="button" role="tab" aria-selected={activeTabId === item.id} onClick={() => { setActiveTabId(item.id); if (item.tool === 'git') void refreshGitStatus(); }} title={label}><Icon name={meta.icon} size={13}/><span>{label}</span></button>
              <button type="button" className="inspector-close-tab" onClick={() => closeTab(item.id)} title={tr(`Close ${label} tab`, `关闭${label}标签页`)} aria-label={tr(`Close ${label} tab`, `关闭${label}标签页`)}><Icon name="close" size={11}/></button>
            </div>;
          })}
        </div>
        <div className="inspector-panel-actions">
          <div className={`inspector-tool-picker${toolPickerOpen ? ' open' : ''}`} ref={toolPickerRef}>
            <button type="button" className="inspector-add-tab" onClick={() => setToolPickerOpen(previous => !previous)} title={tr('Open tool', '打开工具')} aria-label={tr('Open tool', '打开工具')} aria-expanded={toolPickerOpen}><Icon name="plus" size={14}/></button>
            {toolPickerOpen && <div className="inspector-tool-menu" role="menu">{tabOrder.map(item => { const meta = inspectorTabMeta(item, tr); return <button type="button" role="menuitem" key={item} onClick={() => openTab(item)}><Icon name={meta.icon} size={14}/><span>{meta.label}</span></button>; })}</div>}
          </div>
          {tab && <button type="button" className="inspector-popout" onClick={() => openInspectorWindow(tab, sessionId, path)} title={tr('Open in separate window', '在独立窗口中打开')} aria-label={tr('Open in separate window', '在独立窗口中打开')}><Icon name="external" size={14}/></button>}
        </div>
      </header>}
      <div className="inspector-content">
        {openTabs.map(item => <div className={`inspector-tool-page${activeTabId === item.id ? ' active' : ''}`} key={item.id} aria-hidden={activeTabId !== item.id}>{renderTool(item)}</div>)}
      </div>
    </div>
  </section>;
}

function WorkspaceActivitySummary({ mainWorking, agentCount, agentTokens, goal, todos, onGoalControl }: { mainWorking: boolean; agentCount: number; agentTokens: number; goal: GoalSnapshot | null; todos: TodoItem[]; onGoalControl?: (action: 'pause' | 'resume' | 'cancel') => void | Promise<void> }) {
  const { tr } = useI18n();
  const [phraseIndex, setPhraseIndex] = useState(0);
  const mainPhrases = [
    tr('Nori is tracing the threads…', 'Nori 正在理清线索…'),
    tr('Nori is sharpening the answer…', 'Nori 正在打磨答案…'),
    tr('Nori is fitting the pieces together…', 'Nori 正在拼好思路…'),
    tr('Nori is checking the gears…', 'Nori 正在检查齿轮…'),
  ];
  const agentPhrases = [
    tr('Agents are exploring in parallel…', '智能体正在并行探索…'),
    tr('Agents are comparing notes…', '智能体正在交换发现…'),
    tr('Agents are mapping the code…', '智能体正在绘制代码脉络…'),
    tr('Agents are gathering results…', '智能体正在汇总成果…'),
  ];
  useEffect(() => {
    if (!mainWorking && agentCount === 0) return;
    setPhraseIndex(0);
    const timer = setInterval(() => setPhraseIndex(current => current + 1), 3_200);
    return () => clearInterval(timer);
  }, [agentCount, mainWorking]);

  if (agentCount === 0 && goal === null && todos.length === 0 && !mainWorking) return null;
  const currentMainPhrase = mainPhrases[phraseIndex % mainPhrases.length];
  const currentAgentPhrase = agentPhrases[phraseIndex % agentPhrases.length];
  const completedTodos = todos.filter(todo => todo.status === 'done').length;
  const goalStatusLabel = goal === null
    ? ''
    : goal.status === 'active'
      ? tr('Active', '进行中')
      : goal.status === 'paused'
        ? tr('Paused', '已暂停')
        : goal.status === 'blocked'
          ? tr('Blocked', '受阻')
          : tr('Complete', '已完成');
  const budgetItems = goal === null ? [] : [
    goal.budget.turnBudget === null ? tr(`${goal.turnsUsed} turns`, `${goal.turnsUsed} 轮`) : tr(`${goal.turnsUsed}/${goal.budget.turnBudget} turns`, `${goal.turnsUsed}/${goal.budget.turnBudget} 轮`),
    goal.budget.tokenBudget === null ? `${formatTokens(goal.tokensUsed)} tokens` : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.budget.tokenBudget)} tokens`,
    formatGoalTime(goal.wallClockMs, tr),
  ];
  const headline = mainWorking
    ? currentMainPhrase
    : agentCount > 0
      ? currentAgentPhrase
      : goal?.objective ?? (todos.length > 0 ? tr('Todo list', '待办列表') : '');
  const icon = mainWorking ? 'sparkles' : agentCount > 0 ? 'swarm' : goal ? 'target' : 'list';
  const statusSummary = [
    mainWorking ? tr('Nori active', 'Nori 工作中') : '',
    agentCount > 0 ? tr(`${agentCount} agents`, `${agentCount} 个智能体`) : '',
    goal ? tr('Goal tracked', '目标跟踪中') : '',
    todos.length > 0 ? tr(`${completedTodos}/${todos.length} todos`, `${completedTodos}/${todos.length} 待办`) : '',
  ].filter(Boolean).join(' · ');

  return <section className={`inspector-activity-summary${goal ? ` goal-${goal.status}` : ''}`} aria-live={mainWorking || agentCount > 0 ? 'polite' : undefined}>
    <div className="inspector-activity-highlight">
      <span className="inspector-activity-icon"><Icon name={icon} size={14}/></span>
      <span><small>{statusSummary}</small><strong>{headline}</strong></span>
      {agentTokens > 0 && <em>{formatTokens(agentTokens)} tokens</em>}
    </div>
    {agentCount > 0 && <p className="inspector-activity-line active"><span>{tr('Subagents', '子智能体')}</span><strong>{currentAgentPhrase}{agentTokens > 0 ? ` · ${formatTokens(agentTokens)} tokens` : ''}</strong></p>}
    {goal && <div className="inspector-activity-section">
      <p className="inspector-activity-line"><span>{tr('Goal', '目标')}</span><strong>{goal.objective}</strong></p>
      <p className="inspector-activity-line"><span>{tr('Status', '状态')}</span><strong>{goalStatusLabel}</strong></p>
      <p className="inspector-activity-line"><span>{tr('Budget', '预算')}</span><strong>{budgetItems.join(' · ')}</strong></p>
      {goal.completionCriterion && <p className="inspector-activity-line"><span>{tr('Done when', '完成标准')}</span><strong>{goal.completionCriterion}</strong></p>}
      {goal.terminalReason && <p className="inspector-activity-line"><span>{tr('Status note', '状态说明')}</span><strong>{goal.terminalReason}</strong></p>}
      {onGoalControl && goal.status !== 'complete' && <div className="inspector-activity-actions">{goal.status === 'active' ? <button type="button" onClick={() => void onGoalControl('pause')}>{tr('Pause', '暂停')}</button> : <button type="button" onClick={() => void onGoalControl('resume')}>{tr('Resume', '继续')}</button>}<button type="button" className="danger" onClick={() => { if (window.confirm(tr('Cancel this goal?', '取消这个目标吗？'))) void onGoalControl('cancel'); }}>{tr('Cancel goal', '取消目标')}</button></div>}
    </div>}
    {todos.length > 0 && <div className="inspector-activity-section inspector-activity-todos">
      <div className="inspector-activity-todos-heading"><span className="inspector-activity-label">{tr('Todo list', '待办')}</span><strong>{completedTodos}/{todos.length}</strong></div>
      <ol>{todos.map((todo, index) => <li key={`${todo.title}-${index}`} className={`todo-${todo.status}`}><Icon name={todo.status === 'done' ? 'check' : todo.status === 'in_progress' ? 'sparkles' : 'target'} size={12}/><strong>{todo.title}</strong></li>)}</ol>
    </div>}
  </section>;
}

function formatGoalTime(milliseconds: number, tr: (en: string, zh: string) => string): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return tr('<1 min', '<1 分钟');
  if (minutes < 60) return tr(`${minutes} min`, `${minutes} 分钟`);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return tr(`${hours}h ${remainder}m`, `${hours} 小时 ${remainder} 分钟`);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function InspectorTabButton({ tab, active, compact, count, detail, onClick, onMove }: { tab: InspectorTab; active: boolean; compact: boolean; count?: number; detail?: string; onClick: () => void; onMove: (target: InspectorTab) => void }) {
  const { tr } = useI18n();
  const meta = inspectorTabMeta(tab, tr);
  return <button type="button" role="tab" draggable aria-selected={active} className={active ? 'active' : ''} title={compact ? meta.label : undefined} onClick={onClick} onDragStart={event => event.dataTransfer.setData('text/nori-inspector-tab', tab)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const source = event.dataTransfer.getData('text/nori-inspector-tab') as InspectorTab; if (DEFAULT_INSPECTOR_TABS.includes(source)) onMove(source); }}><span className="inspector-nav-icon"><Icon name={meta.icon} size={compact ? 16 : 18}/></span>{!compact && <span className="inspector-nav-copy"><strong>{meta.label}</strong>{detail && <small>{detail}</small>}</span>}{count !== undefined && count > 0 ? <em>{count}</em> : null}{!compact && <Icon name="chevron-right" size={15}/>}</button>;
}

function moveOpenInspectorTab(order: OpenInspectorTab[], target: string, source: string): OpenInspectorTab[] {
  if (target === source) return order;
  const sourceTab = order.find(item => item.id === source);
  if (!sourceTab) return order;
  const next = order.filter(item => item.id !== source);
  const targetIndex = next.findIndex(item => item.id === target);
  next.splice(targetIndex < 0 ? next.length : targetIndex, 0, sourceTab);
  return next;
}

function inspectorTabDetail(tab: InspectorTab, context: { path: string; projectPath?: string; sessionId: string | null; gitStatus: FsGitStatusResponse | null; diagnosticCount?: number; tr: (en: string, zh: string) => string }): string {
  const { path, projectPath, sessionId, gitStatus, diagnosticCount, tr } = context;
  if (tab === 'preview') return path ? splitDisplayPath(projectRelativePath(path, projectPath)).fileName : tr('No file selected', '未选择文件');
  if (tab === 'git') return gitStatus?.branch || tr('Repository', '仓库');
  if (tab === 'lsp') return diagnosticCount === undefined ? 'LSP' : tr(`${diagnosticCount} diagnostics`, `${diagnosticCount} 条诊断`);
  if (tab === 'terminal') return sessionId ? tr('Current session', '当前会话') : tr('No session', '无会话');
  if (tab === 'browser') return tr('Browser', '浏览器');
  return projectPath ? splitDisplayPath(projectPath.replaceAll('\\', '/')).fileName : tr('Workspace', '工作区');
}

function inspectorTabMeta(tab: InspectorTab, tr: (en: string, zh: string) => string) {
  const values = {
    changes: { icon: 'diff' as const, label: tr('Changes', '更改') },
    preview: { icon: 'files' as const, label: tr('Preview', '预览') },
    browser: { icon: 'globe' as const, label: tr('Browser', '浏览器') },
    git: { icon: 'git-branch' as const, label: 'Git' },
    lsp: { icon: 'target' as const, label: 'LSP' },
    terminal: { icon: 'terminal' as const, label: tr('Terminal', '终端') },
  };
  return values[tab];
}

function loadInspectorTabOrder(): InspectorTab[] {
  try {
    const value = JSON.parse(localStorage.getItem('nori-inspector-tab-order') ?? '[]') as unknown;
    if (!Array.isArray(value)) return DEFAULT_INSPECTOR_TABS;
    const valid = value.filter((item): item is InspectorTab => typeof item === 'string' && DEFAULT_INSPECTOR_TABS.includes(item as InspectorTab));
    return [...new Set([...valid, ...DEFAULT_INSPECTOR_TABS])];
  } catch { return DEFAULT_INSPECTOR_TABS; }
}

function loadInspectorPinned(): boolean {
  try { return localStorage.getItem(INSPECTOR_PINNED_KEY) !== 'false'; } catch { return true; }
}

function moveInspectorTab(order: InspectorTab[], target: InspectorTab, source: InspectorTab): InspectorTab[] {
  const next = order.filter(item => item !== source);
  next.splice(Math.max(0, next.indexOf(target)), 0, source);
  localStorage.setItem('nori-inspector-tab-order', JSON.stringify(next));
  return next;
}

function openInspectorWindow(tab: InspectorTab, sessionId: string | null, path: string): void {
  const input = { tab, sessionId: sessionId ?? undefined, path: path || undefined };
  if (window.noriDesktop?.openInspectorWindow) { void window.noriDesktop.openInspectorWindow(input); return; }
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  params.set('inspector', tab);
  if (sessionId) params.set('session', sessionId);
  if (path) params.set('path', path);
  window.open(`${window.location.pathname}${window.location.search}#${params}`, `nori-inspector-${tab}`, 'popup,width=720,height=760');
}

function latestToolMutationKey(messages: ChatMessage[]): string | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (!message) continue;
    const tools = message.toolCalls ?? [];
    for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex--) {
      const tool = tools[toolIndex];
      if (!tool || (tool.name !== 'Edit' && tool.name !== 'Write')) continue;
      const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {};
      const path = typeof args['path'] === 'string' ? args['path'] : '';
      return [message.id, tool.id ?? '', tool.name, path, tool.result ?? ''].join('\u0000');
    }
  }
  return undefined;
}

export function latestFileMutationKey(path: string, projectPath: string | undefined, codeChanges: CodeChange[], messages: ChatMessage[]): string {
  const normalizedPath = normalizeComparablePath(path, projectPath);
  if (!normalizedPath) return '';
  let latestChange: CodeChange | undefined;
  for (const change of codeChanges) {
    if (normalizeComparablePath(change.path, projectPath) !== normalizedPath) continue;
    if (!latestChange || codeChangeTimestamp(change) > codeChangeTimestamp(latestChange)) latestChange = change;
  }
  if (latestChange) {
    return [latestChange.operationId ?? '', latestChange.agentId, latestChange.operation, latestChange.path, latestChange.occurredAt, latestChange.diff].join('\u0000');
  }
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (!message) continue;
    const tools = message.toolCalls ?? [];
    for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex--) {
      const tool = tools[toolIndex];
      if (!tool || (tool.name !== 'Edit' && tool.name !== 'Write') || tool.result === undefined) continue;
      const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {};
      const toolPath = typeof args['path'] === 'string' ? args['path'] : '';
      if (normalizeComparablePath(toolPath, projectPath) !== normalizedPath) continue;
      return [message.id, tool.id ?? '', tool.name, toolPath, tool.result].join('\u0000');
    }
  }
  return '';
}

function normalizeComparablePath(path: string, projectPath?: string): string {
  return projectRelativePath(path, projectPath)
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .toLocaleLowerCase();
}

interface Attribution {
  path: string;
  agent: string;
  timestamp: number;
}

interface ProjectDiffCache {
  diffs: Record<string, FsDiffResponse>;
  failedPaths: Set<string>;
}

const PROJECT_DIFF_CACHE_LIMIT = 12;
const projectDiffCaches = new Map<string, ProjectDiffCache>();
const projectCodeChangeCaches = new Map<string, CodeChange[]>();

export function collectAttributions(messages: ChatMessage[]): Attribution[] {
  const attributions: Attribution[] = [];
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt ?? '') || 0;
    for (const tool of message.toolCalls ?? []) {
      if (tool.name !== 'Edit' && tool.name !== 'Write') continue;
      const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {};
      const path = typeof args['path'] === 'string' ? args['path'].replaceAll('\\', '/') : '';
      if (path) attributions.push({ path, agent: 'Nori', timestamp });
    }
  }
  return attributions.sort((left, right) => right.timestamp - left.timestamp);
}

function ChangesPanel({ sessionId, projectPath, status, messages, codeChanges, onRefreshGitStatus, onRefreshMessages, onPreviewFile, onCountChange }: { sessionId: string | null; projectPath?: string; status: FsGitStatusResponse | null; messages: ChatMessage[]; codeChanges: CodeChange[]; onRefreshGitStatus: (options?: GitStatusRefreshOptions) => Promise<FsGitStatusResponse | null>; onRefreshMessages?: () => Promise<void>; onPreviewFile?: (path: string) => void; onCountChange: (count: number | undefined) => void }) {
  const { tr } = useI18n();
  const [diffs, setDiffs] = useState<Record<string, FsDiffResponse>>({});
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set());
  const [reloadVersion, setReloadVersion] = useState(0);
  const [recalculating, setRecalculating] = useState(false);
  const [projectChanges, setProjectChanges] = useState<CodeChange[]>([]);
  const projectKey = normalizeProjectKey(projectPath, sessionId);
  const cacheProjectRef = useRef<string | null>(null);
  const diffCacheRef = useRef<Record<string, FsDiffResponse>>({});
  const pendingPathsRef = useRef<Set<string>>(new Set());
  const failedPathsRef = useRef<Set<string>>(new Set());
  const activePathsRef = useRef<Set<string>>(new Set());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const incomingChanges = useMemo(() => mergeCodeChanges(
    codeChanges.map(change => ({ ...change, path: projectRelativePath(change.path, projectPath) })),
    collectToolCodeChanges(messages, projectPath),
  ), [codeChanges, messages, projectPath]);
  const incomingChangesKey = useMemo(() => incomingChanges
    .map(change => [change.operationId, change.agentId, change.operation, change.path, change.diff, change.occurredAt].join('\u0000'))
    .join('\u0001'), [incomingChanges]);

  useEffect(() => {
    if (projectKey === null) {
      setProjectChanges(incomingChanges);
      return;
    }
    const merged = mergeCodeChanges(projectCodeChangeCaches.get(projectKey) ?? [], incomingChanges);
    rememberProjectCodeChanges(projectKey, merged);
    setProjectChanges(merged);
  }, [incomingChanges, incomingChangesKey, projectKey]);

  const paths = useMemo(() => [...new Set([
    ...projectChanges.map(change => change.path),
    ...Object.keys(status?.entries ?? {}),
  ])], [projectChanges, status?.entries]);
  const pathsKey = useMemo(() => paths.join('\u0000'), [paths]);
  const orderedPaths = useMemo(() => [...paths].sort((left, right) => {
    const leftTime = changesForPath(left, projectChanges)[0] === undefined ? 0 : codeChangeTimestamp(changesForPath(left, projectChanges)[0]!);
    const rightTime = changesForPath(right, projectChanges)[0] === undefined ? 0 : codeChangeTimestamp(changesForPath(right, projectChanges)[0]!);
    return rightTime - leftTime || left.localeCompare(right);
  }), [paths, projectChanges]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const projectChanged = cacheProjectRef.current !== projectKey;
    if (projectChanged) {
      cacheProjectRef.current = projectKey;
      generationRef.current++;
      const cached = projectKey === null ? undefined : projectDiffCaches.get(projectKey);
      diffCacheRef.current = { ...cached?.diffs };
      pendingPathsRef.current = new Set();
      failedPathsRef.current = new Set(cached?.failedPaths ?? []);
      setDiffs({ ...diffCacheRef.current });
      setPendingPaths(new Set());
      setFailedPaths(new Set(failedPathsRef.current));
      onCountChange(undefined);
    }

    const activePaths = new Set(paths);
    activePathsRef.current = activePaths;
    diffCacheRef.current = Object.fromEntries(
      Object.entries(diffCacheRef.current).filter(([path]) => activePaths.has(path)),
    );
    pendingPathsRef.current = new Set([...pendingPathsRef.current].filter(path => activePaths.has(path)));
    failedPathsRef.current = new Set([...failedPathsRef.current].filter(path => activePaths.has(path)));
    rememberProjectDiffCache(projectKey, diffCacheRef.current, failedPathsRef.current);

    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId || paths.length === 0) {
      setDiffs(diffCacheRef.current);
      setPendingPaths(new Set(pendingPathsRef.current));
      setFailedPaths(new Set(failedPathsRef.current));
      onCountChange(0);
      return;
    }

    const gitDiffPaths = paths.filter(path => resolvedDiff(path, projectChanges, {}) === undefined);
    const missingPaths = diffPathsToLoad(gitDiffPaths, diffCacheRef.current, pendingPathsRef.current, failedPathsRef.current);
    setDiffs({ ...diffCacheRef.current });
    setFailedPaths(new Set(failedPathsRef.current));
    if (missingPaths.length === 0) {
      setPendingPaths(new Set(pendingPathsRef.current));
      return;
    }

    for (const path of missingPaths) pendingPathsRef.current.add(path);
    setPendingPaths(new Set(pendingPathsRef.current));
    const generation = generationRef.current;
    const results = Array.from<{ path: string; result: FsDiffResponse | null }>({ length: missingPaths.length });
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < missingPaths.length) {
        const index = nextIndex++;
        const path = missingPaths[index]!;
        try {
          results[index] = { path, result: await api.sessions.fs.diff(activeSessionId, path) };
        } catch {
          results[index] = { path, result: null };
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, missingPaths.length) }, worker)).then(() => {
      if (!mountedRef.current || cacheProjectRef.current !== projectKey || generationRef.current !== generation) return;
      for (const item of results) {
        pendingPathsRef.current.delete(item.path);
        if (!activePathsRef.current.has(item.path)) continue;
        if (item.result) {
          diffCacheRef.current[item.path] = item.result;
          failedPathsRef.current.delete(item.path);
        } else {
          failedPathsRef.current.add(item.path);
        }
      }
      setDiffs({ ...diffCacheRef.current });
      setFailedPaths(new Set(failedPathsRef.current));
      setPendingPaths(new Set(pendingPathsRef.current));
      rememberProjectDiffCache(projectKey, diffCacheRef.current, failedPathsRef.current);
    });
  }, [onCountChange, pathsKey, projectChanges, projectKey, reloadVersion]);

  const visiblePaths = useMemo(() => orderedPaths.filter(path => {
    const diff = resolvedDiff(path, projectChanges, diffs);
    if (diff === undefined) return false;
    return hasTextChanges(diff);
  }), [diffs, orderedPaths, projectChanges]);
  const visibleStats = useMemo(() => visiblePaths.reduce((total, path) => {
    const operations = changesForPath(path, projectChanges);
    const stats = changedLineStats(operations.length > 0
      ? operations.map(change => change.diff).join('\n')
      : resolvedDiff(path, projectChanges, diffs) ?? '');
    return { additions: total.additions + stats.additions, deletions: total.deletions + stats.deletions };
  }, { additions: 0, deletions: 0 }), [diffs, projectChanges, visiblePaths]);

  useEffect(() => {
    if (pendingPaths.size === 0) onCountChange(visiblePaths.length);
  }, [onCountChange, pendingPaths.size, visiblePaths.length]);

  const recalculate = async () => {
    if (!sessionId || recalculating) return;
    setRecalculating(true);
    try {
      await Promise.all([
        onRefreshGitStatus({ force: true }),
        onRefreshMessages?.(),
      ]);
      generationRef.current++;
      diffCacheRef.current = {};
      pendingPathsRef.current = new Set();
      failedPathsRef.current = new Set();
      if (projectKey !== null) projectDiffCaches.delete(projectKey);
      setDiffs({});
      setPendingPaths(new Set());
      setFailedPaths(new Set());
      onCountChange(undefined);
      setReloadVersion(version => version + 1);
    } finally {
      setRecalculating(false);
    }
  };

  return <div className="changes-panel">
    <header className="inspector-section-header"><div><strong>{tr('Project changes', '项目更改')}</strong><span>{recalculating ? tr('Refreshing Git status and diffs…', '正在刷新 Git 状态和差异…') : tr('Cached by project · newest first', '按项目缓存 · 最新更改优先')}</span></div><span className="diff-stats"><b>+{visibleStats.additions}</b><i>-{visibleStats.deletions}</i><button type="button" className="change-recalculate" onClick={() => void recalculate()} disabled={!sessionId || recalculating} title={tr('Recalculate project changes', '重新计算项目更改')} aria-label={tr('Recalculate project changes', '重新计算项目更改')}>{recalculating ? <span className="spinner"/> : <Icon name="refresh" size={12}/>}</button></span></header>
    {!sessionId ? <InspectorEmpty text={tr('Open a conversation to track changes.', '打开会话后可跟踪更改。')} />
      : orderedPaths.length === 0 ? <InspectorEmpty text={tr('No uncommitted changes.', '没有未提交的更改。')} />
      : pendingPaths.size === orderedPaths.length ? <div className="inspector-empty"><span className="spinner"/><span>{tr('Reading text changes…', '正在读取文本更改…')}</span></div>
      : visiblePaths.length === 0 && pendingPaths.size === 0 && failedPaths.size === 0 ? <InspectorEmpty text={tr('No text changes to display.', '没有可显示的文本行更改。')} />
      : <>{pendingPaths.size > 0 && <div className="change-load-status"><span className="spinner"/>{tr(`Reading ${pendingPaths.size} changes…`, `正在读取 ${pendingPaths.size} 项更改…`)}</div>}
    {failedPaths.size > 0 && <div className="change-load-status error">{tr(`${failedPaths.size} diffs could not be loaded.`, `${failedPaths.size} 项 diff 读取失败。`)}</div>}
    <div className="change-list">{visiblePaths.map((path, index) => {
      const rawDiff = resolvedDiff(path, projectChanges, diffs) ?? '';
      return <FileChangeCard
        key={path}
        path={path}
        status={status?.entries[path] ?? 'modified'}
        changes={changesForPath(path, projectChanges)}
        fallbackDiff={rawDiff}
        defaultOpen={index === 0}
        onPreview={onPreviewFile}
      />;
    })}</div></>}
  </div>;
}

export function collectToolCodeChanges(messages: ChatMessage[], projectPath?: string): CodeChange[] {
  const changes: CodeChange[] = [];
  for (const message of messages) {
    for (const tool of message.toolCalls ?? []) {
      if ((tool.name !== 'Edit' && tool.name !== 'Write') || tool.result === undefined) continue;
      const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {};
      const rawPath = typeof args['path'] === 'string' ? args['path'] : '';
      if (!rawPath) continue;
      const diff = tool.name === 'Edit'
        ? changedTextDiff(args['old_string'], args['new_string'])
        : addedTextDiff(args['content']);
      if (!diff) continue;
      changes.push({
        operationId: tool.id,
        agentId: 'main',
        operation: tool.name === 'Edit' ? 'edit' : 'write',
        path: projectRelativePath(rawPath, projectPath),
        diff,
        occurredAt: message.createdAt ?? new Date(0).toISOString(),
      });
    }
  }
  return changes.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
}

function changedTextDiff(before: unknown, after: unknown): string {
  if (typeof before !== 'string' || typeof after !== 'string') return '';
  return compactOperationLines([
    ...before.replaceAll('\r\n', '\n').split('\n').map(line => `-${line}`),
    ...after.replaceAll('\r\n', '\n').split('\n').map(line => `+${line}`),
  ]);
}

function addedTextDiff(content: unknown): string {
  if (typeof content !== 'string') return '';
  return compactOperationLines(content.replaceAll('\r\n', '\n').split('\n').map(line => `+${line}`));
}

function compactOperationLines(lines: string[]): string {
  return lines.length <= 40
    ? lines.join('\n')
    : [...lines.slice(0, 40), `... ${String(lines.length - 40)} more changed lines`].join('\n');
}

function projectRelativePath(path: string, projectPath?: string): string {
  const normalized = path.replaceAll('\\', '/');
  const root = projectPath?.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!root) return normalized;
  const prefix = `${root}/`;
  return normalized.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? normalized.slice(prefix.length)
    : normalized;
}

export function mergeCodeChanges(existing: CodeChange[], incoming: CodeChange[]): CodeChange[] {
  const ordered = [...incoming, ...existing]
    .sort((left, right) => codeChangeTimestamp(right) - codeChangeTimestamp(left));
  const merged: CodeChange[] = [];
  for (const change of ordered) {
    const duplicate = merged.some(candidate =>
      (candidate.operationId !== undefined && change.operationId !== undefined
        ? candidate.operationId === change.operationId
        : candidate.operation === change.operation
          && candidate.path === change.path
          && candidate.diff.trim() === change.diff.trim()
          && codeChangeTimestamp(candidate) === codeChangeTimestamp(change))
    );
    if (!duplicate) merged.push(change);
  }
  return merged.slice(0, 100);
}

function codeChangeTimestamp(change: CodeChange): number {
  const timestamp = Date.parse(change.occurredAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function rememberProjectCodeChanges(projectKey: string, changes: CodeChange[]): void {
  projectCodeChangeCaches.delete(projectKey);
  projectCodeChangeCaches.set(projectKey, changes);
  while (projectCodeChangeCaches.size > PROJECT_DIFF_CACHE_LIMIT) {
    const oldest = projectCodeChangeCaches.keys().next().value;
    if (oldest === undefined) break;
    projectCodeChangeCaches.delete(oldest);
  }
}

function normalizeProjectKey(projectPath: string | undefined, sessionId: string | null): string | null {
  const normalized = projectPath?.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase();
  return normalized || (sessionId ? `session:${sessionId}` : null);
}

function rememberProjectDiffCache(
  projectKey: string | null,
  diffs: Record<string, FsDiffResponse>,
  failedPaths: Set<string>,
): void {
  if (projectKey === null) return;
  projectDiffCaches.delete(projectKey);
  projectDiffCaches.set(projectKey, { diffs: { ...diffs }, failedPaths: new Set(failedPaths) });
  while (projectDiffCaches.size > PROJECT_DIFF_CACHE_LIMIT) {
    const oldest = projectDiffCaches.keys().next().value;
    if (oldest === undefined) break;
    projectDiffCaches.delete(oldest);
  }
}

export function diffPathsToLoad(
  paths: string[],
  diffs: Record<string, FsDiffResponse>,
  pending: Set<string>,
  failed: Set<string>,
): string[] {
  return paths.filter(path => diffs[path] === undefined && !pending.has(path) && !failed.has(path));
}

export function combinedCodeChangeDiff(path: string, codeChanges: CodeChange[]): string | undefined {
  const operationDiffs = codeChanges
    .filter(item => item.path === path || item.path.endsWith(`/${path}`))
    .map(item => item.diff.trimEnd())
    .filter(diff => compactChangedLines(diff).length > 0);
  return operationDiffs.length > 0 ? operationDiffs.join('\n') : undefined;
}

function resolvedDiff(path: string, codeChanges: CodeChange[], diffs: Record<string, FsDiffResponse>): string | undefined {
  const liveDiff = combinedCodeChangeDiff(path, codeChanges);
  if (liveDiff !== undefined) return liveDiff;
  return diffs[path]?.diff;
}

function FileChangeCard({ path, status, changes, fallbackDiff, defaultOpen, onPreview }: { path: string; status: string; changes: CodeChange[]; fallbackDiff: string; defaultOpen: boolean; onPreview?: (path: string) => void }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const orderedChanges = [...changes]
    .filter(change => hasTextChanges(change.diff))
    .sort((left, right) => codeChangeTimestamp(right) - codeChangeTimestamp(left));
  const displayChanges = orderedChanges.length > 0 ? orderedChanges : [{
    operationId: `git:${path}`,
    agentId: 'unknown',
    operation: 'edit' as const,
    path,
    diff: fallbackDiff,
    occurredAt: new Date(0).toISOString(),
  }];
  const stats = changedLineStats(displayChanges.map(change => change.diff).join('\n'));
  const displayPath = splitDisplayPath(path);
  return <article className={`change-file-card${open ? ' open' : ''}`}>
    <div className="change-entry-header">
      <button type="button" className="change-entry-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <Icon name="chevron-right" size={12}/>
        <span className={`git-status-mark status-${status}`}/>
        <span className="change-entry-title" title={path}><strong className="change-entry-path">{displayPath.directory && <><span className="change-entry-directory">{displayPath.directory}</span><span className="change-entry-separator">/</span></>}<span className="change-entry-file">{displayPath.fileName}</span></strong><small>{tr(`${displayChanges.length} operations`, `${displayChanges.length} 次更改`)}</small></span>
        <span className="change-entry-stats"><b>+{stats.additions}</b><i>-{stats.deletions}</i></span>
      </button>
      {onPreview && <button type="button" className="change-entry-preview" onClick={() => onPreview(path)} title={tr('Preview this file', '预览此文件')} aria-label={tr(`Preview ${displayPath.fileName}`, `预览 ${displayPath.fileName}`)}><Icon name="files" size={13}/></button>}
    </div>
    {open && <div className="change-operation-list">{displayChanges.map((change, index) => <OperationChangeCard key={change.operationId ?? `${change.occurredAt}:${index}`} change={change} defaultOpen={index === 0}/>)}</div>}
  </article>;
}

function OperationChangeCard({ change, defaultOpen }: { change: CodeChange; defaultOpen: boolean }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const lines = compactChangedLines(change.diff);
  const stats = changedLineStats(change.diff);
  const agent = change.agentId === 'main' ? 'Nori' : change.agentId === 'unknown' ? tr('Unknown', '未知') : change.agentId;
  const timestamp = codeChangeTimestamp(change);
  return <section className={`change-operation-card${open ? ' open' : ''}`}>
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      <Icon name="chevron-right" size={11}/>
      <strong>{agent}</strong>
      <span>{change.operation === 'write' ? tr('Write', '写入') : tr('Edit', '编辑')}</span>
      {timestamp > 0 && <time dateTime={change.occurredAt}>{new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>}
      <i>+{stats.additions}</i><em>-{stats.deletions}</em>
    </button>
    {open && <pre className="compact-diff">{lines.map((line, index) => <span key={`${index}-${line}`} className={line.startsWith('+') ? 'added' : 'removed'}>{line}</span>)}</pre>}
  </section>;
}

function changesForPath(path: string, changes: CodeChange[]): CodeChange[] {
  return changes
    .filter(change => change.path === path || change.path.endsWith(`/${path}`))
    .sort((left, right) => codeChangeTimestamp(right) - codeChangeTimestamp(left));
}

export function splitDisplayPath(path: string): { directory: string; fileName: string } {
  const normalized = path.replaceAll('\\', '/');
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return { directory: '', fileName: normalized };
  return {
    directory: normalized.slice(0, separator),
    fileName: normalized.slice(separator + 1),
  };
}

function GitPanel({ sessionId, projectPath, status, error, loading, onRefresh }: { sessionId: string | null; projectPath?: string; status: FsGitStatusResponse | null; error: string | null; loading: boolean; onRefresh: (options?: GitStatusRefreshOptions) => Promise<FsGitStatusResponse | null> }) {
  const { tr } = useI18n();
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState<FsDiffResponse | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const paths = Object.keys(status?.entries ?? {});

  useEffect(() => {
    if (!selectedPath || !sessionId) { setDiff(null); return; }
    let cancelled = false;
    void api.sessions.fs.diff(sessionId, selectedPath).then(result => { if (!cancelled) setDiff(result); }).catch(error => {
      if (!cancelled) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [selectedPath, sessionId, status]);

  const commit = async () => {
    if (!sessionId || !message.trim() || paths.length === 0) return;
    setBusy('commit'); setNotice(null);
    try {
      const result = await api.sessions.fs.commit(sessionId, message.trim());
      setMessage('');
      setSelectedPath('');
      setNotice({ kind: 'success', text: tr(`Committed ${result.commit}`, `已提交 ${result.commit}`) });
      await onRefresh();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  const push = async () => {
    if (!sessionId || busy) return;
    if (!window.confirm(tr('Push the current branch to its remote?', '将当前分支推送到远程吗？'))) return;
    setBusy('push'); setNotice(null);
    try {
      const result = await api.sessions.fs.push(sessionId);
      setNotice({ kind: 'success', text: tr(`Pushed ${result.branch} to ${result.remote}`, `已将 ${result.branch} 推送到 ${result.remote}`) });
      await onRefresh();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  if (!sessionId) return <InspectorEmpty text={tr('Open a conversation to use Git controls.', '打开会话后可使用 Git 控制。')} />;
  if (!status && loading) return <div className="inspector-empty"><span className="spinner"/><span>{tr('Loading Git status…', '正在加载 Git 状态…')}</span></div>;
  if (!status) return <div className="inspector-empty git-unavailable"><Icon name="git-branch" size={24}/><strong>{tr('Git status is unavailable', '无法读取 Git 状态')}</strong><span title={error ?? projectPath}>{error ?? tr('The selected project folder is not a Git repository.', '所选项目文件夹不是 Git 仓库。')}</span>{projectPath && <small>{projectPath}</small>}<button type="button" onClick={() => void onRefresh()}>{tr('Try again', '重试')}</button></div>;

  return <div className="git-panel">
    <header className="git-summary"><div><Icon name="git-branch" size={16}/><strong>{status.branch || tr('Detached HEAD', '游离 HEAD')}</strong><span>{status.ahead > 0 ? `↑${status.ahead}` : ''}{status.behind > 0 ? ` ↓${status.behind}` : ''}</span></div><button type="button" onClick={() => void onRefresh()} title={tr('Refresh Git status', '刷新 Git 状态')}><Icon name="refresh" size={14}/></button></header>
    <div className="git-file-list">{paths.length === 0 ? <p>{tr('Working tree clean', '工作树干净')}</p> : paths.map(path => <button type="button" key={path} className={selectedPath === path ? 'active' : ''} onClick={() => setSelectedPath(path)}><span className={`git-status-mark status-${status.entries[path]}`}/><span>{path}</span><small>{status.entries[path]}</small></button>)}</div>
    {diff && <div className="git-diff-view"><header><strong>{diff.path}</strong>{diff.truncated && <span>{tr('Truncated', '已截断')}</span>}</header><pre>{diff.diff.split('\n').map((line, index) => <span key={`${index}-${line}`} className={diffLineClass(line)}>{line || ' '}</span>)}</pre></div>}
    <div className="git-actions"><input value={message} onChange={event => setMessage(event.target.value)} placeholder={tr('Commit message', '提交说明')} disabled={busy !== null}/><button type="button" className="git-commit-button" disabled={!message.trim() || paths.length === 0 || busy !== null} onClick={() => void commit()}>{busy === 'commit' ? tr('Committing…', '正在提交…') : tr('Commit all', '提交全部')}</button><button type="button" className="git-push-button" disabled={busy !== null} onClick={() => void push()}><Icon name="upload" size={14}/>{busy === 'push' ? tr('Pushing…', '正在推送…') : tr('Push', '发布')}</button></div>
    {(notice || error) && <div className={`git-notice ${notice?.kind ?? 'error'}`}>{notice?.text ?? error}</div>}
  </div>;
}

function compactChangedLines(diff: string): string[] {
  return diff.split('\n').filter(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))).slice(0, 40);
}

export function changedLineStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export function hasTextChanges(diff: string): boolean {
  const stats = changedLineStats(diff);
  return stats.additions > 0 || stats.deletions > 0;
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'header';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (line.startsWith('@@')) return 'hunk';
  return '';
}

function InspectorEmpty({ text }: { text: string }) {
  return <div className="inspector-empty"><Icon name="diff" size={24}/><span>{text}</span></div>;
}
