/**
 * Team-engineering snapshot helpers for the TUI.
 *
 * The CLI cannot call agent-core `listAgents`. It reconstructs a department
 * tree from session resume metadata, live `agent.status.updated` /
 * `discussion.updated` events, and Team* tool results — enough to browse
 * members, roles, and reports in a terminal list.
 */

export type TeamAgentKind = 'main' | 'team' | 'discussion' | 'independent';

export type TeamReportStatus = 'unreported' | 'completed' | 'blocked' | 'needs_decision';

export interface TeamAgentSnapshot {
  readonly agentId: string;
  readonly kind: TeamAgentKind;
  readonly name: string;
  readonly parentAgentId: string | null;
  readonly role?: string;
  readonly mandate?: string;
  readonly mountedSessionId?: string;
  readonly assignedTask?: string;
  readonly reportStatus?: TeamReportStatus;
  readonly reportSummary?: string;
  readonly status?: 'idle' | 'running';
  readonly archived?: boolean;
  readonly discussionTurnAgentId?: string;
  readonly discussionParticipantAgentIds?: readonly string[];
}

export interface TeamTreeRow {
  readonly agent: TeamAgentSnapshot;
  readonly depth: number;
}

const MAIN_AGENT_ID = 'main';
const REPORT_STATUSES: readonly TeamReportStatus[] = [
  'unreported',
  'completed',
  'blocked',
  'needs_decision',
];

export function teamMemberCount(agents: readonly TeamAgentSnapshot[]): number {
  return agents.filter((agent) => agent.kind === 'team' && agent.archived !== true).length;
}

export function teamHasBlockingReports(agents: readonly TeamAgentSnapshot[]): boolean {
  return agents.some(
    (agent) => agent.reportStatus === 'blocked' || agent.reportStatus === 'needs_decision',
  );
}

export function formatTeamReportsStatus(agents: readonly TeamAgentSnapshot[]): string {
  let blocked = 0;
  let needsDecision = 0;
  for (const agent of agents) {
    if (agent.reportStatus === 'blocked') blocked += 1;
    else if (agent.reportStatus === 'needs_decision') needsDecision += 1;
  }
  if (blocked === 0 && needsDecision === 0) return 'all clear';
  const parts: string[] = [];
  if (blocked > 0) parts.push(`${String(blocked)} blocked`);
  if (needsDecision > 0) {
    parts.push(`${String(needsDecision)} needs decision`);
  }
  return parts.join(', ');
}

export function teamIsSpeaking(
  agent: TeamAgentSnapshot,
  agents: readonly TeamAgentSnapshot[],
): boolean {
  return agents.some(
    (candidate) =>
      candidate.kind === 'discussion' &&
      candidate.archived !== true &&
      candidate.discussionTurnAgentId === agent.agentId,
  );
}

export interface TeamSecondaryPart {
  readonly text: string;
  readonly tone: 'muted' | 'success' | 'warning' | 'error';
}

export function teamRowSecondaryParts(
  agent: TeamAgentSnapshot,
  agents: readonly TeamAgentSnapshot[],
): readonly TeamSecondaryPart[] {
  if (agent.kind === 'discussion') {
    const speakerId = agent.discussionTurnAgentId;
    const speaker =
      speakerId === undefined
        ? undefined
        : agents.find((candidate) => candidate.agentId === speakerId);
    const parts: TeamSecondaryPart[] = [{ text: 'discuss', tone: 'muted' }];
    if (speakerId !== undefined) {
      parts.push({ text: `speak:${speaker?.name ?? speakerId}`, tone: 'muted' });
    }
    return parts;
  }

  const parts: TeamSecondaryPart[] = [{ text: kindLabel(agent.kind), tone: 'muted' }];
  if (agent.status === 'running') parts.push({ text: 'running', tone: 'muted' });
  else if (agent.kind === 'team') parts.push({ text: agent.status ?? 'idle', tone: 'muted' });
  if (teamIsSpeaking(agent, agents)) parts.push({ text: 'speaking', tone: 'success' });
  if (agent.reportStatus === 'blocked') parts.push({ text: 'blocked', tone: 'warning' });
  if (agent.reportStatus === 'needs_decision') {
    parts.push({ text: 'needs decision', tone: 'error' });
  }
  return parts;
}

