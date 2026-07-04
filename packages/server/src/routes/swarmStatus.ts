/**
 * Swarm status API route.
 *
 * GET /swarm/status/{swarm_id} — query a swarm's execution status
 *
 * Backed by an in-memory Map that the swarm manager writes via
 * {@link setSwarmStatus}. When no entry exists for a swarm_id the
 * route returns `pending` / task_count 0 as a safe default.
 */

import { z } from 'zod';
import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { broadcastSwarmStatus } from './swarmWs';
import type { IInstantiationService } from '@moonshot-ai/agent-core';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: Record<string, unknown> },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const swarmStatusSchema = z.object({
  swarm_id: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  task_count: z.number(),
  completed_count: z.number(),
  tasks: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.string(),
  })).optional(),
});

const swarmIdParamsSchema = z.object({
  swarm_id: z.string(),
});

// ---------------------------------------------------------------------------
// In-memory swarm-state store
// ---------------------------------------------------------------------------

export interface SwarmStatusEntry {
  swarm_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  task_count: number;
  completed_count: number;
  tasks?: Array<{ id: string; label: string; status: string }>;
}

const swarmState = new Map<string, SwarmStatusEntry>();

/** Write or update the status of a swarm. */
export function setSwarmStatus(entry: SwarmStatusEntry): void {
  swarmState.set(entry.swarm_id, entry);
  broadcastSwarmStatus({
    swarm_id: entry.swarm_id,
    status: entry.status,
    task_count: entry.task_count,
    completed_count: entry.completed_count,
  });
}

/** Read the current status of a swarm (undefined when never written). */
export function getSwarmStatus(swarmId: string): SwarmStatusEntry | undefined {
  return swarmState.get(swarmId);
}

/** Remove a swarm entry (e.g. when GC'd). */
export function clearSwarmStatus(swarmId: string): boolean {
  return swarmState.delete(swarmId);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSwarmStatusRoute(app: RouteHost, _ix: IInstantiationService): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/swarm/status/{swarm_id}',
      params: swarmIdParamsSchema,
      success: { data: swarmStatusSchema },
      description: 'Query swarm execution status',
      tags: ['swarm'],
    },
    async (req, reply) => {
      const swarmId = req.params['swarm_id'] as string;
      const entry = swarmState.get(swarmId);
      reply.send(okEnvelope({
        swarm_id: swarmId,
        status: entry?.status ?? ('pending' as const),
        task_count: entry?.task_count ?? 0,
        completed_count: entry?.completed_count ?? 0,
      }, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
