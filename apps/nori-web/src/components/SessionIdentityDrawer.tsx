import { useMemo, useState } from 'react';
import { api, type Session } from '../api/client';
import { useI18n } from '../i18n';

export type SessionIdentityMode = 'edit' | 'create';
export type SessionIdentityParentStatus = 'idle' | 'writing' | 'waiting' | 'failed';

export interface SessionIdentityDraftValues {
  name: string;
  role: string;
  mandate: string;
  prompt: string;
  tags: string;
}

function readString(metadata: Session['metadata'], key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : '';
}

function readTags(metadata: Session['metadata']): string {
  const value = metadata?.session_tags;
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string').join(', ');
}

export function parseIdentityTags(value: string): string[] {
  return [...new Set(
    value
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  )].slice(0, 16);
}

function valuesFromSession(session: Session): SessionIdentityDraftValues {
  return {
    name: session.title?.trim() || readString(session.metadata, 'mount_name'),
    role: readString(session.metadata, 'mount_role'),
    mandate: readString(session.metadata, 'mount_mandate'),
    prompt: '',
    tags: readTags(session.metadata),
  };
}

export function SessionIdentityDrawer({
  session,
  mode = session === undefined ? 'create' : 'edit',
  parentTitle,
  initialValues,
  parentStatus = 'idle',
  parentMessage,
  allowAskParent = false,
  requireCompleteIdentity = true,
  submitting = false,
  onAskParent,
  onClose,
  onSaved,
  onSubmit,
  onChange,
}: {
  session?: Session;
  mode?: SessionIdentityMode;
  parentTitle?: string;
  initialValues?: Partial<SessionIdentityDraftValues>;
  parentStatus?: SessionIdentityParentStatus;
  parentMessage?: string;
  allowAskParent?: boolean;
  requireCompleteIdentity?: boolean;
  submitting?: boolean;
  onAskParent?: (prompt: string) => void;
  onClose: () => void;
  onSaved?: (next: Session) => void;
  onSubmit?: (values: SessionIdentityDraftValues) => void | Promise<void>;
  onChange?: (values: SessionIdentityDraftValues) => void;
}) {
  const { tr } = useI18n();
  const seeded = session !== undefined ? valuesFromSession(session) : {
    name: '',
    role: '',
    mandate: '',
    prompt: '',
    tags: '',
  };
  const [values, setValues] = useState<SessionIdentityDraftValues>({
    ...seeded,
    ...initialValues,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creating = mode === 'create';
  const locked = busy || submitting || parentStatus === 'writing';
  const canSaveEdit = values.name.trim().length > 0;
  const canCreate = requireCompleteIdentity
    ? values.name.trim().length > 0 && values.role.trim().length > 0 && values.mandate.trim().length > 0
    : true;

  const update = (patch: Partial<SessionIdentityDraftValues>) => {
    setValues((current) => {
      const next = { ...current, ...patch };
      onChange?.(next);
      return next;
    });
  };

  const parentStatusText = useMemo(() => {
    if (parentMessage !== undefined && parentMessage.trim().length > 0) return parentMessage;
    if (parentStatus === 'writing') return tr('The parent is writing…', '父节点正在填写…');
    if (parentStatus === 'waiting') return tr('Wait for the parent to finish talking.', '等父节点说完再写身份。');
    if (parentStatus === 'failed') return tr('The parent did not fill this in. You can type it yourself.', '父亲这次没写出来，你可以自己填。');
    return null;
  }, [parentMessage, parentStatus, tr]);

  const save = async () => {
    if (creating) {
      if (!canCreate || onSubmit === undefined) return;
      setBusy(true);
      setError(null);
      try {
        await onSubmit(values);
      } catch {
        setError(tr('The session could not be created. Try again.', '没建成功，可以改完再试。'));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (session === undefined || !canSaveEdit) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.sessions.updateIdentity(session.id, {
        name: values.name.trim(),
        role: values.role.trim() || undefined,
        mandate: values.mandate.trim() || undefined,
        tags: parseIdentityTags(values.tags),
      });
      onSaved?.(next);
      onClose();
    } catch {
      setError(tr('Identity could not be saved. Try again.', '身份没保存好，可以再试一次。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="session-identity-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={tr('Identity', '身份')}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div className="session-identity-drawer-panel" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h3>{creating ? tr('New member', '新成员') : tr('Identity', '身份')}</h3>
          <p>
            {creating && parentTitle
              ? tr(`Identity for a member of “${parentTitle}”.`, `给「${parentTitle}」的新成员写身份。`)
              : creating
                ? tr('Name this session, then create it.', '先写身份，确认后才会创建。')
                : tr('Name, role, responsibility, and identity tags.', '名字、角色、职责和身份标签。')}
          </p>
        </header>
        <label>
          {tr('Name', '名字')}
          <input
            autoFocus
            value={values.name}
            disabled={locked}
            maxLength={120}
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <label>
          {tr('Role', '角色')}
          <input
            value={values.role}
            disabled={locked}
            maxLength={4000}
            onChange={(event) => update({ role: event.target.value })}
          />
        </label>
        <label>
          {tr('Mandate', '职责')}
          <textarea
            value={values.mandate}
            disabled={locked}
            rows={4}
            maxLength={4000}
            onChange={(event) => update({ mandate: event.target.value })}
          />
        </label>
        {creating && allowAskParent ? (
          <label>
            Prompt
            <textarea
              value={values.prompt}
              disabled={locked}
              rows={3}
              maxLength={4000}
              placeholder={tr('Tell the parent what kind of person you need.', '跟父节点说你要什么样的人。')}
              onChange={(event) => update({ prompt: event.target.value })}
            />
          </label>
        ) : null}
        {!creating ? (
          <label>
            {tr('Tags', '标签')}
            <input
              value={values.tags}
              disabled={locked}
              placeholder={tr('review, backend', 'review, backend')}
              onChange={(event) => update({ tags: event.target.value })}
            />
          </label>
        ) : null}
        {allowAskParent && (
          <div className="session-identity-parent">
            <button
              type="button"
              className="session-map-tool"
              disabled={locked || values.prompt.trim().length === 0 || parentStatus === 'waiting'}
              onClick={() => onAskParent?.(values.prompt.trim())}
            >
              {parentStatus === 'writing'
                ? tr('Parent is writing…', '父节点正在填写…')
                : tr('Ask parent to fill', '让父节点填写')}
            </button>
            {parentStatusText !== null && (
              <p className={parentStatus === 'failed' ? 'session-identity-drawer-error' : 'session-identity-parent-status'}>
                {parentStatusText}
              </p>
            )}
          </div>
        )}
        {error !== null && <p className="session-identity-drawer-error">{error}</p>}
        <footer>
          <button type="button" className="session-map-tool" onClick={onClose} disabled={submitting || (creating && busy)}>
            {tr('Cancel', '取消')}
          </button>
          <button
            type="button"
            className="session-map-tool primary"
            onClick={() => void save()}
            disabled={locked || (creating ? !canCreate : !canSaveEdit)}
          >
            {submitting || busy
              ? (creating ? tr('Creating…', '正在出生…') : tr('Saving…', '保存中…'))
              : (creating ? tr('Create', '创建') : tr('Save', '保存'))}
          </button>
        </footer>
      </div>
    </div>
  );
}