export function teamAgentsFromSessionMetadata(metadata: unknown): TeamAgentSnapshot[] {
  const agentsRecord = readAgentsRecord(metadata);
  if (agentsRecord === undefined) return [];

  const snapshots: TeamAgentSnapshot[] = [];
  for (const [agentId, raw] of Object.entries(agentsRecord)) {
    const snapshot = snapshotFromMetadataEntry(agentId, raw);
    if (snapshot !== undefined) snapshots.push(snapshot);
  }
  if (!snapshots.some((agent) => agent.agentId === MAIN_AGENT_ID || agent.kind === 'main')) {
    snapshots.unshift({
      agentId: MAIN_AGENT_ID,
      kind: 'main',
      name: 'Main',
      parentAgentId: null,
    });
  }
  return snapshots;
}

export function flattenTeamTree(agents: readonly TeamAgentSnapshot[]): TeamTreeRow[] {
  const byParent = new Map<string | null, TeamAgentSnapshot[]>();
  for (const agent of agents) {
    if (agent.archived === true && agent.kind !== 'discussion') continue;
    const parent = agent.kind === 'main' ? null : (agent.parentAgentId ?? MAIN_AGENT_ID);
    const siblings = byParent.get(parent) ?? [];
    siblings.push(agent);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(compareTeamAgents);
  }

  const rows: TeamTreeRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    const children = byParent.get(parentId) ?? [];
    for (const agent of children) {
      rows.push({ agent, depth });
      walk(agent.agentId, depth + 1);
    }
  };
  walk(null, 0);
  if (rows.length === 0) {
    for (const agent of [...agents].toSorted(compareTeamAgents)) {
      if (agent.archived === true && agent.kind !== 'discussion') continue;
      rows.push({ agent, depth: agent.kind === 'main' ? 0 : 1 });
    }
  }
  return rows;
}

export function formatTeamRowSecondary(
  agent: TeamAgentSnapshot,
  agents: readonly TeamAgentSnapshot[] = [],
): string {
  return teamRowSecondaryParts(agent, agents)
    .map((part) => part.text)
    .join(' · ');
}

export function formatTeamAgentDetails(
  agent: TeamAgentSnapshot,
  agents: readonly TeamAgentSnapshot[] = [],
  recentSpeech: readonly string[] = [],
): string {
  const lines: string[] = [];
  if (agent.role !== undefined && agent.role.trim().length > 0) lines.push(`Role: ${agent.role}`);
  if (agent.mandate !== undefined && agent.mandate.trim().length > 0) {
    lines.push(`Mandate: ${agent.mandate}`);
  }
  if (agent.assignedTask !== undefined && agent.assignedTask.trim().length > 0) {
    lines.push(`Assigned: ${agent.assignedTask}`);
  }
  if (agent.reportStatus !== undefined) {
    const summary =
      agent.reportSummary !== undefined && agent.reportSummary.trim().length > 0
        ? ` — ${agent.reportSummary}`
        : '';
    lines.push(`Report: ${agent.reportStatus}${summary}`);
  }
  if (agent.discussionTurnAgentId !== undefined) {
    const speaker =
      agents.find((candidate) => candidate.agentId === agent.discussionTurnAgentId)?.name ??
      agent.discussionTurnAgentId;
    lines.push(`Speaking: ${speaker}`);
  }
  const participantIds = agent.discussionParticipantAgentIds;
  if (participantIds !== undefined && participantIds.length > 0) {
    const names = participantIds.map((id) => {
      const member = agents.find((candidate) => candidate.agentId === id);
      return member?.name ?? id;
    });
    lines.push(`Participants: ${names.join(', ')}`);
  }
  if (recentSpeech.length > 0) {
    lines.push('Recent speech:');
    for (const speech of recentSpeech) {
      const trimmed = speech.trim();
      if (trimmed.length === 0) continue;
      lines.push(...trimmed.split('\n'));
    }
  }
  if (lines.length === 0) {
    return agent.kind === 'main'
      ? 'Lead agent for this session. Hire partners with TeamCreate; Shift-Tab opens Discuss once a department exists.'
      : 'No role, assignment, or report yet.';
  }
  return lines.join('\n');
}

