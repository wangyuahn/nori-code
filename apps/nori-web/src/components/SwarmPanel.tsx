import { useEffect, useState } from 'react';
import type { SwarmConnectionState } from '../hooks/useApi';
import { api, type BackgroundTask, type SwarmStatus } from '../api/client';
import { useI18n } from '../i18n';
import { MarkdownView } from './MarkdownView';

export function SwarmPanel({ swarm, sessionId }: { swarm: SwarmConnectionState; sessionId?: string | null }) {
  const { tr } = useI18n();
  const { swarmStatuses, connected, error } = swarm;
  const runs = Array.from(swarmStatuses.values())
    .filter(status => !sessionId || status.session_id === sessionId)
    .sort((left, right) => (right.round ?? 0) - (left.round ?? 0));
  const rounds = new Map<number, SwarmStatus[]>();
  for (const run of runs) {
    const round = run.round ?? 1;
    rounds.set(round, [...(rounds.get(round) ?? []), run]);
  }
  const swarmTaskIds = new Set(runs.flatMap(run => run.task_id ? [run.task_id] : []));

  return (
    <div className="swarm-panel">
      <header className="swarm-panel-header">
        <div>
          <strong>{tr('Agent rounds', '智能体轮次')}</strong>
          <span>{tr('Live output and token usage for this conversation', '当前会话的实时输出与 token 消耗')}</span>
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
        <div className="swarm-round-list">
          {Array.from(rounds.entries()).map(([round, roundRuns]) => (
            <SwarmRound key={round} round={round} runs={roundRuns} />
          ))}
        </div>
      )}
      {sessionId && (
        <BackgroundTasksPanel sessionId={sessionId} swarmTaskIds={swarmTaskIds}/>
      )}
    </div>
  );
}

function SwarmRound({ round, runs }: { round: number; runs: SwarmStatus[] }) {
  const { tr } = useI18n();
  const running = runs.some(run => run.status === 'running' || run.status === 'pending');
  const agentCount = runs.reduce((total, run) => total + run.task_count, 0);
  const completedCount = runs.reduce((total, run) => total + run.completed_count, 0);
  const tokens = runs.reduce((total, run) => total + (run.usage?.total ?? 0), 0);

  return <details className={`swarm-round${running ? ' running' : ''}`} defaultOpen={running}>
    <summary>
      <span className={`status-dot ${running ? 'running' : 'done'}`}/>
      <span className="swarm-round-copy"><strong>{tr(`Round ${round}`, `第 ${round} 轮`)}</strong><small>{completedCount}/{agentCount} {tr('agents complete', '个智能体已完成')}</small></span>
      <span className="swarm-round-meta">{tokens > 0 && <small>{tokens.toLocaleString()} tokens</small>}<span className={`badge badge-${running ? 'info' : 'success'}`}>{running ? tr('Running', '运行中') : tr('Done', '已完成')}</span></span>
    </summary>
    <div className="swarm-round-body">{runs.map(run => <SwarmRun key={run.swarm_id} run={run}/>)}</div>
  </details>;
}

function SwarmRun({ run }: { run: SwarmStatus }) {
  const { tr } = useI18n();
  const progress = run.task_count > 0 ? Math.round((run.completed_count / run.task_count) * 100) : 0;
  const tasks = run.tasks ?? [];
  return <section className={`swarm-run swarm-run-${run.status}`}>
    <header>
      <span className={`status-dot ${run.status}`}/>
      <span><strong>{run.description || run.swarm_id}</strong><small>{run.owner_agent_id === 'main' ? tr('Started by Nori', '由 Nori 发起') : tr('Started by an agent', '由智能体发起')}</small></span>
      <span className="swarm-run-stats"><small>{run.completed_count}/{run.task_count}</small>{run.usage && <small>{run.usage.total.toLocaleString()} tokens</small>}</span>
    </header>
    <div className="swarm-run-progress"><i style={{ width: `${progress}%` }}/></div>
    <div className="swarm-task-items">
      {tasks.length > 0
        ? tasks.map(task => <TaskPreview key={task.id} task={task}/>)
        : <PreviewNotice kind="loading" text={tr('Waiting for agents to start…', '正在等待智能体启动…')}/>}
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

  return (
    <details className={`swarm-task-preview swarm-task-preview-${task.status}`}>
      <summary className="swarm-task-summary">
        <span className={`status-dot ${task.status}`} />
        <span className="swarm-task-identity">
          <strong>{task.label || tr('Unnamed task', '未命名任务')}</strong>
          <small>{task.id}</small>
        </span>
        <span className="swarm-task-meta">
          {task.usage ? <small>{task.usage.total.toLocaleString()} tokens</small> : null}
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
  if (status === 'failed' || status === 'cancelled') return 'danger';
  return 'muted';
}

function taskStatusLabel(
  status: string,
  tr: (english: string, chinese: string) => string,
): string {
  if (status === 'done' || status === 'completed') return tr('Done', '已完成');
  if (status === 'running') return tr('Running', '运行中');
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
