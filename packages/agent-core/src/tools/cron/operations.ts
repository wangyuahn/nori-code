import type { CronManager } from '../../agent/cron';
import { ErrorCodes, KimiError } from '../../errors';
import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
  type ParsedCronExpression,
} from './cron-expr';
import {
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from './jitter';
import type { CronCreateRequest, CronTask, CronTaskDetails } from './types';

export const MAX_CRON_JOBS_PER_SESSION = 50;
export const MAX_CRON_PROMPT_BYTES = 8 * 1024;
const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CRON_ID_PATTERN = /^[0-9a-f]{8}$/;

export class CronOperationError extends KimiError {
  constructor(message: string) {
    super(ErrorCodes.REQUEST_INVALID, message);
    this.name = 'CronOperationError';
  }
}

interface PreparedCronCreate {
  readonly cron: string;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly parsed: ParsedCronExpression;
}

export function prepareCronCreate(
  manager: CronManager,
  input: CronCreateRequest,
): PreparedCronCreate {
  if (process.env['NORI_DISABLE_CRON'] === '1') {
    throw new CronOperationError('Cron scheduling is disabled (NORI_DISABLE_CRON=1).');
  }

  const cron = input.cron.trim().split(/\s+/).join(' ');
  let parsed: ParsedCronExpression;
  try {
    parsed = parseCronExpression(cron);
  } catch (error) {
    throw new CronOperationError(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const now = manager.clocks.wallNow();
  if (!hasFireWithinYears(parsed, 5, now)) {
    throw new CronOperationError(
      `Cron expression ${JSON.stringify(cron)} has no fire within 5 years; refusing to schedule.`,
    );
  }
  if (manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
    throw new CronOperationError(
      `Cron job cap reached (max ${String(MAX_CRON_JOBS_PER_SESSION)} per session).`,
    );
  }
  if (input.prompt.trim().length === 0) {
    throw new CronOperationError('Prompt must not be empty.');
  }
  const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
  if (promptBytes > MAX_CRON_PROMPT_BYTES) {
    throw new CronOperationError(
      `Prompt exceeds ${String(MAX_CRON_PROMPT_BYTES)} bytes (got ${String(promptBytes)}).`,
    );
  }

  const recurring = input.recurring !== false;
  if (!recurring) {
    const firstFire = computeNextCronRun(parsed, now);
    if (firstFire !== null && firstFire - now > ONE_SHOT_MAX_FUTURE_MS) {
      throw new CronOperationError(
        `One-shot cron ${JSON.stringify(cron)} would fire more than a year from now. Pick a future date closer to today or use wildcards.`,
      );
    }
  }

  return { cron, prompt: input.prompt, recurring, parsed };
}

export function createCronTask(
  manager: CronManager,
  input: CronCreateRequest,
): CronTaskDetails {
  const prepared = prepareCronCreate(manager, input);
  const task = manager.addTask({
    cron: prepared.cron,
    prompt: prepared.prompt,
    recurring: prepared.recurring,
  });
  manager.emitScheduled(task);
  return projectCronTask(manager, task, prepared.parsed);
}

export function listCronTasks(manager: CronManager): readonly CronTaskDetails[] {
  return manager.store.list().map((task) => projectCronTask(manager, task));
}

export function deleteCronTask(manager: CronManager, id: string): void {
  if (!CRON_ID_PATTERN.test(id)) {
    throw new CronOperationError(
      `Invalid cron job id ${JSON.stringify(id)}; it must be 8 lowercase hex characters.`,
    );
  }
  if (manager.removeTasks([id]).length === 0) {
    throw new CronOperationError(`No cron job with id ${id}.`);
  }
  manager.emitDeleted(id);
}

function projectCronTask(
  manager: CronManager,
  task: CronTask,
  knownParsed?: ParsedCronExpression,
): CronTaskDetails {
  const now = manager.clocks.wallNow();
  let humanSchedule = task.cron;
  let nextFireAt: number | null = null;
  try {
    const parsed = knownParsed ?? parseCronExpression(task.cron);
    humanSchedule = cronToHuman(parsed);
    nextFireAt = knownParsed === undefined
      ? manager.getNextFireForTask(task.id)
      : nextFireForNewTask(task, parsed, now);
  } catch {
    // Keep the raw expression visible for a malformed persisted record.
  }
  const ageMs = now - task.createdAt;
  return {
    ...task,
    recurring: task.recurring !== false,
    humanSchedule,
    nextFireAt,
    ageDays: Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0,
    stale: manager.isStale(task),
  };
}

function nextFireForNewTask(
  task: CronTask,
  parsed: ParsedCronExpression,
  now: number,
): number | null {
  const ideal = computeNextCronRun(parsed, now);
  if (ideal === null) return null;
  return task.recurring === false
    ? oneShotJitteredNextCronRunMs(task, ideal)
    : jitteredNextCronRunMs(task, parsed, ideal);
}
