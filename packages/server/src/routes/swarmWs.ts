/**
 * Swarm WebSocket route — push swarm status updates to connected clients.
 *
 * WS  /api/v1/swarm/ws
 *
 * Uses the same `noServer` + upgrade-listener pattern as the main WS gateway
 * so it coexists without a separate Fastify plugin.
 */

import type { RawData, WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { IInstantiationService } from '@nori-code/agent-core';
import type { FastifyInstance } from 'fastify';

interface SwarmStatusTaskPayload {
  id: string;
  label: string;
  status: string;
  agent_id?: string;
  parent_agent_id?: string;
  profile?: string;
  output?: string;
  output_bytes?: number;
  usage?: SwarmStatusPayload['usage'];
  live_output_tokens?: number;
  context_tokens?: number;
}

interface SwarmStatusSnapshot extends Omit<SwarmStatusPayload, 'type' | 'timestamp' | 'tasks'> {
  tasks?: Array<SwarmStatusTaskPayload & { live_output?: string }>;
}

export interface SwarmStatusPayload {
  type: 'swarm_status';
  swarm_id: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  task_count: number;
  completed_count: number;
  session_id?: string;
  task_id?: string;
  description?: string;
  owner_agent_id?: string;
  parent_swarm_id?: string;
  round?: number;
  started_at?: string;
  usage?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
  tasks?: SwarmStatusTaskPayload[];
  timestamp: string;
}

const SWARM_WS_PATH = '/api/v1/swarm/ws';

const connectedClients = new Set<WebSocket>();

/** Broadcast a swarm status update to all connected clients. */
export function broadcastSwarmStatus(payload: Omit<SwarmStatusPayload, 'type' | 'timestamp'>): void {
  const frame: SwarmStatusPayload = {
    type: 'swarm_status',
    ...payload,
    timestamp: new Date().toISOString(),
  };
  const data = JSON.stringify(frame);
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  }
}

export function registerSwarmWsRoute(
  app: FastifyInstance,
  _ix: IInstantiationService,
  listStatuses: () => readonly SwarmStatusSnapshot[],
): void {
  const wss = new WebSocketServer({ noServer: true });

  const server = app.server;
  // prependListener so our handler fires BEFORE the main WS gateway's upgrade
  // listener, which destroys sockets on non-matching paths.
  server.prependListener('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    const path = url.split('?', 1)[0];
    if (path !== SWARM_WS_PATH) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      connectedClients.add(ws);

      ws.send(
        JSON.stringify({
          type: 'swarm_connected',
          timestamp: new Date().toISOString(),
          client_count: connectedClients.size,
        }),
      );
      for (const entry of listStatuses()) {
        ws.send(JSON.stringify({
          type: 'swarm_status',
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
          tasks: entry.tasks?.map(({ live_output: _liveOutput, ...task }) => task),
          timestamp: new Date().toISOString(),
        } satisfies SwarmStatusPayload));
      }

      ws.on('message', (raw: RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          }
        } catch {
          /* ignore malformed messages */
        }
      });

      ws.on('close', () => {
        connectedClients.delete(ws);
      });

      ws.on('error', () => {
        connectedClients.delete(ws);
      });
    });
  });
}
