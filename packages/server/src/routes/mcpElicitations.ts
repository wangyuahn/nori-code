import {
  ErrorCode,
  listPendingMcpElicitationsQuerySchema,
  listPendingMcpElicitationsResponseSchema,
  mcpElicitationResolveRequestSchema,
  mcpElicitationResolveResultSchema,
} from '@nori-code/protocol';
import {
  compileToolArgsValidator,
  IMcpElicitationService,
  mcpElicitationToAgentCoreResponse,
  type IInstantiationService,
  validateToolArgs,
} from '@nori-code/agent-core';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { McpElicitationService } from '#/services/mcpElicitation';

interface McpElicitationRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionParamsSchema = z.object({
  session_id: z.string().min(1),
});

const resolveParamsSchema = sessionParamsSchema.extend({
  elicitation_id: z.string().min(1),
});

export function registerMcpElicitationRoutes(
  app: McpElicitationRouteHost,
  ix: IInstantiationService,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/mcp-elicitations',
      params: sessionParamsSchema,
      querystring: listPendingMcpElicitationsQuerySchema,
      success: { data: listPendingMcpElicitationsResponseSchema },
      description: 'List pending MCP elicitation requests for a session',
      tags: ['mcp'],
    },
    async (req, reply) => {
      const service = ix.invokeFunction(
        (accessor) => accessor.get(IMcpElicitationService) as McpElicitationService,
      );
      reply.send(
        okEnvelope({ items: service.listPending(req.params.session_id) }, req.id),
      );
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<McpElicitationRouteHost['get']>[2],
  );

  const resolveRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/mcp-elicitations/{elicitation_id}',
      params: resolveParamsSchema,
      body: mcpElicitationResolveRequestSchema,
      success: { data: mcpElicitationResolveResultSchema },
      errors: {
        [ErrorCode.MCP_ELICITATION_NOT_FOUND]: {},
        [ErrorCode.MCP_ELICITATION_ALREADY_RESOLVED]: {
          dataSchema: z.object({ resolved: z.literal(false) }),
        },
        [ErrorCode.VALIDATION_FAILED]: {
          detailsSchema: z.array(
            z.object({ path: z.string(), message: z.string() }),
          ),
        },
      },
      description: 'Resolve an MCP elicitation request',
      tags: ['mcp'],
    },
    async (req, reply) => {
      const { session_id, elicitation_id } = req.params;
      const service = ix.invokeFunction(
        (accessor) => accessor.get(IMcpElicitationService) as McpElicitationService,
      );
      const pending = service.getPending(elicitation_id);
      if (pending === undefined || pending.session_id !== session_id) {
        const code = service.isRecentlyResolved(elicitation_id)
          ? ErrorCode.MCP_ELICITATION_ALREADY_RESOLVED
          : ErrorCode.MCP_ELICITATION_NOT_FOUND;
        reply.send(
          code === ErrorCode.MCP_ELICITATION_ALREADY_RESOLVED
            ? {
                code,
                msg: `MCP elicitation ${elicitation_id} already resolved`,
                data: { resolved: false },
                request_id: req.id,
              }
            : errEnvelope(code, `MCP elicitation ${elicitation_id} not found`, req.id),
        );
        return;
      }
      if (!service.isAnswerable(elicitation_id)) {
        reply.send({
          code: ErrorCode.MCP_ELICITATION_ALREADY_RESOLVED,
          msg: `MCP elicitation ${elicitation_id} is awaiting completion`,
          data: { resolved: false },
          request_id: req.id,
        });
        return;
      }

      if (
        pending.mode === 'form' &&
        req.body.action === 'accept'
      ) {
        const content = req.body.content ?? {};
        const validationError = validateToolArgs(
          compileToolArgsValidator(pending.requested_schema),
          content,
        );
        if (validationError !== null) {
          reply.send({
            code: ErrorCode.VALIDATION_FAILED,
            msg: validationError,
            data: null,
            request_id: req.id,
            details: [{ path: 'content', message: validationError }],
          });
          return;
        }
      }

      const status = service.resolve(
        elicitation_id,
        mcpElicitationToAgentCoreResponse(req.body),
      );
      if (status === undefined) {
        reply.send({
          code: ErrorCode.MCP_ELICITATION_ALREADY_RESOLVED,
          msg: `MCP elicitation ${elicitation_id} already resolved`,
          data: { resolved: false },
          request_id: req.id,
        });
        return;
      }
      reply.send(
        okEnvelope(
          {
            resolved: true as const,
            status,
            resolved_at: new Date().toISOString(),
          },
          req.id,
        ),
      );
    },
  );
  app.post(
    resolveRoute.path,
    resolveRoute.options,
    resolveRoute.handler as Parameters<McpElicitationRouteHost['post']>[2],
  );
}
