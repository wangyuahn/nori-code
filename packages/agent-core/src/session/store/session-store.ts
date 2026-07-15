import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'pathe';

import { z } from 'zod';

import { ErrorCodes, KimiError } from '#/errors';
import type { SessionIndexEntry } from '#/session/store/session-index';
import { appendSessionIndexEntry, readSessionIndex, removeSessionIndexEntry } from '#/session/store/session-index';
import { encodeWorkDirKey, normalizeWorkDir } from '#/session/store/workdir-key';
import type { JsonObject, ListSessionsPayload, SessionSummary } from '#/rpc/core-api';
import {
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordOf,
} from '../../agent/records';

const SessionSummaryStateSchema = z.object({
  archived: z.boolean().optional(),
  customTitle: z.string().optional(),
  isCustomTitle: z.boolean().optional(),
  lastPrompt: z.string().optional(),
  title: z.string().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

const FORKED_SESSION_DROPPED_FILES = ['upcoming-goals.json'] as const;

type SessionSummaryState = z.infer<typeof SessionSummaryStateSchema>;
type SummaryUsage = NonNullable<SessionSummary['usage']>;
type SummaryTokenUsage = NonNullable<SummaryUsage['total']>;

interface MainWireSummary {
  readonly usage?: SummaryUsage | undefined;
  readonly messageCount: number;
  readonly model?: string | undefined;
}

interface MainWireSummaryCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly summary: Promise<MainWireSummary>;
}

const EMPTY_MAIN_WIRE_SUMMARY: MainWireSummary = { messageCount: 0 };

export interface CreateSessionRecordInput {
  readonly id: string;
  readonly workDir: string;
}

export interface ForkSessionRecordInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
}

export type SessionStoreOptions = Record<string, never>;

export class SessionStore {
  readonly sessionsDir: string;
  private readonly mainWireSummaryCache = new Map<string, MainWireSummaryCacheEntry>();

  constructor(
    readonly homeDir: string,
    _options: SessionStoreOptions = {},
  ) {
    this.sessionsDir = join(homeDir, 'sessions');
  }

  sessionDirFor(input: { readonly id: string; readonly workDir: string }): string {
    assertSafeSessionId(input.id);
    return join(this.sessionsDir, encodeWorkDirKey(normalizeWorkDir(input.workDir)), input.id);
  }

  async create(input: CreateSessionRecordInput): Promise<SessionSummary> {
    assertSafeSessionId(input.id);
    const workDir = normalizeWorkDir(input.workDir);
    const indexed = await this.findSessionEntry(input.id);
    if (indexed !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.id}" already exists`);
    }

