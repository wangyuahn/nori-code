/** Validation shared by the TeamChat tool and the in-process session host. */

export function validateTeamChatMentions(
  message: string,
  mentions: readonly string[],
): void {
  const trimmed = message.trim();
  const tokens = trimmed.split(/\s+/);
  const leadingMentions: string[] = [];
  for (const token of tokens) {
    if (!token.startsWith('@')) break;
    const id = token.slice(1);
    if (id.length === 0 || id.includes('@')) {
      throw new Error('TeamChat messages must begin with one or more literal @session-id (or member name) mentions.');
    }
    leadingMentions.push(id);
  }
  if (leadingMentions.length === 0) {
    throw new Error(
      'TeamChat messages must begin with one or more literal @session-id (or member name) mentions; '
      + 'use @all only when every department member must receive the message.',
    );
  }

  const normalizedMentions = mentions.map((id) => id.trim()).filter(Boolean);
  const hasAll = leadingMentions.includes('all') || normalizedMentions.includes('all');
  if (hasAll) {
    if (leadingMentions.length !== 1 || leadingMentions[0] !== 'all'
      || normalizedMentions.length !== 1 || normalizedMentions[0] !== 'all') {
      throw new Error('TeamChat @all must be the only leading mention and the only mentions entry.');
    }
    return;
  }

  const uniqueLeading = [...new Set(leadingMentions)];
  const uniqueMentions = [...new Set(normalizedMentions)];
  if (uniqueLeading.length !== leadingMentions.length) {
    throw new Error('TeamChat leading mentions must not contain duplicates.');
  }
  if (uniqueMentions.length !== normalizedMentions.length
    || uniqueLeading.length !== uniqueMentions.length
    || uniqueLeading.some((id, index) => id !== uniqueMentions[index])) {
    throw new Error(
      'TeamChat mentions must exactly match the literal @session-id (or member name) mentions at the start of the message.',
    );
  }
}
