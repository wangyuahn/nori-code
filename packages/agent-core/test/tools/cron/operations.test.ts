import { afterEach, describe, expect, it } from 'vitest';

import { CronManager } from '../../../src/agent/cron/manager';
import {
  CronOperationError,
  createCronTask,
  deleteCronTask,
  listCronTasks,
} from '../../../src/tools/cron/operations';
import { createAgentStub, createClocks } from '../../agent/cron/harness/stub';

const managers: CronManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
});

describe('Cron management operations', () => {
  it('creates, projects, and deletes the same scheduler-backed task', () => {
    const stub = createAgentStub();
    const manager = new CronManager(stub.agent, {
      clocks: createClocks().clocks,
      pollIntervalMs: null,
    });
    managers.push(manager);

    const created = createCronTask(manager, {
      cron: '*/5 * * * *',
      prompt: 'Check the build',
      recurring: true,
    });

    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
    expect(created.humanSchedule).toBe('every 5 minutes');
    expect(created.nextFireAt).not.toBeNull();
    expect(listCronTasks(manager)).toEqual([created]);
    expect(stub.telemetryCalls.map((call) => call.event)).toContain('cron_scheduled');

    deleteCronTask(manager, created.id);
    expect(listCronTasks(manager)).toEqual([]);
    expect(stub.telemetryCalls.map((call) => call.event)).toContain('cron_deleted');
  });

  it('rejects invalid expressions before mutating the store', () => {
    const manager = new CronManager(createAgentStub().agent, { pollIntervalMs: null });
    managers.push(manager);

    expect(() => createCronTask(manager, {
      cron: 'not a cron',
      prompt: 'Do something',
    })).toThrow(CronOperationError);
    expect(listCronTasks(manager)).toEqual([]);
  });
});
