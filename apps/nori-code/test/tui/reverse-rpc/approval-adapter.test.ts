import { describe, expect, it } from 'vitest';

import { adaptApprovalRequest, adaptPanelResponse } from '#/tui/reverse-rpc/approval/adapter';

describe('approval adapter', () => {
  it('adapts generic command displays into shell blocks with approval choices', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-1',
        toolName: 'Bash',
        action: 'run',
        display: {
          kind: 'generic',
          summary: 'run',
          detail: {
            command: 'sudo rm -rf /tmp/cache',
            cwd: '/tmp',
          },
        },
      },
    );

    expect(adapted).toMatchObject({
      id: 'tc-1',
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      display: [
        {
          type: 'shell',
          language: 'bash',
          command: 'sudo rm -rf /tmp/cache',
          cwd: '/tmp',
          danger: 'recursive delete',
        },
      ],
    });
    expect(adapted.choices.map((choice) => choice.label)).toEqual([
      'Approve once',
      'Approve for this session',
      'Reject',
      'Reject with feedback',
    ]);
  });

  it('emits one file operation block for Edit line operations', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-edit',
        toolName: 'Edit',
        action: 'edit',
        display: {
          kind: 'generic',
          summary: 'edit',
          detail: {
            file_path: 'src/foo.ts',
            expected_tag: 'a1b2',
            line_ops: [{ op: 'swap', start: 2, end: 2, content: 'B' }],
          },
        },
      },
    );

    expect(adapted.display).toEqual([{
      type: 'file_op',
      operation: 'edit',
      path: 'src/foo.ts',
      detail: 'Expected tag: A1B2\nreplace lines 2-2\n+ B',
    }]);
  });

  it('emits a file_content block for Write so the new file previews as code, not diff', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-write',
        toolName: 'Write',
        action: 'write',
        display: {
          kind: 'generic',
          summary: 'write',
          detail: {
            file_path: 'src/new.ts',
            content: 'export const x = 1;\nexport const y = 2;',
          },
        },
      },
    );

    expect(adapted.display).toEqual([
      {
        type: 'file_content',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    ]);
  });

  // The builtin Write tool emits its display as file_io (operation=write) with
  // the file content alongside the path, so the approval panel can show — and
  // ctrl+e expand — the bytes about to land on disk.
  it('emits a file_content block for file_io write with content', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-write-io',
      toolName: 'Write',
      action: 'Writing src/new.ts',
      display: {
        kind: 'file_io',
        operation: 'write',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    });

    expect(adapted.display).toEqual([
      {
        type: 'file_content',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    ]);
  });

  // The builtin Edit tool emits its display as file_io (operation=edit) with
  // its hash-anchored operation summary alongside the path.
  it('emits a file operation block for file_io edit metadata', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-edit-io',
      toolName: 'Edit',
      action: 'Editing src/foo.ts',
      display: {
        kind: 'file_io',
        operation: 'edit',
        path: 'src/foo.ts',
        detail: 'Expected tag: A1B2\nreplace lines 2-2\n+ B',
      },
    });

    expect(adapted.display).toEqual([{
      type: 'file_op',
      operation: 'edit',
      path: 'src/foo.ts',
      detail: 'Expected tag: A1B2\nreplace lines 2-2\n+ B',
    }]);
  });

  // Read/Glob/Grep have no content to preview, so file_io without
  // content/before/after still collapses to a path-only file_op row.
  it('keeps a path-only file_op block for file_io without preview fields', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-read',
      toolName: 'Read',
      action: 'Reading src/foo.ts',
      display: {
        kind: 'file_io',
        operation: 'read',
        path: 'src/foo.ts',
      },
    });

    expect(adapted.display).toEqual([
      { type: 'file_op', operation: 'read', path: 'src/foo.ts', detail: undefined },
    ]);
  });

  it('renders the /goal start menu for a CreateGoal approval in manual mode', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-goal',
      toolName: 'CreateGoal',
      action: 'Creating a goal',
      display: {
        kind: 'goal_start',
        objective: 'Fix the failing auth tests',
        completionCriterion: 'npm test -- auth exits 0',
        mode: 'manual',
      },
    });

    // Objective + criterion are previewed as a brief block.
    expect(adapted.display).toEqual([
      {
        type: 'brief',
        text: 'Start goal: Fix the failing auth tests\nDone when: npm test -- auth exits 0',
      },
    ]);
    // Choices mirror the manual-mode /goal start menu; mode options approve and
    // carry the mode in selected_label, "Do not start" cancels. Each keeps the
    // /goal menu's description.
    expect(adapted.choices).toEqual([
      {
        label: 'Switch to Auto and start',
        response: 'approved',
        selected_label: 'auto',
        description:
          'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically, and questions are skipped.',
      },
      {
        label: 'Switch to YOLO and start',
        response: 'approved',
        selected_label: 'yolo',
        description:
          'Tools and plan changes are approved automatically. Kimi Code may still ask you questions.',
      },
      {
        label: 'Start in Manual',
        response: 'approved',
        selected_label: 'manual',
        description:
          'Keep approvals on. Kimi Code will ask before risky actions, so the goal may stop and wait for you.',
      },
      {
        label: 'Do not start',
        response: 'cancelled',
        selected_label: 'cancel',
        description: 'Return to the input box with your goal command.',
      },
    ]);
  });

  it('renders the yolo-mode /goal start menu for a CreateGoal approval', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-goal-yolo',
      toolName: 'CreateGoal',
      action: 'Creating a goal',
      display: {
        kind: 'goal_start',
        objective: 'Ship the feature',
        mode: 'yolo',
      },
    });

    expect(adapted.display).toEqual([{ type: 'brief', text: 'Start goal: Ship the feature' }]);
    expect(adapted.choices).toEqual([
      {
        label: 'Switch to Auto and start',
        response: 'approved',
        selected_label: 'auto',
        description:
          'Best if you want Kimi Code to keep working while you are away. Tools are approved automatically, and questions are skipped.',
      },
      {
        label: 'Keep YOLO and start',
        response: 'approved',
        selected_label: 'yolo',
        description:
          'Tools and plan changes stay approved automatically. Kimi Code may still ask you questions.',
      },
      {
        label: 'Do not start',
        response: 'cancelled',
        selected_label: 'cancel',
        description: 'Return to the input box with your goal command.',
      },
    ]);
  });

  it('maps approved-for-session responses into core approval payloads', () => {
    expect(
      adaptPanelResponse({
        response: 'approved_for_session',
        feedback: 'looks good',
        selected_label: 'Approve for this session',
      }),
    ).toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
      selectedLabel: 'Approve for this session',
    });
  });
});
