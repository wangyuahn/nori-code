import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, ICoreProcessService, ISessionService, KimiError } from '@nori-code/agent-core';

import { registerCronRoutes } from '../src/routes/cron';

describe('Cron routes', () => {
  it('resumes the session and manages scheduler-backed jobs', async () => {
    const handlers = new Map<string, (req: any, reply: any) => Promise<void>>();
    const app = {
      get: (path: string, _options: object, handler: any) => handlers.set(`GET ${path}`, handler),
      post: (path: string, _options: object, handler: any) => handlers.set(`POST ${path}`, handler),
      delete: (path: string, _options: object, handler: any) => handlers.set(`DELETE ${path}`, handler),
    };
    const task = {
      id: 'deadbeef', cron: '*/5 * * * *', prompt: 'Check build', createdAt: 1,
      recurring: true, humanSchedule: 'every 5 minutes', nextFireAt: 2, ageDays: 0, stale: false,
    };
    const sessionService = { get: vi.fn(async () => ({ id: 'session-a' })) };
    const rpc = {
      resumeSession: vi.fn(async () => ({})),
      listCron: vi.fn(async () => [task]),
      createCron: vi.fn(async () => task),
      deleteCron: vi.fn(async () => ({ deleted: true as const })),
    };
    const ix = {
      invokeFunction: (callback: (accessor: { get(token: unknown): unknown }) => unknown) => callback({
        get: (token) => token === ISessionService ? sessionService : token === ICoreProcessService ? { rpc } : undefined,
      }),
    };
    registerCronRoutes(app as never, ix as never);

    const sent: unknown[] = [];
    const reply = { send: (payload: unknown) => { sent.push(payload); } };
    await handlers.get('GET /sessions/:session_id/cron')?.({ id: 'r1', params: { session_id: 'session-a' } }, reply);
    await handlers.get('POST /sessions/:session_id/cron')?.({
      id: 'r2', params: { session_id: 'session-a' }, body: { cron: '*/5 * * * *', prompt: 'Check build', recurring: true },
    }, reply);
    await handlers.get('DELETE /sessions/:session_id/cron/:cron_id')?.({
      id: 'r3', params: { session_id: 'session-a', cron_id: 'deadbeef' },
    }, reply);

    expect(sessionService.get).toHaveBeenCalledTimes(3);
    expect(rpc.resumeSession).toHaveBeenCalledTimes(3);
    expect(rpc.listCron).toHaveBeenCalledWith({ sessionId: 'session-a', agentId: 'main' });
    expect(rpc.createCron).toHaveBeenCalledWith({
      sessionId: 'session-a', agentId: 'main', cron: '*/5 * * * *', prompt: 'Check build', recurring: true,
    });
    expect(rpc.deleteCron).toHaveBeenCalledWith({ sessionId: 'session-a', agentId: 'main', id: 'deadbeef' });
    expect(sent.map((item) => (item as { code: number }).code)).toEqual([0, 0, 0]);
  });

  it('maps transport-stable request and session errors without hiding internal failures', async () => {
    const { handlers, rpc } = routeHarness();
    const reply = { send: vi.fn() };
    const request = {
      id: 'request-error',
      params: { session_id: 'session-a' },
      body: { cron: '* * * * *', prompt: 'Run', recurring: true },
    };

    rpc.createCron.mockRejectedValueOnce(new KimiError(ErrorCodes.REQUEST_INVALID, 'Invalid cron'));
    await handlers.get('POST /sessions/:session_id/cron')?.(request, reply);
    expect(reply.send).toHaveBeenLastCalledWith(expect.objectContaining({ code: 40001, msg: 'Invalid cron' }));

    rpc.createCron.mockRejectedValueOnce(new KimiError(ErrorCodes.SESSION_NOT_FOUND, 'Missing session'));
    await handlers.get('POST /sessions/:session_id/cron')?.(request, reply);
    expect(reply.send).toHaveBeenLastCalledWith(expect.objectContaining({ code: 40401, msg: 'Missing session' }));

    rpc.createCron.mockRejectedValueOnce(new Error('scheduler storage failed'));
    await expect(handlers.get('POST /sessions/:session_id/cron')?.(request, reply))
      .rejects.toThrow('scheduler storage failed');
  });
});

function routeHarness() {
  const handlers = new Map<string, (req: any, reply: any) => Promise<void>>();
  const app = {
    get: (path: string, _options: object, handler: any) => handlers.set(`GET ${path}`, handler),
    post: (path: string, _options: object, handler: any) => handlers.set(`POST ${path}`, handler),
    delete: (path: string, _options: object, handler: any) => handlers.set(`DELETE ${path}`, handler),
  };
  const sessionService = { get: vi.fn(async () => ({ id: 'session-a' })) };
  const rpc = {
    resumeSession: vi.fn(async () => ({})),
    listCron: vi.fn(async () => []),
    createCron: vi.fn(async () => ({})),
    deleteCron: vi.fn(async () => ({ deleted: true as const })),
  };
  const ix = {
    invokeFunction: (callback: (accessor: { get(token: unknown): unknown }) => unknown) => callback({
      get: (token) => token === ISessionService ? sessionService : token === ICoreProcessService ? { rpc } : undefined,
    }),
  };
  registerCronRoutes(app as never, ix as never);
  return { handlers, rpc };
}
