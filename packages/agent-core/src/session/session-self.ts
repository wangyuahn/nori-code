/**
 * Identity block + mount-change notices for the session mount tree.
 * Not transcript inheritance / compact — only who-you-are and what just changed.
 */

export interface SessionSelfMember {
  /** Session or agent handle for a direct child in the current department. */
  readonly sessionId: string;
  readonly title: string;
  readonly role?: string;
  readonly mandate?: string;
}

export interface SessionSelfInfo {
  readonly sessionId: string;
  readonly title: string;
  readonly parentSessionId?: string;
  readonly parentTitle?: string;
  readonly role?: string;
  readonly mandate?: string;
  readonly tags?: readonly string[];
  readonly depth: number;
  readonly position: 'top-level' | 'member';
  readonly directChildren: readonly SessionSelfMember[];
}

export interface MountChangeInfo {
  readonly session_id: string;
  readonly old_parent_session_id: string | null;
  readonly new_parent_session_id: string | null;
  readonly role?: string;
  readonly mandate?: string;
  readonly reason: 'mount' | 'unmount' | 'remount' | 'parent_deleted';
}

export type MountChangeRecipientRole = 'subject' | 'old_parent' | 'new_parent' | 'direct_child';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Latest identity snapshot for the system prompt (`<session_self>`). */
export function formatSessionSelf(info: SessionSelfInfo): string {
  const lines = [
    '<session_self>',
    `Session: ${escapeXml(info.sessionId)}`,
    `Title: ${escapeXml(info.title || info.sessionId)}`,
    `Position: ${info.position}`,
    `Depth: ${String(info.depth)}`,
  ];
  if (info.parentSessionId !== undefined) {
    lines.push(
      `Parent: ${escapeXml(info.parentSessionId)}`
        + (info.parentTitle !== undefined && info.parentTitle.length > 0
          ? ` (${escapeXml(info.parentTitle)})`
          : ''),
    );
  } else {
    lines.push('Parent: (none — top-level)');
  }
  if (info.role !== undefined && info.role.length > 0) {
    lines.push(`Role: ${escapeXml(info.role)}`);
  }
  if (info.mandate !== undefined && info.mandate.length > 0) {
    lines.push(`Mandate: ${escapeXml(info.mandate)}`);
  }
  if (info.tags !== undefined && info.tags.length > 0) {
    lines.push(`Tags: ${info.tags.map((tag) => escapeXml(tag)).join(', ')}`);
  }
  if (info.directChildren.length === 0) {
    lines.push('Direct members: (none)');
  } else {
    lines.push('Direct members:');
    for (const child of info.directChildren) {
      const bits = [
        escapeXml(child.sessionId),
        escapeXml(child.title || child.sessionId),
      ];
      if (child.role !== undefined && child.role.length > 0) bits.push(`role=${escapeXml(child.role)}`);
      if (child.mandate !== undefined && child.mandate.length > 0) {
        bits.push(`mandate=${escapeXml(child.mandate)}`);
      }
      lines.push(`- ${bits.join(' | ')}`);
    }
  }
  lines.push('</session_self>');
  return lines.join('\n');
}

/** One-shot org/identity change notice (not a conversation summary). */
export function formatMountChangeNotice(
  change: MountChangeInfo,
  recipientRole: MountChangeRecipientRole,
): string {
  const roleLabel = {
    subject: 'you are the session whose mount/identity changed',
    old_parent: 'you are the previous parent',
    new_parent: 'you are the new parent',
    direct_child: 'you are a direct member of the session whose parent changed',
  }[recipientRole];

  const lines = [
    '<session_mount_changed>',
    `Your role in this notice: ${roleLabel}.`,
    `Changed session: ${escapeXml(change.session_id)}`,
    `Reason: ${change.reason}`,
    `Old parent: ${change.old_parent_session_id === null
      ? '(none)'
      : escapeXml(change.old_parent_session_id)}`,
    `New parent: ${change.new_parent_session_id === null
      ? '(none — top-level)'
      : escapeXml(change.new_parent_session_id)}`,
  ];
  if (change.role !== undefined) lines.push(`Role: ${escapeXml(change.role)}`);
  if (change.mandate !== undefined) lines.push(`Mandate: ${escapeXml(change.mandate)}`);
  lines.push(
    'This is an organization/identity update only. It is not a transcript summary and does not inherit another session\'s conversation.',
    '</session_mount_changed>',
  );
  return lines.join('\n');
}

export interface IdentityChangeInfo {
  readonly session_id: string;
  readonly name?: string;
  readonly role?: string;
  readonly mandate?: string;
  readonly tags?: readonly string[];
}

export type IdentityChangeRecipientRole = 'subject' | 'parent' | 'sibling';

/** One-shot identity edit notice. Does not start a turn. */
export function formatIdentityChangeNotice(
  change: IdentityChangeInfo,
  recipientRole: IdentityChangeRecipientRole,
): string {
  const roleLabel = {
    subject: 'you are the session whose identity changed',
    parent: 'you are the parent of the session whose identity changed',
    sibling: 'you are a sibling in the same department',
  }[recipientRole];

  const lines = [
    '<session_identity_changed>',
    `Your role in this notice: ${roleLabel}.`,
    `Changed session: ${escapeXml(change.session_id)}`,
    'Reason: identity',
  ];
  if (change.name !== undefined) lines.push(`Name: ${escapeXml(change.name)}`);
  if (change.role !== undefined) lines.push(`Role: ${escapeXml(change.role)}`);
  if (change.mandate !== undefined) lines.push(`Mandate: ${escapeXml(change.mandate)}`);
  if (change.tags !== undefined) {
    lines.push(
      change.tags.length === 0
        ? 'Tags: (none)'
        : `Tags: ${change.tags.map((tag) => escapeXml(tag)).join(', ')}`,
    );
  }
  lines.push(
    'This is an identity update only. It does not start a turn and is not a transcript summary.',
    '</session_identity_changed>',
  );
  return lines.join('\n');
}
