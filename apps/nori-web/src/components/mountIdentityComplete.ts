/**
 * Fill mount role / mandate / title from a short user prompt (local heuristic only).
 */

export interface MountIdentityDraft {
  title: string;
  role: string;
  mandate: string;
}

const KEYED = /(?:^|\n)\s*(title|name|角色名|名称|role|角色|mandate|职责|说明)\s*[:：]\s*(.+)$/gim;

/**
 * Parse a free-form hire prompt into mount identity fields.
 * Supports keyed lines (`role: …`) and prose like 「作为 reviewer，负责审查 PR」.
 */
export function completeMountIdentityFromPrompt(prompt: string): MountIdentityDraft {
  const text = prompt.trim();
  if (text.length === 0) {
    return { title: '', role: '', mandate: '' };
  }

  const keyed: Partial<Record<string, string>> = {};
  for (const match of text.matchAll(KEYED)) {
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (value.length === 0) continue;
    if (key === 'title' || key === 'name' || key === '角色名' || key === '名称') keyed.title = value;
    else if (key === 'role' || key === '角色') keyed.role = value;
    else if (key === 'mandate' || key === '职责' || key === '说明') keyed.mandate = value;
  }

  let title = keyed.title ?? '';
  let role = keyed.role ?? '';
  let mandate = keyed.mandate ?? '';

  if (role.length === 0 || mandate.length === 0) {
    const asMatch = text.match(
      /(?:作为|當作|as(?:\s+an?)?)\s+([^\n,，。；;]{1,80})/i,
    );
    if (asMatch?.[1] && role.length === 0) {
      role = asMatch[1].trim();
    }
    const dutyMatch = text.match(
      /(?:负责|負責|mandate|owns?|to)\s*[:：]?\s*([^\n]{1,400})/i,
    );
    if (dutyMatch?.[1] && mandate.length === 0) {
      mandate = dutyMatch[1].trim().replace(/[.。]+$/, '');
    }
  }

  if (title.length === 0) {
    const named = text.match(
      /(?:名叫|名为|名為|named|name(?:d)?)\s+["「]?([A-Za-z0-9_\-\u4e00-\u9fff]{1,60})["」]?/i,
    );
    if (named?.[1]) title = named[1];
  }

  if (role.length === 0) {
    const firstLine = text.split(/\n/)[0]?.trim() ?? text;
    role = firstLine.slice(0, 80);
  }
  if (mandate.length === 0) {
    mandate = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  if (title.length === 0) {
    title = role.split(/[,，\s]/)[0]?.slice(0, 40) || 'member';
  }

  return { title, role, mandate };
}

/**
 * Extract `{"title","role","mandate"}` from a parent-agent reply.
 * Tolerates markdown fences and leading/trailing prose.
 */
export function parseMountIdentityJson(text: string): MountIdentityDraft | null {
  const raw = text.trim();
  if (raw.length === 0) return null;

  const candidates: string[] = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const braced = raw.match(/\{[\s\S]*\}/);
  if (braced?.[0]) candidates.unshift(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title.trim() : '';
      const role = typeof record.role === 'string' ? record.role.trim() : '';
      const mandate = typeof record.mandate === 'string' ? record.mandate.trim() : '';
      if (title.length === 0 && role.length === 0 && mandate.length === 0) continue;
      return { title, role, mandate };
    } catch {
      // try next candidate
    }
  }
  return null;
}
