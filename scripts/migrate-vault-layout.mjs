/* oxlint-disable no-console */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';

const apply = process.argv.includes('--apply');
const requested = process.argv.slice(2).filter(value => !value.startsWith('--'));
const vaults = requested.length > 0 ? requested : [join(homedir(), '.nori-code', 'vault')];
const legacyFolders = new Map([
  ['analyses', 'analysis'],
  ['decisions', 'decision'],
  ['reviews', 'review'],
  ['tasks', 'task'],
]);

let moved = 0;
let removed = 0;
let rewritten = 0;
const unresolvedLinks = new Set();

for (const vault of vaults) {
  if (!existsSync(vault)) {
    console.warn(`[vault-migrate] skipped missing vault: ${vault}`);
    continue;
  }
  console.log(`[vault-migrate] ${apply ? 'applying' : 'previewing'} ${vault}`);
  for (const canonical of ['analysis', 'decision', 'review', 'task']) {
    if (apply) await mkdir(join(vault, canonical), { recursive: true });
  }
  for (const [legacy, canonical] of legacyFolders) {
    await mergeLegacyFolder(vault, legacy, canonical);
  }
  await rewriteLinks(vault);
}

console.log(`[vault-migrate] ${apply ? 'changed' : 'would change'}: ${moved} moved, ${rewritten} rewritten, ${removed} empty legacy folders removed`);
if (unresolvedLinks.size > 0) console.warn(`[vault-migrate] unresolved links moved under unresolved/: ${[...unresolvedLinks].join(', ')}`);

async function mergeLegacyFolder(vault, legacy, canonical) {
  const source = join(vault, legacy);
  if (!existsSync(source)) return;
  const files = await markdownFiles(source);
  for (const file of files) {
    const suffix = relative(source, file);
    const preferred = join(vault, canonical, suffix);
    const destination = await availableDestination(file, preferred);
    console.log(`  move ${relative(vault, file)} -> ${relative(vault, destination)}`);
    moved += 1;
    if (!apply) continue;
    await mkdir(dirname(destination), { recursive: true });
    if (destination === preferred && existsSync(preferred) && await sameContent(file, preferred)) {
      await rm(file);
    } else {
      await rename(file, destination);
    }
  }
  if (apply) await removeEmptyTree(source);
  if (!existsSync(source) || await directoryIsEmpty(source)) {
    console.log(`  remove empty ${legacy}/`);
    removed += 1;
    if (apply && existsSync(source)) await rm(source, { recursive: true });
  }
}

async function availableDestination(source, preferred) {
  if (!existsSync(preferred) || await sameContent(source, preferred)) return preferred;
  const extension = extname(preferred);
  const stem = preferred.slice(0, -extension.length);
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-legacy-${String(suffix)}${extension}`;
    if (!existsSync(candidate)) return candidate;
  }
}

async function sameContent(left, right) {
  return await readFile(left, 'utf8') === await readFile(right, 'utf8');
}

async function removeEmptyTree(root) {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyTree(join(root, entry.name));
  }
  if (await directoryIsEmpty(root)) await rm(root, { recursive: true });
}

async function directoryIsEmpty(path) {
  if (!existsSync(path)) return true;
  return (await readdir(path)).length === 0;
}

async function rewriteLinks(vault) {
  const files = (await Promise.all(
    ['analysis', 'decision', 'review', 'task'].map(folder => markdownFiles(join(vault, folder))),
  )).flat();
  const index = new Map();
  for (const file of files.toSorted()) {
    const content = await readFile(file, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const title = frontmatter.title
      ? frontmatter.title
      : basename(file, extname(file));
    const target = relative(vault, file).replaceAll('\\', '/').replace(/\.md$/i, '');
    for (const key of [title, target, basename(target)]) {
      const normalized = normalizeTarget(key);
      if (!index.has(normalized)) index.set(normalized, { target, title });
    }
  }

  for (const file of files) {
    const original = await readFile(file, 'utf8');
    const parsed = parseFrontmatter(original);
    const legacyRelated = [...parsed.related, ...parsed.links];
    if (legacyRelated.length === 0 && !/\[\[[^\]]+\]\]/.test(parsed.body)) continue;
    const canonicalRelated = [...new Set(legacyRelated.map(value => canonicalLink(value, index)).filter(Boolean))];
    let body = parsed.body.replaceAll(/\[\[([^\]]+)\]\]/g, (_whole, value) => canonicalLink(value, index) || `[[${value}]]`);
    const bodyTargets = new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(match => normalizeTarget(match[1] ?? '')));
    const missing = canonicalRelated.filter(link => !bodyTargets.has(normalizeTarget(link)));
    if (missing.length > 0) {
      body = `${body.trimEnd()}\n\n## Related\n${missing.map(link => `- ${link}`).join('\n')}\n`;
    }
    const next = parsed.hasFrontmatter
      ? `---\n${updateRelatedFrontmatter(parsed.frontmatter, canonicalRelated)}\n---\n${body.replace(/^\n+/, '')}`
      : body;
    if (next === original) continue;
    console.log(`  rewrite ${relative(vault, file)}`);
    rewritten += 1;
    if (apply) await writeFile(file, next, 'utf8');
  }
}

