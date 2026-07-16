import type { BrowserActionResult, IInstantiationService } from '@nori-code/agent-core';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { IBrowserAutomationService } from '../services/browser';

interface BrowserRouteHost {
  get(path: string, options: object, handler: (req: any, reply: any) => unknown): unknown;
  post(path: string, options: object, handler: (req: any, reply: any) => unknown): unknown;
}

const clientParams = z.object({ client_id: z.string().min(1).max(200) });
const actionParams = z.object({ client_id: z.string().min(1).max(200), action_id: z.string().uuid() });
const pollQuery = z.object({ wait_ms: z.coerce.number().int().min(0).max(25_000).default(20_000) });
const emptyBody = z.object({}).passthrough();
const pauseBody = z.object({ paused: z.boolean() }).strict();
const resultBody = z.object({
  ok: z.boolean(),
  output: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  tabId: z.string().optional(),
  screenshotDataUrl: z.string().optional(),
  staleRef: z.boolean().optional(),
}).strict();
const bridgeState = z.object({ connected: z.boolean(), paused: z.boolean(), pending: z.number() });
const actionResponse = z.object({ action: z.unknown().nullable() });

export function registerBrowserRoutes(app: BrowserRouteHost, ix: IInstantiationService): void {
  const service = () => ix.invokeFunction(accessor => accessor.get(IBrowserAutomationService));

  const register = defineRoute({
    method: 'POST', path: '/browser/clients/{client_id}', params: clientParams, body: emptyBody,
    success: { data: bridgeState }, tags: ['browser'], description: 'Register a Nori Work browser executor',
  }, (req, reply) => {
    service().registerClient(req.params.client_id);
    reply.send(okEnvelope(service().getState(), req.id));
  });
  app.post(register.path, register.options, register.handler);

  const heartbeat = defineRoute({
    method: 'POST', path: '/browser/clients/{client_id}/heartbeat', params: clientParams, body: pauseBody,
    success: { data: bridgeState }, tags: ['browser'], description: 'Keep a Nori Work browser executor registered',
  }, (req, reply) => {
    service().heartbeat(req.params.client_id, req.body.paused);
    reply.send(okEnvelope(service().getState(), req.id));
  });
  app.post(heartbeat.path, heartbeat.options, heartbeat.handler);

  const poll = defineRoute({
    method: 'GET', path: '/browser/clients/{client_id}/actions', params: clientParams, querystring: pollQuery,
    success: { data: actionResponse }, tags: ['browser'], description: 'Wait for the next browser action',
  }, async (req, reply) => {
    const action = await service().nextAction(req.params.client_id, req.query.wait_ms);
    reply.send(okEnvelope({ action }, req.id));
  });
  app.get(poll.path, poll.options, poll.handler);

  const resolve = defineRoute({
    method: 'POST', path: '/browser/clients/{client_id}/actions/{action_id}', params: actionParams, body: resultBody,
    success: { data: z.object({ resolved: z.boolean() }) }, tags: ['browser'], description: 'Resolve a browser action',
  }, (req, reply) => {
    const resolved = service().resolveAction(
      req.params.client_id,
      req.params.action_id,
      req.body as BrowserActionResult,
    );
    if (!resolved) {
      reply.send(errEnvelope(40404, 'Browser action not found or assigned to another client.', req.id));
      return;
    }
    reply.send(okEnvelope({ resolved: true }, req.id));
  });
  app.post(resolve.path, resolve.options, resolve.handler);

  const pause = defineRoute({
    method: 'POST', path: '/browser/clients/{client_id}/pause', params: clientParams, body: pauseBody,
    success: { data: bridgeState }, tags: ['browser'], description: 'Pause or resume Agent browser actions',
  }, (req, reply) => {
    service().setPaused(req.params.client_id, req.body.paused);
    reply.send(okEnvelope(service().getState(), req.id));
  });
  app.post(pause.path, pause.options, pause.handler);
}
