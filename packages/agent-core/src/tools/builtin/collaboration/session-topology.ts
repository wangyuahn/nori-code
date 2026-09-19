import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const SessionSearchInputSchema = z.object({
  query: z.string().trim().max(400).default(''),
}).strict();
export type SessionSearchInput = z.infer<typeof SessionSearchInputSchema>;

export class SessionSearchTool implements BuiltinTool<SessionSearchInput> {
  readonly name = 'SessionSearch' as const;
  readonly description = 'Search sessions by id, title, role, or working directory. Use this before SessionMount when you need to find an existing session to attach as a department member.';
  readonly parameters = toInputJsonSchema(SessionSearchInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: SessionSearchInput): ToolExecution {
    return {
      description: 'Searching sessions',
      approvalRule: this.name,
      execute: async () => ({
        output: JSON.stringify({ hits: await this.host.searchSessions(args.query) }),
      }),
    };
  }
}

export const SessionMountInputSchema = z.object({
  session_id: z.string().trim().min(1),
  parent_session_id: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).max(4_000).optional(),
  mandate: z.string().trim().min(1).max(4_000).optional(),
}).strict();
export type SessionMountInput = z.infer<typeof SessionMountInputSchema>;

export class SessionMountTool implements BuiltinTool<SessionMountInput> {
  readonly name = 'SessionMount' as const;
  readonly description = 'Mount or remount an existing session under a parent session so it becomes a department member. Omit parent_session_id to mount under the current session. This changes Session topology, not a second Team Agent identity.';
  readonly parameters = toInputJsonSchema(SessionMountInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: SessionMountInput): ToolExecution {
    return {
      description: 'Mounting a session',
      approvalRule: this.name,
      execute: async () => {
        const parentSessionId = args.parent_session_id ?? this.host.currentSessionId();
        if (parentSessionId === undefined) {
          throw new Error('SessionMount requires parent_session_id.');
        }
        await this.host.remountSession(args.session_id, parentSessionId, args.role, args.mandate);
        return { output: JSON.stringify({ mounted: args.session_id, parent_session_id: parentSessionId }) };
      },
    };
  }
}

export const SessionUnmountInputSchema = z.object({
  session_id: z.string().trim().min(1),
}).strict();
export type SessionUnmountInput = z.infer<typeof SessionUnmountInputSchema>;

export class SessionUnmountTool implements BuiltinTool<SessionUnmountInput> {
  readonly name = 'SessionUnmount' as const;
  readonly description = 'Detach a mounted child session without deleting it. The session becomes top-level. TeamDismiss deletes the member session instead.';
  readonly parameters = toInputJsonSchema(SessionUnmountInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(args: SessionUnmountInput): ToolExecution {
    return {
      description: 'Unmounting a session',
      approvalRule: this.name,
      execute: async () => {
        await this.host.unmountSession(args.session_id);
        return { output: JSON.stringify({ unmounted: args.session_id }) };
      },
    };
  }
}

export const SessionGraphInputSchema = z.object({}).strict();
export type SessionGraphInput = z.infer<typeof SessionGraphInputSchema>;

export class SessionGraphTool implements BuiltinTool<SessionGraphInput> {
  readonly name = 'SessionGraph' as const;
  readonly description = 'Read the session forest: every node is a Session, and parent_session_id is the department mount. Use this instead of inferring topology from Team Agent ids.';
  readonly parameters = toInputJsonSchema(SessionGraphInputSchema);

  constructor(private readonly host: SessionSubagentHost) {}

  resolveExecution(_args: SessionGraphInput): ToolExecution {
    return {
      description: 'Reading the session forest',
      approvalRule: this.name,
      execute: async () => ({
        output: JSON.stringify(await this.host.sessionGraph()),
      }),
    };
  }
}
