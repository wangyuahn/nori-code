/**
 *   POST    /v1/sessions                  body: SessionCreate   data: Session
 *   GET     /v1/sessions                  query: ListSessions   data: Page<Session>
 *   GET     /v1/sessions/{id}             -                     data: Session
 *   GET     /v1/sessions/{id}/profile     -                     data: Session
 *   POST    /v1/sessions/{id}/profile     body: SessionUpdate   data: Session
 *   POST    /v1/sessions/{id}:fork        body: SessionFork     data: Session
 *   POST    /v1/sessions/{id}:btw         -                     data: StartBtwSession
 *   GET     /v1/sessions/{id}/children    query: ListSessions   data: Page<Session>
 *   POST    /v1/sessions/{id}/children    body: SessionChild    data: Session
 *   GET     /v1/sessions/{id}/agents      -                     data: SessionAgentTree
 *   GET     /v1/sessions/{id}/status      -                     data: SessionStatus
 *   POST    /v1/sessions/{id}:compact     body: CompactSession  data: {}
 *   POST    /v1/sessions/{id}:undo        body: UndoSession     data: UndoSession
 *   POST    /v1/sessions/{id}:archive     -                     data: { archived: true }
 */

import { z } from 'zod';

import { goalSnapshotSchema } from '../events';
import { messageSchema } from '../message';
import { cursorQuerySchema, pageResponseSchema } from '../pagination';
import {
  sessionChildCreateSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionSchema,
  sessionStatusSchema,
  sessionUpdateSchema,
} from '../session';

export const createSessionRequestSchema = sessionCreateSchema;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionResponseSchema = sessionSchema;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

const booleanQueryParam = z.preprocess(
  (value) => {
    if (value === 'true' || value === '1' || value === 1 || value === true) return true;
    if (value === 'false' || value === '0' || value === 0 || value === false) return false;
    return value;
  },
  z.boolean().optional(),
);

export const listSessionsQuerySchema = cursorQuerySchema.and(
  z.object({
    status: sessionStatusSchema.optional(),
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,
  }),
);
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const getSessionResponseSchema = sessionSchema;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;

export const getSessionProfileResponseSchema = sessionSchema;
export type GetSessionProfileResponse = z.infer<typeof getSessionProfileResponseSchema>;

export const sessionAgentIdSchema = z.string().min(1);

/**
 * Runtime controls may target a transcript inside the parent session. The
 * target is transport-only; it is never persisted in session metadata.
 */
export const updateSessionProfileRequestSchema = sessionUpdateSchema.extend({
  agent_id: sessionAgentIdSchema.optional(),
});
export type UpdateSessionProfileRequest = z.infer<typeof updateSessionProfileRequestSchema>;

export const updateSessionProfileResponseSchema = sessionSchema;
export type UpdateSessionProfileResponse = z.infer<typeof updateSessionProfileResponseSchema>;

export const updateSessionMetaRequestSchema = updateSessionProfileRequestSchema;
export type UpdateSessionMetaRequest = UpdateSessionProfileRequest;

export const updateSessionMetaResponseSchema = updateSessionProfileResponseSchema;
export type UpdateSessionMetaResponse = UpdateSessionProfileResponse;

export const updateSessionRequestSchema = updateSessionProfileRequestSchema;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const updateSessionResponseSchema = sessionSchema;
export type UpdateSessionResponse = z.infer<typeof updateSessionResponseSchema>;

export const forkSessionRequestSchema = sessionForkSchema;
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>;

export const forkSessionResponseSchema = sessionSchema;
export type ForkSessionResponse = z.infer<typeof forkSessionResponseSchema>;

export const startBtwSessionResponseSchema = z.object({
  agent_id: z.string().min(1),
});
export type StartBtwSessionResponse = z.infer<typeof startBtwSessionResponseSchema>;

// Child lists intentionally omit exclude_empty: the /sessions/{id}/children route
// does not filter by it, so advertising it would mislead generated clients.
export const listSessionChildrenQuerySchema = cursorQuerySchema.and(
  z.object({
    status: sessionStatusSchema.optional(),
    include_archive: booleanQueryParam,
  }),
);
export type ListSessionChildrenQuery = z.infer<typeof listSessionChildrenQuerySchema>;

export const listSessionChildrenResponseSchema = pageResponseSchema(sessionSchema);
export type ListSessionChildrenResponse = z.infer<typeof listSessionChildrenResponseSchema>;

export const createSessionChildRequestSchema = sessionChildCreateSchema;
export type CreateSessionChildRequest = z.infer<typeof createSessionChildRequestSchema>;

export const createSessionChildResponseSchema = sessionSchema;
export type CreateSessionChildResponse = z.infer<typeof createSessionChildResponseSchema>;

export const sessionAgentQuerySchema = z.object({
  agent_id: sessionAgentIdSchema.optional(),
});
export type SessionAgentQuery = z.infer<typeof sessionAgentQuerySchema>;

const realtimeTokenUsageSchema = z.object({
  input_other: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  input_cache_read: z.number().int().nonnegative(),
  input_cache_creation: z.number().int().nonnegative(),
});

