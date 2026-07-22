import type { IInstantiationService } from '@nori-code/agent-core';
import { ulid } from 'ulid';

import { okEnvelope } from '../envelope';
import { NORI_SERVER_APP_ID } from '../identity';
import { registerApprovalsRoutes } from './approvals';
import { registerAuthRoute } from './auth';
import { registerConfigRoutes } from './config';
import { registerConnectionsRoutes } from './connections';
import { registerDebugRoutes } from './debug';
import { registerFilesRoutes } from './files';
import { registerFsRoutes } from './fs';
import { registerGuiStoreRoutes } from './guiStore';
import { registerMessagesRoutes } from './messages';
import { registerMetaRoute } from './meta';
import { registerModelCatalogRoutes } from './modelCatalog';
import { registerOAuthRoutes } from './oauth';
import { registerPromptsRoutes } from './prompts';
import { registerQuestionsRoutes } from './questions';
import { registerSessionsRoutes } from './sessions';
import { registerShutdownRoutes } from './shutdown';
import { registerSkillsRoutes } from './skills';
import { registerSnapshotRoutes } from './snapshot';
import { registerTasksRoutes } from './tasks';
import { registerTerminalsRoutes } from './terminals';
import { registerLspRoutes } from './lsp';
import { registerToolsRoutes } from './tools';
import { registerWorkspaceFsRoutes } from './workspaceFs';
import { registerWorkspacesRoutes } from './workspaces';
import { registerVaultRoutes } from './vault';
import { registerSwarmStatusRoute } from './swarmStatus';
import { registerPhaseRoute } from './phase';
import { registerBrowserRoutes } from './browser';
import { registerCronRoutes } from './cron';

interface ApiV1AppHost {
  register(
    plugin: (apiV1: ApiV1RouteHost) => Promise<void> | void,
    opts: { prefix: string },
  ): unknown;
}

interface ApiV1RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => unknown,
  ): unknown;
}

export interface RegisterApiV1RoutesOptions {
  readonly serverVersion: string;
  readonly debugEndpoints?: boolean;
  /**
   * Mount `POST /api/v1/shutdown`. Defaults to true (backward compatible);
   * `start.ts` sets it false on a public bind unless `--allow-remote-shutdown`.
   */
  readonly enableShutdown?: boolean;
  /**
   * Mount the PTY `/api/v1/terminals/*` routes. Defaults to true (backward
   * compatible); `start.ts` sets it false on a public bind unless
   * `--allow-remote-terminals`.
   */
  readonly enableTerminals?: boolean;
}

