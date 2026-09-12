import { useMemo, useState } from 'react';
import { api, type Session } from '../api/client';
import { useI18n } from '../i18n';

function readString(metadata: Session['metadata'], key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : '';
}

function readTags(metadata: Session['metadata']): string {
  const value = metadata?.session_tags;
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string').join(', ');
}

function parseTags(value: string): string[] {
  return [...new Set(
    value
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  )].slice(0, 16);
}

export function SessionIdentityDrawer({
  session,
  onClose,
  onSaved,
}: {
  session: Session;
  onClose: () => void;
  onSaved?: (next: Session) => void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(session.title?.trim() || readString(session.metadata, 'mount_name'));
  const [role, setRole] = useState(readString(session.metadata, 'mount_role'));
  const [mandate, setMandate] = useState(readString(session.metadata, 'mount_mandate'));
  const [tags, setTags] = useState(readTags(session.metadata));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = useMemo(() => name.trim().length > 0, [name]);

  const save = async () => {
    const nextName = name.trim();
    if (nextName.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.sessions.updateIdentity(session.id, {
        name: nextName,
        role: role.trim() || undefined,
        mandate: mandate.trim() || undefined,
        tags: parseTags(tags),
      });
      onSaved?.(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="session-identity-drawer" role="dialog" aria-modal="true">
      <div className="session-identity-drawer-panel" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h3>{tr('Session settings', '会话设置')}</h3>
          <p>{tr('Name, mandate, and tags. Related sessions are notified without starting a turn.', '名称、职责和标签。相关会话会收到提醒，但不会被唤醒。')}</p>
        </header>
        <label>
          {tr('Name', '名称')}
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        </label>
        <label>
          {tr('Role', '角色')}
          <input value={role} onChange={(event) => setRole(event.target.value)} maxLength={4000} />
        </label>
        <label>
          {tr('Mandate', '职责')}
          <textarea value={mandate} onChange={(event) => setMandate(event.target.value)} rows={4} maxLength={4000} />
        </label>
        <label>
          {tr('Tags', '标签')}
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder={tr('review, backend', 'review, backend')}
          />
        </label>
        {error !== null && <p className="session-identity-drawer-error">{error}</p>}
        <footer>
          <button type="button" className="session-map-tool" onClick={onClose} disabled={busy}>
            {tr('Cancel', '取消')}
          </button>
          <button type="button" className="session-map-tool" onClick={() => void save()} disabled={busy || !canSave}>
            {busy ? tr('Saving…', '保存中…') : tr('Save', '保存')}
          </button>
        </footer>
      </div>
    </div>
  );
}
