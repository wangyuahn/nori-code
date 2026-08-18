import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Note } from '../api/client';
import { useVaultNotes } from '../hooks/useApi';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { VaultGraph } from './VaultGraph';
import { MarkdownView } from './MarkdownView';

const TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  analysis: { bg: 'color-mix(in srgb, var(--nori-cyan) 15%, transparent)', color: 'var(--nori-cyan)' },
  decision: { bg: 'color-mix(in srgb, var(--nori-purple) 15%, transparent)', color: 'var(--nori-purple)' },
  task: { bg: 'color-mix(in srgb, var(--nori-warning) 15%, transparent)', color: 'var(--nori-warning)' },
  review: { bg: 'color-mix(in srgb, var(--nori-success) 15%, transparent)', color: 'var(--nori-success)' },
};

const FOLDERS = ['all', 'analysis', 'decision', 'review', 'task'] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function VaultBrowser({ mode = 'list' }: { mode?: 'list' | 'graph' }) {
  const { tr } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { notes, loading, error, refresh } = useVaultNotes();

  useEffect(() => {
    setSelectedNote(null);
    setDetailError(null);
    setEditing(false);
    setSaveError(null);
  }, [selectedFolder]);

  const beginEdit = useCallback((note: Note) => {
    setDraftTitle(note.title);
    setDraftContent(vaultNoteBodyForEdit(note));
    setDraftTags((note.tags ?? []).join(', '));
    setSaveError(null);
    setEditing(true);
  }, []);

  const openNote = useCallback(async (note: Note, startEditing = false) => {
    setSelectedNote(note);
    setDetailLoading(true);
    setDetailError(null);
    setSaveError(null);
    setEditing(false);
    try {
      const detail = await api.vault.get(note.path || note.title);
      if (!detail) throw new Error(tr('The note no longer exists.', '这篇笔记已不存在。'));
      setSelectedNote(detail);
      if (startEditing) beginEdit(detail);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : tr('Failed to load note.', '加载笔记失败。'));
    } finally {
      setDetailLoading(false);
    }
  }, [beginEdit, tr]);

  const cancelEdit = useCallback(() => {
    setSaveError(null);
    setEditing(false);
  }, []);

  const saveNote = useCallback(async () => {
    if (!selectedNote) return;
    const title = draftTitle.trim();
    if (title.length === 0) {
      setSaveError(tr('Title cannot be empty.', '标题不能为空。'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.vault.update(selectedNote.path || selectedNote.title, {
        title,
        content: draftContent,
        tags: parseTagInput(draftTags),
        expected_updated_at: selectedNote.updated_at,
        expected_content_hash: selectedNote.content_hash,
      });
      setSelectedNote(saved);
      setEditing(false);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : tr('Failed to save note.', '保存笔记失败。');
      if (/modified after you opened/i.test(message)) {
        setSaveError(tr(
          'This note was modified after you opened it. Refresh and try again.',
          '笔记已被其他更改修改，请刷新后重试。',
        ));
      } else if (/not found/i.test(message)) {
        setSaveError(tr('The note no longer exists.', '这篇笔记已不存在。'));
      } else {
        setSaveError(message);
      }
    } finally {
      setSaving(false);
    }
  }, [draftContent, draftTags, draftTitle, refresh, selectedNote, tr]);

  const filteredNotes = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return notes
      .filter(note => {
        return (selectedFolder === 'all' || note.folder === selectedFolder) &&
          (!query
            || note.title.toLowerCase().includes(query)
            || note.preview.toLowerCase().includes(query)
            || (note.tags ?? []).some(tag => tag.toLowerCase().includes(query)));
      })
      .slice()
      .sort(compareVaultNotesByWrittenAt);
  }, [notes, searchQuery, selectedFolder]);

  if (selectedNote) {
    const typeColors = TYPE_COLORS[selectedNote.type] ?? TYPE_COLORS.analysis;
    const relatedNotes = collectRelatedNotes(notes, selectedNote);
    const writtenLabel = formatVaultNoteWrittenAt(selectedNote);
    const updatedLabel = formatVaultNoteUpdatedAt(selectedNote);
    return (
      <div className="card vault-note-detail">
        <div className="vault-note-toolbar">
          <button className="btn" onClick={() => { setSelectedNote(null); setEditing(false); setSaveError(null); }}>
            <Icon name="chevron-left" size={14} /> {tr('Back', '返回')}
          </button>
          {!editing && !detailLoading && !detailError && (
            <button className="btn" onClick={() => beginEdit(selectedNote)}>
              <Icon name="edit" size={14} /> {tr('Edit', '编辑')}
            </button>
          )}
          {editing && (
            <>
              <button className="btn" onClick={cancelEdit} disabled={saving}>{tr('Cancel', '取消')}</button>
              <button className="btn btn-primary" onClick={() => void saveNote()} disabled={saving}>
                {saving ? tr('Saving', '保存中') : tr('Save', '保存')}
              </button>
            </>
          )}
        </div>
        <span className="vault-note-type" style={{ background: typeColors.bg, color: typeColors.color }}>{selectedNote.type}</span>
        {editing ? (
          <label className="vault-note-field">
            <span>{tr('Title', '标题')}</span>
            <input className="input" value={draftTitle} onChange={event => setDraftTitle(event.target.value)} />
          </label>
        ) : (
          <h2>{selectedNote.title}</h2>
        )}
        <div className="vault-note-date">
          {writtenLabel
            ? tr(`Written ${writtenLabel}`, `写入 ${writtenLabel}`)
            : tr('Write time unknown', '写入时间未知')}
          {updatedLabel && updatedLabel !== writtenLabel ? ` · ${tr(`Edited ${updatedLabel}`, `修改 ${updatedLabel}`)}` : ''}
        </div>
        {editing ? (
          <>
            <label className="vault-note-field">
              <span>{tr('Tags', '标签')}</span>
              <input
                className="input"
                value={draftTags}
                onChange={event => setDraftTags(event.target.value)}
                placeholder={tr('Comma-separated tags', '逗号分隔的标签')}
              />
            </label>
            <label className="vault-note-field">
              <span>{tr('Body', '正文')}</span>
              <textarea className="input vault-note-editor" value={draftContent} onChange={event => setDraftContent(event.target.value)} />
            </label>
          </>
        ) : null}
        {saveError && <div className="vault-note-state error">{saveError}</div>}
        {detailLoading ? (
          <div className="vault-note-state"><span className="spinner spinner-small" /> {tr('Loading full note', '正在加载完整笔记')}</div>
        ) : detailError ? (
          <div className="vault-note-state error">{detailError}</div>
        ) : editing ? null : (
          <MarkdownView className="vault-note-content" content={noteBodyWithoutDuplicateTitle(selectedNote)} />
        )}
        {!editing && !detailLoading && !detailError && relatedNotes.length > 0 && <section className="vault-related-notes">
          <header><strong>{tr('Related', '相关笔记')}</strong><span>{tr('Obsidian links and backlinks', 'Obsidian 链接与反向链接')}</span></header>
          <div>{relatedNotes.map(item => <button type="button" key={`${item.direction}:${item.note.path}`} onClick={() => void openNote(item.note)}>
            <span><strong>{item.note.title}</strong><small>{item.note.path}</small></span>
            <i>{item.direction === 'outgoing' ? tr('Link', '链接') : tr('Backlink', '反向链接')}</i>
          </button>)}</div>
        </section>}
      </div>
    );
  }

  return (
    <div className="vault-browser">
      <input className="input" placeholder={tr('Search notes...', '搜索笔记...')} value={searchQuery} onChange={event => setSearchQuery(event.target.value)} />
      <div className="vault-folder-tabs">
        {FOLDERS.map(folder => (
          <button key={folder} className={`btn ${selectedFolder === folder ? 'btn-primary' : ''}`} onClick={() => setSelectedFolder(folder)}>
            {tr(folder, folder === 'all' ? '全部' : folder === 'analysis' ? '分析' : folder === 'decision' ? '决策' : folder === 'review' ? '评审' : '任务')}
          </button>
        ))}
        <button className="btn btn-icon" onClick={() => void refresh()} disabled={loading} title={tr('Refresh', '刷新')}><Icon name="refresh" size={14} /></button>
      </div>
      {error && <div className="vault-note-state error">{error}</div>}
      {loading ? (
        <div className="vault-note-state"><span className="spinner spinner-small" /> {tr('Loading notes', '正在加载笔记')}</div>
      ) : !error && mode === 'graph' ? (
        <VaultGraph notes={filteredNotes} onOpenNote={note => void openNote(note)} />
      ) : !error && (
        <div className="vault-note-list">
          {filteredNotes.map((note, index) => {
            const typeColors = TYPE_COLORS[note.type] ?? TYPE_COLORS.analysis;
            const writtenLabel = formatVaultNoteWrittenAt(note);
            return (
              <div key={note.path || `${note.type}-${note.title}-${index}`} className="card vault-note-card">
                <button type="button" className="vault-note-card-open" onClick={() => void openNote(note)}>
                  <span className="vault-note-card-heading"><strong>{note.title}</strong><span className="vault-note-type" style={{ background: typeColors.bg, color: typeColors.color }}>{note.type}</span></span>
                  <span className="vault-note-preview">{note.preview}</span>
                  <time dateTime={note.created_at ?? note.date}>
                    {writtenLabel
                      ? tr(`Written ${writtenLabel}`, `写入 ${writtenLabel}`)
                      : tr('Write time unknown', '写入时间未知')}
                  </time>
                </button>
                <button
                  type="button"
                  className="btn vault-note-card-edit"
                  onClick={() => void openNote(note, true)}
                >
                  <Icon name="edit" size={13} /> {tr('Edit', '编辑')}
                </button>
              </div>
            );
          })}
          {filteredNotes.length === 0 && <div className="vault-note-state">{tr('No notes found.', '未找到笔记。')}</div>}
        </div>
      )}
    </div>
  );
}

