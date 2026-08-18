/**
 * Vault API routes — browse and search the Obsidian shared memory vault.
 * Reads markdown files directly from the filesystem.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ErrorCode } from '@nori-code/protocol';
import {
  compareMemoryNotesByWrittenAtDesc,
  nowUtcIso,
  resolveMemoryNoteTimestamps,
  timestampsConflict,
  utcDateOnly,
} from '@nori-code/agent-core/tools/builtin/nori/memory-note-meta';
import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { IInstantiationService } from '@nori-code/agent-core';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: Record<string, unknown>; params: Record<string, unknown> },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  patch(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: {
        id: string;
        query: Record<string, unknown>;
        params: Record<string, unknown>;
        body: unknown;
      },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const noteSchema = z.object({
  title: z.string(),
  type: z.enum(['analysis', 'decision', 'task', 'review']),
  folder: z.string(),
  preview: z.string(),
  date: z.string(),
  path: z.string(),
  links: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  /** Stable content version used to detect edits made outside Nori Work. */
  content_hash: z.string().optional(),
});

const noteDetailSchema = noteSchema.extend({
  content: z.string(),
});

const notesListSchema = z.array(noteSchema);

const searchQuerySchema = z.object({
  q: z.string().optional(),
  types: z.string().optional(),
});

const listQuerySchema = z.object({
  type: z.string().optional(),
});

const noteIdParamsSchema = z.object({
  note_id: z.string(),
});

const updateNoteBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  expected_updated_at: z.string().optional(),
  expected_content_hash: z.string().trim().min(1).optional(),
}).refine(
  (value) => value.title !== undefined || value.content !== undefined || value.tags !== undefined,
  { message: 'At least one of title, content, or tags is required' },
);

export type NoteEntry = z.infer<typeof noteSchema>;

export type VaultNoteUpdateResult =
  | { status: 'updated'; note: NoteEntry & { content: string } }
  | { status: 'missing' }
  | { status: 'conflict'; current: NoteEntry }
  | { status: 'io'; message: string };

