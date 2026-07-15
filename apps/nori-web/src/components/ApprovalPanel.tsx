import { useEffect, useState, type WheelEvent } from 'react';
import type { ApprovalRequest } from '../api/client';
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
  onResolve: (id: string, decision: 'approved' | 'rejected' | 'cancelled', options?: ApprovalOptions) => void;
}

interface DisplayData {
  kind?: string;
  [key: string]: unknown;
}

export function ApprovalPanel({ requests, onResolve }: ApprovalPanelProps) {
  const { tr } = useI18n();
  const [layout, setLayout] = useState<'compact' | 'stack'>('compact');
  const [activeIndex, setActiveIndex] = useState(0);
  const [remembered, setRemembered] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(0, requests.length - 1)));
  }, [requests.length]);

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (layout !== 'compact' || requests.length < 2) return;
    event.preventDefault();
    setActiveIndex(index => (index + (event.deltaY > 0 ? 1 : -1) + requests.length) % requests.length);
  };

  const renderRequest = (request: ApprovalRequest) => {
    const display = asDisplay(request.tool_input_display);
    const kind = display?.kind;
    const selectedLabel = selectedLabels[request.approval_id];
    const requestFeedback = feedback[request.approval_id] ?? '';
    const remember = remembered.has(request.approval_id);
    const resolve = (decision: 'approved' | 'rejected' | 'cancelled', options: ApprovalOptions = {}) => onResolve(request.approval_id, decision, { remember, feedback: requestFeedback, ...options });

    return <div key={request.approval_id} className={`approval-card pending approval-kind-${kind ?? 'generic'}`}>
      <div className="approval-card-header"><span className="approval-tool-icon"><Icon name={kind === 'goal_start' ? 'target' : kind === 'plan_review' ? 'list' : 'settings'} size={15}/></span><span className="approval-tool-name">{kind === 'goal_start' ? tr('Start goal', '启动目标') : kind === 'plan_review' ? tr('Review plan', '审核计划') : request.tool_name}</span><span className="approval-status approval-status--pending">{tr('Permission required', '需要授权')}</span></div>
      <div className="approval-action-label">{request.action}</div>
      <ApprovalDisplay display={display} fallback={request.tool_input_display}/>

      {kind === 'plan_review' && <div className="approval-choice-list">{planOptions(display).map(option => <button type="button" key={option.label} className={selectedLabel === option.label ? 'selected' : ''} onClick={() => setSelectedLabels(previous => ({ ...previous, [request.approval_id]: option.label }))}><span className="question-radio">{selectedLabel === option.label && <Icon name="check" size={12}/>}</span><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></button>)}</div>}

      {(kind === 'plan_review' || kind === 'generic') && <textarea className="approval-feedback" value={requestFeedback} onChange={event => setFeedback(previous => ({ ...previous, [request.approval_id]: event.target.value }))} placeholder={tr('Optional feedback', '可选反馈')}/>} 

      <div className="approval-actions">
        {kind === 'goal_start' ? <GoalApprovalActions display={display} onSelect={(decision, label) => resolve(decision, { selectedLabel: label })} tr={tr}/>
          : kind === 'plan_review' ? <><button className="approval-btn approval-btn--approve" disabled={!selectedLabel} onClick={() => resolve('approved', { selectedLabel })}>{tr('Approve choice', '批准所选方案')}</button><button className="approval-btn approval-btn--decline" disabled={!requestFeedback.trim()} onClick={() => resolve('rejected', { selectedLabel: 'Revise' })}>{tr('Revise', '要求修改')}</button><button className="approval-btn approval-btn--decline" onClick={() => resolve('rejected', { selectedLabel: 'Reject' })}>{tr('Reject', '拒绝')}</button></>
          : <><button className="approval-btn approval-btn--approve" onClick={() => resolve('approved')}>{tr('Approve', '允许')}</button><button className="approval-btn approval-btn--decline" onClick={() => resolve('rejected')}>{tr('Decline', '拒绝')}</button><label className="approval-always-allow"><input type="checkbox" checked={remember} onChange={event => setRemembered(previous => { const next = new Set(previous); if (event.target.checked) next.add(request.approval_id); else next.delete(request.approval_id); return next; })}/>{tr('Always allow this tool in this session', '本会话始终允许此工具')}</label></>}
      </div>
    </div>;
  };

  return <aside className={`approval-dock approval-dock-${layout}`} onWheel={onWheel}>
    <header className="approval-dock-header"><span><Icon name="alert" size={14}/><strong>{tr('Tool permissions', '工具授权')}</strong><small>{requests.length}</small></span><div className="approval-layout-switch" role="group" aria-label={tr('Approval layout', '授权布局')}><button className={layout === 'compact' ? 'active' : ''} onClick={() => setLayout('compact')} title={tr('Group requests and use the mouse wheel to switch', '合并请求，用鼠标滚轮切换')}><Icon name="archive" size={13}/></button><button className={layout === 'stack' ? 'active' : ''} onClick={() => setLayout('stack')} title={tr('Show requests vertically', '纵向平铺请求')}><Icon name="list" size={13}/></button></div></header>
    <div className="approval-panel">{layout === 'compact' ? renderRequest(requests[activeIndex]!) : requests.map(renderRequest)}</div>
    {layout === 'compact' && requests.length > 1 && <footer className="approval-pager"><button onClick={() => setActiveIndex(index => (index - 1 + requests.length) % requests.length)}><Icon name="chevron-left" size={13}/></button><span>{activeIndex + 1} / {requests.length} · {tr('Scroll to switch', '滚轮切换')}</span><button onClick={() => setActiveIndex(index => (index + 1) % requests.length)}><Icon name="chevron-right" size={13}/></button></footer>}
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
