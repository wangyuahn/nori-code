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
import { ITaskService, type IInstantiationService } from '@nori-code/agent-core';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: Record<string, unknown> },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: Record<string, unknown>; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const swarmExecutionStatusSchema = z.enum(['pending', 'running', 'paused', 'done', 'failed', 'stopped']);

const swarmStatusSchema = z.object({
  swarm_id: z.string(),
  status: swarmExecutionStatusSchema,
  task_count: z.number(),
  completed_count: z.number(),
  session_id: z.string().optional(),
  task_id: z.string().optional(),
  description: z.string().optional(),
  owner_agent_id: z.string().optional(),
  parent_swarm_id: z.string().optional(),
  round: z.number().int().positive().optional(),
  started_at: z.string().optional(),
  usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative(),
    cache_write: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).optional(),
  tasks: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.string(),
    agent_id: z.string().optional(),
    parent_agent_id: z.string().optional(),
    profile: z.string().optional(),
    output: z.string().optional(),
    output_bytes: z.number().optional(),
    usage: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative(),
      cache_write: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }).optional(),
    live_output_tokens: z.number().int().nonnegative().optional(),
    context_tokens: z.number().int().nonnegative().optional(),
  })).optional(),
});

const swarmIdParamsSchema = z.object({
  swarm_id: z.string(),
});

const swarmActionParamsSchema = z.object({
  swarm_id: z.string().min(1),
  action: z.enum(['stop', 'pause', 'guide', 'resume']),
});

const swarmActionBodySchema = z.object({
  prompt: z.string().trim().min(1).optional(),
});

// ---------------------------------------------------------------------------
// In-memory swarm-state store
// ---------------------------------------------------------------------------

export interface SwarmTokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface SwarmTaskStatusEntry {
  id: string;
  label: string;
  status: string;
  agent_id?: string;
  parent_agent_id?: string;
  profile?: string;
  output?: string;
  output_bytes?: number;
  usage?: SwarmTokenUsage;
  live_output_tokens?: number;
  /** Current incomplete model step, retained only for live token estimation. */
  live_output?: string;
  context_tokens?: number;
}

export interface SwarmStatusEntry {
  swarm_id: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  task_count: number;
  completed_count: number;
  tasks?: SwarmTaskStatusEntry[];
  usage?: SwarmTokenUsage;
  /** Internal lookup fields used to resolve the aggregate background task output. */
  session_id?: string;
  task_id?: string;
  description?: string;
  owner_agent_id?: string;
  parent_swarm_id?: string;
  tool_call_id?: string;
  round?: number;
  started_at?: string;
}

function parseSwarmUsage(output: string | undefined): SwarmTokenUsage | undefined {
  if (output === undefined) return undefined;
  const matches = [...output.matchAll(/<usage\s+input="(\d+)"\s+output="(\d+)"\s+cache_read="(\d+)"\s+cache_write="(\d+)"\s+total="(\d+)"\s*\/>/g)];
  const match = matches.at(-1);
  if (!match) return undefined;
  return {
    input: Number(match[1]),
    output: Number(match[2]),
    cache_read: Number(match[3]),
    cache_write: Number(match[4]),
    total: Number(match[5]),
  };
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
    session_id: entry.session_id,
    task_id: entry.task_id,
    description: entry.description,
    owner_agent_id: entry.owner_agent_id,
    parent_swarm_id: entry.parent_swarm_id,
    round: entry.round,
    started_at: entry.started_at,
    usage: entry.usage,
  });
}

/** Update one swarm snapshot. Token-level output updates can skip WS notification. */
export function updateSwarmStatus(
  swarmId: string,
  update: (entry: SwarmStatusEntry) => SwarmStatusEntry,
  notify = true,
): SwarmStatusEntry | undefined {
  const current = swarmState.get(swarmId);
  if (current === undefined) return undefined;
  const next = update(current);
  if (notify) setSwarmStatus(next);
  else swarmState.set(swarmId, next);
  return next;
}

export function nextSwarmRound(sessionId: string): number {
  let highest = 0;
  for (const entry of swarmState.values()) {
    if (entry.session_id === sessionId) highest = Math.max(highest, entry.round ?? 0);
  }
  return highest + 1;
}

export function findSwarmByToolCall(
  sessionId: string,
  ownerAgentId: string,
  toolCallId: string,
): SwarmStatusEntry | undefined {
  return [...swarmState.values()].find(entry =>
    entry.session_id === sessionId
    && entry.owner_agent_id === ownerAgentId
    && entry.tool_call_id === toolCallId,
  );
}

export function findSwarmByAgent(sessionId: string, agentId: string): SwarmStatusEntry | undefined {
  return [...swarmState.values()].find(entry =>
    entry.session_id === sessionId
    && entry.tasks?.some(task => task.agent_id === agentId),
  );
}