/** Resolve the vault path from project root or NORI_CODE_HOME. */
function resolveVaultPath(): string {
  const home = process.env['NORI_CODE_HOME'] ?? join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.', '.nori-code');
  // Try project-relative first, then home
  const candidates = [
    join(process.cwd(), 'nori-vault'),
    join(home, 'vault'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!; // fallback — array is always non-empty
}

/** Folders that map to note types. */
const FOLDER_TO_TYPE: Record<string, NoteEntry['type']> = {
  analysis: 'analysis',
  analyses: 'analysis',
  decision: 'decision',
  decisions: 'decision',
  review: 'review',
  reviews: 'review',
  task: 'task',
  tasks: 'task',
};

const VAULT_NOTE_FOLDERS = Object.keys(FOLDER_TO_TYPE);

export function scanVault(vaultPath: string): NoteEntry[] {
  const notes: NoteEntry[] = [];

  for (const folder of VAULT_NOTE_FOLDERS) {
    const folderPath = join(vaultPath, folder);
    if (!existsSync(folderPath)) continue;

    for (const filePath of markdownFiles(folderPath)) {
      const note = readNoteEntry(vaultPath, folder, filePath);
      if (note) notes.push(note);
    }
  }

  notes.sort(compareMemoryNotesByWrittenAtDesc);
  return notes;
}

function readNoteEntry(vaultPath: string, folder: string, filePath: string): NoteEntry | undefined {
  const entry = basename(filePath);
  let content: string;
  try { content = readFileSync(filePath, 'utf-8'); } catch { return undefined; }

  let fileMtimeIso: string | undefined;
  try { fileMtimeIso = statSync(filePath).mtime.toISOString(); } catch { fileMtimeIso = undefined; }

  const frontmatter = parseFrontmatter(content);
  const timestamps = resolveMemoryNoteTimestamps(frontmatter, { fileMtimeIso });
  const rawTitle = basename(entry, '.md');
  const filenameTitle = rawTitle.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const title = typeof frontmatter['title'] === 'string' && frontmatter['title'].trim() !== ''
    ? frontmatter['title'].trim()
    : filenameTitle;
  const links = relatedLinks(frontmatter, content);
  const tags = stringList(frontmatter['tags']);
  const noteType = FOLDER_TO_TYPE[folder] ?? 'analysis';
  const notePath = relative(vaultPath, filePath).replaceAll('\\', '/');

  return {
    title,
    type: noteType,
    folder: noteType,
    preview: notePreview(content),
    date: timestamps.date ?? '',
    path: notePath,
    links,
    tags,
    created_at: timestamps.created_at,
    updated_at: timestamps.updated_at,
    content_hash: noteContentHash(content),
  };
}

export function updateVaultNote(
  vaultPath: string,
  noteId: string,
  patch: {
    title?: string;
    content?: string;
    tags?: string[];
    expected_updated_at?: string;
    expected_content_hash?: string;
  },
  now: Date = new Date(),
): VaultNoteUpdateResult {
  const notes = scanVault(vaultPath);
  const current = findNote(notes, noteId);
  if (!current) return { status: 'missing' };
  if (
    contentHashesConflict(patch.expected_content_hash, current.content_hash)
    || (patch.expected_content_hash === undefined && timestampsConflict(patch.expected_updated_at, current.updated_at))
  ) {
    return { status: 'conflict', current };
  }

  const absolute = join(vaultPath, current.path);
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf-8');
  } catch (error) {
    return { status: 'io', message: error instanceof Error ? error.message : String(error) };
  }

  const { fields, body } = splitFrontmatter(raw);
  const timestamps = resolveMemoryNoteTimestamps(fields, {
    fileMtimeIso: current.updated_at,
  });
  const writtenAt = nowUtcIso(now);
  const createdAt = timestamps.created_at ?? writtenAt;
  const nextTitle = patch.title?.trim() || current.title;
  const nextTags = patch.tags ?? stringList(fields['tags']);
  const nextBody = patch.content === undefined ? body : stripFrontmatter(patch.content);

  const nextFields: Record<string, unknown> = { ...fields };
  nextFields['title'] = nextTitle;
  nextFields['type'] = typeof fields['type'] === 'string' ? fields['type'] : current.type;
  nextFields['date'] = timestamps.date ?? utcDateOnly(createdAt);
  nextFields['created_at'] = createdAt;
  nextFields['updated_at'] = writtenAt;
  if (nextTags.length > 0) nextFields['tags'] = nextTags;
  else delete nextFields['tags'];

  const serialized = stringifyYaml(nextFields, { lineWidth: 0 }).trimEnd();
  try {
    writeFileSync(absolute, `---\n${serialized}\n---\n\n${nextBody.trimEnd()}\n`, 'utf-8');
  } catch (error) {
    return { status: 'io', message: error instanceof Error ? error.message : String(error) };
  }

  const updated = readNoteEntry(vaultPath, current.folder, absolute);
  if (!updated) return { status: 'io', message: 'Note was written but could not be re-read' };
  let content = '';
  try { content = readFileSync(absolute, 'utf-8'); } catch { content = ''; }
  return { status: 'updated', note: { ...updated, content } };
}

function noteContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function contentHashesConflict(expected: string | undefined, current: string | undefined): boolean {
  if (expected === undefined || expected.trim() === '') return false;
  return current === undefined || expected !== current;
}

function markdownFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: Dirent[];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(entryPath);
    }
  }
  return result;
}

function relatedLinks(frontmatter: Record<string, unknown>, content: string): string[] {
  const candidates = [frontmatter['related'], frontmatter['links']]
    .flatMap(value => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === 'string');
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    if (match[1]) candidates.push(match[1]);
  }
  return [...new Set(candidates.map(normalizeLinkTarget).filter(Boolean))];
}

function normalizeLinkTarget(value: string): string {
  const unwrapped = value.trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
  return (unwrapped.split('|', 1)[0] ?? '')
    .split('#', 1)[0]!
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '');
}

function parseFrontmatter(content: string): Record<string, unknown> {
  return splitFrontmatter(content).fields;
}

function splitFrontmatter(content: string): { fields: Record<string, unknown>; body: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match?.[1]) return { fields: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    const fields = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    return { fields, body: content.slice(match[0].length) };
  } catch {
    return { fields: {}, body: content };
  }
}

function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function notePreview(content: string): string {
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('- [')) continue;
    return trimmed.slice(0, 200);
  }
  return '(empty)';
}

function searchNotes(notes: NoteEntry[], query: string, types?: string[]): NoteEntry[] {
  const q = query.toLowerCase();
  return notes.filter(n => {
    if (types && types.length > 0 && !types.includes(n.type)) return false;
    if (!q) return true;
    return n.title.toLowerCase().includes(q)
      || n.preview.toLowerCase().includes(q)
      || n.tags.some(tag => tag.toLowerCase().includes(q));
  });
}

