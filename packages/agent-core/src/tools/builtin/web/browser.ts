import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { BrowserActionRequest, BrowserExecutor } from '../../support/services';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern } from '../../support/rule-match';
import DESCRIPTION from './browser.md?raw';

export const BrowserInputSchema = z.object({
  action: z.enum([
    'snapshot',
    'navigate',
    'click',
    'type',
    'upload',
    'keypress',
    'scroll',
    'wait',
    'screenshot',
    'back',
    'forward',
    'reload',
    'retry',
    'get_console',
    'get_network',
    'download_list',
    'permission_list',
    'dialog_list',
    'dialog_respond',
    'annotation_list',
  ]),
  tab_id: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  text: z.string().optional(),
  key: z.string().min(1).optional(),
  x: z.number().finite().nonnegative().optional(),
  y: z.number().finite().nonnegative().optional(),
  delta_x: z.number().finite().optional(),
  delta_y: z.number().finite().optional(),
  timeout_ms: z.number().int().min(0).max(30_000).optional(),
  clear: z.boolean().optional(),
  paths: z.array(z.string().min(1)).min(1).max(20).optional(),
  dialog_id: z.string().min(1).optional(),
  accept: z.boolean().optional(),
  prompt_text: z.string().optional(),
  filter: z.string().optional(),
}).strict();

export type BrowserInput = z.infer<typeof BrowserInputSchema>;

export class BrowserTool implements BuiltinTool<BrowserInput> {
  readonly name = 'Browser' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BrowserInputSchema);

  constructor(
    private readonly browser: BrowserExecutor,
    private readonly supportsImageInput = true,
  ) {}

  resolveExecution(args: BrowserInput): ToolExecution {
    const validationError = validateAction(args);
    if (validationError !== undefined) return { output: validationError, isError: true };
    if (args.action === 'screenshot' && !this.supportsImageInput) {
      return {
        output: 'The current model does not support screenshot input. Use Browser snapshot instead.',
        isError: true,
      };
    }
    const subject = actionSubject(args);
    return {
      accesses: browserAccesses(args),
      description: `Browser ${args.action}${subject === '' ? '' : `: ${subject}`}`,
      approvalRule: literalRulePattern(this.name, `${args.action} ${subject}`.trim()),
      execute: (ctx) => this.execute(args, ctx),
    };
  }

  private async execute(
    args: BrowserInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const request: BrowserActionRequest = {
      action: args.action,
      tabId: args.tab_id,
      url: args.url,
      ref: args.ref,
      text: args.text,
      key: args.key,
      x: args.x,
      y: args.y,
      deltaX: args.delta_x,
      deltaY: args.delta_y,
      timeoutMs: args.timeout_ms,
      clear: args.clear,
      paths: args.paths,
      dialogId: args.dialog_id,
      accept: args.accept,
      promptText: args.prompt_text,
      filter: args.filter,
    };
    try {
      const result = await this.browser.execute(request, {
        toolCallId: context.toolCallId,
        signal: context.signal,
      });
      if (!result.ok) return { output: result.output, isError: true };
      if (result.screenshotDataUrl !== undefined) {
        return {
          output: [
            { type: 'text', text: result.output },
            { type: 'image_url', imageUrl: { url: result.screenshotDataUrl } },
          ],
        };
      }
      return { output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Browser action failed: ${message}`, isError: true };
    }
  }
}

function browserAccesses(input: BrowserInput) {
  if (input.action === 'upload') {
    return (input.paths ?? []).map(path => ({ kind: 'file' as const, operation: 'read' as const, path }));
  }
  if (input.action !== 'navigate' || input.url === undefined) return ToolAccesses.none();
  try {
    const url = new URL(input.url);
    if (url.protocol === 'file:') return ToolAccesses.readFile(fileURLToPath(url));
  } catch {
    if (isAbsolute(input.url)) return ToolAccesses.readFile(input.url);
  }
  return ToolAccesses.none();
}

function validateAction(input: BrowserInput): string | undefined {
  if (input.action === 'navigate' && input.url === undefined) return 'navigate requires url.';
  if (input.action === 'click' && input.ref === undefined && (input.x === undefined || input.y === undefined)) {
    return 'click requires ref or both x and y.';
  }
  if (input.action === 'type' && (input.ref === undefined || input.text === undefined)) {
    return 'type requires ref and text.';
  }
  if (input.action === 'upload' && (input.ref === undefined || input.paths === undefined || input.paths.length === 0)) {
    return 'upload requires ref and paths.';
  }
  if (input.action === 'keypress' && input.key === undefined) return 'keypress requires key.';
  if (input.action === 'dialog_respond' && (input.dialog_id === undefined || input.accept === undefined)) {
    return 'dialog_respond requires dialog_id and accept.';
  }
  return undefined;
}

function actionSubject(input: BrowserInput): string {
  return input.url ?? input.ref ?? input.dialog_id ?? input.paths?.join(', ') ?? input.key ?? input.text?.slice(0, 80) ?? '';
}