export function resolveVaultNote(notes: Note[], target: string): Note | undefined {
  const normalized = normalizeVaultLink(target);
  return notes.find(note => {
    const notePath = normalizeVaultLink(note.path);
    const basename = notePath.split('/').at(-1) ?? notePath;
    return notePath === normalized || normalizeVaultLink(note.title) === normalized || basename === normalized;
  });
}

export function collectRelatedNotes(
  notes: Note[],
  selected: Note,
): Array<{ note: Note; direction: 'outgoing' | 'backlink' }> {
  const selectedPath = normalizeVaultLink(selected.path);
  const result = new Map<string, { note: Note; direction: 'outgoing' | 'backlink' }>();
  for (const target of selected.links ?? []) {
    const note = resolveVaultNote(notes, target);
    if (note && normalizeVaultLink(note.path) !== selectedPath) {
      result.set(note.path, { note, direction: 'outgoing' });
    }
  }
  for (const note of notes) {
    if (normalizeVaultLink(note.path) === selectedPath || result.has(note.path)) continue;
    const linksToSelected = (note.links ?? []).some(target =>
      normalizeVaultLink(resolveVaultNote(notes, target)?.path ?? target) === selectedPath,
    );
    if (linksToSelected) result.set(note.path, { note, direction: 'backlink' });
  }
  return [...result.values()];
}

