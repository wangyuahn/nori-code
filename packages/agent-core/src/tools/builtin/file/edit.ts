/**
 * EditTool - hash-anchored line operations for an existing text file.
 *
 * Every call is tied to the four-hex tag returned by Read. All line numbers
 * refer to that original snapshot, and every operation is preflighted before
 * one write commits the resulting file.
 */

import { computeContentTag, type Kaos } from '@nori-code/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { summarizeChangedLines, type CodeChangeReporter } from './change-summary';
import EDIT_DESCRIPTION from './edit.md?raw';
import { materializeModelText, toModelTextView } from './line-endings';

const LineNumberSchema = z.number().int().min(1);
const FinalContentSchema = z
  .string()
  .describe('Final replacement or insertion content. Use LF between lines and omit unchanged context.');

export const EditLineOperationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('swap'),
      start: LineNumberSchema.describe('First original line to replace, inclusive.'),
      end: LineNumberSchema.describe('Last original line to replace, inclusive.'),
      content: FinalContentSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('del'),
      start: LineNumberSchema.describe('First original line to delete, inclusive.'),
      end: LineNumberSchema.describe('Last original line to delete, inclusive.'),
    })
    .strict(),
  z
    .object({
      op: z.literal('insert_pre'),
      line: LineNumberSchema.describe('Original line before which content is inserted.'),
      content: FinalContentSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('insert_post'),
      line: LineNumberSchema.describe('Original line after which content is inserted.'),
      content: FinalContentSchema,
    })
    .strict(),
]);

export const EditInputSchema = z
  .object({
    path: z
      .string()
      .describe(
        'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
      ),
    expected_tag: z
      .string()
      .regex(/^[0-9A-Fa-f]{4}$/)
      .describe('Four-hex content tag from the latest Read output for this file.'),
    line_ops: z
      .array(EditLineOperationSchema)
      .min(1)
      .describe('Atomic line operations whose coordinates all refer to the tagged original file.'),
  })
  .strict();

export type EditLineOperation = z.infer<typeof EditLineOperationSchema>;
export type EditInput = z.infer<typeof EditInputSchema>;

