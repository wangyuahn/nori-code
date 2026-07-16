/**
 * Vault API routes — browse and search the Obsidian shared memory vault.
 * Reads markdown files directly from the filesystem.
 */

import { readFileSync, readdirSync, existsSync, statSync, type Dirent } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { okEnvelope } from '../envelope';
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
}

const noteSchema = z.object({
  title: z.string(),
  type: z.enum(['analysis', 'decision', 'task', 'review']),
  folder: z.string(),
  preview: z.string(),
  date: z.string(),
  path: z.string(),
  links: z.array(z.string()).default([]),
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

export type NoteEntry = z.infer<typeof noteSchema>;

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
      const entry = basename(filePath);
      let content: string;
      try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

      // Get file modification time
      let mtime = '';
      try {
        mtime = statSync(filePath).mtime.toISOString().slice(0, 10);
      } catch { mtime = ''; }

      const frontmatter = parseFrontmatter(content);
      // Prefer the canonical memory title because wiki-links target it. Fall
      // back to the filename for legacy notes without frontmatter.
      const rawTitle = basename(entry, '.md');
      const filenameTitle = rawTitle.replace(/^\d{4}-\d{2}-\d{2}-/, '');
      const title = typeof frontmatter['title'] === 'string' && frontmatter['title'].trim() !== ''
        ? frontmatter['title'].trim()
        : filenameTitle;
      const links = relatedLinks(frontmatter, content);

      // Preview: first non-empty, non-heading line, skipping YAML frontmatter
      const lines = content.split('\n');
      let inFrontmatter = false;
      let preview = '';
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip YAML frontmatter delimiters and their content
        if (trimmed === '---') {
          inFrontmatter = !inFrontmatter;
          continue;
        }
        if (inFrontmatter) continue;
        if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('- [')) continue;
        preview = trimmed.slice(0, 200);
        break;
      }
      if (!preview) preview = '(empty)';

      const noteType = FOLDER_TO_TYPE[folder] ?? 'analysis';
      const notePath = relative(vaultPath, filePath).replaceAll('\\', '/');

      notes.push({
        title,
        type: noteType,
        folder: noteType,
        preview,
        date: mtime,
        path: notePath,
        links,
      });
    }
  }

  // Sort by date descending
  notes.sort((a, b) => b.date.localeCompare(a.date));
  return notes;
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
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match?.[1]) return {};
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function searchNotes(notes: NoteEntry[], query: string, types?: string[]): NoteEntry[] {
  const q = query.toLowerCase();
  return notes.filter(n => {
    if (types && types.length > 0 && !types.includes(n.type)) return false;
    if (!q) return true;
    return n.title.toLowerCase().includes(q) || n.preview.toLowerCase().includes(q);
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
      // Read full content — if the file was deleted since boot, return empty content
      let content = '';
      try { content = readFileSync(join(vaultPath, note.path), 'utf-8'); } catch { /* file missing/deleted */ }
      reply.send(okEnvelope({ ...note, content }, req.id));
    },
  );
  app.get(noteRoute.path, noteRoute.options, noteRoute.handler as Parameters<RouteHost['get']>[2]);
}