export function applyAgentStatusToTeam(
  agents: readonly TeamAgentSnapshot[],
  input: {
    readonly agentId: string;
    readonly team?: {
      readonly assignedTask: string | null;
      readonly status: 'idle' | 'running';
      readonly reportStatus: TeamReportStatus;
      readonly reportSummary: string | null;
    };
  },
): TeamAgentSnapshot[] {
  const team = input.team;
  if (team === undefined && input.agentId === MAIN_AGENT_ID) return [...agents];

  const existing = agents.find((agent) => agent.agentId === input.agentId);
  const next: TeamAgentSnapshot = {
    agentId: input.agentId,
    kind: existing?.kind ?? (input.agentId === MAIN_AGENT_ID ? 'main' : 'team'),
    name: existing?.name ?? input.agentId,
    parentAgentId: existing?.parentAgentId ?? (input.agentId === MAIN_AGENT_ID ? null : MAIN_AGENT_ID),
    role: existing?.role,
    mandate: existing?.mandate,
    mountedSessionId: existing?.mountedSessionId,
    assignedTask:
      team === undefined ? existing?.assignedTask : (team.assignedTask ?? undefined),
    reportStatus: team?.reportStatus ?? existing?.reportStatus,
    reportSummary:
      team === undefined ? existing?.reportSummary : (team.reportSummary ?? undefined),
    status: team?.status ?? existing?.status,
    archived: existing?.archived,
    discussionTurnAgentId: existing?.discussionTurnAgentId,
    discussionParticipantAgentIds: existing?.discussionParticipantAgentIds,
  };
  return upsertTeamAgent(agents, next);
}

export function applyDiscussionUpdateToTeam(
  agents: readonly TeamAgentSnapshot[],
  input: {
    readonly discussionAgentId: string;
    readonly currentTurnAgentId?: string | null;
    readonly kind?: string;
    readonly participantAgentIds?: readonly string[];
  },
): TeamAgentSnapshot[] {
  const existing = agents.find((agent) => agent.agentId === input.discussionAgentId);
  const ended = input.kind === 'lifecycle' && input.currentTurnAgentId === null;
  const parentAgentId = existing?.parentAgentId ?? MAIN_AGENT_ID;
  const participants =
    input.participantAgentIds ?? existing?.discussionParticipantAgentIds;
  const proposedTurn =
    input.currentTurnAgentId === null
      ? undefined
      : (input.currentTurnAgentId ?? existing?.discussionTurnAgentId);
  const discussionDraft: TeamAgentSnapshot = {
    agentId: input.discussionAgentId,
    kind: 'discussion',
    name: existing?.name ?? 'Discussion',
    parentAgentId,
    discussionParticipantAgentIds: participants,
    discussionTurnAgentId: existing?.discussionTurnAgentId,
  };
  const ownedTurn =
    proposedTurn === undefined ||
    discussionOwnsTurn(discussionDraft, proposedTurn, agents)
      ? proposedTurn
      : existing?.discussionTurnAgentId;
  const next: TeamAgentSnapshot = {
    agentId: input.discussionAgentId,
    kind: 'discussion',
    name: existing?.name ?? 'Discussion',
    parentAgentId,
    role: existing?.role,
    mandate: existing?.mandate,
    assignedTask: existing?.assignedTask,
    reportStatus: existing?.reportStatus,
    reportSummary: existing?.reportSummary,
    status: ended ? 'idle' : 'running',
    archived: ended ? true : existing?.archived,
    discussionTurnAgentId: ended ? undefined : ownedTurn,
    discussionParticipantAgentIds: participants,
  };
  return upsertTeamAgent(agents, next);
}

