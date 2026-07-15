import { useEffect, useState } from 'react';
import type { SwarmConnectionState } from '../hooks/useApi';
import { api, type BackgroundTask, type Session, type SwarmStatus } from '../api/client';
import { useI18n } from '../i18n';
import { MarkdownView } from './MarkdownView';
import { Icon } from './Icon';

export function SwarmPanel({
  swarm,
  sessionId,
  sessions,
}: {
  swarm: SwarmConnectionState;
  sessionId?: string | null;
  sessions: Session[];
}) {
  const { tr } = useI18n();
  const { swarmStatuses, connected, error } = swarm;
  const runs = Array.from(swarmStatuses.values())
    .sort((left, right) => {
      const timeDifference = Date.parse(right.started_at ?? '') - Date.parse(left.started_at ?? '');
      return Number.isNaN(timeDifference) || timeDifference === 0
        ? (right.round ?? 0) - (left.round ?? 0)
        : timeDifference;
    });
  const projectGroups = groupSwarmRunsByProject(runs, sessions);

  return (
    <div className="swarm-panel">
      <header className="swarm-panel-header">
        <div>
          <strong>{tr('Agent rounds', '智能体轮次')}</strong>
          <span>{tr('Live output grouped by project and conversation', '按项目与会话查看实时输出和 token 消耗')}</span>
        </div>
        <div className="live-indicator">
          <span className={`status-dot ${connected ? 'active' : 'error'}`} />
          {connected ? tr('Live', '已连接') : tr('Offline', '离线')}
        </div>
      </header>

      {runs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">◇</div>
          <div>
            {error
              ? tr('Unable to receive swarm updates', '无法接收智能体协作更新')
              : tr('No active swarm agents', '暂无活动智能体')}
          </div>
          <div style={{ color: 'var(--nori-text-muted)', fontSize: 12, marginTop: 4 }}>
            {error
              ? tr('Reconnect to the server to resume live updates.', '请重新连接服务器以恢复实时更新。')
              : tr('Agents appear here when a swarm is launched', '启动智能体协作后，智能体会显示在这里。')}
          </div>
        </div>
      ) : (
        <div className="swarm-project-list">
          {projectGroups.map(project => (
            <SwarmProject
              key={project.key}
              project={project}
              currentSessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface SwarmSessionGroup {
  key: string;
  sessionId?: string;
  title: string;
  runs: SwarmStatus[];
}

export interface SwarmProjectGroup {
  key: string;
  path?: string;
  sessions: SwarmSessionGroup[];
}

export function groupSwarmRunsByProject(
  runs: SwarmStatus[],
  sessions: Session[],
): SwarmProjectGroup[] {
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  const projects = new Map<string, SwarmProjectGroup>();
  const sessionGroups = new Map<string, SwarmSessionGroup>();

  for (const run of runs) {
    const session = run.session_id ? sessionById.get(run.session_id) : undefined;
    const cwd = session?.metadata?.cwd?.trim().replaceAll('\\', '/').replace(/\/+$/, '');
    const projectKey = cwd || '__unassigned__';
    let project = projects.get(projectKey);
    if (project === undefined) {
      project = { key: projectKey, path: cwd, sessions: [] };
      projects.set(projectKey, project);
    }

    const sessionKey = `${projectKey}:${run.session_id ?? '__unknown__'}`;
    let sessionGroup = sessionGroups.get(sessionKey);
    if (sessionGroup === undefined) {
      sessionGroup = {
        key: sessionKey,
        sessionId: run.session_id,
        title: session?.title || run.session_id?.slice(0, 8) || 'Unknown conversation',
        runs: [],
      };
      sessionGroups.set(sessionKey, sessionGroup);
      project.sessions.push(sessionGroup);
    }
    sessionGroup.runs.push(run);
  }

  return [...projects.values()];
}

function SwarmProject({
  project,
  currentSessionId,
}: {
  project: SwarmProjectGroup;
  currentSessionId?: string | null;
}) {
  const { tr } = useI18n();
  const name = project.path?.split('/').filter(Boolean).at(-1)
    ?? tr('Unassigned project', '未指定项目');
  const path = project.path ?? tr('Project information unavailable', '项目路径不可用');

  return <section className="swarm-project-group">
    <header className="swarm-project-heading" title={path}>
      <span><strong>{name}</strong><small>{path}</small></span>
      <small>{project.sessions.length} {tr('conversations', '个会话')}</small>
    </header>
    <div className="swarm-session-list">
      {project.sessions.map(group => (
        <SwarmSession
          key={group.key}
          group={group}
          current={group.sessionId === currentSessionId}
        />
      ))}
    </div>
  </section>;
}

function SwarmSession({ group, current }: { group: SwarmSessionGroup; current: boolean }) {
  const { tr } = useI18n();
  const rounds = groupSwarmRuns(group.runs);
  const treeRuns = collectSwarmTreeRuns([...rounds.values()].flat(), group.runs);
  const progress = treeRuns.map(swarmRunProgress);
  const running = progress.some(item => item.running);
  const paused = !running && progress.some(item => item.status === 'paused');
  const [open, setOpen] = useState(current || running);
  const swarmTaskIds = swarmTaskIdsForRuns(group.runs);

  useEffect(() => {
    if (current || running) setOpen(true);
  }, [current, running]);

  return <details
    className={`swarm-session-group${current ? ' current' : ''}`}
    open={open}
    onToggle={event => setOpen(event.currentTarget.open)}
  >
    <summary>
      <span className={`status-dot ${running ? 'running' : paused ? 'paused' : 'done'}`}/>
      <span><strong>{group.title}</strong><small>{group.sessionId ?? tr('Unknown conversation', '未知会话')}</small></span>
      <span className={`badge badge-${running ? 'info' : paused ? 'warning' : 'success'}`}>{running ? tr('Running', '运行中') : paused ? tr('Paused', '已暂停') : tr('Done', '已完成')}</span>
    </summary>
    <div className="swarm-session-body">
      <div className="swarm-round-list">
        {Array.from(rounds.entries()).map(([round, roundRuns]) => (
          <SwarmRound key={round} round={round} runs={roundRuns} allRuns={group.runs}/>
        ))}
      </div>
      {current && group.sessionId && (
        <BackgroundTasksPanel sessionId={group.sessionId} swarmTaskIds={swarmTaskIds}/>
      )}
    </div>
  </details>;
}

export function groupSwarmRuns(runs: SwarmStatus[]): Map<number, SwarmStatus[]> {
  const rounds = new Map<number, SwarmStatus[]>();
  const runIds = new Set(runs.map(run => run.swarm_id));
  for (const run of runs.filter(item => !item.parent_swarm_id || !runIds.has(item.parent_swarm_id))) {
    const round = run.round ?? 1;
    rounds.set(round, [...(rounds.get(round) ?? []), run]);
  }
  return rounds;
}

export function collectSwarmTreeRuns(roots: SwarmStatus[], allRuns: SwarmStatus[]): SwarmStatus[] {
  const children = new Map<string, SwarmStatus[]>();
  for (const run of allRuns) {
    if (!run.parent_swarm_id) continue;
    children.set(run.parent_swarm_id, [...(children.get(run.parent_swarm_id) ?? []), run]);
  }
  const result: SwarmStatus[] = [];
  const visited = new Set<string>();
  const visit = (run: SwarmStatus) => {
    if (visited.has(run.swarm_id)) return;
    visited.add(run.swarm_id);
    result.push(run);
    for (const child of children.get(run.swarm_id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return result;
}

export function swarmTaskIdsForRuns(runs: SwarmStatus[]): Set<string> {
  return new Set(runs.flatMap(run => [
    ...(run.task_id ? [run.task_id] : []),
    ...(run.tasks?.flatMap(task => [task.id, ...(task.agent_id ? [task.agent_id] : [])]) ?? []),
  ]));
}

export function runningSwarmAgents(runs: SwarmStatus[]): { ids: Set<string>; untracked: number } {
  const ids = new Set<string>();
  let untracked = 0;
  for (const run of runs) {
    if (!run.tasks) {
      if (swarmRunProgress(run).running) untracked++;
      continue;
    }
    for (const task of run.tasks) {
      if (task.status === 'running') ids.add(task.agent_id ?? task.id);
    }
  }
  return { ids, untracked };
}

export function swarmRunProgress(run: SwarmStatus): {
  total: number;
  completed: number;
  running: boolean;
  status: SwarmStatus['status'];
} {
  const tasks = run.tasks ?? [];
  const total = Math.max(run.task_count, tasks.length, 1);
  const completedFromTasks = tasks.filter(task => isTaskFinished(task.status)).length;
  const explicitlyFinished = run.status === 'done' || run.status === 'failed' || run.status === 'stopped';
  const tasksFinished = tasks.length >= total && completedFromTasks >= total;
  const completed = explicitlyFinished
    ? total
    : Math.min(total, Math.max(run.completed_count, completedFromTasks));
  const failed = run.status === 'failed'
    || tasks.some(task => task.status === 'failed' || task.status === 'cancelled');
  const status = explicitlyFinished || tasksFinished
    ? (run.status === 'stopped' ? 'stopped' : failed ? 'failed' : 'done')
    : run.status;
  return { total, completed, running: status === 'running' || status === 'pending', status };
}

function SwarmRound({ round, runs, allRuns }: { round: number; runs: SwarmStatus[]; allRuns: SwarmStatus[] }) {
  const { tr } = useI18n();
  const treeRuns = collectSwarmTreeRuns(runs, allRuns);
  const progressByRun = treeRuns.map(swarmRunProgress);
  const running = progressByRun.some(progress => progress.running);
  const paused = !running && progressByRun.some(progress => progress.status === 'paused');
  const [open, setOpen] = useState(running);
  const agentCount = progressByRun.reduce((total, progress) => total + progress.total, 0);
  const completedCount = progressByRun.reduce((total, progress) => total + progress.completed, 0);
  const tokens = treeRuns.reduce((total, run) => total + swarmRunTokens(run), 0);
  const hasLiveTokens = treeRuns.some(run => run.tasks?.some(task => (task.live_output_tokens ?? 0) > 0));

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  return <details className={`swarm-round${running ? ' running' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className={`status-dot ${running ? 'running' : paused ? 'paused' : 'done'}`}/>
      <span className="swarm-round-copy"><strong>{tr(`Round ${round}`, `第 ${round} 轮`)}</strong><small>{completedCount}/{agentCount} {tr('agents complete', '个智能体已完成')}</small></span>
      <span className="swarm-round-meta">{tokens > 0 && <small>{hasLiveTokens ? '~' : ''}{tokens.toLocaleString()} tokens</small>}<span className={`badge badge-${running ? 'info' : paused ? 'warning' : 'success'}`}>{running ? tr('Running', '运行中') : paused ? tr('Paused', '已暂停') : tr('Done', '已完成')}</span></span>
    </summary>
    <div className="swarm-round-body">{runs.map(run => <SwarmRun key={run.swarm_id} run={run} allRuns={allRuns}/>)}</div>
  </details>;
}

function SwarmRun({ run, allRuns }: { run: SwarmStatus; allRuns: SwarmStatus[] }) {
  const { tr } = useI18n();
  const runProgress = swarmRunProgress(run);
  const progress = Math.round((runProgress.completed / runProgress.total) * 100);
  const tasks = run.tasks ?? [];
  const childRuns = allRuns.filter(child => child.parent_swarm_id === run.swarm_id);
  const taskAgentIds = new Set(tasks.flatMap(task => task.agent_id ? [task.agent_id] : []));
  const unattachedChildren = childRuns.filter(child => !child.owner_agent_id || !taskAgentIds.has(child.owner_agent_id));
  const tokens = swarmRunTokens(run);
  const hasLiveTokens = tasks.some(task => (task.live_output_tokens ?? 0) > 0);
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<'stop' | 'pause' | 'guide' | 'resume' | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const controllable = runProgress.status === 'running'
    || runProgress.status === 'pending'
    || runProgress.status === 'paused';

  const control = async (action: 'stop' | 'pause' | 'guide' | 'resume') => {
    if (busy !== null) return;
    if (action === 'stop' && !window.confirm(tr('Stop this swarm?', '停止这个智能体协作任务吗？'))) return;
    setBusy(action);
    setControlError(null);
    try {
      await api.swarm.control(run.swarm_id, action, guidance);
      if (action === 'guide' || action === 'resume') setGuidance('');
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return <section className={`swarm-run swarm-run-${runProgress.status}`}>
    <header>
      <span className={`status-dot ${runProgress.status}`}/>
      <span><strong>{run.description || run.swarm_id}</strong><small>{run.owner_agent_id === 'main' ? tr('Started by Nori', '由 Nori 发起') : tr('Started by an agent', '由智能体发起')}</small></span>
      <span className="swarm-run-stats">
        <small>{runProgress.completed}/{runProgress.total}</small>
        {tokens > 0 && <small>{hasLiveTokens ? '~' : ''}{tokens.toLocaleString()} tokens</small>}
        {controllable && <span className="swarm-run-controls">
          {runProgress.status === 'paused'
            ? <button type="button" onClick={() => void control('resume')} disabled={busy !== null} title={tr('Resume swarm', '恢复协作')}><Icon name="play" size={12}/></button>
            : <button type="button" onClick={() => void control('pause')} disabled={busy !== null} title={tr('Pause swarm', '暂停协作')}><Icon name="pause" size={12}/></button>}
          <button type="button" className="danger" onClick={() => void control('stop')} disabled={busy !== null} title={tr('Stop swarm', '停止协作')}><Icon name="stop" size={11}/></button>
        </span>}
      </span>
    </header>
    <div className="swarm-run-progress"><i style={{ width: `${progress}%` }}/></div>
    {runProgress.status === 'paused' && <div className="swarm-guidance">
      <input value={guidance} onChange={event => setGuidance(event.target.value)} placeholder={tr('Add guidance before resuming', '在恢复前追加引导指令')} disabled={busy !== null}/>
      <button type="button" onClick={() => void control('guide')} disabled={!guidance.trim() || busy !== null}>{busy === 'guide' ? tr('Adding…', '添加中…') : tr('Add', '追加')}</button>
    </div>}
    {controlError && <div className="swarm-control-error">{controlError}</div>}
    <div className="swarm-task-items">
      {tasks.length > 0
        ? tasks.map(task => {
          const children = childRuns.filter(child => child.owner_agent_id === task.agent_id);
          return <div className="swarm-task-branch" key={task.id}><TaskPreview task={task}/>{children.length > 0 && <div className="swarm-child-runs">{children.map(child => <SwarmRun key={child.swarm_id} run={child} allRuns={allRuns}/>)}</div>}</div>;
        })
        : <PreviewNotice kind="loading" text={tr('Waiting for agents to start…', '正在等待智能体启动…')}/>}
      {unattachedChildren.length > 0 && <div className="swarm-child-runs swarm-child-runs-unattached">{unattachedChildren.map(child => <SwarmRun key={child.swarm_id} run={child} allRuns={allRuns}/>)}</div>}
    </div>
  </section>;
}

function BackgroundTasksPanel({ sessionId, swarmTaskIds }: { sessionId: string; swarmTaskIds: ReadonlySet<string> }) {
  const { tr } = useI18n();
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await api.sessions.tasks.list(sessionId);
        if (!cancelled) { setTasks(result.items); setError(null); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sessionId]);

  const otherTasks = tasks.filter(task => !swarmTaskIds.has(task.id));
  if (!error && otherTasks.length === 0) return null;
  return <section className="background-tasks-panel"><header><div><strong>{tr('Other background tasks', '其他后台任务')}</strong><span>{tr('Non-swarm agent and tool jobs', '非 Swarm 的智能体与工具任务')}</span></div><small>{otherTasks.filter(task => task.status === 'running').length} {tr('running', '运行中')}</small></header>{error && <PreviewNotice kind="error" text={tr('Unable to load background tasks.', '无法加载后台任务。')} detail={error}/>}<div className="background-task-list">{otherTasks.map(task => <BackgroundTaskRow key={task.id} sessionId={sessionId} task={task} onCancelled={() => setTasks(previous => previous.map(item => item.id === task.id ? { ...item, status: 'cancelled' } : item))}/>)}</div></section>;
}

function BackgroundTaskRow({ sessionId, task, onCancelled }: { sessionId: string; task: BackgroundTask; onCancelled: () => void }) {
  const { tr } = useI18n();
  const [detail, setDetail] = useState<BackgroundTask | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (detail || loading) return;
    setLoading(true);
    try { setDetail(await api.sessions.tasks.get(sessionId, task.id)); } finally { setLoading(false); }
  };
  const cancel = async () => {
    if (!window.confirm(tr('Stop this background task?', '停止这个后台任务吗？'))) return;
    await api.sessions.tasks.cancel(sessionId, task.id);
    onCancelled();
  };
  return <details className={`background-task-row task-${task.status}`} onToggle={event => { if (event.currentTarget.open) void load(); }}><summary><span className={`status-dot ${task.status}`}/><span><strong>{task.description || task.id}</strong><small>{task.kind} · {task.id}</small></span><span className={`badge badge-${taskStatusBadge(task.status)}`}>{taskStatusLabel(task.status, tr)}</span></summary><div className="background-task-detail">{task.command && <code>{task.command}</code>}{loading ? <PreviewNotice kind="loading" text={tr('Loading output…', '正在加载输出…')}/> : (detail?.output_preview || task.output_preview) ? <MarkdownView content={detail?.output_preview || task.output_preview || ''}/> : <PreviewNotice kind="empty" text={tr('No output captured yet.', '尚未捕获输出。')}/>} {task.status === 'running' && <button type="button" onClick={() => void cancel()}>{tr('Stop task', '停止任务')}</button>}</div></details>;
}

type SwarmTask = NonNullable<SwarmStatus['tasks']>[number];

function TaskPreview({ task }: { task: SwarmTask }) {
  const { tr } = useI18n();
  const output = task.output?.trim() ?? '';
  const tokenTotal = (task.usage?.total ?? 0) + (task.live_output_tokens ?? 0);

  return (
    <details className={`swarm-task-preview swarm-task-preview-${task.status}`}>
      <summary className="swarm-task-summary">
        <span className={`status-dot ${task.status}`} />
        <span className="swarm-task-identity">
          <strong>{task.label || tr('Unnamed task', '未命名任务')}</strong>
          <small>{task.id}</small>
        </span>
        <span className="swarm-task-meta">
          {tokenTotal > 0 ? <small>{(task.live_output_tokens ?? 0) > 0 ? '~' : ''}{tokenTotal.toLocaleString()} tokens</small> : null}
          {typeof task.output_bytes === 'number' ? <small>{formatBytes(task.output_bytes)}</small> : null}
          <span className={`badge badge-${taskStatusBadge(task.status)}`}>
            {taskStatusLabel(task.status, tr)}
          </span>
        </span>
      </summary>

      <div className="swarm-task-output">
        {output ? (
          <MarkdownView content={output} className="swarm-task-output-markdown" />
        ) : (
          <PreviewNotice
            kind="empty"
            text={isTaskFinished(task.status)
              ? tr('This agent did not return output.', '此智能体未返回输出。')
              : tr('Waiting for this agent to produce output…', '正在等待此智能体生成输出…')}
          />
        )}
      </div>
    </details>
  );
}

export function swarmRunTokens(run: SwarmStatus): number {
  const exact = run.usage?.total ?? run.tasks?.reduce((total, task) => total + (task.usage?.total ?? 0), 0) ?? 0;
  const live = run.tasks?.reduce((total, task) => total + (task.live_output_tokens ?? 0), 0) ?? 0;
  return exact + live;
}

function PreviewNotice({
  kind,
  text,
  detail,
}: {
  kind: 'loading' | 'empty' | 'error';
  text: string;
  detail?: string;
}) {
  return (
    <div className={`swarm-preview-notice ${kind}`}>
      {kind === 'loading' ? <span className="swarm-preview-spinner" /> : null}
      <span>{text}</span>
      {detail ? <small title={detail}>{detail}</small> : null}
    </div>
  );
}

function taskStatusBadge(status: string): string {
  if (status === 'done' || status === 'completed') return 'success';
  if (status === 'running') return 'info';
  if (status === 'paused') return 'warning';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  return 'muted';
}

function taskStatusLabel(
  status: string,
  tr: (english: string, chinese: string) => string,
): string {
  if (status === 'done' || status === 'completed') return tr('Done', '已完成');
  if (status === 'running') return tr('Running', '运行中');
  if (status === 'paused') return tr('Paused', '已暂停');
  if (status === 'failed') return tr('Failed', '失败');
  if (status === 'cancelled') return tr('Cancelled', '已取消');
  if (status === 'pending' || status === 'queued') return tr('Pending', '等待中');
  return status;
}

function isTaskFinished(status: string): boolean {
  return status === 'done' || status === 'completed' || status === 'failed' || status === 'cancelled';
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
