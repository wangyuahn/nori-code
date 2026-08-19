import type { Agent } from '../..';
import type { PermissionPolicy } from '../types';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from './auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicy } from './default-tool-approve';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import {
  GitControlPathAccessAskPermissionPolicy,
  SensitiveFileAccessAskPermissionPolicy,
} from './file-access-ask';
import { GitCwdWriteApprovePermissionPolicy } from './git-cwd-write-approve';
import { GoalStartReviewAskPermissionPolicy } from './goal-start-review-ask';
import { DiscussModeGuardDenyPermissionPolicy } from './discuss-mode-guard-deny';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';
import { ModeApprovePermissionPolicy } from './mode-approve';
import { ReadonlyPermissionPolicy } from './tools-readonly-deny';

/** Permission policies run in order; the first non-undefined result wins. */
export function createPermissionDecisionPolicies(agent: Agent): PermissionPolicy[] {
  return [
    // PreToolUse hook returned a block → deny.
    new PreToolCallHookPermissionPolicy(agent),
    // auto mode + AskUserQuestion → deny.
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    // Discuss: Write/Edit/Bash/SubAgent and related mutating tools → deny.
    new DiscussModeGuardDenyPermissionPolicy(agent),
    // tools_readonly: deny Write/Edit/Bash when readonly is active.
    new ReadonlyPermissionPolicy(agent),
    // User-configured deny rule matches → deny.
    new UserConfiguredDenyPermissionPolicy(agent),
    // auto mode → approve (any auto-mode block must be a deny rule above this).
    new ModeApprovePermissionPolicy(agent, 'auto', 'auto-mode-approve'),
    // yolo mode → approve before any policy that can ask. Explicit hard deny
    // rules above still apply, but yolo never opens an approval prompt.
    new ModeApprovePermissionPolicy(agent, 'yolo', 'yolo-mode-approve'),
    // Approve-for-session memorized rule matches → approve. Runs before user-configured ask rules so an in-session grant beats a still-matching ask rule on later calls.
    new SessionApprovalHistoryPermissionPolicy(agent),
    // User-configured ask rule matches → ask.
    new UserConfiguredAskPermissionPolicy(agent),
    // User-configured allow rule matches → approve.
    new UserConfiguredAllowPermissionPolicy(agent),
    // CreateGoal (non-auto) → ask with the same start menu as /goal: choose the
    // permission mode to run the goal under, or decline. Applies the mode, then
    // lets the tool create the goal.
    new GoalStartReviewAskPermissionPolicy(agent),
    // Access touches a sensitive file (.env, SSH key, credentials) → ask.
    new SensitiveFileAccessAskPermissionPolicy(),
    // Access touches .git or a git control-dir path → ask.
    new GitControlPathAccessAskPermissionPolicy(agent),
    // Tool is in the default-approve list (read-only / UI helpers) → approve.
    new DefaultToolApprovePermissionPolicy(),
    // Write/Edit on POSIX paths inside cwd inside a git work tree → approve.
    new GitCwdWriteApprovePermissionPolicy(agent),
    // Nothing matched → ask.
    new FallbackAskPermissionPolicy(),
  ];
}
