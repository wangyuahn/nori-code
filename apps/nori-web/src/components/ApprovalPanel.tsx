import { useEffect, useState, type WheelEvent } from 'react';
import type { ApprovalRequest } from '../api/client';
import type { NoriBrowserState } from '../types/nori-desktop';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { MarkdownView } from './MarkdownView';

interface ApprovalOptions {
  remember?: boolean;
  feedback?: string;
  selectedLabel?: string;
}

interface ApprovalPanelProps {
  requests: ApprovalRequest[];
  onResolve?: (id: string, decision: 'approved' | 'rejected' | 'cancelled', options?: ApprovalOptions) => void | Promise<void>;
  onPermissionChange?: (mode: 'auto' | 'yolo') => void | Promise<void>;
  browserPermissions?: NoriBrowserState['permissions']['pending'];
  onResolveBrowserPermission?: (id: string, decision: 'allow_once' | 'allow_always' | 'deny' | 'deny_always') => void | Promise<void>;
}

interface DisplayData {
  kind?: string;
  [key: string]: unknown;
}

export function ApprovalPanel({ requests, onResolve, onPermissionChange, browserPermissions = [], onResolveBrowserPermission }: ApprovalPanelProps) {
  const { tr } = useI18n();
  const [layout, setLayout] = useState<'compact' | 'stack'>('compact');
  const [activeIndex, setActiveIndex] = useState(0);
  const [remembered, setRemembered] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string>>({});
  const [switchingMode, setSwitchingMode] = useState<Record<string, 'auto' | 'yolo' | undefined>>({});
  const [modeErrors, setModeErrors] = useState<Record<string, string | undefined>>({});

  const items = [
    ...requests.map(request => ({ kind: 'tool' as const, request })),
    ...browserPermissions.map(request => ({ kind: 'browser' as const, request })),
  ];

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(0, items.length - 1)));
  }, [items.length]);

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (layout !== 'compact' || items.length < 2) return;
    event.preventDefault();
    setActiveIndex(index => (index + (event.deltaY > 0 ? 1 : -1) + items.length) % items.length);
  };

  const switchModeAndResolve = async (
    requestId: string,
    mode: 'auto' | 'yolo',
    resolve: () => void | Promise<void>,
  ) => {
    if (!onPermissionChange || switchingMode[requestId]) return;
    setSwitchingMode(previous => ({ ...previous, [requestId]: mode }));
    setModeErrors(previous => ({ ...previous, [requestId]: undefined }));
    try {
      await onPermissionChange(mode);
      await resolve();
    } catch (error) {
      setModeErrors(previous => ({
        ...previous,
        [requestId]: error instanceof Error
          ? error.message
          : tr('Unable to change permission mode.', '无法切换权限模式。'),
      }));
    } finally {
      setSwitchingMode(previous => ({ ...previous, [requestId]: undefined }));
    }
  };

  const renderRequest = (request: ApprovalRequest) => {
    const display = asDisplay(request.tool_input_display);
    const kind = display?.kind;
    const selectedLabel = selectedLabels[request.approval_id];
    const requestFeedback = feedback[request.approval_id] ?? '';
    const remember = remembered.has(request.approval_id);
    const resolve = (decision: 'approved' | 'rejected' | 'cancelled', options: ApprovalOptions = {}) => onResolve?.(request.approval_id, decision, { remember, feedback: requestFeedback, ...options });
    const activeModeSwitch = switchingMode[request.approval_id];

    return <div key={request.approval_id} className={`approval-card pending approval-kind-${kind ?? 'generic'}`}>
      <div className="approval-card-header"><span className="approval-tool-icon"><Icon name={kind === 'goal_start' ? 'target' : kind === 'plan_review' ? 'list' : 'settings'} size={15}/></span><span className="approval-tool-name">{kind === 'goal_start' ? tr('Start goal', '启动目标') : kind === 'plan_review' ? tr('Review plan', '审核计划') : request.tool_name}</span><span className="approval-status approval-status--pending">{tr('Permission required', '需要授权')}</span></div>
      <div className="approval-action-label">{request.action}</div>
      <ApprovalDisplay display={display} fallback={request.tool_input_display}/>

      {kind === 'plan_review' && <div className="approval-choice-list">{planOptions(display).map(option => <button type="button" key={option.label} className={selectedLabel === option.label ? 'selected' : ''} onClick={() => setSelectedLabels(previous => ({ ...previous, [request.approval_id]: option.label }))}><span className="question-radio">{selectedLabel === option.label && <Icon name="check" size={12}/>}</span><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></button>)}</div>}

      {(kind === 'plan_review' || kind === 'generic') && <textarea className="approval-feedback" value={requestFeedback} onChange={event => setFeedback(previous => ({ ...previous, [request.approval_id]: event.target.value }))} placeholder={tr('Optional feedback', '可选反馈')}/>} 

      {modeErrors[request.approval_id] && <div className="approval-mode-error" role="alert">{modeErrors[request.approval_id]}</div>}

      <div className="approval-actions">
        {kind === 'goal_start' ? <GoalApprovalActions display={display} onSelect={(decision, label) => resolve(decision, { selectedLabel: label })} tr={tr}/>
          : kind === 'plan_review' ? <><button className="approval-btn approval-btn--approve" disabled={!selectedLabel} onClick={() => resolve('approved', { selectedLabel })}>{tr('Approve choice', '批准所选方案')}</button><button className="approval-btn approval-btn--decline" disabled={!requestFeedback.trim()} onClick={() => resolve('rejected', { selectedLabel: 'Revise' })}>{tr('Revise', '要求修改')}</button><button className="approval-btn approval-btn--decline" onClick={() => resolve('rejected', { selectedLabel: 'Reject' })}>{tr('Reject', '拒绝')}</button></>
          : <><button className="approval-btn approval-btn--approve" disabled={Boolean(activeModeSwitch)} onClick={() => resolve('approved')}>{tr('Approve', '允许')}</button>{onPermissionChange && <><button className="approval-btn approval-btn--auto" disabled={Boolean(activeModeSwitch)} onClick={() => void switchModeAndResolve(request.approval_id, 'auto', () => resolve('approved'))}>{activeModeSwitch === 'auto' ? tr('Switching…', '切换中…') : tr('Switch to AUTO and approve', '切换为 AUTO 并允许')}</button><button className="approval-btn approval-btn--yolo" disabled={Boolean(activeModeSwitch)} onClick={() => void switchModeAndResolve(request.approval_id, 'yolo', () => resolve('approved'))}>{activeModeSwitch === 'yolo' ? tr('Switching…', '切换中…') : tr('Switch to YOLO and approve', '切换为 YOLO 并允许')}</button></>}<button className="approval-btn approval-btn--decline" disabled={Boolean(activeModeSwitch)} onClick={() => resolve('rejected')}>{tr('Decline', '拒绝')}</button><label className="approval-always-allow"><input type="checkbox" checked={remember} disabled={Boolean(activeModeSwitch)} onChange={event => setRemembered(previous => { const next = new Set(previous); if (event.target.checked) next.add(request.approval_id); else next.delete(request.approval_id); return next; })}/>{tr('Always allow this tool in this session', '本会话始终允许此工具')}</label></>}
      </div>
    </div>;
  };

  const renderBrowserPermission = (request: NoriBrowserState['permissions']['pending'][number]) => {
    const activeModeSwitch = switchingMode[request.id];
    return <div key={request.id} className="approval-card pending browser-permission-card">
      <div className="approval-card-header"><span className="approval-tool-icon"><Icon name="globe" size={15}/></span><span className="approval-tool-name">{tr('Browser permission', '浏览器权限')}</span><span className="approval-status approval-status--pending">{tr('Permission required', '需要授权')}</span></div>
      <div className="approval-action-label">{request.permission}</div>
      <pre className="approval-args">{request.origin}</pre>
      {modeErrors[request.id] && <div className="approval-mode-error" role="alert">{modeErrors[request.id]}</div>}
      <div className="approval-actions">
        <button className="approval-btn approval-btn--approve" disabled={Boolean(activeModeSwitch)} onClick={() => onResolveBrowserPermission?.(request.id, 'allow_once')}>{tr('Allow once', '允许一次')}</button>
        {onPermissionChange && <><button className="approval-btn approval-btn--auto" disabled={Boolean(activeModeSwitch)} onClick={() => void switchModeAndResolve(request.id, 'auto', () => onResolveBrowserPermission?.(request.id, 'allow_once'))}>{activeModeSwitch === 'auto' ? tr('Switching…', '切换中…') : tr('Switch to AUTO and approve', '切换为 AUTO 并允许')}</button><button className="approval-btn approval-btn--yolo" disabled={Boolean(activeModeSwitch)} onClick={() => void switchModeAndResolve(request.id, 'yolo', () => onResolveBrowserPermission?.(request.id, 'allow_once'))}>{activeModeSwitch === 'yolo' ? tr('Switching…', '切换中…') : tr('Switch to YOLO and approve', '切换为 YOLO 并允许')}</button></>}
        <button className="approval-btn approval-btn--approve" disabled={Boolean(activeModeSwitch)} onClick={() => onResolveBrowserPermission?.(request.id, 'allow_always')}>{tr('Always allow', '始终允许')}</button>
        <button className="approval-btn approval-btn--decline" disabled={Boolean(activeModeSwitch)} onClick={() => onResolveBrowserPermission?.(request.id, 'deny')}>{tr('Deny', '拒绝')}</button>
        <button className="approval-btn approval-btn--decline" disabled={Boolean(activeModeSwitch)} onClick={() => onResolveBrowserPermission?.(request.id, 'deny_always')}>{tr('Always deny', '始终拒绝')}</button>
      </div>
    </div>;
  };

  const renderItem = (item: (typeof items)[number]) => item.kind === 'tool'
    ? renderRequest(item.request)
    : renderBrowserPermission(item.request);

  return <aside className={`approval-dock approval-dock-${layout}`} onWheel={onWheel}>
    <header className="approval-dock-header"><span><Icon name="alert" size={14}/><strong>{tr('Permissions', '授权')}</strong><small>{items.length}</small></span><div className="approval-layout-switch" role="group" aria-label={tr('Approval layout', '授权布局')}><button className={layout === 'compact' ? 'active' : ''} onClick={() => setLayout('compact')} title={tr('Group requests and use the mouse wheel to switch', '合并请求，用鼠标滚轮切换')}><Icon name="archive" size={13}/></button><button className={layout === 'stack' ? 'active' : ''} onClick={() => setLayout('stack')} title={tr('Show requests vertically', '纵向平铺请求')}><Icon name="list" size={13}/></button></div></header>
    <div className="approval-panel">{layout === 'compact' ? renderItem(items[activeIndex]!) : items.map(renderItem)}</div>
    {layout === 'compact' && items.length > 1 && <footer className="approval-pager"><button onClick={() => setActiveIndex(index => (index - 1 + items.length) % items.length)}><Icon name="chevron-left" size={13}/></button><span>{activeIndex + 1} / {items.length} · {tr('Scroll to switch', '滚轮切换')}</span><button onClick={() => setActiveIndex(index => (index + 1) % items.length)}><Icon name="chevron-right" size={13}/></button></footer>}
  </aside>;
}

