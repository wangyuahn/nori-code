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
import type { IInstantiationService } from '@moonshot-ai/agent-core';
import type { FastifyInstance } from 'fastify';

export interface SwarmStatusPayload {
  type: 'swarm_status';
  swarm_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  task_count: number;
  completed_count: number;
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

export function registerSwarmWsRoute(app: FastifyInstance, _ix: IInstantiationService): void {
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