export function discussionOwnsTurn(
  discussion: TeamAgentSnapshot,
  turnAgentId: string,
  agents: readonly TeamAgentSnapshot[],
): boolean {
  if (discussion.parentAgentId === turnAgentId) return true;
  const participants = discussion.discussionParticipantAgentIds;
  if (participants !== undefined) return participants.includes(turnAgentId);
  // discussion.updated does not carry the participant list. Until resume
  // metadata or a tool result fills it in, accept department members only —
  // never independents or agents from another tree.
  const speaker = agents.find((agent) => agent.agentId === turnAgentId);
  if (speaker === undefined || speaker.kind === 'independent') return false;
  return speaker.kind === 'team' && speaker.parentAgentId === discussion.parentAgentId;
}

/** True when Discuss is showing this agent's utterances in the main transcript. */
export function isDiscussTranscriptAgent(
  agents: readonly TeamAgentSnapshot[],
  agentId: string,
): boolean {
  return agents.some(
    (agent) =>
      agent.kind === 'discussion' &&
      agent.archived !== true &&
      discussionOwnsTurn(agent, agentId, agents),
  );
}

export function isTeamSpeechTool(name: string | undefined): boolean {
  return name === 'TeamSpeak' || name === 'TeamDecide';
}

export function extractTeamSpeechText(
  toolName: string | undefined,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === 'TeamSpeak') return readString(args['message']);
  if (toolName === 'TeamDecide') {
    const action = readString(args['action']);
    if (action === 'archive' || action === 'vote') return undefined;
    return readString(args['statement']);
  }
  return undefined;
}

export function isTeamChatTool(name: string | undefined): boolean {
  return name === 'TeamChat';
}

export function extractTeamChatPost(
  toolName: string | undefined,
  args: Record<string, unknown>,
): { readonly message: string; readonly mentions: readonly string[] } | undefined {
  if (!isTeamChatTool(toolName)) return undefined;
  const message = readString(args['message']);
  if (message === undefined) return undefined;
  const rawMentions = args['mentions'];
  const mentions = Array.isArray(rawMentions)
    ? rawMentions.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  return { message, mentions };
}

export interface AgentDiscussion {
  readonly discussionAgentId: string;
  readonly leaderAgentId: string;
  readonly turnAgentId?: string;
  readonly topic?: string;
  readonly participantAgentIds?: readonly string[];
}

/** The Discuss round that concerns `agentId` — own department first, then the parent’s. */
export function findAgentDiscussion(
  agents: readonly TeamAgentSnapshot[],
  agentId: string,
): AgentDiscussion | undefined {
  const viewer = agents.find((agent) => agent.agentId === agentId);
  const departmentLeaderAgentId = viewer?.kind === 'team' ? (viewer.parentAgentId ?? undefined) : undefined;
  const discussions = agents.filter(
    (agent) => agent.kind === 'discussion' && agent.archived !== true,
  );
  const own = discussions.find((agent) => agent.parentAgentId === agentId);
  const joined =
    departmentLeaderAgentId === undefined
      ? undefined
      : discussions.find((agent) => agent.parentAgentId === departmentLeaderAgentId);
  const discussion = own ?? joined;
  const leaderAgentId = discussion?.parentAgentId;
  if (discussion === undefined || leaderAgentId === null || leaderAgentId === undefined) {
    return undefined;
  }
  return {
    discussionAgentId: discussion.agentId,
    leaderAgentId,
    turnAgentId: discussion.discussionTurnAgentId,
    topic: discussion.assignedTask ?? discussion.role,
    participantAgentIds: discussion.discussionParticipantAgentIds,
  };
}

/** Sibling Chat lives on the department lead; the lead itself is not a participant. */
export function departmentChatLeaderId(agent: TeamAgentSnapshot): string | undefined {
  if (agent.kind !== 'team') return undefined;
  return agent.parentAgentId ?? undefined;
}

export function currentViewingAgentId(viewingAgentId: string | undefined): string {
  return viewingAgentId === undefined || viewingAgentId.length === 0 ? MAIN_AGENT_ID : viewingAgentId;
}

export type DepartmentPaneMode = 'discuss' | 'chat';

/** Discuss on → meeting track; otherwise department Chat. Closing the pane does not change this. */
export function departmentPaneMode(discussMode: boolean): DepartmentPaneMode {
  return discussMode ? 'discuss' : 'chat';
}

