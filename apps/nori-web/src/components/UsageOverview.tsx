import { useMemo, useState } from 'react';
import type { ModelCatalogItem, Session } from '../api/client';
import { useI18n } from '../i18n';

type UsageRange = 'all' | '30d' | '7d';
type UsageTab = 'overview' | 'models';

export interface UsageSummary {
  sessions: number;
  messages: number;
  tokens: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string;
  activityByDay: Map<string, number>;
  models: Array<{ model: string; sessions: number; messages: number; tokens: number }>;
}

export function UsageOverview({ sessions, models }: { sessions: Session[]; models: ModelCatalogItem[] }) {
  const { tr } = useI18n();
  const [range, setRange] = useState<UsageRange>('all');
  const [tab, setTab] = useState<UsageTab>('overview');
  const summary = useMemo(() => summarizeUsage(sessions, range), [range, sessions]);
  const modelNames = useMemo(() => new Map(models.map(model => [model.model, model.display_name || model.model])), [models]);
  const heatmap = useMemo(() => buildHeatmap(summary.activityByDay), [summary.activityByDay]);

  return <section className="initial-usage" aria-label={tr('Usage statistics', '用量统计')}>
    <header className="initial-usage-header">
      <div className="initial-usage-tabs" role="tablist" aria-label={tr('Usage view', '用量视图')}>
        <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>{tr('Overview', '概览')}</button>
        <button type="button" className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>{tr('Models', '模型')}</button>
      </div>
      <div className="initial-usage-range" role="group" aria-label={tr('Usage period', '统计周期')}>
        {(['all', '30d', '7d'] as const).map(value => <button type="button" key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{value === 'all' ? tr('All', '全部') : value === '30d' ? tr('30d', '30 天') : tr('7d', '7 天')}</button>)}
      </div>
    </header>

    {tab === 'overview' ? <>
      <div className="initial-usage-metrics">
        <UsageMetric label={tr('Sessions', '会话')} value={formatNumber(summary.sessions)}/>
        <UsageMetric label={tr('Messages', '消息')} value={formatNumber(summary.messages)}/>
        <UsageMetric label={tr('Total tokens', '总 token')} value={formatTokens(summary.tokens)}/>
        <UsageMetric label={tr('Active days', '活跃天数')} value={formatNumber(summary.activeDays)}/>
        <UsageMetric label={tr('Current streak', '当前连续')} value={tr(`${summary.currentStreak}d`, `${summary.currentStreak} 天`)}/>
        <UsageMetric label={tr('Longest streak', '最长连续')} value={tr(`${summary.longestStreak}d`, `${summary.longestStreak} 天`)}/>
        <UsageMetric label={tr('Peak hour', '高峰时段')} value={summary.peakHour === null ? '-' : formatHour(summary.peakHour)}/>
        <UsageMetric label={tr('Favorite model', '常用模型')} value={modelNames.get(summary.favoriteModel) ?? summary.favoriteModel}/>
      </div>
      <div className="usage-heatmap" aria-label={tr('Activity over the last 12 weeks', '最近 12 周活跃度')}>
        {heatmap.map(day => <i key={day.key} className={`level-${day.level}`} title={`${day.key}: ${day.value} ${tr('messages', '条消息')}`}/>)}
      </div>
    </> : <div className="usage-model-list">
      {summary.models.length === 0 ? <p>{tr('No model usage recorded yet.', '暂无模型用量记录。')}</p> : summary.models.map(model => <div key={model.model}>
        <span><strong>{modelNames.get(model.model) ?? model.model}</strong><small>{model.sessions} {tr('sessions', '个会话')} · {model.messages} {tr('messages', '条消息')}</small></span>
        <b>{formatTokens(model.tokens)}</b>
      </div>)}
    </div>}
  </section>;
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

export function summarizeUsage(sessions: Session[], range: UsageRange, now = new Date()): UsageSummary {
  const cutoff = range === 'all' ? Number.NEGATIVE_INFINITY : now.getTime() - (range === '30d' ? 30 : 7) * 86_400_000;
  const filtered = sessions.filter(session => Date.parse(session.updated_at) >= cutoff);
  const activityByDay = new Map<string, number>();
  const activityByHour = new Map<number, number>();
  const byModel = new Map<string, { sessions: number; messages: number; tokens: number }>();
  let messages = 0;
  let tokens = 0;

  for (const session of filtered) {
    const messageCount = session.message_count ?? 0;
    const sessionTokens = usageTokens(session);
    messages += messageCount;
    tokens += sessionTokens;
    const date = new Date(session.updated_at);
    const day = localDayKey(date);
    activityByDay.set(day, (activityByDay.get(day) ?? 0) + Math.max(1, messageCount));
    activityByHour.set(date.getHours(), (activityByHour.get(date.getHours()) ?? 0) + Math.max(1, messageCount));
    const model = session.agent_config?.model?.trim();
    if (!model || model.toLowerCase() === 'unknown') continue;
    const prior = byModel.get(model) ?? { sessions: 0, messages: 0, tokens: 0 };
    byModel.set(model, { sessions: prior.sessions + 1, messages: prior.messages + messageCount, tokens: prior.tokens + sessionTokens });
  }

  const activeDayKeys = [...activityByDay.keys()].sort();
  const streaks = calculateStreaks(activeDayKeys, now);
  const models = [...byModel.entries()]
    .map(([model, value]) => ({ model, ...value }))
    .sort((left, right) => right.sessions - left.sessions || right.messages - left.messages || right.tokens - left.tokens);
  const peakHour = [...activityByHour.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;

  return {
    sessions: filtered.length,
    messages,
    tokens,
    activeDays: activeDayKeys.length,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
    peakHour,
    favoriteModel: models[0]?.model ?? (filtered.length === 0 ? 'Unknown' : '-'),
    activityByDay,
    models,
  };
}

function usageTokens(session: Session): number {
  const usage = session.usage;
  if (!usage) return 0;
  return usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
}

function calculateStreaks(dayKeys: string[], now: Date): { current: number; longest: number } {
  if (dayKeys.length === 0) return { current: 0, longest: 0 };
  const dayNumbers = [...new Set(dayKeys.map(key => Math.floor(new Date(`${key}T00:00:00`).getTime() / 86_400_000)))].sort((a, b) => a - b);
  let longest = 1;
  let running = 1;
  for (let index = 1; index < dayNumbers.length; index++) {
    running = dayNumbers[index]! - dayNumbers[index - 1]! === 1 ? running + 1 : 1;
    longest = Math.max(longest, running);
  }
  const today = Math.floor(new Date(localDayKey(now) + 'T00:00:00').getTime() / 86_400_000);
  const last = dayNumbers.at(-1)!;
  if (today - last > 1) return { current: 0, longest };
  let current = 1;
  for (let index = dayNumbers.length - 1; index > 0; index--) {
    if (dayNumbers[index]! - dayNumbers[index - 1]! !== 1) break;
    current++;
  }
  return { current, longest };
}

function buildHeatmap(activity: Map<string, number>): Array<{ key: string; value: number; level: number }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const max = Math.max(1, ...activity.values());
  return Array.from({ length: 84 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (83 - index));
    const key = localDayKey(date);
    const value = activity.get(key) ?? 0;
    return { key, value, level: value === 0 ? 0 : Math.max(1, Math.ceil(value / max * 4)) };
  });
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return value.toLocaleString();
}

function formatHour(hour: number): string {
  const normalized = hour % 12 || 12;
  return `${normalized} ${hour < 12 ? 'AM' : 'PM'}`;
}
