import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { api, type CronJob, type Session } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface CronJobPanelProps {
  sessions: Session[];
  sessionId: string | null;
  onCountChange?: (sessionId: string, count: number) => void;
}

export function CronJobPanel({ sessions, sessionId, onCountChange }: CronJobPanelProps) {
  const { tr } = useI18n();
  const [selectedSessionId, setSelectedSessionId] = useState(sessionId ?? sessions[0]?.id ?? '');
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [prompt, setPrompt] = useState('');
  const [recurring, setRecurring] = useState(true);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const jobsRef = useRef<CronJob[]>([]);
  const loadSequenceRef = useRef(0);
  selectedSessionIdRef.current = selectedSessionId;

  useEffect(() => {
    if (sessionId && sessions.some((session) => session.id === sessionId)) {
      setSelectedSessionId(sessionId);
      return;
    }
    setSelectedSessionId((current) =>
      sessions.some((session) => session.id === current) ? current : sessions[0]?.id ?? '',
    );
  }, [sessionId, sessions]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  const loadJobs = async (targetSessionId = selectedSessionId, signal?: AbortSignal) => {
    const sequence = ++loadSequenceRef.current;
    if (!targetSessionId) {
      jobsRef.current = [];
      setJobs([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.sessions.cron.list(targetSessionId);
      if (!signal?.aborted && sequence === loadSequenceRef.current && selectedSessionIdRef.current === targetSessionId) {
        jobsRef.current = result.items;
        setJobs(result.items);
        onCountChange?.(targetSessionId, result.items.length);
      }
    } catch (loadError) {
      if (!signal?.aborted && sequence === loadSequenceRef.current && selectedSessionIdRef.current === targetSessionId) {
        setJobs([]);
        setError(cronErrorMessage(loadError, tr));
      }
    } finally {
      if (!signal?.aborted && sequence === loadSequenceRef.current && selectedSessionIdRef.current === targetSessionId) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(selectedSessionId, controller.signal);
    return () => { controller.abort(); };
  }, [selectedSessionId]);

  const createJob = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSessionId || !cron.trim() || !prompt.trim()) return;
    const targetSessionId = selectedSessionId;
    setSaving(true);
    setError(null);
    try {
      const created = await api.sessions.cron.create(targetSessionId, {
        cron: cron.trim(),
        prompt: prompt.trim(),
        recurring,
      });
      if (selectedSessionIdRef.current === targetSessionId) {
        const next = [created, ...jobsRef.current.filter((job) => job.id !== created.id)];
        jobsRef.current = next;
        setJobs(next);
        onCountChange?.(targetSessionId, next.length);
        setPrompt('');
      }
    } catch (createError) {
      if (selectedSessionIdRef.current === targetSessionId) {
        setError(cronErrorMessage(createError, tr));
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteJob = async (job: CronJob) => {
    if (!selectedSessionId) return;
    if (!window.confirm(tr(`Delete Cron Job ${job.id}?`, `删除 Cron Job ${job.id}？`))) return;
    const targetSessionId = selectedSessionId;
    setDeletingId(job.id);
    setError(null);
    try {
      await api.sessions.cron.delete(targetSessionId, job.id);
      if (selectedSessionIdRef.current === targetSessionId) {
        const next = jobsRef.current.filter((item) => item.id !== job.id);
        jobsRef.current = next;
        setJobs(next);
        onCountChange?.(targetSessionId, next.length);
      }
    } catch (deleteError) {
      if (selectedSessionIdRef.current === targetSessionId) {
        setError(cronErrorMessage(deleteError, tr));
      }
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="cron-panel" aria-label="Cron Job">
      <div className="cron-toolbar">
        <label className="cron-session-select">
          <span>{tr('Session', '会话')}</span>
          <select value={selectedSessionId} onChange={(event) => { setSelectedSessionId(event.target.value); }}>
            {sessions.length === 0 && <option value="">{tr('No sessions', '暂无会话')}</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>{session.title || session.id}</option>
            ))}
          </select>
        </label>
        <div className="cron-session-context" title={selectedSession?.metadata?.cwd}>
          <strong>{selectedSession?.title ?? tr('Select a session', '请选择会话')}</strong>
          <span>{selectedSession?.metadata?.cwd ?? tr('Cron Jobs belong to a session.', 'Cron Job 按会话保存。')}</span>
        </div>
        <button className="icon-button" type="button" onClick={() => void loadJobs(selectedSessionId)} disabled={!selectedSessionId || loading} title={tr('Refresh', '刷新')}>
          {loading ? <span className="spinner spinner-small" /> : <Icon name="refresh" size={15} />}
        </button>
      </div>

      <form className="cron-create-form" onSubmit={(event) => { void createJob(event); }}>
        <div className="cron-form-row">
          <label className="cron-field cron-expression-field">
            <span>{tr('Schedule', '执行周期')}</span>
            <input value={cron} onChange={(event) => { setCron(event.target.value); }} placeholder="0 9 * * 1-5" spellCheck={false} disabled={!selectedSessionId || saving} />
            <small>{tr('Five fields in local time: minute, hour, day, month, weekday', '本地时间五段式：分 时 日 月 周')}</small>
          </label>
          <label className="cron-recurring-toggle">
            <input type="checkbox" checked={recurring} onChange={(event) => { setRecurring(event.target.checked); }} disabled={!selectedSessionId || saving} />
            <span>{recurring ? tr('Recurring', '循环执行') : tr('One shot', '仅执行一次')}</span>
          </label>
        </div>
        <label className="cron-field">
          <span>{tr('Prompt', '任务提示')}</span>
          <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); }} rows={3} maxLength={8192} placeholder={tr('What should the main agent do when this job fires?', '任务触发时主 Agent 应该做什么？')} disabled={!selectedSessionId || saving} />
        </label>
        <div className="cron-form-actions">
          <span>{prompt.length.toLocaleString()} / 8,192</span>
          <button className="cron-create-button" type="submit" disabled={!selectedSessionId || !cron.trim() || !prompt.trim() || saving}>
            {saving ? <span className="spinner spinner-small" /> : <Icon name="plus" size={14} />}
            {tr('Create Job', '创建任务')}
          </button>
        </div>
      </form>

      {error && <div className="cron-error" role="alert"><Icon name="alert" size={15} /><span>{error}</span></div>}

      <div className="cron-list-heading">
        <div><strong>{tr('Scheduled Jobs', '已安排任务')}</strong><span>{jobs.length}</span></div>
        <small>{tr('Schedules use the server local timezone.', '执行时间使用服务端本地时区。')}</small>
      </div>

      {!selectedSessionId ? (
        <CronEmpty title={tr('No session selected', '未选择会话')} description={tr('Create or select a session before scheduling a job.', '请先创建或选择一个会话。')} />
      ) : error ? null : loading && jobs.length === 0 ? (
        <div className="cron-loading"><span className="spinner" />{tr('Loading Cron Jobs...', '正在加载 Cron Job...')}</div>
      ) : jobs.length === 0 ? (
        <CronEmpty title={tr('No Cron Jobs', '暂无 Cron Job')} description={tr('Create a scheduled prompt for this session above.', '可在上方为当前会话创建定时任务。')} />
      ) : (
        <div className="cron-job-list">
          {jobs.map((job) => (
            <article key={job.id} className={`cron-job-card${job.stale ? ' stale' : ''}`}>
              <div className="cron-job-card-head">
                <div className="cron-job-schedule">
                  <span className="cron-job-icon"><Icon name="clock" size={15} /></span>
                  <div><strong>{job.humanSchedule}</strong><code>{job.cron}</code></div>
                </div>
                <div className="cron-job-badges">
                  {job.stale && <span className="cron-badge warning">{tr('Stale', '已过期')}</span>}
                  <span className="cron-badge">{job.recurring ? tr('Recurring', '循环') : tr('One shot', '单次')}</span>
                  <button className="icon-button danger" type="button" onClick={() => void deleteJob(job)} disabled={deletingId === job.id} title={tr('Delete job', '删除任务')}>
                    {deletingId === job.id ? <span className="spinner spinner-small" /> : <Icon name="trash" size={14} />}
                  </button>
                </div>
              </div>
              <p className="cron-job-prompt">{job.prompt}</p>
              <dl className="cron-job-meta">
                <div><dt>{tr('Next run', '下次执行')}</dt><dd>{formatTime(job.nextFireAt, tr('No future run', '无后续执行'))}</dd></div>
                <div><dt>{tr('Last run', '上次执行')}</dt><dd>{formatTime(job.lastFiredAt, tr('Not run yet', '尚未执行'))}</dd></div>
                <div><dt>{tr('Created', '创建时间')}</dt><dd>{formatTime(job.createdAt, '-')}</dd></div>
                <div><dt>ID</dt><dd><code>{job.id}</code></dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function CronEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="cron-empty">
      <Icon name="clock" size={22} />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function formatTime(value: number | undefined | null, fallback: string): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function cronErrorMessage(
  error: unknown,
  tr: (english: string, chinese: string) => string,
): string {
  const message = error instanceof Error ? error.message : '';
  if (/\/cron failed: 404\b/.test(message)) {
    return tr(
      'The connected Nori server does not support Cron Jobs yet. Restart the development server or update Nori Work, then try again.',
      '当前连接的 Nori 后台尚不支持定时任务。请重启开发服务或更新 Nori Work 后重试。',
    );
  }
  return message || tr('Cron Job request failed.', '定时任务请求失败。');
}
