import type { ContentPart, Message } from '@nori-code/kosong';

import type { SkillSource } from '../../skill';
import type { BackgroundTaskStatus } from '../background';

export interface UserPromptOrigin {
  readonly kind: 'user';
  /** The host explicitly requested goal-loop intake for this prompt. */
  readonly goalIntake?: boolean;
  /** The default model-facing speaker for direct human input. */
  readonly speaker?: SpeakerOrigin;
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = {
  kind: 'user',
  speaker: { from: 'user', speakerName: '用户' },
};

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string | undefined;
  readonly skillPath?: string | undefined;
  readonly skillSource?: SkillSource | undefined;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string | undefined;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  /** Only present on `phase: 'output'` — whether the command failed, so replay
   *  can colour stderr red only for actual failures (not warnings). */
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
  /**
   * Durable ordering marker for a human-visible team discussion statement.
   * It is transcript metadata only; model projection deliberately omits it.
   */
  readonly discussionEntryId?: number;
  /** Durable idempotency marker for a team-discussion lifecycle notice. */
  readonly discussionLifecycleNoticeId?: string;
  /** Durable round number for visible team-discussion transcript events. */
  readonly discussionRound?: number;
  /** Optional skip reason for a visible discussion abstention marker. */
  readonly discussionSkipReason?: string;
  /** Tool name attached to a visible member-side Discuss failure. */
  readonly discussionToolName?: string;
}

/**
 * Identifies a message produced by a participant rather than by the current
 * agent. Human submissions retain the existing `kind: 'user'` origin so Goal
 * checkpoints and UserPrompt hooks keep their established semantics.
 */
export type SpeakerKind = 'user' | 'lead' | 'team' | 'sub' | 'system';

export interface SpeakerOrigin {
  readonly from: SpeakerKind;
  readonly speakerId?: string;
  readonly speakerName?: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly notificationId: string;
  /** Model-facing identity for detached SubAgent completion notifications. */
  readonly speaker?: SpeakerOrigin;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  /** Number of theoretical fires that were collapsed into this single delivery (>= 1). */
  readonly coalescedCount: number;
  /** True for recurring tasks past the 7-day age threshold. */
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  /** Number of one-shot tasks bundled into this missed-fire notification. */
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export type PromptOrigin = (
  | UserPromptOrigin
  | SkillActivationOrigin
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin
) & {
  /** Optional model-facing identity without changing origin lifecycle semantics. */
  readonly speaker?: SpeakerOrigin;
};

export type ContextMessage = Message & {
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
};

export interface UserMessageRecord {
  content: readonly ContentPart[];
  origin: PromptOrigin;
}

export interface SystemReminderRecord {
  content: string;
  origin: PromptOrigin;
}

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}