export interface TeamChatMessage {
  readonly messageId: number;
  readonly agentId: string;
  readonly name: string;
  readonly message: string;
  readonly mentions: readonly string[];
  readonly sentAt: string;
}

export function teamChatMessagesFromMetadata(
  metadata: unknown,
  leaderAgentId: string,
): TeamChatMessage[] {
  const agentsRecord = readAgentsRecord(metadata);
  if (agentsRecord === undefined) return [];
  const record = asRecord(agentsRecord[leaderAgentId]);
  const chat = asRecord(record['chat']);
  const rawMessages = chat['messages'];
  if (!Array.isArray(rawMessages)) return [];
  const messages: TeamChatMessage[] = [];
  for (const raw of rawMessages) {
    const parsed = parseTeamChatRecord(raw);
    if (parsed !== undefined) messages.push(parsed);
  }
  return messages;
}

export function upsertTeamChatMessage(
  messages: readonly TeamChatMessage[],
  next: TeamChatMessage,
): TeamChatMessage[] {
  const index = messages.findIndex((message) => message.messageId === next.messageId);
  if (index < 0) return [...messages, next];
  const copy = [...messages];
  copy[index] = next;
  return copy;
}

function parseTeamChatRecord(raw: unknown): TeamChatMessage | undefined {
  const record = asRecord(raw);
  const messageId = record['messageId'] ?? record['message_id'];
  const agentId = readString(record['agentId'] ?? record['agent_id']);
  const message = readString(record['message']);
  if (typeof messageId !== 'number' || agentId === undefined || message === undefined) {
    return undefined;
  }
  const mentionsRaw = record['mentions'];
  return {
    messageId,
    agentId,
    name: readString(record['name']) ?? agentId,
    message,
    mentions: Array.isArray(mentionsRaw)
      ? mentionsRaw.filter((value): value is string => typeof value === 'string')
      : [],
    sentAt: readString(record['sentAt'] ?? record['sent_at']) ?? '',
  };
}

/**
 * Whether a child agent's event should become a labeled Discuss block.
 * Independent / BTW agents stay off the lead transcript. TeamSpeak is
 * always meeting speech. Assistant text paints when Discuss is on and
 * the speaker is a department member (or an unknown id while a round
 * is live — snapshot can lag the first delta).
 */
export function shouldPaintDiscussUtterance(
  agents: readonly TeamAgentSnapshot[],
  agentId: string,
  opts: { readonly discussMode: boolean; readonly toolName?: string },
): boolean {
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  if (agent?.kind === 'independent' || agent?.kind === 'discussion') return false;
  if (isTeamSpeechTool(opts.toolName)) return true;
  if (!opts.discussMode) return false;
  if (agent?.kind === 'team') return true;
  if (isDiscussTranscriptAgent(agents, agentId)) return true;
  if (agent !== undefined) return false;
  return agents.some(
    (candidate) => candidate.kind === 'discussion' && candidate.archived !== true,
  );
}

export function teamSpeakingLabel(agents: readonly TeamAgentSnapshot[]): string | undefined {
  const discussion = agents.find(
    (agent) =>
      agent.kind === 'discussion' &&
      agent.archived !== true &&
      agent.discussionTurnAgentId !== undefined,
  );
  const speakerId = discussion?.discussionTurnAgentId;
  if (speakerId === undefined) return undefined;
  const speaker = agents.find((agent) => agent.agentId === speakerId);
  return speaker?.name ?? speakerId;
}

export function applyTeamToolResultToTeam(
  agents: readonly TeamAgentSnapshot[],
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  parentAgentId: string,
): TeamAgentSnapshot[] {
  switch (toolName) {
    case 'TeamCreate':
      return applyTeamCreate(agents, args, output, parentAgentId);
    case 'TeamAssign':
      return applyTeamAssign(agents, args);
    case 'TeamDismiss':
      return applyTeamDismiss(agents, args, output);
    default:
      return [...agents];
  }
}

