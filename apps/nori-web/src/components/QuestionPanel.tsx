import { useEffect, useMemo, useState } from 'react';
import type { QuestionAnswer, QuestionRequest } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { MarkdownView } from './MarkdownView';

interface QuestionPanelProps {
  requests: QuestionRequest[];
  onSubmit: (questionId: string, answers: Record<string, QuestionAnswer>) => void | Promise<void>;
  onDismiss: (questionId: string) => void | Promise<void>;
}

interface DraftAnswer {
  optionIds: string[];
  other: string;
  useOther: boolean;
  skipped: boolean;
}

const EMPTY_DRAFT: DraftAnswer = { optionIds: [], other: '', useOther: false, skipped: false };

export function QuestionPanel({ requests, onSubmit, onDismiss }: QuestionPanelProps) {
  const { tr } = useI18n();
  const request = requests[0];
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts({});
    setError(null);
  }, [request?.question_id]);

  const answers = useMemo(() => request ? buildAnswers(request, drafts) : null, [drafts, request]);
  if (!request) return null;

  const update = (itemId: string, updater: (draft: DraftAnswer) => DraftAnswer) => {
    setDrafts(previous => ({ ...previous, [itemId]: updater(previous[itemId] ?? EMPTY_DRAFT) }));
  };

  const submit = async () => {
    if (!answers) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(request.question_id, answers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('Unable to submit answers.', '无法提交回答。'));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDismiss(request.question_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('Unable to dismiss questions.', '无法关闭问题。'));
    } finally {
      setBusy(false);
    }
  };

  return <aside className="question-dock" aria-label={tr('Questions from Nori', 'Nori 的问题')}>
    <header><span><Icon name="chat" size={15}/><strong>{tr('Nori needs your input', 'Nori 需要你的回答')}</strong></span><small>{requests.length > 1 ? tr(`${requests.length} requests`, `${requests.length} 组问题`) : tr('Waiting', '等待回答')}</small></header>
    <div className="question-list">{request.questions.map((item, itemIndex) => {
      const draft = drafts[item.id] ?? EMPTY_DRAFT;
      return <section className="question-item" key={item.id}>
        <div className="question-copy"><small>{item.header || tr(`Question ${itemIndex + 1}`, `问题 ${itemIndex + 1}`)}</small><strong>{item.question}</strong>{item.body && <MarkdownView content={item.body}/>}</div>
        <div className="question-options">{item.options.map(option => {
          const selected = draft.optionIds.includes(option.id);
          return <button type="button" key={option.id} className={selected ? 'selected' : ''} onClick={() => update(item.id, current => ({
            ...current,
            skipped: false,
            useOther: item.multi_select ? current.useOther : false,
            optionIds: item.multi_select
              ? selected ? current.optionIds.filter(id => id !== option.id) : [...current.optionIds, option.id]
              : [option.id],
          }))} disabled={busy}><span className={item.multi_select ? 'question-check' : 'question-radio'}>{selected && <Icon name="check" size={12}/>}</span><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></button>;
        })}</div>
        {item.allow_other && <div className={`question-other ${draft.useOther ? 'active' : ''}`}><button type="button" onClick={() => update(item.id, current => ({ ...current, skipped: false, useOther: !current.useOther, optionIds: item.multi_select ? current.optionIds : [] }))} disabled={busy}>{item.other_label || tr('Other', '其他')}</button>{draft.useOther && <input value={draft.other} onChange={event => update(item.id, current => ({ ...current, other: event.target.value }))} placeholder={item.other_description || tr('Type your answer', '输入你的回答')} disabled={busy} autoFocus/>}</div>}
        <button type="button" className={`question-skip ${draft.skipped ? 'selected' : ''}`} onClick={() => update(item.id, () => ({ ...EMPTY_DRAFT, skipped: true }))} disabled={busy}>{tr('Skip this question', '跳过此问题')}</button>
      </section>;
    })}</div>
    {error && <div className="question-error">{error}</div>}
    <footer><button type="button" className="question-dismiss" onClick={() => void dismiss()} disabled={busy}>{tr('Dismiss request', '关闭整组问题')}</button><button type="button" className="question-submit" onClick={() => void submit()} disabled={busy || !answers}>{busy ? tr('Submitting…', '正在提交…') : tr('Submit answers', '提交回答')}</button></footer>
  </aside>;
}

function buildAnswers(request: QuestionRequest, drafts: Record<string, DraftAnswer>): Record<string, QuestionAnswer> | null {
  const result: Record<string, QuestionAnswer> = {};
  for (const item of request.questions) {
    const draft = drafts[item.id] ?? EMPTY_DRAFT;
    if (draft.skipped) {
      result[item.id] = { kind: 'skipped' };
    } else if (draft.useOther && draft.other.trim()) {
      result[item.id] = item.multi_select
        ? { kind: 'multi_with_other', option_ids: draft.optionIds, other_text: draft.other.trim() }
        : { kind: 'other', text: draft.other.trim() };
    } else if (item.multi_select && draft.optionIds.length > 0) {
      result[item.id] = { kind: 'multi', option_ids: draft.optionIds };
    } else if (!item.multi_select && draft.optionIds[0]) {
      result[item.id] = { kind: 'single', option_id: draft.optionIds[0] };
    } else {
      return null;
    }
  }
  return result;
}
