/**
 * Summary-style renderers — produce optional inline-glance content for
 * tools whose raw output is high-volume but low-information (Grep,
 * Glob). The numeric summary (line counts, exit codes, sizes) lives in
 * the header chip (see chip.ts), so most tools intentionally render an
 * empty body and only expose details when the global expand toggle is
 * on.
 *
 * Errors always fall through to the truncated renderer so the user
 * sees the actual error message, not a synthetic summary.
 */

import type { Component } from '@nori-code/pi-tui';
import { Text } from '@nori-code/pi-tui';

import { currentTheme } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

const GLANCE_SAMPLES = 3;

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => string;

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    if (result.is_error) return renderTruncated(toolCall, result, ctx);
    const safeResult = { ...result, output: sanitizeShellOutput(result.output) };

    const out: Component[] = [];
    if (glance !== null) {
      const line = glance(toolCall, safeResult);
      if (line.length > 0) {
        out.push(new Text(`  ${currentTheme.dim(line)}`, 0, 0));
      }
    }
    if (ctx.expanded && safeResult.output.length > 0) {
      out.push(new Text(currentTheme.dim(safeResult.output), 4, 0));
    }
    return out;
  };
}

function nonEmptyLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n').filter((line) => line.length > 0);
}

// Strip a trailing `:line:col:text` so the glance shows the file path
// only, even when grep is in `content` mode (`src/foo.ts:42:    foo()`).
function pathFromGrepLine(line: string): string {
  const idx = line.indexOf(':');
  if (idx <= 0) return line;
  const second = line.indexOf(':', idx + 1);
  if (second <= 0) return line;
  return line.slice(0, second);
}

const grepGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';
  const samples = lines.slice(0, GLANCE_SAMPLES).map(pathFromGrepLine);
  const remaining = lines.length - samples.length;
  const tail = remaining > 0 ? `, +${String(remaining)} more` : '';
  return `${samples.join(', ')}${tail}`;
};

const globGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';
  const samples = lines.slice(0, GLANCE_SAMPLES);
  const remaining = lines.length - samples.length;
  const tail = remaining > 0 ? `, +${String(remaining)} more` : '';
  return `${samples.join(', ')}${tail}`;
};

function recordNames(value: unknown, nameKey: string, extraKey?: string): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record[nameKey] === 'string' ? record[nameKey] : undefined;
    if (name === undefined || name.length === 0) continue;
    const extra = extraKey !== undefined && typeof record[extraKey] === 'string' ? record[extraKey] : undefined;
    names.push(extra !== undefined && extra.length > 0 ? `${name} (${extra})` : name);
  }
  return names;
}

const teamGlance: GlanceFn = (toolCall, _result) => {
  const args = toolCall.args;
  switch (toolCall.name) {
    case 'TeamCreate': {
      const names = recordNames(args['members'], 'name', 'role');
      return names.length === 0 ? 'Hired partners' : `Hired ${names.join(', ')}`;
    }
    case 'TeamAssign': {
      const assignments = Array.isArray(args['assignments']) ? args['assignments'] : [];
      const parts: string[] = [];
      for (const item of assignments) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        const id = typeof record['agent_id'] === 'string' ? record['agent_id'] : undefined;
        if (id === undefined) continue;
        const task = typeof record['task'] === 'string' && record['task'].length > 0 ? record['task'] : 'cleared';
        parts.push(`${id}: ${task}`);
      }
      return parts.length === 0 ? 'Updated assignments' : parts.join('; ');
    }
    case 'TeamDismiss': {
      const ids = Array.isArray(args['agent_ids'])
        ? args['agent_ids'].filter((value): value is string => typeof value === 'string')
        : [];
      return ids.length === 0 ? 'Dismissed partners' : `Dismissed ${ids.join(', ')}`;
    }
    case 'TeamDM':
    case 'TeamBroadcast':
    case 'TeamSpeak': {
      const message = typeof args['message'] === 'string' ? args['message'] : '';
      const trimmed = message.trim();
      if (trimmed.length === 0) return 'Sent a team message';
      return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
    }
    case 'TeamDecide': {
      const action = typeof args['action'] === 'string' ? args['action'] : 'decide';
      const topic = typeof args['topic'] === 'string' ? args['topic'] : '';
      return topic.length > 0 ? `${action}: ${topic}` : action;
    }
    case 'TeamStatus':
      return 'Checked team status';
    case 'TeamChat': {
      const message = typeof args['message'] === 'string' ? args['message'] : '';
      const trimmed = message.trim();
      return trimmed.length === 0 ? 'Department chat' : trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
    }
    case 'TeamDiscussInvite':
      return 'Invited a partner to Discuss';
    case 'TeamDiscussKick':
      return 'Removed a partner from Discuss';
    default:
      return '';
  }
};

// ── Exports ──────────────────────────────────────────────────────────

// Tools whose chip already conveys everything — the body is empty in
// the collapsed state and only the raw output appears when expanded.
export const readSummary: ResultRenderer = withGlance(null);
export const fetchSummary: ResultRenderer = withGlance(null);
export const webSearchSummary: ResultRenderer = withGlance(null);
export const thinkSummary: ResultRenderer = withGlance(null);
export const editSummary: ResultRenderer = withGlance(null);
export const writeSummary: ResultRenderer = withGlance(null);

// Tools that benefit from inline path samples below the chip.
export const grepSummary: ResultRenderer = withGlance(grepGlance);
export const globSummary: ResultRenderer = withGlance(globGlance);
export const teamSummary: ResultRenderer = withGlance(teamGlance);