export function formatVaultNoteWrittenAt(note: Pick<Note, 'created_at' | 'date'>): string | undefined {
  return formatIsoLocal(note.created_at) ?? (note.date && DATE_ONLY.test(note.date) ? note.date : undefined);
}

export function formatVaultNoteUpdatedAt(note: Pick<Note, 'updated_at'>): string | undefined {
  return formatIsoLocal(note.updated_at);
}

export function compareVaultNotesByWrittenAt(left: Pick<Note, 'created_at' | 'date'>, right: Pick<Note, 'created_at' | 'date'>): number {
  return writtenAtSortMs(right) - writtenAtSortMs(left);
}

export function vaultNoteBodyForEdit(note: Note): string {
  const content = note.content ?? note.preview;
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^\r?\n/, '');
}

function formatIsoLocal(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function writtenAtSortMs(note: Pick<Note, 'created_at' | 'date'>): number {
  if (note.created_at) {
    const ms = Date.parse(note.created_at);
    if (!Number.isNaN(ms)) return ms;
  }
  if (note.date && DATE_ONLY.test(note.date)) return Date.parse(`${note.date}T00:00:00.000Z`);
  return 0;
}

function parseTagInput(value: string): string[] {
  return [...new Set(value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeVaultLink(value: string): string {
  return value.trim()
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .split('|', 1)[0]!
    .split('#', 1)[0]!
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '')
    .toLowerCase();
}

function noteBodyWithoutDuplicateTitle(note: Note): string {
  const content = note.content ?? note.preview;
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const heading = /^(?:\s*\r?\n)*#\s+(.+?)\s*\r?\n/.exec(body);
  if (!heading) return content;
  const normalize = (value: string) => value
    .replace(/\.(?:md|markdown)$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replaceAll(/[*_`~]/g, '')
    .trim()
    .toLowerCase();
  return normalize(heading[1] ?? '') === normalize(note.title)
    ? body.slice(heading[0].length)
    : content;
}