    const dir = this.sessionDirFor({ id: input.id, workDir });
    if (await isDirectory(dir)) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.id}" already exists`);
    }

    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendSessionIndexEntry(this.homeDir, {
      sessionId: input.id,
      sessionDir: dir,
      workDir,
    });
    return this.summaryFromDir(input.id, dir, workDir);
  }

  async fork(input: ForkSessionRecordInput): Promise<SessionSummary> {
    const source = await this.findExistingSessionEntry(input.sourceId);
    assertSafeSessionId(input.targetId);
    const indexed = await this.findSessionEntry(input.targetId);
    if (indexed !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.targetId}" already exists`);
    }

    const targetDir = this.sessionDirFor({ id: input.targetId, workDir: source.workDir });
    if (await isDirectory(targetDir)) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${input.targetId}" already exists`);
    }

    await mkdir(dirname(targetDir), { recursive: true, mode: 0o700 });
    try {
      await cp(source.sessionDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await dropForkedSessionFiles(targetDir);
      const forkedState = await this.writeForkedState(input, source.sessionDir, targetDir);
      await appendForkedMarkers(forkedState);
      const summary = await this.summaryFromDir(input.targetId, targetDir, source.workDir);
      await appendSessionIndexEntry(this.homeDir, {
        sessionId: input.targetId,
        sessionDir: targetDir,
        workDir: source.workDir,
      });
      return summary;
    } catch (error) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async get(id: string): Promise<SessionSummary> {
    const entry = await this.findExistingSessionEntry(id);
    return this.summaryFromDir(id, entry.sessionDir, entry.workDir);
  }

  async rename(id: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (normalized.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    const entry = await this.findExistingSessionEntry(id);
    const statePath = join(entry.sessionDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new KimiError(ErrorCodes.SESSION_STATE_NOT_FOUND, `Session "${id}" state.json was not found`, {
        cause: error,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session "${id}" state.json is invalid`);
    }
    const next: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      title: normalized,
      isCustomTitle: true,
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  }

  async archive(id: string): Promise<SessionSummary> {
    const entry = await this.findExistingSessionEntry(id);
    const statePath = join(entry.sessionDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new KimiError(ErrorCodes.SESSION_STATE_NOT_FOUND, `Session "${id}" state.json was not found`, {
        cause: error,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session "${id}" state.json is invalid`);
    }
    const now = new Date().toISOString();
    const next: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      archived: true,
      updatedAt: now,
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    return this.summaryFromDir(id, entry.sessionDir, entry.workDir);
  }

  async delete(id: string): Promise<void> {
    const entry = await this.findExistingSessionEntry(id);
    await rm(entry.sessionDir, { recursive: true, force: false });
    this.mainWireSummaryCache.delete(join(entry.sessionDir, 'agents', 'main', 'wire.jsonl'));
    await removeSessionIndexEntry(this.homeDir, this.sessionsDir, id);
  }

  async list(options: ListSessionsPayload = {}): Promise<readonly SessionSummary[]> {
    const workDir =
      options.workDir === undefined ? undefined : normalizeRequiredWorkDir(options.workDir);
    const sessionId = normalizeOptionalSessionId(options.sessionId);
    const includeArchive = options.includeArchive === true;

    if (workDir !== undefined) {
      if (sessionId !== undefined) {
        const local = await this.summaryFromWorkDirSession(sessionId, workDir, includeArchive);
        if (local !== undefined) return [local];
        return this.listSessionId(sessionId, includeArchive);
      }
      return this.listWorkDir(workDir, includeArchive);
    }

    if (sessionId !== undefined) {
      return this.listSessionId(sessionId, includeArchive);
    }
    return this.listAll(includeArchive);
  }

  private async listWorkDir(
    workDir: string,
    includeArchive: boolean,
  ): Promise<readonly SessionSummary[]> {
    const bucketDir = join(this.sessionsDir, encodeWorkDirKey(workDir));
    let entries;
    try {
      entries = await readdir(bucketDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!isSafeSessionId(id)) continue;
      const dir = join(bucketDir, id);
      const summary = await this.summaryFromDir(id, dir, workDir);
      if (!includeArchive && summary.archived === true) continue;
      sessions.push(summary);
    }
    sessions.sort(compareSessionSummary);
    return sessions;
  }

  private async listSessionId(
    sessionId: string,
    includeArchive: boolean,
  ): Promise<readonly SessionSummary[]> {
    try {
      const summary = await this.get(sessionId);
      if (!includeArchive && summary.archived === true) return [];
      return [summary];
    } catch (error) {
      if (error instanceof KimiError && error.code === ErrorCodes.SESSION_NOT_FOUND) {
        return [];
      }
      throw error;
    }
  }

  private async listAll(includeArchive: boolean): Promise<readonly SessionSummary[]> {
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    const sessions: SessionSummary[] = [];
    for (const entry of index.values()) {
      if (!(await isDirectory(entry.sessionDir))) continue;
      const summary = await this.summaryFromDir(entry.sessionId, entry.sessionDir, entry.workDir);
      if (!includeArchive && summary.archived === true) continue;
      sessions.push(summary);
    }
    sessions.sort(compareSessionSummary);
    return sessions;
  }

  private async summaryFromWorkDirSession(
    sessionId: string,
    workDir: string,
    includeArchive: boolean,
  ): Promise<SessionSummary | undefined> {
    if (!isSafeSessionId(sessionId)) return undefined;
    const sessionDir = this.sessionDirFor({ id: sessionId, workDir });
    if (!(await isDirectory(sessionDir))) return undefined;
    const summary = await this.summaryFromDir(sessionId, sessionDir, workDir);
    if (!includeArchive && summary.archived === true) return undefined;
    return summary;
  }

  async assertDirectory(id: string): Promise<string> {
    return (await this.findExistingSessionEntry(id)).sessionDir;
  }

  private async findSessionEntry(id: string): Promise<SessionIndexEntry | undefined> {
    if (!isSafeSessionId(id)) return undefined;
    const index = await readSessionIndex(this.homeDir, this.sessionsDir);
    return index.get(id);
  }

  private async findExistingSessionEntry(id: string): Promise<SessionIndexEntry> {
    const entry = await this.findSessionEntry(id);
    if (entry !== undefined && (await isDirectory(entry.sessionDir))) return entry;
    throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${id}" was not found`, {
      details: { sessionId: id },
    });
  }

  private async writeForkedState(
    input: ForkSessionRecordInput,
    sourceDir: string,
    targetDir: string,
  ): Promise<Record<string, unknown>> {
    const statePath = join(targetDir, 'state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
    } catch (error) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_NOT_FOUND,
        `Session "${input.sourceId}" state.json was not found`,
        {
          cause: error,
        },
      );
    }
    if (!isRecord(parsed)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session "${input.sourceId}" state.json is invalid`,
      );
    }

    const title = normalizeForkTitle(input.title, parsed['title']);
    const now = new Date().toISOString();
    const next: Record<string, unknown> = {
      ...parsed,
      createdAt: now,
      updatedAt: now,
      title,
      isCustomTitle: input.title === undefined ? parsed['isCustomTitle'] === true : true,
      forkedFrom: input.sourceId,
      agents: rewriteAgentHomedirs(parsed['agents'], sourceDir, targetDir),
      custom: forkCustomMetadata(parsed['custom'], input.metadata),
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    return next;
  }

  private async summaryFromDir(
    id: string,
    sessionDir: string,
    workDir: string,
  ): Promise<SessionSummary> {
    const dirStat = await stat(sessionDir);
    const state = await readOptionalState(sessionDir);
    const mainWirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const [stateInfo, wireInfo, agentsWireMtime, mainWireInfo] = await Promise.all([
      statIfExists(join(sessionDir, 'state.json')),
      statIfExists(join(sessionDir, 'wire.jsonl')),
      latestAgentWireMtime(sessionDir),
      statIfExists(mainWirePath),
    ]);
    const mainWireSummary = await this.readMainWireSummary(mainWirePath, mainWireInfo);
    return {
      id,
      workDir,
      sessionDir,
      createdAt: timestampOrFallback(dirStat.birthtimeMs, dirStat.ctimeMs),
      updatedAt: Math.max(
        dirStat.mtimeMs,
        stateInfo?.mtimeMs ?? 0,
        wireInfo?.mtimeMs ?? 0,
        agentsWireMtime ?? 0,
      ),
      archived: state?.archived === true,
      title: titleFromState(state),
      lastPrompt: state?.lastPrompt,
      metadata: metadataFromState(state),
      usage: mainWireSummary.usage,
      messageCount: mainWireSummary.messageCount,
      model: mainWireSummary.model,
    };
  }

  private async readMainWireSummary(
    wirePath: string,
    wireInfo: FileInfo | undefined,
  ): Promise<MainWireSummary> {
    if (wireInfo === undefined) return EMPTY_MAIN_WIRE_SUMMARY;

    const cached = this.mainWireSummaryCache.get(wirePath);
    if (cached?.mtimeMs === wireInfo.mtimeMs && cached.size === wireInfo.size) {
      return cached.summary;
    }

    const summary = summarizeMainWire(wirePath);
    this.mainWireSummaryCache.set(wirePath, {
      mtimeMs: wireInfo.mtimeMs,
      size: wireInfo.size,
      summary,
    });
    return summary;
  }
}

async function summarizeMainWire(wirePath: string): Promise<MainWireSummary> {
  const persistence = new FileSystemAgentRecordPersistence(wirePath);
  const byModel: Record<string, SummaryTokenUsage> = {};
  let total: SummaryTokenUsage | undefined;
  let promptCount = 0;
  let contextUserCount = 0;
  let configuredModel: string | undefined;

  try {
    for await (const record of persistence.read()) {
      if (record.type === 'usage.record') {
        const usage = validTokenUsage(record.usage);
        if (usage === undefined) continue;

        total = total === undefined ? usage : addTokenUsage(total, usage);
        const rawModel = typeof record.model === 'string' ? record.model.trim() : '';
        if (rawModel !== '') {
          byModel[rawModel] = byModel[rawModel] === undefined
            ? usage
            : addTokenUsage(byModel[rawModel], usage);
        }
        continue;
      }

      if (record.type === 'config.update') {
        configuredModel = knownModel(record.modelAlias) ?? configuredModel;
        continue;
      }

      if (isRealUserPrompt(record)) promptCount++;
      if (isRealUserContextMessage(record)) contextUserCount++;
    }
  } catch {
    // Keep the valid prefix when a later record is damaged.
  }

  return {
    ...(total === undefined
      ? {}
      : {
          usage: {
            ...(Object.keys(byModel).length === 0 ? {} : { byModel }),
            total,
          },
        }),
    messageCount: Math.max(promptCount, contextUserCount),
    model: mostUsedKnownModel(byModel) ?? configuredModel,
  };
}

function isRealUserPrompt(record: AgentRecord): boolean {
  if (record.type !== 'turn.prompt') return false;
  return isRealUserOrigin(record.origin);
}

function isRealUserContextMessage(record: AgentRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = record.message;
  return isRecord(message) && message['role'] === 'user' && isRealUserOrigin(message['origin']);
}

function isRealUserOrigin(origin: unknown): boolean {
  if (origin === undefined) return true;
  if (!isRecord(origin)) return false;
  if (origin['kind'] === 'user') return true;
  return (
    (origin['kind'] === 'skill_activation' || origin['kind'] === 'plugin_command') &&
    origin['trigger'] === 'user-slash'
  );
}

function mostUsedKnownModel(byModel: Readonly<Record<string, SummaryTokenUsage>>): string | undefined {
  let selected: string | undefined;
  let selectedTokens = -1;
  for (const [rawModel, usage] of Object.entries(byModel)) {
    const model = knownModel(rawModel);
    if (model === undefined) continue;
    const tokens = totalTokens(usage);
    if (tokens <= selectedTokens) continue;
    selected = model;
    selectedTokens = tokens;
  }
  return selected;
}

function knownModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const model = value.trim();
  return model !== '' && model.toLowerCase() !== 'unknown' ? model : undefined;
}

function validTokenUsage(value: unknown): SummaryTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputOther = validTokenCount(value['inputOther']);
  const output = validTokenCount(value['output']);
  const inputCacheRead = validTokenCount(value['inputCacheRead']);
  const inputCacheCreation = validTokenCount(value['inputCacheCreation']);
  if (
    inputOther === undefined ||
    output === undefined ||
    inputCacheRead === undefined ||
    inputCacheCreation === undefined
  ) {
    return undefined;
  }
  return { inputOther, output, inputCacheRead, inputCacheCreation };
}

function validTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function addTokenUsage(left: SummaryTokenUsage, right: SummaryTokenUsage): SummaryTokenUsage {
  return {
    inputOther: left.inputOther + right.inputOther,
    output: left.output + right.output,
    inputCacheRead: left.inputCacheRead + right.inputCacheRead,
    inputCacheCreation: left.inputCacheCreation + right.inputCacheCreation,
  };
}

function totalTokens(usage: SummaryTokenUsage): number {
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

function metadataFromState(state: SessionSummaryState | undefined): JsonObject | undefined {
  if (state === undefined || state.custom === undefined) return undefined;
  return state.custom as JsonObject;
}

function forkCustomMetadata(source: unknown, metadata: JsonObject | undefined): Record<string, unknown> {
  return {
    ...customMetadataWithoutGoal(source),
    ...customMetadataWithoutGoal(metadata),
  };
}

async function dropForkedSessionFiles(sessionDir: string): Promise<void> {
  await Promise.all(
    FORKED_SESSION_DROPPED_FILES.map((fileName) => rm(join(sessionDir, fileName), { force: true })),
  );
}

async function appendForkedMarkers(state: Record<string, unknown>): Promise<void> {
  const record: AgentRecordOf<'forked'> = { type: 'forked', time: Date.now() };

  const agents = state['agents'];
  if (!isRecord(agents)) return;

  const paths = new Set<string>();
  for (const agentMeta of Object.values(agents)) {
    if (!isRecord(agentMeta)) continue;
    const homedir = agentMeta['homedir'];
    if (typeof homedir !== 'string') continue;
    paths.add(join(homedir, 'wire.jsonl'));
  }

  await Promise.all([...paths].map(async (path) => {
    const persistence = new FileSystemAgentRecordPersistence(path);
    persistence.append(record);
    await persistence.flush();
  }));
}

function customMetadataWithoutGoal(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const custom: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'goal') continue;
    custom[key] = entry;
  }
  return custom;
}

async function latestAgentWireMtime(sessionDir: string): Promise<number | undefined> {
  const agentsDir = join(sessionDir, 'agents');
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let latest = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wireInfo = await statIfExists(join(agentsDir, entry.name, 'wire.jsonl'));
    latest = Math.max(latest, wireInfo?.mtimeMs ?? 0);
  }
  return latest > 0 ? latest : undefined;
}

function titleFromState(state: SessionSummaryState | undefined): string | undefined {
  if (state === undefined) return undefined;
  if (typeof state.isCustomTitle === 'boolean' && typeof state.title === 'string') {
    return state.title;
  }
  if (typeof state.customTitle === 'string') return state.customTitle;
  return typeof state.title === 'string' ? state.title : undefined;
}

async function readOptionalState(sessionDir: string): Promise<SessionSummaryState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')) as unknown;
    const result = SessionSummaryStateSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRequiredWorkDir(workDir: string): string {
  if (workDir.trim() === '') {
    throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, 'listSessions requires workDir');
  }
  return normalizeWorkDir(workDir);
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  return sessionId === undefined ? undefined : sessionId.trim();
}

function normalizeForkTitle(title: string | undefined, fallback: unknown): string {
  if (title !== undefined) {
    const normalized = title.trim();
    if (normalized.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    return normalized;
  }
  return typeof fallback === 'string' && fallback.trim().length > 0 ? fallback : 'New Session';
}

function rewriteAgentHomedirs(value: unknown, sourceDir: string, targetDir: string): unknown {
  if (!isRecord(value)) return {};

  const agents: Record<string, unknown> = {};
  for (const [agentId, agentMeta] of Object.entries(value)) {
    if (!isRecord(agentMeta)) {
      agents[agentId] = agentMeta;
      continue;
    }
    const homedir = agentMeta['homedir'];
    agents[agentId] = {
      ...agentMeta,
      homedir:
        typeof homedir === 'string' ? remapSessionPath(homedir, sourceDir, targetDir) : homedir,
    };
  }
  return agents;
}

function remapSessionPath(value: string, sourceDir: string, targetDir: string): string {
  const rel = relative(sourceDir, value);
  if (rel === '') return targetDir;
  if (rel.startsWith('..') || isAbsolute(rel)) return value;
  return join(targetDir, rel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface FileInfo {
  readonly mtimeMs: number;
  readonly size: number;
}

async function statIfExists(path: string): Promise<FileInfo | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function timestampOrFallback(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertSafeSessionId(id: string): void {
  if (isSafeSessionId(id)) return;
  throw new KimiError(ErrorCodes.SESSION_ID_INVALID, 'Session id contains unsupported path characters');
}

function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

function compareSessionSummary(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