function applyTeamCreate(
  agents: readonly TeamAgentSnapshot[],
  args: Record<string, unknown>,
  output: string,
  parentAgentId: string,
): TeamAgentSnapshot[] {
  const created = readCreatedMembers(output);
  const argMembers = Array.isArray(args['members']) ? args['members'] : [];
  let next = ensureMainAgent(agents);
  if (created.length > 0) {
    for (const member of created) {
      next = upsertTeamAgent(next, {
        agentId: member.agentId,
        kind: 'team',
        name: member.name,
        parentAgentId,
        role: member.role,
        mandate: member.mandate,
        mountedSessionId: member.mountedSessionId,
        status: 'idle',
      });
    }
    return next;
  }
  for (const [index, raw] of argMembers.entries()) {
    const record = asRecord(raw);
    const name = readString(record['name']) ?? `member-${String(index + 1)}`;
    next = upsertTeamAgent(next, {
      agentId: name,
      kind: 'team',
      name,
      parentAgentId,
      role: readString(record['role']),
      mandate: readString(record['mandate']),
      status: 'idle',
    });
  }
  return next;
}

function applyTeamAssign(
  agents: readonly TeamAgentSnapshot[],
  args: Record<string, unknown>,
): TeamAgentSnapshot[] {
  const assignments = Array.isArray(args['assignments']) ? args['assignments'] : [];
  let next = [...agents];
  for (const raw of assignments) {
    const record = asRecord(raw);
    const agentId = readString(record['agent_id']);
    if (agentId === undefined) continue;
    const task = readString(record['task']);
    const existing = next.find((agent) => agent.agentId === agentId);
    next = upsertTeamAgent(next, {
      agentId,
      kind: existing?.kind ?? 'team',
      name: existing?.name ?? agentId,
      parentAgentId: existing?.parentAgentId ?? MAIN_AGENT_ID,
      role: existing?.role,
      mandate: existing?.mandate,
      mountedSessionId: existing?.mountedSessionId,
      assignedTask: task,
      reportStatus: existing?.reportStatus,
      reportSummary: existing?.reportSummary,
      status: task === undefined ? 'idle' : 'running',
      archived: existing?.archived,
      discussionTurnAgentId: existing?.discussionTurnAgentId,
      discussionParticipantAgentIds: existing?.discussionParticipantAgentIds,
    });
  }
  return next;
}

function applyTeamDismiss(
  agents: readonly TeamAgentSnapshot[],
  args: Record<string, unknown>,
  output: string,
): TeamAgentSnapshot[] {
  const dismissed = readDismissedIds(args, output);
  if (dismissed.length === 0) return [...agents];
  const removed = new Set(dismissed);
  const remaining = agents.filter((agent) => !removed.has(agent.agentId));
  if (teamMemberCount(remaining) > 0) return remaining;
  return remaining.filter((agent) => agent.kind !== 'discussion');
}

function snapshotFromMetadataEntry(agentId: string, raw: unknown): TeamAgentSnapshot | undefined {
  const record = asRecord(raw);
  const type = readString(record['type']);
  const kindField = readString(record['kind']);
  const discussion = asRecord(record['discussion']);
  const hasDiscussion = Object.keys(discussion).length > 0 && record['discussion'] !== undefined;
  const kind = treeKind(agentId, type, kindField, hasDiscussion);
  const report = asRecord(record['teamReport']);
  const assignedTask =
    readString(record['assignedTask']) ?? readString(report['task']);
  const reportStatus = readReportStatus(report['status']);
  const turnAgentId = readString(discussion['currentTurnAgentId']);
  const participants = Array.isArray(discussion['participantAgentIds'])
    ? discussion['participantAgentIds'].filter((value): value is string => typeof value === 'string')
    : undefined;
  return {
    agentId,
    kind,
    name: readString(record['name']) ?? agentId,
    parentAgentId: readNullableString(record['parentAgentId']) ?? (kind === 'main' ? null : MAIN_AGENT_ID),
    role: readString(record['role']),
    mandate: readString(record['mandate']),
    mountedSessionId: readString(record['mountedSessionId']),
    assignedTask,
    reportStatus,
    reportSummary: readString(report['summary']),
    archived: discussion['status'] === 'archived',
    discussionTurnAgentId: turnAgentId,
    discussionParticipantAgentIds: participants,
  };
}

