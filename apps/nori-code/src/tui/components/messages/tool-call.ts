/**
 * Renders a tool call entry in the transcript.
 * Supports expand/collapse via Ctrl+O.
 */

import { isAbsolute, relative, sep } from 'node:path';

import { Container, Spacer, Text } from '@nori-code/pi-tui';
import type { Component, TUI } from '@nori-code/pi-tui';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { COMMAND_PREVIEW_LINES, RESULT_PREVIEW_LINES } from '#/tui/constant/rendering';
import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from '#/tui/constant/streaming';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

import { ShellExecutionComponent } from './shell-execution';
import { countNonEmptyLines, pickChip } from './tool-renderers/chip';
import {
  editOperationLabel,
  parseEditLineOperations,
} from './tool-renderers/edit-line-ops';
import { buildGoalToolHeader } from './tool-renderers/goal';
import { pickResultRenderer } from './tool-renderers/registry';

const MAX_ARG_LENGTH = 60;
const STREAMING_PROGRESS_INTERVAL_MS = 1000;
const PROGRESS_URL_RE = /https?:\/\/\S+/g;
const MAX_LIVE_OUTPUT_CHARS = 50_000;

/** Delay before a long-running foreground Bash card advertises Ctrl+B. */
const DETACH_HINT_DELAY_MS = 10_000;
const DETACH_HINT_TEXT = 'Press Ctrl+B to run in background';

/**
 * Immutable Read tool state snapshot. `ReadGroupComponent` reads one-time
 * views via `ToolCallComponent.getReadSnapshot()` and sums lines for the group
 * header. `lines` is 0 while pending or failed, and the non-empty result line
 * count when done, matching the single-card chip.
 */
export interface ToolCallReadSnapshot {
  readonly toolCallId: string;
  readonly filePath: string | undefined;
  readonly phase: 'pending' | 'done' | 'failed';
  readonly lines: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function sanitizeToolResult(
  result: ToolResultBlockData | undefined,
): ToolResultBlockData | undefined {
  if (result === undefined) return undefined;
  return { ...result, output: sanitizeShellOutput(result.output) };
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

/**
 * Pull the live value of a JSON string field out of partially-streamed
 * arguments, even if the closing quote hasn't arrived yet. Handles the
 * common JSON string escapes so `\n` in a streamed `content` becomes a
 * real newline we can highlight. Returns `undefined` if the field hasn't
 * started streaming yet.
 */
function extractPartialStringField(text: string, key: string): string | undefined {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = opener.exec(text);
  if (match === null) return undefined;
  const start = match.index + match[0].length;
  let out = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return out;
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'u': {
          if (i + 5 >= text.length) return out;
          const hex = text.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          if (Number.isNaN(code)) return out;
          out += String.fromCodePoint(code);
          i += 6;
          continue;
        }
        default:
          out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i++;
  }
  return out;
}

const PATH_KEYS = new Set(['path', 'file_path']);

function truncateArgValue(key: string, value: string): string {
  if (value.length <= MAX_ARG_LENGTH) return value;
  if (PATH_KEYS.has(key)) {
    // Preserve the tail (filename) — drop the prefix so the user can
    // still tell which file is being touched.
    return '…' + value.slice(value.length - (MAX_ARG_LENGTH - 1));
  }
  return value.slice(0, MAX_ARG_LENGTH - 3) + '...';
}

function makeWorkspaceRelativePath(filePath: string, workspaceDir: string | undefined): string {
  if (workspaceDir === undefined || workspaceDir.length === 0 || !isAbsolute(filePath)) {
    return filePath;
  }
  const relativePath = relative(workspaceDir, filePath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return filePath;
  }
  return relativePath;
}

function formatKeyArgument(
  toolName: string,
  key: string,
  value: string,
  workspaceDir: string | undefined,
): string {
  const displayValue =
    toolName === 'Read' && PATH_KEYS.has(key)
      ? makeWorkspaceRelativePath(value, workspaceDir)
      : value;
  return truncateArgValue(key, displayValue);
}

function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const keyMap: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
  };

  // Glob: concatenate multiple args into a single summary so the header
  // shows pattern, optional explicit path, and ignored-file inclusion.
  if (toolName === 'Glob') {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0) return null;
    let summary = pattern;
    const path = args['path'];
    if (typeof path === 'string' && path.length > 0) {
      summary += ` · ${makeWorkspaceRelativePath(path, workspaceDir)}`;
    }
    if (args['include_ignored'] === true) {
      summary += ' · include ignored';
    }
    return truncateArgValue('pattern', summary);
  }

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      const displayValue =
        toolName === 'Bash' && val.includes('\n') ? `${firstLine}…` : firstLine;
      return formatKeyArgument(toolName, key, displayValue, workspaceDir);
    }
  }
  return null;
}