interface RangeOperation {
  readonly op: 'swap' | 'del';
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

class LineOperationError extends Error {}

export class EditTool implements BuiltinTool<EditInput> {
  readonly name = 'Edit' as const;
  readonly description = EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    private readonly reportChange?: CodeChangeReporter,
  ) {}

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        detail: formatLineOperations(args),
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: (context) => this.execution(args, path, context),
    };
  }

  private async execution(
    args: EditInput,
    safePath: string,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const raw = await this.kaos.readText(safePath);
      const currentTag = computeContentTag(raw);
      if (currentTag !== args.expected_tag.toUpperCase()) {
        return {
          isError: true,
          output:
            `Content tag mismatch for ${args.path}: expected ${args.expected_tag.toUpperCase()}, ` +
            `current ${currentTag}. Re-read the file and retry with the new tag and line numbers.`,
        };
      }

      const modelView = toModelTextView(raw);
      let newContent: string;
      try {
        newContent = applyLineOperations(modelView.text, args.line_ops);
      } catch (error) {
        if (error instanceof LineOperationError) {
          return {
            isError: true,
            output: `Invalid line_ops for ${args.path}: ${error.message}`,
          };
        }
        throw error;
      }

      if (newContent === modelView.text) {
        return { isError: true, output: `No changes to make in ${args.path}.` };
      }

      const materialized = materializeModelText(newContent, modelView.lineEndingStyle);
      await this.kaos.writeText(safePath, materialized);
      this.reportChange?.({
        operationId: context.toolCallId,
        operation: 'edit',
        path: args.path,
        diff: summarizeChangedLines(modelView.text, newContent),
        occurredAt: new Date().toISOString(),
      });

      const newTag = computeContentTag(materialized);
      const operationWord = args.line_ops.length === 1 ? 'operation' : 'operations';
      return {
        output:
          `[${args.path}#${newTag}]\n` +
          `Applied ${String(args.line_ops.length)} line ${operationWord} to ${args.path}.`,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${args.path} is not a file.` };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function applyLineOperations(content: string, operations: readonly EditLineOperation[]): string {
  const hasBom = content.startsWith('\uFEFF');
  const body = hasBom ? content.slice(1) : content;
  const endsWithNewline = body.endsWith('\n');
  const originalLines = splitFileLines(body, endsWithNewline);
  const lineCount = originalLines.length;
  if (lineCount === 0) {
    throw new LineOperationError('the file is empty; use Write to replace an empty file.');
  }

  const ranges: RangeOperation[] = [];
  const insertBefore = new Map<number, string[][]>();
  const insertAfter = new Map<number, string[][]>();

  for (const operation of operations) {
    if (operation.op === 'swap' || operation.op === 'del') {
      validateRange(operation.start, operation.end, lineCount);
      ranges.push({
        op: operation.op,
        start: operation.start,
        end: operation.end,
        lines: operation.op === 'swap' ? splitOperationContent(operation.content) : [],
      });
      continue;
    }

    validateLine(operation.line, lineCount);
    const target = operation.op === 'insert_pre' ? insertBefore : insertAfter;
    const entries = target.get(operation.line) ?? [];
    entries.push(splitOperationContent(operation.content));
    target.set(operation.line, entries);
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous !== undefined && current !== undefined && current.start <= previous.end) {
      throw new LineOperationError(
        `ranges ${String(previous.start)}-${String(previous.end)} and ` +
          `${String(current.start)}-${String(current.end)} overlap.`,
      );
    }
  }

  for (const range of ranges) {
    for (const line of insertBefore.keys()) {
      if (line > range.start && line <= range.end) {
        throw new LineOperationError(
          `insert_pre line ${String(line)} falls inside range ${String(range.start)}-${String(range.end)}.`,
        );
      }
    }
    for (const line of insertAfter.keys()) {
      if (line >= range.start && line < range.end) {
        throw new LineOperationError(
          `insert_post line ${String(line)} falls inside range ${String(range.start)}-${String(range.end)}.`,
        );
      }
    }
  }

  const rangeByStart = new Map(ranges.map((range) => [range.start, range]));
  const result: string[] = [];
  let line = 1;
  while (line <= lineCount) {
    appendInsertions(result, insertBefore.get(line));
    const range = rangeByStart.get(line);
    if (range !== undefined) {
      result.push(...range.lines);
      appendInsertions(result, insertAfter.get(range.end));
      line = range.end + 1;
      continue;
    }

    const original = originalLines[line - 1];
    if (original !== undefined) result.push(original);
    appendInsertions(result, insertAfter.get(line));
    line += 1;
  }

  const joined = result.join('\n');
  const nextBody = endsWithNewline && result.length > 0 ? `${joined}\n` : joined;
  return hasBom ? `\uFEFF${nextBody}` : nextBody;
}

function splitFileLines(content: string, endsWithNewline: boolean): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (endsWithNewline) lines.pop();
  return lines;
}

function splitOperationContent(content: string): string[] {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

function validateRange(start: number, end: number, lineCount: number): void {
  if (start > end) {
    throw new LineOperationError(`range start ${String(start)} is greater than end ${String(end)}.`);
  }
  validateLine(start, lineCount);
  validateLine(end, lineCount);
}

function validateLine(line: number, lineCount: number): void {
  if (line > lineCount) {
    throw new LineOperationError(
      `line ${String(line)} is outside the original file (1-${String(lineCount)}).`,
    );
  }
}

function appendInsertions(target: string[], groups: readonly string[][] | undefined): void {
  if (groups === undefined) return;
  for (const lines of groups) target.push(...lines);
}

function formatLineOperations(args: EditInput): string {
  const operations = args.line_ops.map((operation) => {
    switch (operation.op) {
      case 'swap':
        return `swap ${String(operation.start)}-${String(operation.end)}`;
      case 'del':
        return `delete ${String(operation.start)}-${String(operation.end)}`;
      case 'insert_pre':
        return `insert before ${String(operation.line)}`;
      case 'insert_post':
        return `insert after ${String(operation.line)}`;
    }
    throw new Error('Unsupported line operation.');
  });
  return [`Expected tag: ${args.expected_tag.toUpperCase()}`, ...operations].join('\n');
}
