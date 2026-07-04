import { useState, useCallback } from 'react';
import { useVaultNotes } from '../hooks/useApi';
import type { Note } from '../api/client';

const TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  analysis: { bg: 'color-mix(in srgb, var(--nori-cyan) 15%, transparent)', color: 'var(--nori-cyan)' },
  decision: { bg: 'color-mix(in srgb, var(--nori-purple) 15%, transparent)', color: 'var(--nori-purple)' },
  task:     { bg: 'color-mix(in srgb, var(--nori-warning) 15%, transparent)', color: 'var(--nori-warning)' },
  review:   { bg: 'color-mix(in srgb, var(--nori-success) 15%, transparent)', color: 'var(--nori-success)' },
};

const FOLDERS = ['all', 'analysis', 'decision', 'review', 'task'] as const;

export function VaultBrowser() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);

  const { notes, loading, error, refresh } = useVaultNotes(
    selectedFolder !== 'all' ? selectedFolder : undefined,
  );

  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const filteredNotes = notes.filter(note => {
    const matchFolder = selectedFolder === 'all' || note.folder === selectedFolder;
    const matchSearch = !searchQuery ||
      note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      note.preview.toLowerCase().includes(searchQuery.toLowerCase());
    return matchFolder && matchSearch;
  });

  if (selectedNote) {
    const typeColors = TYPE_COLORS[selectedNote.type] || TYPE_COLORS.analysis;
    return (
      <div className="card" style={{ height: '100%' }}>
        <div style={{ marginBottom: '16px' }}>
          <button className="btn" onClick={() => setSelectedNote(null)}>← Back</button>
        </div>
        <div style={{ marginBottom: '8px' }}>
          <span style={{
            fontSize: '11px',
            padding: '2px 8px',
            borderRadius: '4px',
            background: typeColors.bg,
            color: typeColors.color,
            fontWeight: 600,
            textTransform: 'uppercase',
          }}>
            {selectedNote.type}
          </span>
        </div>
        <h2 style={{ fontSize: '18px', marginBottom: '4px' }}>{selectedNote.title}</h2>
        <div style={{ color: 'var(--nori-text-muted)', fontSize: '12px', marginBottom: '16px' }}>{selectedNote.date}</div>
        <div style={{
          background: 'var(--nori-bg)',
          border: '1px solid var(--nori-border)',
          borderRadius: '8px',
          padding: '16px',
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace',
          fontSize: '13px',
          lineHeight: '1.7',
        }}>
          {selectedNote.content || selectedNote.preview}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      {/* Search */}
      <input
        className="input"
        placeholder="Search notes..."
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
      />

      {/* Folder tabs */}
      <div style={{ display: 'flex', gap: '4px' }}>
        {FOLDERS.map(f => (
          <button
            key={f}
            className={`btn ${selectedFolder === f ? 'btn-primary' : ''}`}
            style={{ fontSize: '12px', padding: '4px 12px' }}
            onClick={() => setSelectedFolder(f)}
          >
            {f}
          </button>
        ))}
        <button
          className="btn"
          style={{ fontSize: '12px', padding: '4px 12px', marginLeft: 'auto' }}
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? '⏳' : '↻'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px',
          borderRadius: '6px',
          background: 'color-mix(in srgb, var(--nori-danger) 15%, transparent)',
          border: '1px solid var(--nori-danger)',
          color: 'var(--nori-danger)',
          fontSize: '13px',
        }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--nori-text-muted)', padding: '32px', fontSize: '13px' }}>
          Loading notes...
        </div>
      )}

      {/* Notes list */}
      {!loading && !error && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {filteredNotes.map((note, i) => {
            const typeColors = TYPE_COLORS[note.type] || TYPE_COLORS.analysis;
            return (
              <div
                key={note.path || `${note.type}-${note.title}-${i}`}
                className="card"
                style={{
                  marginBottom: '8px',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onClick={() => setSelectedNote(note)}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--nori-cyan)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--nori-border)')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontWeight: 600, fontSize: '14px' }}>{note.title}</span>
                  <span style={{
                    fontSize: '10px',
                    padding: '1px 6px',
                    borderRadius: '3px',
                    background: typeColors.bg,
                    color: typeColors.color,
                    textTransform: 'uppercase',
                  }}>
                    {note.type}
                  </span>
                </div>
                <div style={{ color: 'var(--nori-text-muted)', fontSize: '12px' }}>{note.preview}</div>
                <div style={{ color: 'var(--nori-text-muted)', fontSize: '11px', marginTop: '6px', opacity: 0.6 }}>{note.date}</div>
              </div>
            );
          })}
          {filteredNotes.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--nori-text-muted)', padding: '32px' }}>
              No notes found.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