export const sessionAgentTreeNodeSchema = z.object({
  id: sessionAgentIdSchema,
  kind: z.enum(['main', 'team', 'discussion', 'independent']),
  parent_agent_id: sessionAgentIdSchema.nullable(),
  name: z.string().min(1),
  role: z.string().min(1).optional(),
  mandate: z.string().min(1).optional(),
  assigned_task: z.string().min(1).optional(),
  team_report_status: z.enum(['unreported', 'completed', 'blocked', 'needs_decision']).nullable().optional(),
  team_report_summary: z.string().min(1).optional(),
  team_report_received: z.boolean().optional(),
  summary: z.string().min(1).optional(),
  status: sessionStatusSchema,
  usage: realtimeTokenUsageSchema.optional(),
  last_active: z.string().datetime(),
  archived: z.boolean(),
  /** The team member whose serial Discuss turn is currently running. */
  discussion_turn_agent_id: sessionAgentIdSchema.optional(),
  /** Members taking part in this Discuss round; only discussion nodes carry it. */
  discussion_participant_agent_ids: z.array(sessionAgentIdSchema).optional(),
});
export type SessionAgentTreeNode = z.infer<typeof sessionAgentTreeNodeSchema>;

export const sessionAgentTreeResponseSchema = z.object({
  agents: z.array(sessionAgentTreeNodeSchema),
});
export type SessionAgentTreeResponse = z.infer<typeof sessionAgentTreeResponseSchema>;

/** One persisted message in a department's sibling-only Chat log. */
export const teamChatMessageSchema = z.object({
  message_id: z.number().int().positive(),
  agent_id: sessionAgentIdSchema,
  name: z.string().min(1),
  message: z.string(),
  mentions: z.array(sessionAgentIdSchema),
  sent_at: z.string().datetime(),
});
export type TeamChatMessage = z.infer<typeof teamChatMessageSchema>;

/**
 * The department Chat log for one member. `department_leader_agent_id` is null
 * when the requested node is not a team member — the parent never sees its
 * department's chat, so a lead asking receives an empty log, not an error.
 */
export const sessionAgentChatResponseSchema = z.object({
  department_leader_agent_id: sessionAgentIdSchema.nullable(),
  messages: z.array(teamChatMessageSchema),
});
export type SessionAgentChatResponse = z.infer<typeof sessionAgentChatResponseSchema>;

/** Lightweight cross-session activity used by global UI indicators. */
export const sessionActivityItemSchema = z.object({
  session_id: z.string().min(1),
  agent_id: sessionAgentIdSchema,
  kind: z.enum(['agent', 'background']).default('agent'),
  task_id: z.string().optional(),
  status: sessionStatusSchema,
  last_active: z.string().datetime().optional(),
});
export type SessionActivityItem = z.infer<typeof sessionActivityItemSchema>;

export const sessionActivityResponseSchema = z.object({
  items: z.array(sessionActivityItemSchema),
});
export type SessionActivityResponse = z.infer<typeof sessionActivityResponseSchema>;

export const sessionStatusResponseSchema = z.object({
  status: sessionStatusSchema,
  model: z.string().optional(),
  thinking_level: z.string(),
  permission: z.string(),
  discuss_mode: z.boolean(),
  main_write_enabled: z.boolean(),
  goal: goalSnapshotSchema.nullable(),
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().nonnegative(),
  context_usage: z.number().min(0).max(1),
  usage: z.object({
    by_model: z.record(z.string(), realtimeTokenUsageSchema).optional(),
    current_turn: realtimeTokenUsageSchema.optional(),
    total: realtimeTokenUsageSchema.optional(),
  }).optional(),
});
export type SessionStatusResponse = z.infer<typeof sessionStatusResponseSchema>;

export const sessionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
});
export type SessionWarning = z.infer<typeof sessionWarningSchema>;

export const sessionWarningsResponseSchema = z.object({
  warnings: z.array(sessionWarningSchema),
});
export type SessionWarningsResponse = z.infer<typeof sessionWarningsResponseSchema>;

export const compactSessionRequestSchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({
    instruction: z.string().optional(),
    agent_id: sessionAgentIdSchema.optional(),
  }),
);
export type CompactSessionRequest = z.infer<typeof compactSessionRequestSchema>;

export const compactSessionResponseSchema = z.object({});
export type CompactSessionResponse = z.infer<typeof compactSessionResponseSchema>;

export const undoSessionRequestSchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({
    count: z.number().int().positive().default(1),
    page_size: z.number().int().min(1).max(100).optional(),
    agent_id: sessionAgentIdSchema.optional(),
  }),
);
export type UndoSessionRequest = z.infer<typeof undoSessionRequestSchema>;

export const undoSessionResponseSchema = z.object({
  messages: pageResponseSchema(messageSchema),
  status: sessionStatusResponseSchema,
});
export type UndoSessionResponse = z.infer<typeof undoSessionResponseSchema>;

export const archiveSessionResponseSchema = z.object({
  archived: z.literal(true),
});
export type ArchiveSessionResponse = z.infer<typeof archiveSessionResponseSchema>;

export const removeSessionResponseSchema = z.object({
  deleted: z.literal(true),
});
export type RemoveSessionResponse = z.infer<typeof removeSessionResponseSchema>;

/** @deprecated kept as an alias for backward compatibility; prefer archiveSessionResponseSchema. */
export const deleteSessionResponseSchema = archiveSessionResponseSchema;
/** @deprecated kept as an alias for backward compatibility; prefer ArchiveSessionResponse. */
export type DeleteSessionResponse = ArchiveSessionResponse;

export const sessionAbortResponseSchema = z.object({
  aborted: z.boolean(),
});
export type SessionAbortResponse = z.infer<typeof sessionAbortResponseSchema>;
