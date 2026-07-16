import {
  ErrorCode,
  lspRequestSchema,
  lspResultSchema,
  lspStatusSchema,
} from '@nori-code/protocol';
import {
  FsPathEscapesError,
  ILspService,
  LspPositionRequiredError,
  LspUnavailableError,
  LspUnsupportedLanguageError,
  SessionNotFoundError,
  type IInstantiationService,
} from '@nori-code/agent-core';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface LspRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamsSchema = z.object({ session_id: z.string().min(1) });
const statusRequestSchema = z.object({ path: z.string().min(1) });
const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerLspRoutes(app: LspRouteHost, ix: IInstantiationService): void {
  const statusRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/lsp::status',
      params: sessionIdParamsSchema,
      body: statusRequestSchema,
      success: { data: lspStatusSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
      },
      description: 'Start or inspect the language server for a workspace file',
      tags: ['lsp'],
    },
    async (req, reply) => {
      try {
        const result = await ix.invokeFunction(accessor =>
          accessor.get(ILspService).status(req.params.session_id, req.body.path),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(statusRoute.path, statusRoute.options, statusRoute.handler as Parameters<LspRouteHost['post']>[2]);

  const requestRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/lsp::request',
      params: sessionIdParamsSchema,
      body: lspRequestSchema,
      success: { data: lspResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Execute a semantic Language Server Protocol request',
      tags: ['lsp'],
    },
    async (req, reply) => {
      try {
        const result = await ix.invokeFunction(accessor =>
          accessor.get(ILspService).request(req.params.session_id, req.body),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(requestRoute.path, requestRoute.options, requestRoute.handler as Parameters<LspRouteHost['post']>[2]);
}

function sendMappedError(reply: { send(payload: unknown): unknown }, requestId: string, error: unknown): void {
  if (error instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, requestId));
    return;
  }
  if (error instanceof FsPathEscapesError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, error.message, requestId));
    return;
  }
  if (error instanceof LspUnsupportedLanguageError || error instanceof LspPositionRequiredError) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, requestId));
    return;
  }
  if (error instanceof LspUnavailableError) {
    reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, error.message, requestId));
    return;
  }
  throw error;
}
