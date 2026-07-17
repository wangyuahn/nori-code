import { ErrorCode } from '@nori-code/protocol';
import {
  ErrorCodes,
  ICoreProcessService,
  ISessionService,
  KimiError,
  SessionNotFoundError,
  type IInstantiationService,
} from '@nori-code/agent-core';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface CronRouteHost {
  get(path: string, options: object, handler: (req: any, reply: any) => unknown): unknown;
  post(path: string, options: object, handler: (req: any, reply: any) => unknown): unknown;
  delete(path: string, options: object, handler: (req: any, reply: any) => unknown): unknown;
}

const sessionParams = z.object({ session_id: z.string().min(1) });
const cronParams = sessionParams.extend({ cron_id: z.string().regex(/^[0-9a-f]{8}$/) });
const createBody = z.object({
  cron: z.string().min(1).max(200),
  prompt: z.string().min(1).max(8192),
  recurring: z.boolean().default(true),
}).strict();
const cronTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  recurring: z.boolean(),
  lastFiredAt: z.number().optional(),
  humanSchedule: z.string(),
  nextFireAt: z.number().nullable(),
  ageDays: z.number(),
  stale: z.boolean(),
});

export function registerCronRoutes(app: CronRouteHost, ix: IInstantiationService): void {
  const requireSession = async (sessionId: string) => {
    await ix.invokeFunction((accessor) => accessor.get(ISessionService).get(sessionId));
    await rpc().resumeSession({ sessionId });
  };
  const rpc = () => ix.invokeFunction((accessor) => accessor.get(ICoreProcessService).rpc);

  const list = defineRoute({
    method: 'GET',
    path: '/sessions/{session_id}/cron',
    params: sessionParams,
    success: { data: z.object({ items: z.array(cronTaskSchema) }) },
    errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
    tags: ['cron'],
    description: 'List Cron Jobs for a session',
  }, async (req, reply) => {
    try {
      await requireSession(req.params.session_id);
      const items = await rpc().listCron({ sessionId: req.params.session_id, agentId: 'main' });
      reply.send(okEnvelope({ items }, req.id));
    } catch (error) {
      sendCronError(reply, req.id, error);
    }
  });
  app.get(list.path, list.options, list.handler);

  const create = defineRoute({
    method: 'POST',
    path: '/sessions/{session_id}/cron',
    params: sessionParams,
    body: createBody,
    success: { data: cronTaskSchema },
    errors: {
      [ErrorCode.VALIDATION_FAILED]: {},
      [ErrorCode.SESSION_NOT_FOUND]: {},
    },
    tags: ['cron'],
    description: 'Create a Cron Job for a session',
  }, async (req, reply) => {
    try {
      await requireSession(req.params.session_id);
      const task = await rpc().createCron({
        sessionId: req.params.session_id,
        agentId: 'main',
        ...req.body,
      });
      reply.send(okEnvelope(task, req.id));
    } catch (error) {
      sendCronError(reply, req.id, error);
    }
  });
  app.post(create.path, create.options, create.handler);

  const remove = defineRoute({
    method: 'DELETE',
    path: '/sessions/{session_id}/cron/{cron_id}',
    params: cronParams,
    success: { data: z.object({ deleted: z.literal(true) }) },
    errors: {
      [ErrorCode.VALIDATION_FAILED]: {},
      [ErrorCode.SESSION_NOT_FOUND]: {},
    },
    tags: ['cron'],
    description: 'Delete a Cron Job from a session',
  }, async (req, reply) => {
    try {
      await requireSession(req.params.session_id);
      const result = await rpc().deleteCron({
        sessionId: req.params.session_id,
        agentId: 'main',
        id: req.params.cron_id,
      });
      reply.send(okEnvelope(result, req.id));
    } catch (error) {
      sendCronError(reply, req.id, error);
    }
  });
  app.delete(remove.path, remove.options, remove.handler);
}

function sendCronError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  error: unknown,
): void {
  if (error instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, requestId));
    return;
  }
  if (error instanceof KimiError && error.code === ErrorCodes.SESSION_NOT_FOUND) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, requestId));
    return;
  }
  if (error instanceof KimiError && error.code === ErrorCodes.REQUEST_INVALID) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, requestId));
    return;
  }
  throw error;
}