function ApprovalDisplay({ display, fallback }: { display: DisplayData | null; fallback: unknown }) {
  if (display?.kind === 'plan_review' && typeof display.plan === 'string') return <div className="approval-plan"><MarkdownView content={display.plan}/></div>;
  if (display?.kind === 'goal_start') return <div className="approval-goal"><strong>{String(display.objective ?? '')}</strong>{typeof display.completionCriterion === 'string' && <span>{display.completionCriterion}</span>}</div>;
  if (display?.kind === 'command') return <pre className="approval-args">{String(display.command ?? '')}</pre>;
  if (display?.kind === 'file_io' || display?.kind === 'diff') return <pre className="approval-args">{String(display.path ?? '')}{typeof display.detail === 'string' ? `\n${display.detail}` : ''}</pre>;
  return <pre className="approval-args">{JSON.stringify(fallback, null, 2)}</pre>;
}

function GoalApprovalActions({ display, onSelect, tr }: { display: DisplayData | null; onSelect: (decision: 'approved' | 'cancelled', label: string) => void; tr: (en: string, zh: string) => string }) {
  const mode = display?.mode === 'yolo' ? 'yolo' : 'manual';
  const choices = [
    { value: 'auto', label: tr('Switch to Auto and start', '切换到 Auto 并启动') },
    { value: 'yolo', label: tr(mode === 'yolo' ? 'Keep YOLO and start' : 'Switch to YOLO and start', mode === 'yolo' ? '保持 YOLO 并启动' : '切换到 YOLO 并启动') },
    ...(mode === 'manual' ? [{ value: 'manual', label: tr('Start in Manual', '以 Manual 启动') }] : []),
  ];
  return <>{choices.map(choice => <button key={choice.value} className="approval-btn approval-btn--approve" onClick={() => onSelect('approved', choice.value)}>{choice.label}</button>)}<button className="approval-btn approval-btn--decline" onClick={() => onSelect('cancelled', 'cancel')}>{tr('Do not start', '不启动')}</button></>;
}

function asDisplay(value: unknown): DisplayData | null {
  return value !== null && typeof value === 'object' ? value as DisplayData : null;
}

function planOptions(display: DisplayData | null): Array<{ label: string; description?: string }> {
  if (!Array.isArray(display?.options) || display.options.length < 2) return [{ label: 'Approve' }];
  return display.options.flatMap(option => option !== null && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string' ? [{ label: (option as { label: string }).label, description: typeof (option as { description?: unknown }).description === 'string' ? (option as { description: string }).description : undefined }] : []);
}
