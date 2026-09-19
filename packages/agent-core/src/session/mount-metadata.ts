/** Shared mount-tree metadata keys and readers (map + TeamCreate). */

export const PARENT_SESSION_ID_KEY = 'parent_session_id';
export const CHILD_SESSION_KIND_KEY = 'child_session_kind';
export const CHILD_SESSION_KIND = 'child';
export const MOUNT_ROLE_KEY = 'mount_role';
export const MOUNT_MANDATE_KEY = 'mount_mandate';
export const MOUNT_NAME_KEY = 'mount_name';
export const SESSION_TAGS_KEY = 'session_tags';
export const DEPARTMENT_MEMBERS_KEY = 'department_members';
export const DEPARTMENT_ASSIGNED_TASK_KEY = 'department_assigned_task';
export const DEPARTMENT_ASSIGNED_AT_KEY = 'department_assigned_at';
export const DEPARTMENT_TEAM_REPORT_KEY = 'department_team_report';
export const DEPARTMENT_LAST_TURN_SKIP_KEY = 'department_last_turn_skip';

export const DEFAULT_MOUNT_MEMBER_ROLE = 'member';
export const DEFAULT_MOUNT_MEMBER_MANDATE = 'Member mounted on the conversation map.';

export function readParentSessionId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const value = metadata?.[PARENT_SESSION_ID_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readMountRole(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.[MOUNT_ROLE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readMountMandate(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const value = metadata?.[MOUNT_MANDATE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readMountName(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.[MOUNT_NAME_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readSessionTags(
  metadata: Record<string, unknown> | undefined,
): readonly string[] | undefined {
  const value = metadata?.[SESSION_TAGS_KEY];
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return tags.length > 0 ? tags : undefined;
}

export function normalizeOptionalMountString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function wouldCreateMountCycle(
  sessionId: string,
  parentSessionId: string,
  parentById: ReadonlyMap<string, string | undefined>,
): boolean {
  if (sessionId === parentSessionId) return true;
  let cursor: string | undefined = parentSessionId;
  const seen = new Set<string>([sessionId]);
  while (cursor !== undefined) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentById.get(cursor);
  }
  return false;
}
