import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { ApprovalRequest, ApprovalResponse } from '@nori-code/sdk';

import { displayBlockToAcpContent } from './convert';
import { acpToolCallId } from './events-map';

/**
 * Canonical option ids surfaced to the ACP client.
 *
 * The wire-level `PermissionOption.optionId` is opaque to the client (it
 * round-trips back in `RequestPermissionResponse.outcome.optionId`), so
 * the adapter is free to pick any stable string. These literals are the
 * single source of truth on both the build- and the parse-side; tests
 * import them rather than re-typing the strings.
 */
export const APPROVE_ONCE_OPTION_ID = 'approve_once';
export const APPROVE_ALWAYS_OPTION_ID = 'approve_always';
export const REJECT_OPTION_ID = 'reject';

/**
 * The three canonical permission options surfaced to the ACP client for
 * a standard approval prompt.
 *
 * Order is load-bearing: ACP clients (Zed at the time of writing) render
 * the options top-to-bottom, so allow-once is the primary action,
 * allow-always is the secondary, and reject is the terminal/dangerous
 * action that should be hardest to click by accident.
 *
 * The `kind` field is used by clients to choose icons / styling; the
 * `name` is the human-readable label that surfaces in the UI and is
 * the value that round-trips back via `ApprovalResponse.selectedLabel`
 * (Phase 5.2). The list is `readonly` because callers treat it as a
 * constant lookup table — they do not mutate it.
 */
const CANONICAL_OPTIONS: readonly PermissionOption[] = [
  { optionId: APPROVE_ONCE_OPTION_ID, name: 'Approve once', kind: 'allow_once' },
  {
    optionId: APPROVE_ALWAYS_OPTION_ID,
    name: 'Approve for this session',
    kind: 'allow_always',
  },
  { optionId: REJECT_OPTION_ID, name: 'Reject', kind: 'reject_once' },
];

/**
 * Build the {@link PermissionOption}[] surfaced to the ACP client for
 * an approval prompt.
 *
 * For every other display kind, the function returns the canonical
 * 3-option list (`Approve once` / `Approve for this session` / `Reject`)
 * — Phase 5's behaviour, preserved verbatim.
 *
 * The `req` parameter is optional so that older callsites (notably
 * callsites may omit the request when only canonical options are needed.
 */
export function approvalRequestToPermissionOptions(
  _req?: ApprovalRequest,
): readonly PermissionOption[] {
  return CANONICAL_OPTIONS;
}

/**
 * Translate an ACP {@link RequestPermissionResponse} into Kimi's
 * {@link ApprovalResponse}.
 *
 * Decision mapping:
 *  - `cancelled` outcome → `decision: 'cancelled'` (the client closed
 *    the prompt without selecting an option).
 *  - `approve_once`  → `decision: 'approved'` (no scope, one-shot).
 *  - `approve_always` → `decision: 'approved'` with `scope: 'session'`
 *    so the SDK installs a session-runtime allow rule for subsequent
 *    invocations of the same matcher.
 *  - `reject`        → `decision: 'rejected'`.
 *  - Any other optionId is treated as a defensive `rejected`: rejecting
 *    is strictly safer than approving for an unknown id.
 */
export function permissionResponseToApprovalResponse(
  _req: ApprovalRequest | undefined,
  response: RequestPermissionResponse,
): ApprovalResponse {
  if (response.outcome.outcome === 'cancelled') {
    return { decision: 'cancelled' };
  }
  const optionId = response.outcome.optionId;
  switch (optionId) {
    case APPROVE_ONCE_OPTION_ID:
    // Legacy Python kimi-cli (< v0.9.0) used 'approve' as the
    // allow-once optionId. Keep accepting it so custom ACP clients
    // built against the old SDK are not silently rejected.
    case 'approve':
      return { decision: 'approved' };
    case APPROVE_ALWAYS_OPTION_ID:
    // Legacy Python kimi-cli (< v0.9.0) used 'approve_for_session' as
    // the allow-always optionId. Same backward-compatibility rationale
    // as the 'approve' branch above.
    case 'approve_for_session':
      return { decision: 'approved', scope: 'session' };
    case REJECT_OPTION_ID:
      return { decision: 'rejected' };
    default:
      // Unknown optionId — defensive fallback. Reject is safer than
      // approve. Logging is the caller's responsibility (the mapper is
      // pure so unit tests don't need to mock a logger).
      return { decision: 'rejected' };
  }
}

/**
 * Build the ACP {@link ToolCallUpdate} that scopes a permission request
 * to a specific in-flight tool call.
 *
 * The `toolCallId` is the **prefixed** ACP wire id `${turnId}:${rawId}`
 * — matching the id format used by all other tool_call/tool_call_update
 * notifications — so the client can correlate the approval prompt with
 * the tool card it already rendered. If `turnId` is `undefined` (the
 * `onEvent` listener has not yet observed any turn-scoped event), the
 * raw SDK id is used as a defensive fallback. In practice approvals
 * always fire **after** `tool.call.started`, so the fallback is
 * effectively unreachable; it exists so the handler never throws.
 *
 * Content shape (Phase 5.2):
 *  - If `req.display` produces a diff-bearing entry via
 *    {@link displayBlockToAcpContent} (diff kind, or file_io with
 *    before+after), prepend it so the diff card is the headline of
 *    the approval prompt. Non-diff display kinds (command, search, …)
 *    contribute no structured content here — their information is
 *    already conveyed by the action text below.
 *  - Always append a human-readable action summary
 *    (`"Requesting approval to ${req.action}"`). This is the fallback
 *    surface in narrow notification UIs that cannot render the full
 *    diff card and matches the wording used by the Python reference.
 */
export function buildPermissionToolCallUpdate(
  turnId: number | undefined,
  req: ApprovalRequest,
): ToolCallUpdate {
  const toolCallId =
    turnId !== undefined ? acpToolCallId(turnId, req.toolCallId) : req.toolCallId;
  const content: ToolCallContent[] = [];
  // Diff entry first — diffs and file-io previews carry the most context.
  const headlineEntry = displayBlockToAcpContent(req.display);
  if (headlineEntry !== null) {
    content.push(headlineEntry);
  }
  // Always include the action summary so the prompt is never empty.
  content.push({
    type: 'content',
    content: { type: 'text', text: `Requesting approval to ${req.action}` },
  });
  return {
    toolCallId,
    title: req.toolName,
    content,
  };
}

/**
 * Look up the matched {@link PermissionOption}'s display name for the
 * given response and return a new {@link ApprovalResponse} carrying
 * `selectedLabel`. Returns the input unchanged when:
 *  - the outcome was `'cancelled'` (no option was matched), or
 *  - the `optionId` does not appear in the option table (defensive —
 *    matches the `permissionResponseToApprovalResponse` unknown→reject
 *    path), or
 *  - the response has already been mapped to `'cancelled'`, or
 *
 * Pure: returns a fresh object (never mutates the input) so callers
 * can stitch the label on top of the discriminator mapping without
 * worrying about TS strict-readonly fields.
 */
export function attachSelectedLabel(
  response: RequestPermissionResponse,
  approval: ApprovalResponse,
  options: readonly PermissionOption[],
): ApprovalResponse {
  const outcome = response.outcome;
  if (outcome.outcome !== 'selected') return approval;
  const matched = options.find((o) => o.optionId === outcome.optionId);
  if (!matched) return approval;
  return { ...approval, selectedLabel: matched.name };
}
