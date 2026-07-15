import { useCallback, useEffect, useState } from 'react';
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

export function VaultBrowser({ mode = 'list' }: { mode?: 'list' | 'graph' }) {
  const { tr } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const { notes, loading, error, refresh } = useVaultNotes();

  useEffect(() => {
    setSelectedNote(null);
    setDetailError(null);
  }, [selectedFolder]);

  const openNote = useCallback(async (note: Note) => {
    setSelectedNote(note);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const detail = await api.vault.get(note.title);
      if (!detail) throw new Error(tr('The note no longer exists.', '这篇笔记已不存在。'));
      setSelectedNote(detail);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : tr('Failed to load note.', '加载笔记失败。'));
    } finally {
      setDetailLoading(false);
    }
  }, [tr]);

  const filteredNotes = notes.filter(note => {
    const query = searchQuery.toLowerCase();
    return (selectedFolder === 'all' || note.folder === selectedFolder) &&
      (!query || note.title.toLowerCase().includes(query) || note.preview.toLowerCase().includes(query));
  });

  if (selectedNote) {
    const typeColors = TYPE_COLORS[selectedNote.type] ?? TYPE_COLORS.analysis;
    return (
      <div className="card vault-note-detail">
        <div className="vault-note-toolbar">
          <button className="btn" onClick={() => setSelectedNote(null)}><Icon name="chevron-left" size={14} /> {tr('Back', '返回')}</button>
        </div>
        <span className="vault-note-type" style={{ background: typeColors.bg, color: typeColors.color }}>{selectedNote.type}</span>
        <h2>{selectedNote.title}</h2>
        <div className="vault-note-date">{selectedNote.date}</div>
        {detailLoading ? (
          <div className="vault-note-state"><span className="spinner spinner-small" /> {tr('Loading full note', '正在加载完整笔记')}</div>
        ) : detailError ? (
          <div className="vault-note-state error">{detailError}</div>
        ) : (
          <MarkdownView className="vault-note-content" content={noteBodyWithoutDuplicateTitle(selectedNote)} />
        )}
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
            return (
              <button key={note.path || `${note.type}-${note.title}-${index}`} className="card vault-note-card" onClick={() => void openNote(note)}>
                <span className="vault-note-card-heading"><strong>{note.title}</strong><span className="vault-note-type" style={{ background: typeColors.bg, color: typeColors.color }}>{note.type}</span></span>
                <span className="vault-note-preview">{note.preview}</span>
                <time>{note.date}</time>
              </button>
            );
          })}
          {filteredNotes.length === 0 && <div className="vault-note-state">{tr('No notes found.', '未找到笔记。')}</div>}
        </div>
      )}
    </div>
  );
}

function noteBodyWithoutDuplicateTitle(note: Note): string {
  const content = note.content ?? note.preview;
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const heading = /^(?:\s*\r?\n)*#\s+(.+?)\s*\r?\n/.exec(body);
  if (!heading) return content;
  const normalize = (value: string) => value
    .replace(/\.(?:md|markdown)$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/[*_`~]/g, '')
    .trim()
    .toLowerCase();
  return normalize(heading[1] ?? '') === normalize(note.title)
    ? body.slice(heading[0].length)
    : content;
}