function parseFrontmatter(content) {
  const normalized = content.replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { title: '', related: [], links: [], frontmatter: '', body: normalized, hasFrontmatter: false };
  const frontmatter = match[1] ?? '';
  const titleMatch = /^title:\s*(.+?)\s*$/m.exec(frontmatter);
  return {
    title: titleMatch ? unquote(titleMatch[1] ?? '') : '',
    related: frontmatterList(frontmatter, 'related'),
    links: frontmatterList(frontmatter, 'links'),
    frontmatter,
    body: match[2] ?? '',
    hasFrontmatter: true,
  };
}

function frontmatterList(frontmatter, key) {
  const lines = frontmatter.split('\n');
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[index] ?? '');
    if (!match) continue;
    const inline = (match[1] ?? '').trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      result.push(...inline.slice(1, -1).split(',').map(unquote).filter(Boolean));
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = /^\s+-\s+(.+?)\s*$/.exec(lines[cursor] ?? '');
      if (!item) break;
      const value = unquote(item[1] ?? '');
      if (value) result.push(value);
    }
  }
  return result;
}

function updateRelatedFrontmatter(frontmatter, related) {
  const lines = frontmatter.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:links|related):(?:\s|$)/.test(lines[index] ?? '')) {
      kept.push(lines[index]);
      continue;
    }
    while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1] ?? '')) index += 1;
  }
  while (kept.at(-1) === '') kept.pop();
  if (related.length > 0) {
    kept.push('related:', ...related.map(link => `  - ${JSON.stringify(link)}`));
  }
  return kept.join('\n');
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch {}
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function canonicalLink(value, index) {
  const parsed = parseLink(value);
  const resolved = index.get(normalizeTarget(parsed.target));
  if (resolved) return `[[${resolved.target}|${sanitizeAlias(parsed.alias || resolved.title)}]]`;
  const target = canonicalizeFolder(parsed.target.replace(/\.md$/i, '').replaceAll('\\', '/'));
  if (target.includes('/')) return `[[${target}${parsed.alias ? `|${sanitizeAlias(parsed.alias)}` : ''}]]`;
  if (target) unresolvedLinks.add(target);
  const unresolvedTarget = target.replaceAll(/[<>:"\\|?*]/g, '-').trim();
  return unresolvedTarget ? `[[unresolved/${unresolvedTarget}|${sanitizeAlias(parsed.alias || target)}]]` : '';
}

function parseLink(value) {
  const unwrapped = String(value).trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
  const [target = '', alias = ''] = unwrapped.split('|', 2);
  return { target: target.split('#', 1)[0].trim(), alias: alias.trim() };
}

function normalizeTarget(value) {
  return canonicalizeFolder(parseLink(value).target)
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '')
    .toLowerCase();
}

function canonicalizeFolder(value) {
  const normalized = value.replaceAll('\\', '/');
  const [first, ...rest] = normalized.split('/');
  return [legacyFolders.get(first) ?? first, ...rest].join('/');
}

function sanitizeAlias(value) {
  return value.replaceAll(/[|\]]/g, '').trim();
}

async function markdownFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(path);
    }
  }
  return result;
}