export class ToolCallComponent extends Container {
  private expanded = false;
  private toolCall: ToolCallBlockData;
  private readonly markdownTheme = createMarkdownTheme();
  private result: ToolResultBlockData | undefined;
  private ui: TUI | undefined;
  private headerText: Text;
  private callPreviewEndIndex = 0;
  private streamingProgressTimer: ReturnType<typeof setInterval> | undefined;


  // ── Live progress lines ──────────────────────────────────────────
  //
  // Populated by `appendProgress` whenever the tool emits an
  // `onUpdate({kind:'status', text})` while still running. Used by
  // long-blocking tools (e.g. the MCP `authenticate` synthetic tool
  // whose 15-minute browser wait would otherwise display only a
  // spinner). Cleared when the result lands — the result is the
  // authoritative final state.
  private progressLines: string[] = [];
  private static readonly MAX_PROGRESS_LINES = 24;
  private liveOutput = '';

  /**
   * Advertises `Ctrl+B` on a foreground Bash/Agent card that has been running
   * for {@link DETACH_HINT_DELAY_MS}. Cleared when the result lands.
   */
  private detachHintTimer: ReturnType<typeof setTimeout> | undefined;
  private detachHintVisible = false;

  /**
   * Registered by `ReadGroupComponent` when this component is borrowed as a
   * hidden state container. Any state change (result, progress, live output)
   * triggers a throttled group re-render. `undefined` means no group is
   * subscribed and standalone rendering is unaffected. A ToolCallComponent can
   * only belong to one group at a time, so one listener slot is enough.
   */
  private onSnapshotChange: (() => void) | undefined;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    ui?: TUI,
    private readonly workspaceDir?: string,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = sanitizeToolResult(result);
    this.ui = ui;

    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.syncStreamingProgressTimer();
    this.startDetachHintTimer();
  }

  private renderCache:
    | { width: number; lines: string[]; childRefs: Component[]; childLines: string[][] }
    | undefined;

  override render(width: number): string[] {
    const cache = this.renderCache;
    const cacheValid =
      isRenderCacheEnabled() &&
      cache !== undefined &&
      cache.width === width &&
      cache.childRefs.length === this.children.length;

    const childRefs: Component[] = [];
    const childLines: string[][] = [];
    let allReused = cacheValid;

    let i = 0;
    for (const child of this.children) {
      const lines = child.render(width);
      childRefs.push(child);
      childLines.push(lines);
      if (cacheValid && (cache.childRefs[i] !== child || cache.childLines[i] !== lines)) {
        allReused = false;
      }
      i++;
    }

    if (allReused) {
      return cache!.lines;
    }

    const out: string[] = [];
    for (const lines of childLines) {
      for (const line of lines) out.push(line);
    }
    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: out, childRefs, childLines };
    }
    return out;
  }

  override invalidate(): void {
    this.renderCache = undefined;
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    super.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.renderCache = undefined;
    // rebuildBody (not rebuildContent) so the args-driven call preview
    // — which is what carries Write content / Edit diff — re-renders
    // with the new line cap. rebuildContent only touches result-driven
    // children and would leave the call preview stuck at its initial
    // collapsed size.
    this.rebuildBody();
  }

  setResult(result: ToolResultBlockData): void {
    this.result = sanitizeToolResult(result);
    // Result supersedes any live progress chatter; the result body is the
    // authoritative final state. Without this clear, a finished tool would
    // show both the streamed status lines and the final output stacked.
    this.progressLines = [];
    this.liveOutput = '';
    this.detachHintVisible = false;
    this.stopDetachHintTimer();
    this.syncStreamingProgressTimer();
    this.headerText.setText(this.buildHeader());
    // rebuildBody (not rebuildContent) so the call preview re-renders
    // with the collapsed cap applied — Write streaming previews and
    // Edit's progress placeholder needs to snap to the final preview on
    // result.
    this.rebuildBody();
    // Final results affect group summaries, especially failed/done counts.
    this.notifySnapshotChange();
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
    this.syncStreamingProgressTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * Append a live progress line emitted by the tool via
   * `onUpdate({kind:'status', text})`. Splits on newlines so multi-line
   * status payloads render row-by-row. Old lines are dropped once the
   * buffer fills past {@link ToolCallComponent.MAX_PROGRESS_LINES} so a
   * misbehaving tool can't grow the box unboundedly.
   */
  appendProgress(text: string): void {
    if (this.result !== undefined) return;
    const cleanText = sanitizeShellOutput(text);
    if (cleanText.length === 0) return;
    for (const line of cleanText.split('\n')) {
      this.progressLines.push(line);
    }
    while (this.progressLines.length > ToolCallComponent.MAX_PROGRESS_LINES) {
      this.progressLines.shift();
    }
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendLiveOutput(text: string): void {
    if (this.result !== undefined || text.length === 0) return;
    const cleanText = sanitizeShellOutput(text);
    if (cleanText.length === 0) return;
    this.liveOutput += cleanText;
    if (this.liveOutput.length > MAX_LIVE_OUTPUT_CHARS) {
      this.liveOutput = `[...truncated]\n${this.liveOutput.slice(
        this.liveOutput.length - MAX_LIVE_OUTPUT_CHARS,
      )}`;
    }
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopStreamingProgressTimer();
    this.stopDetachHintTimer();
  }

  setDiscussInfo(_info: { summary?: string }): void {
    void _info;
  }

  /**
   * Lets `ReadGroupComponent` subscribe to this card's state changes.
   * Registration immediately calls back so the group receives the current
   * snapshot without separately calling `getReadSnapshot`. Pass `undefined` to
   * unsubscribe.
   */
  setSnapshotListener(cb: (() => void) | undefined): void {
    this.onSnapshotChange = cb;
    if (cb !== undefined) cb();
  }

  /**
   * Used by `ReadGroupComponent` to sum line counts across same-step Read
   * cards. `lines` matches the single-card chip
   * (`pluralize(countNonEmptyLines(...), 'line')`) so group and card counts do
   * not drift.
   */
  getReadSnapshot(): ToolCallReadSnapshot {
    const args = this.toolCall.args;
    const filePathRaw = args['file_path'] ?? args['path'];
    const filePath =
      typeof filePathRaw === 'string'
        ? makeWorkspaceRelativePath(filePathRaw, this.workspaceDir)
        : undefined;
    if (this.result === undefined) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'pending', lines: 0 };
    }
    if (this.result.is_error === true) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'failed', lines: 0 };
    }
    return {
      toolCallId: this.toolCall.id,
      filePath,
      phase: 'done',
      lines: countNonEmptyLines(this.result.output),
    };
  }

  // Readonly view for group access to toolCall metadata (id, name, description).
  get toolCallView(): Readonly<ToolCallBlockData> {
    return this.toolCall;
  }

  /** Notifies the listener when internal state changes, if a group is attached. */
  private notifySnapshotChange(): void {
    this.onSnapshotChange?.();
  }

  private isStreamingEditPreview(): boolean {
    return (
      this.toolCall.name === 'Edit' &&
      this.result === undefined &&
      this.toolCall.streamingArguments !== undefined
    );
  }

  private syncStreamingProgressTimer(): void {
    if (!this.isStreamingEditPreview()) {
      this.stopStreamingProgressTimer();
      return;
    }
    if (this.ui === undefined || this.streamingProgressTimer !== undefined) return;
    this.streamingProgressTimer = setInterval(() => {
      if (!this.isStreamingEditPreview()) {
        this.stopStreamingProgressTimer();
        return;
      }
      this.rebuildBody();
      this.ui?.requestRender();
    }, STREAMING_PROGRESS_INTERVAL_MS);
  }

  private stopStreamingProgressTimer(): void {
    if (this.streamingProgressTimer === undefined) return;
    clearInterval(this.streamingProgressTimer);
    this.streamingProgressTimer = undefined;
  }

  /** Only a foreground Bash call can be detached via Ctrl+B. */
  private isDetachHintEligible(): boolean {
    return this.toolCall.name === 'Bash';
  }

  private startDetachHintTimer(): void {
    if (!this.isDetachHintEligible()) return;
    if (this.result !== undefined) return;
    if (this.ui === undefined) return;
    if (this.detachHintTimer !== undefined) return;
    this.detachHintTimer = setTimeout(() => {
      this.detachHintTimer = undefined;
      if (this.result !== undefined) return;
      this.detachHintVisible = true;
      this.rebuildBody();
      this.ui?.requestRender();
    }, DETACH_HINT_DELAY_MS);
  }

  private stopDetachHintTimer(): void {
    if (this.detachHintTimer === undefined) return;
    clearTimeout(this.detachHintTimer);
    this.detachHintTimer = undefined;
  }

  private buildDetachHintBlock(): void {
    if (!this.detachHintVisible) return;
    if (this.result !== undefined) return;
    this.addChild(new Text(currentTheme.dim(DETACH_HINT_TEXT), 2, 0));
  }

  private buildHeader(): string {
    const { toolCall, result } = this;
    const isFinished = result !== undefined;
    const isError = result?.is_error ?? false;
    const isTruncated = toolCall.truncated === true && !isFinished;

    let bullet: string;
    if (isFinished) {
      bullet = isError ? currentTheme.fg('error', '✗ ') : currentTheme.fg('success', STATUS_BULLET);
    } else if (isTruncated) {
      bullet = currentTheme.fg('error', '✗ ');
    } else {
      // Solid bullet for in-flight tools — the previous marker ↔ blank
      // toggle caused visible flicker on every re-render.
      bullet = currentTheme.fg('text', STATUS_BULLET);
    }

    if (toolCall.name === 'AskUserQuestion') {
      const isBackgroundAsk = toolCall.args['background'] === true;
      const label = isFinished
        ? isError
          ? 'Could not collect your input'
          : isBackgroundAsk
            ? 'Started background question'
          : 'Collected your answers'
        : isBackgroundAsk
          ? 'Starting background question'
          : 'Waiting for your input';
      const tone = isError ? 'error' : 'primary';
      return `${bullet}${currentTheme.boldFg(tone, label)}`;
    }

    const goalHeader = buildGoalToolHeader({
      toolCall,
      result,
      bullet,
      chip: isFinished && result !== undefined ? this.buildHeaderChip(result) : '',
    });
    if (goalHeader !== undefined) return goalHeader;

    const verb = isFinished ? 'Used' : isTruncated ? 'Truncated' : 'Using';
    const keyArg = extractKeyArgument(toolCall.name, toolCall.args, this.workspaceDir);
    const decoded = decodeMcpToolName(toolCall.name);
    const verbStyled = isTruncated
      ? currentTheme.fg('error', verb)
      : verb;
    const toolLabel =
      decoded !== null
        ? `${currentTheme.boldFg('primary', decoded.toolName)}${currentTheme.dim(` · MCP/${decoded.serverName}`)}`
        : currentTheme.boldFg('primary', toolCall.name);
    const argStr = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
    let chipStr = '';
    if (isFinished && result) chipStr = this.buildHeaderChip(result);
    return `${bullet}${verbStyled} ${toolLabel}${argStr}${chipStr}`;
  }

  private buildHeaderChip(result: ToolResultBlockData): string {
    const provider = pickChip(this.toolCall.name);
    if (provider === undefined) return '';
    const text = provider(this.toolCall, result);
    if (text.length === 0) return '';
    if (result.is_error) return currentTheme.fg('error', ` · ${text}`);
    return currentTheme.dim(` · ${text}`);
  }

  private rebuildContent(): void {
    while (this.children.length > this.callPreviewEndIndex) {
      this.children.pop();
    }
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
  }

  private rebuildBody(): void {
    while (this.children.length > 2) {
      this.children.pop();
    }
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
  }

  /**
   * Render the accumulated `progressLines` between the call preview and
   * the result body. URLs inside a line are wrapped in an OSC 8 hyperlink
   * sequence so terminals that support it (iTerm2, Ghostty, kitty, modern
   * Terminal.app, VS Code) make the URL Cmd-clickable and expose
   * "Copy Link" via the context menu — even when pi-tui soft-wraps the
   * URL across multiple rows (pi-tui's wrapTextWithAnsi re-opens the
   * active OSC 8 link on each continuation line). Each embedded URL is
   * styled individually so surrounding prose keeps its default dim tone.
   */
  private buildProgressBlock(): void {
    if (this.progressLines.length === 0) return;
    if (this.result !== undefined) return;
    for (const raw of this.progressLines) {
      if (raw.length === 0) {
        this.addChild(new Text('', 2, 0));
        continue;
      }
      PROGRESS_URL_RE.lastIndex = 0;
      const styled = PROGRESS_URL_RE.test(raw)
        ? raw.replace(PROGRESS_URL_RE, (url) => {
          const visible = currentTheme.underlineFg('warning', url);
          return `\u001B]8;;${url}\u001B\\${visible}\u001B]8;;\u001B\\`;
        })
        : currentTheme.dim(raw);
      PROGRESS_URL_RE.lastIndex = 0;
      this.addChild(new Text(styled, 2, 0));
    }
  }

  private buildLiveOutputBlock(): void {
    if (this.result !== undefined) return;
    if (this.liveOutput.length === 0) return;
    this.addChild(
      new ShellExecutionComponent({
        result: {
          tool_call_id: this.toolCall.id,
          output: this.liveOutput,
          is_error: false,
        },
        expanded: this.expanded,
        resultPreviewLines: RESULT_PREVIEW_LINES,
        tailOutput: true,
        expandHint: false,
      }),
    );
  }

  private buildCallPreview(): void {
    const name = this.toolCall.name;
    if (this.result === undefined && this.toolCall.truncated === true) {
      this.addChild(
        new Text(
          currentTheme.dim('Tool call arguments truncated by max_tokens — call never executed.'),
          2,
          0,
        ),
      );
      return;
    }
    if (this.result === undefined && this.toolCall.streamingArguments !== undefined) {
      this.buildStreamingPreview(this.toolCall.streamingArguments);
      return;
    }
    const shouldCap = this.result !== undefined && !this.expanded;
    if (name === 'Write') {
      const content = str(this.toolCall.args['content']);
      if (content.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      // Cap as soon as args finalize, not just when result lands. Otherwise the
      // brief render tick between finalized args and result draws the full file,
      // and the snap back to the collapsed cap triggers pi-tui's full-redraw
      // path which wipes the terminal scrollback (pre-TUI history).
      const writeShouldCap = !this.expanded;
      const shown = writeShouldCap ? allLines.slice(0, COMMAND_PREVIEW_LINES) : allLines;
      const remaining = allLines.length - shown.length;
      for (const [i, line] of shown.entries()) {
        const lineNum = currentTheme.dim(String(i + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + line, 2, 0));
      }
      if (writeShouldCap && remaining > 0) {
        this.addChild(
          new Text(
            currentTheme.dim(
              `... (${String(remaining)} more lines, ${String(allLines.length)} total, ctrl+o to expand)`,
            ),
            2,
            0,
          ),
        );
      }
    } else if (name === 'Edit') {
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const operations = parseEditLineOperations(this.toolCall.args);
      if (operations.length === 0) return;
      const lang = langFromPath(filePath);
      const allLines: string[] = [];
      for (const operation of operations) {
        allLines.push(currentTheme.dim(editOperationLabel(operation)));
        if (operation.op === 'del') continue;
        for (const contentLine of highlightLines(operation.content, lang)) {
          allLines.push(currentTheme.fg('success', '+ ') + contentLine);
        }
      }
      const lines = shouldCap ? allLines.slice(0, COMMAND_PREVIEW_LINES) : allLines;
      for (const line of lines) {
        this.addChild(new Text(line, 2, 0));
      }
      if (shouldCap && allLines.length > lines.length) {
        this.addChild(
          new Text(
            currentTheme.dim(
              `... (${String(allLines.length - lines.length)} more lines, ctrl+o to expand)`,
            ),
            2,
            0,
          ),
        );
      }
    } else if (name === 'Bash' && this.result === undefined) {
      // While a long-running Bash call is in-flight (args finalized, no result
      // yet), surface its command in the body so the user can see what is
      // running and expand it with ctrl+o. Once the result lands, buildContent's
      // shellExecutionResultRenderer takes over command rendering.
      const command = str(this.toolCall.args['command']);
      if (command.length === 0) return;
      this.addChild(
        new ShellExecutionComponent({
          command,
          showCommand: true,
          commandPreviewLines: this.expanded ? undefined : COMMAND_PREVIEW_LINES,
        }),
      );
    }
  }

  /**
   * Live-rendering during the `tool.call.delta` streaming window.
   *
   * For tools we recognise, we reach into the partial JSON (via
   * `extractPartialStringField`) and render a stable high-signal
   * preview: Write's `content` as highlighted code, Edit's argument
   * receive progress, Bash's `$ command`, etc. While args are still
   * streaming we render from a bounded preview buffer; once the result lands,
   * the preview snaps to the collapsed cap unless the user has expanded.
   */
  private buildStreamingPreview(streamText: string): void {
    const name = this.toolCall.name;
    const previewText = streamText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
    if (name === 'Write') {
      const content = extractPartialStringField(previewText, 'content');
      if (content === undefined || content.length === 0) return;
      const filePath =
        extractPartialStringField(previewText, 'file_path') ??
        extractPartialStringField(previewText, 'path') ??
        '';
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      const maxLines = COMMAND_PREVIEW_LINES;
      const scrollLines =
        allLines.length > maxLines
          ? allLines.slice(allLines.length - maxLines)
          : allLines;
      for (const [i, line] of scrollLines.entries()) {
        const originalLineNumber =
          allLines.length > maxLines
            ? allLines.length - maxLines + i
            : i;
        const lineNum = currentTheme.dim(String(originalLineNumber + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + line, 2, 0));
      }
      return;
    }
    if (name === 'Edit') {
      const filePath =
        extractPartialStringField(previewText, 'file_path') ??
        extractPartialStringField(previewText, 'path') ??
        '';
      const bytes = Buffer.byteLength(previewText, 'utf8');
      const startedAtMs = this.toolCall.streamingStartedAtMs;
      const elapsedSeconds =
        startedAtMs === undefined ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
      const target = filePath.length > 0 ? ` for ${filePath}` : '';
      const progress = `Preparing changes${target}... ${formatByteSize(bytes)} · ${formatElapsed(
        elapsedSeconds,
      )} elapsed`;
      this.addChild(new Text(currentTheme.dim(progress), 2, 0));
      return;
    }
    if (name === 'Bash') {
      const cmd = extractPartialStringField(previewText, 'command');
      if (cmd === undefined || cmd.length === 0) return;
      this.addChild(
        new ShellExecutionComponent({
          command: cmd,
          showCommand: true,
          commandPreviewLines: COMMAND_PREVIEW_LINES,
        }),
      );
    }
    // Unknown tools: nothing sensible to stream without a schema, so
    // leave the body blank and let the header do the talking.
  }

  private buildContent(): void {
    const { result } = this;
    if (result === undefined) return;

    if (!result.output) return;

    // Outputs that start with a `<system…>` tag are harness-injected
    // reminders piggy-backing on a tool result. They are noise for the
    // user, so suppress the body while keeping the header chip intact.
    if (result.output.trimStart().startsWith('<system')) {
      return;
    }

    // TodoList: the authoritative list is shown in the dedicated
    // TodoPanel before the input area, so repeating the text dump here is
    // pure clutter. Keep the headline, drop the body.
    if (this.toolCall.name === 'TodoList' && !result.is_error) {
      return;
    }

    if (
      this.toolCall.name === 'AskUserQuestion' &&
      this.toolCall.args['background'] !== true &&
      !result.is_error &&
      this.renderAskUserQuestionResult(result.output)
    ) {
      return;
    }

    const renderer = pickResultRenderer(this.toolCall.name);
    const components = renderer(this.toolCall, result, {
      expanded: this.expanded,
    });
    for (const component of components) {
      this.addChild(component);
    }
  }

  /**
   * Render AskUserQuestion's JSON payload as a friendly Q/A list.
   * Returns true on success (caller skips the default JSON dump);
   * false on parse failure (caller falls back to raw display).
   */
  private renderAskUserQuestionResult(output: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;

    const accent = (text: string) => currentTheme.fg('primary', text);

    const answers = (parsed as { answers?: unknown }).answers;
    const note = (parsed as { note?: unknown }).note;

    const hasAnswers =
      typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0;

    if (!hasAnswers) {
      const noteText =
        typeof note === 'string' && note.length > 0 ? note : 'User dismissed the question.';
      this.addChild(new Text(currentTheme.dim(`  ${noteText}`), 0, 0));
      return true;
    }

    for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
      const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
      this.addChild(new Text(`  ${currentTheme.dim('Q')}  ${question}`, 0, 0));
      this.addChild(new Text(`  ${accent('→')}  ${answerText}`, 0, 0));
    }
    return true;
  }
}