/** Read the current status of a swarm (undefined when never written). */
export function getSwarmStatus(swarmId: string): SwarmStatusEntry | undefined {
  return swarmState.get(swarmId);
}

/** Snapshot used to replay known swarms to newly connected WebSocket clients. */
export function listSwarmStatuses(): SwarmStatusEntry[] {
  return [...swarmState.values()];
}

/** Remove a swarm entry (e.g. when GC'd). */
export function clearSwarmStatus(swarmId: string): boolean {
  return swarmState.delete(swarmId);
}

function aggregateTaskUsage(tasks: readonly SwarmTaskStatusEntry[] | undefined): SwarmTokenUsage | undefined {
  const usages = tasks?.flatMap(task => task.usage === undefined ? [] : [task.usage]) ?? [];
  if (usages.length === 0) return undefined;
  return usages.reduce<SwarmTokenUsage>((total, usage) => ({
    input: total.input + usage.input,
    output: total.output + usage.output,
    cache_read: total.cache_read + usage.cache_read,
    cache_write: total.cache_write + usage.cache_write,
    total: total.total + usage.total,
  }), { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSwarmStatusRoute(app: RouteHost, ix: IInstantiationService): void {
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
      let tasks = entry?.tasks;
      let usage = entry?.usage ?? aggregateTaskUsage(tasks);
      let status = entry?.status ?? ('pending' as const);
      if (entry?.session_id !== undefined && entry.task_id !== undefined) {
        try {
          const task = await ix.invokeFunction((a) =>
            a.get(ITaskService).get(entry.session_id!, entry.task_id!, {
              withOutput: true,
              outputBytes: 128_000,
              agentId: entry.owner_agent_id,
            }),
          );
          status = task.paused
            ? 'paused'
            : task.status === 'cancelled'
              ? 'stopped'
              : task.status === 'failed'
                ? 'failed'
                : task.status === 'completed'
                  ? 'done'
                  : status === 'paused'
                    ? 'running'
                    : status;
          if (tasks === undefined || tasks.length === 0) {
            tasks = [{
              id: task.id,
              label: entry.description ?? task.description,
              status: task.status,
              ...(task.output_preview === undefined ? {} : { output: task.output_preview }),
              ...(task.output_bytes === undefined ? {} : { output_bytes: task.output_bytes }),
            }];
          }
          usage ??= parseSwarmUsage(task.output_preview);
        } catch {
          // Preserve the last known status even if the task was already pruned.
        }
      }
      reply.send(okEnvelope({
        swarm_id: swarmId,
        status,
        task_count: entry?.task_count ?? 0,
        completed_count: entry?.completed_count ?? 0,
        session_id: entry?.session_id,
        task_id: entry?.task_id,
        description: entry?.description,
        owner_agent_id: entry?.owner_agent_id,
        parent_swarm_id: entry?.parent_swarm_id,
        round: entry?.round,
        started_at: entry?.started_at,
        ...(usage === undefined ? {} : { usage }),
        ...(tasks === undefined ? {} : { tasks }),
      }, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/swarm/{swarm_id}/{action}',
      params: swarmActionParamsSchema,
      body: swarmActionBodySchema,
      success: { data: z.object({ swarm_id: z.string(), status: swarmExecutionStatusSchema }) },
      description: 'Stop, pause, guide, or resume a swarm run',
      tags: ['swarm'],
    },
    async (req, reply) => {
      const { swarm_id: swarmId, action } = req.params;
      const { prompt } = req.body;
      const entry = swarmState.get(swarmId);
      if (entry?.session_id === undefined || entry.task_id === undefined) {
        throw new Error(`Swarm "${swarmId}" is not available for control.`);
      }
      const ownerAgentId = entry.owner_agent_id ?? 'main';
      const service = ix.invokeFunction((a) => a.get(ITaskService));
      if (action === 'stop') {
        await service.cancel(entry.session_id, entry.task_id, ownerAgentId);
      } else if (action === 'pause') {
        await service.pause(entry.session_id, entry.task_id, prompt, ownerAgentId);
      } else if (action === 'guide') {
        if (prompt === undefined) throw new Error('prompt is required when adding swarm guidance.');
        await service.guide(entry.session_id, entry.task_id, prompt, ownerAgentId);
      } else {
        await service.resume(entry.session_id, entry.task_id, prompt, ownerAgentId);
      }
      const status = action === 'stop' ? 'stopped' : action === 'resume' ? 'running' : 'paused';
      updateSwarmStatus(swarmId, current => ({ ...current, status }));
      reply.send(okEnvelope({ swarm_id: swarmId, status }, req.id));
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<RouteHost['post']>[2]);
}
