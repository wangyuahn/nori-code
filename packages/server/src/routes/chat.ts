/**
 * `/sessions/{session_id}/agents/{agent_id}/chat` REST route.
 *
 * GET → the department Chat log visible from `agentId` (siblings only; the
 * parent never participates, so a non-member agent id yields an empty log
 * rather than an error). Live updates arrive as `team.chat.updated` WS events.
 */

import { ErrorCode, sessionAgentChatResponseSchema } from '@nori-code/protocol';
import { ISessionService, SessionNotFoundError, type IInstantiationService } from '@nori-code/agent-core';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionAgentIdParamSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
});

interface ChatRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerChatRoutes(
  app: ChatRouteHost,
  ix: IInstantiationService,
): void {
  const chatRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/agents/{agent_id}/chat',
      params: sessionAgentIdParamSchema,
      success: { data: sessionAgentChatResponseSchema },
      description: "List a member's department chat log",
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id, agent_id } = req.params;
        const chat = await ix.invokeFunction((a) =>
          a.get(ISessionService).getDepartmentChat(session_id, agent_id),
        );
        reply.send(okEnvelope(chat, req.id));
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, req.id));
          return;
        }
        throw err;
      }
    },
  );
  app.get(chatRoute.path, chatRoute.options, chatRoute.handler as Parameters<ChatRouteHost['get']>[2]);
}