export async function registerApiV1Routes(
  app: ApiV1AppHost,
  ix: IInstantiationService,
  opts: RegisterApiV1RoutesOptions,
): Promise<void> {
  // Register all REST routes under a single `/api/v1` prefix so individual
  // route modules do not hardcode the version segment.
  await app.register(async (apiV1) => {
    registerHealthRoute(apiV1, { serverVersion: opts.serverVersion });

    registerMetaRoute(apiV1, {
      serverVersion: opts.serverVersion,
      serverId: ulid(),
      startedAt: new Date().toISOString(),
    });

    registerAuthRoute(apiV1 as unknown as Parameters<typeof registerAuthRoute>[0], ix);
    registerConfigRoutes(apiV1 as unknown as Parameters<typeof registerConfigRoutes>[0], ix);
    registerConnectionsRoutes(
      apiV1 as unknown as Parameters<typeof registerConnectionsRoutes>[0],
      ix,
    );
    registerOAuthRoutes(apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0], ix);
    registerModelCatalogRoutes(
      apiV1 as unknown as Parameters<typeof registerModelCatalogRoutes>[0],
      ix,
    );
    registerSessionsRoutes(apiV1 as unknown as Parameters<typeof registerSessionsRoutes>[0], ix);
    if (opts.enableShutdown !== false) {
      registerShutdownRoutes(
        apiV1 as unknown as Parameters<typeof registerShutdownRoutes>[0],
        ix,
      );
    }
    registerSnapshotRoutes(apiV1 as unknown as Parameters<typeof registerSnapshotRoutes>[0], ix);
    registerMessagesRoutes(apiV1 as unknown as Parameters<typeof registerMessagesRoutes>[0], ix);
    registerPromptsRoutes(apiV1 as unknown as Parameters<typeof registerPromptsRoutes>[0], ix);
    registerApprovalsRoutes(
      apiV1 as unknown as Parameters<typeof registerApprovalsRoutes>[0],
      ix,
    );
    registerQuestionsRoutes(
      apiV1 as unknown as Parameters<typeof registerQuestionsRoutes>[0],
      ix,
    );
    registerToolsRoutes(apiV1 as unknown as Parameters<typeof registerToolsRoutes>[0], ix);
    registerSkillsRoutes(apiV1 as unknown as Parameters<typeof registerSkillsRoutes>[0], ix);
    registerTasksRoutes(apiV1 as unknown as Parameters<typeof registerTasksRoutes>[0], ix);
    if (opts.enableTerminals !== false) {
      registerTerminalsRoutes(
        apiV1 as unknown as Parameters<typeof registerTerminalsRoutes>[0],
        ix,
      );
    }
    registerLspRoutes(apiV1 as unknown as Parameters<typeof registerLspRoutes>[0], ix);
    registerFsRoutes(apiV1 as unknown as Parameters<typeof registerFsRoutes>[0], ix);
    registerGuiStoreRoutes(apiV1 as unknown as Parameters<typeof registerGuiStoreRoutes>[0], ix);
    registerFilesRoutes(apiV1 as unknown as Parameters<typeof registerFilesRoutes>[0], ix);
    registerWorkspacesRoutes(
      apiV1 as unknown as Parameters<typeof registerWorkspacesRoutes>[0],
      ix,
    );
    registerWorkspaceFsRoutes(
      apiV1 as unknown as Parameters<typeof registerWorkspaceFsRoutes>[0],
      ix,
    );

    // Nori API routes
    registerVaultRoutes(apiV1 as unknown as Parameters<typeof registerVaultRoutes>[0], ix);
    registerSwarmStatusRoute(apiV1 as unknown as Parameters<typeof registerSwarmStatusRoute>[0], ix);
    registerPhaseRoute(apiV1 as unknown as Parameters<typeof registerPhaseRoute>[0], ix);
    registerBrowserRoutes(apiV1 as unknown as Parameters<typeof registerBrowserRoutes>[0], ix);
    registerCronRoutes(apiV1 as unknown as Parameters<typeof registerCronRoutes>[0], ix);

    // NOTE: Swarm WebSocket (WS /api/v1/swarm/ws) must be registered on the
    // main Fastify app instance OUTSIDE this /api/v1 prefix register, because
    // Fastify upgrade listeners need the raw HTTP server. Call
    //   import { registerSwarmWsRoute } from './swarmWs';
    //   registerSwarmWsRoute(app, ix);
    // from start.ts after registerApiV1Routes().

    if (opts.debugEndpoints === true) {
      registerDebugRoutes(
        apiV1 as unknown as Parameters<typeof registerDebugRoutes>[0],
        ix,
      );
    }
  }, { prefix: '/api/v1' });
}

function registerHealthRoute(apiV1: ApiV1RouteHost, opts: { serverVersion: string }): void {
  apiV1.get('/healthz', {
    schema: {
      description: 'Health check',
      response: {
        200: {
          type: 'object',
          properties: {
            code: { type: 'number' },
            msg: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                app: { type: 'string' },
                version: { type: 'string' },
              },
            },
            request_id: { type: 'string' },
          },
        },
      },
    },
  }, async (req, reply) => {
    // `app` identifies this as a Nori server: clients sharing the machine with
    // products that return an identical `{code: 0}` envelope (e.g. upstream
    // Kimi Code on the same historical default port) must not mistake them for
    // a live Nori daemon. See `identity.ts`.
    return reply.send(
      okEnvelope({ ok: true, app: NORI_SERVER_APP_ID, version: opts.serverVersion }, req.id),
    );
  });
}
