/**
 * Phase status API route.
 *
 * GET /phase/status — get the current session phase
 */

import { z } from 'zod';
import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { IInstantiationService } from '@nori-code/agent-core';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const phaseStatusSchema = z.object({
  phase: z.enum(['plan', 'implement', 'review', 'idle']),
  step: z.number(),
  mode: z.string().optional(),
});

export function registerPhaseRoute(app: RouteHost, _ix: IInstantiationService): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/phase/status',
      success: { data: phaseStatusSchema },
      description: 'Get current session phase status',
      tags: ['phase'],
    },
    async (req, reply) => {
      // Stub: real impl reads from NoriHost.getCurrentPhase()
      reply.send(okEnvelope({
        phase: 'idle' as const,
        step: 0,
      }, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