function findNote(notes: NoteEntry[], noteId: string): NoteEntry | null {
  let decoded = noteId;
  try { decoded = decodeURIComponent(noteId); } catch { /* invalid URI sequence, use raw value */ }
  const normalized = normalizeLinkTarget(decoded).toLowerCase();
  return notes.find(n => {
    const notePath = n.path.replace(/\.md$/i, '').toLowerCase();
    return n.title.toLowerCase() === normalized || notePath === normalized || basename(notePath) === normalized;
  }) ?? null;
}

export function registerVaultRoutes(app: RouteHost, _ix: IInstantiationService): void {
  const vaultPath = resolveVaultPath();

  // GET /vault/search?q=keywords&types=analysis,decision
  const searchRoute = defineRoute(
    {
      method: 'GET',
      path: '/vault/search',
      querystring: searchQuerySchema,
      success: { data: notesListSchema },
      description: 'Search the Obsidian vault for notes matching keywords',
      tags: ['vault'],
    },
    async (req, reply) => {
      const q = req.query['q'] ?? '';
      const typesStr = req.query['types'] ?? '';
      const types = typesStr ? typesStr.split(',').filter(Boolean) : undefined;
      const results = searchNotes(scanVault(vaultPath), q, types);
      reply.send(okEnvelope(results, req.id));
    },
  );
  app.get(searchRoute.path, searchRoute.options, searchRoute.handler as Parameters<RouteHost['get']>[2]);

  // GET /vault/notes?type=analysis
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/vault/notes',
      querystring: listQuerySchema,
      success: { data: notesListSchema },
      description: 'List all notes in the vault, optionally filtered by type',
      tags: ['vault'],
    },
    async (req, reply) => {
      const typeFilter = req.query['type'] ?? '';
      const allNotes = scanVault(vaultPath);
      const results = typeFilter
        ? allNotes.filter(n => n.type === typeFilter || n.folder === typeFilter)
        : allNotes;
      reply.send(okEnvelope(results, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<RouteHost['get']>[2]);

  // GET /vault/notes/{note_id}
  const noteRoute = defineRoute(
    {
      method: 'GET',
      path: '/vault/notes/{note_id}',
      params: noteIdParamsSchema,
      success: { data: noteDetailSchema.nullable() },
      description: 'Get a single note by encoded title',
      tags: ['vault'],
    },
    async (req, reply) => {
      const noteId = req.params['note_id'];
      const note = findNote(scanVault(vaultPath), noteId);
      if (!note) {
        reply.send(okEnvelope(null, req.id));
        return;
      }
      let content = '';
      try { content = readFileSync(join(vaultPath, note.path), 'utf-8'); } catch { /* file missing/deleted */ }
      reply.send(okEnvelope({ ...note, content }, req.id));
    },
  );
  app.get(noteRoute.path, noteRoute.options, noteRoute.handler as Parameters<RouteHost['get']>[2]);

  const updateRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/vault/notes/{note_id}',
      params: noteIdParamsSchema,
      body: updateNoteBodySchema,
      success: { data: noteDetailSchema },
      errors: {
        [ErrorCode.VAULT_NOTE_NOT_FOUND]: {},
        [ErrorCode.VAULT_NOTE_CONFLICT]: { dataSchema: noteSchema },
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description: 'Update title, body, or tags of a vault note in place',
      tags: ['vault'],
    },
    async (req, reply) => {
      const result = updateVaultNote(vaultPath, req.params['note_id'], req.body);
      if (result.status === 'missing') {
        reply.send(errEnvelope(ErrorCode.VAULT_NOTE_NOT_FOUND, 'Note not found.', req.id));
        return;
      }
      if (result.status === 'conflict') {
        reply.send({
          ...errEnvelope(
            ErrorCode.VAULT_NOTE_CONFLICT,
            'This note was modified after you opened it. Refresh and try again.',
            req.id,
          ),
          data: result.current,
        });
        return;
      }
      if (result.status === 'io') {
        reply.send(errEnvelope(ErrorCode.PERSISTENCE_FAILURE, result.message, req.id));
        return;
      }
      reply.send(okEnvelope(result.note, req.id));
    },
  );
  app.patch(updateRoute.path, updateRoute.options, updateRoute.handler as Parameters<RouteHost['patch']>[2]);
}