function treeKind(
  agentId: string,
  type: string | undefined,
  kindField: string | undefined,
  hasDiscussion: boolean,
): TeamAgentKind {
  if (agentId === MAIN_AGENT_ID || type === 'main') return 'main';
  if (hasDiscussion) return 'discussion';
  if (kindField === 'team') return 'team';
  return 'independent';
}

function ensureMainAgent(agents: readonly TeamAgentSnapshot[]): TeamAgentSnapshot[] {
  if (agents.some((agent) => agent.agentId === MAIN_AGENT_ID || agent.kind === 'main')) {
    return [...agents];
  }
  return [
    {
      agentId: MAIN_AGENT_ID,
      kind: 'main',
      name: 'Main',
      parentAgentId: null,
    },
    ...agents,
  ];
}

function upsertTeamAgent(
  agents: readonly TeamAgentSnapshot[],
  next: TeamAgentSnapshot,
): TeamAgentSnapshot[] {
  const index = agents.findIndex((agent) => agent.agentId === next.agentId);
  if (index < 0) return [...agents, next];
  const copy = [...agents];
  copy[index] = next;
  return copy;
}

function compareTeamAgents(left: TeamAgentSnapshot, right: TeamAgentSnapshot): number {
  if (left.kind === 'main') return -1;
  if (right.kind === 'main') return 1;
  const kindRank = kindOrder(left.kind) - kindOrder(right.kind);
  if (kindRank !== 0) return kindRank;
  return left.name.localeCompare(right.name);
}

function kindOrder(kind: TeamAgentKind): number {
  switch (kind) {
    case 'main':
      return 0;
    case 'team':
      return 1;
    case 'discussion':
      return 2;
    case 'independent':
      return 3;
  }
}

function kindLabel(kind: TeamAgentKind): string {
  switch (kind) {
    case 'main':
      return 'main';
    case 'team':
      return 'team';
    case 'discussion':
      return 'discuss';
    case 'independent':
      return 'agent';
  }
}

function readCreatedMembers(
  output: string,
): Array<{
  agentId: string;
  name: string;
  role?: string;
  mandate?: string;
  mountedSessionId?: string;
}> {
  const parsed = parseJsonObject(output);
  const members = parsed === undefined ? undefined : parsed['members'];
  if (!Array.isArray(members)) return [];
  const created: Array<{
    agentId: string;
    name: string;
    role?: string;
    mandate?: string;
    mountedSessionId?: string;
  }> = [];
  for (const raw of members) {
    const record = asRecord(raw);
    const identity = asRecord(record['identity']);
    const agentId = readString(record['agentId']) ?? readString(record['agent_id']);
    const name = readString(identity['name']) ?? readString(record['name']);
    if (agentId === undefined || name === undefined) continue;
    created.push({
      agentId,
      name,
      role: readString(identity['role']) ?? readString(record['role']),
      mandate: readString(identity['mandate']) ?? readString(record['mandate']),
      mountedSessionId: readString(record['session_id']),
    });
  }
  return created;
}

function readDismissedIds(args: Record<string, unknown>, output: string): string[] {
  const parsed = parseJsonObject(output);
  const fromOutput = parsed === undefined ? undefined : parsed['dismissed'];
  if (Array.isArray(fromOutput)) {
    return fromOutput.filter((value): value is string => typeof value === 'string');
  }
  const fromArgs = args['agent_ids'];
  return Array.isArray(fromArgs)
    ? fromArgs.filter((value): value is string => typeof value === 'string')
    : [];
}

function readAgentsRecord(metadata: unknown): Record<string, unknown> | undefined {
  const record = asRecord(metadata);
  const agents = record['agents'];
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) return undefined;
  return agents as Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

function readReportStatus(value: unknown): TeamReportStatus | undefined {
  return typeof value === 'string' && REPORT_STATUSES.includes(value as TeamReportStatus)
    ? (value as TeamReportStatus)
    : undefined;
}
