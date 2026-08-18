import type { BackgroundTaskInfo } from '../background';

import GOAL_BACKGROUND_IDLE_WAKE_PROMPT_RAW from './goal-background-idle.md?raw';

/** Default when `loop_control.goal_background_idle_minutes` is unset. */
export const DEFAULT_GOAL_BACKGROUND_IDLE_MINUTES = 5;

/** Origin name for the idle-timeout force wake (UI shows as context injection). */
export const GOAL_BACKGROUND_IDLE_WAKE_ORIGIN_NAME = 'goal_background_idle_wake';

export const GOAL_BACKGROUND_IDLE_WAKE_PROMPT = GOAL_BACKGROUND_IDLE_WAKE_PROMPT_RAW.trim();

/**
 * Resolve the configured idle minutes.
 * - `undefined` → default 5
 * - `0` → timeout wake disabled (immediate goal continuation is still suppressed)
 * - `>0` → force-wake after that many minutes without background reaction
 */
export function resolveGoalBackgroundIdleMinutes(
  configured: number | undefined,
): number {
  if (configured === undefined) return DEFAULT_GOAL_BACKGROUND_IDLE_MINUTES;
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_GOAL_BACKGROUND_IDLE_MINUTES;
  return Math.floor(configured);
}

/** True when BackgroundManager still has non-terminal tasks. */
export function hasUnfinishedBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[],
): boolean {
  return tasks.length > 0;
}

/**
 * Goal should not immediately re-invoke the main model solely to continue
 * when unfinished background work exists.
 */
export function shouldSuppressGoalContinuationForBackground(
  unfinishedBackgroundTasks: readonly BackgroundTaskInfo[],
): boolean {
  return hasUnfinishedBackgroundTasks(unfinishedBackgroundTasks);
}
