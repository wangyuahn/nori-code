import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { join } from 'pathe';
import type { Kaos } from '@nori-code/kaos';
import type { SessionWarning } from '@nori-code/protocol';

import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import type { Logger, SessionLogHandle } from '#/logging/types';
import type {
  KimiConfig,
  NoriRuntimeSettings,
  SDKSessionRPC,
  SetNoriRuntimeSettingsPayload,
} from '#/rpc';
import { proxyWithExtraPayload } from '#/rpc/types';

import { Agent, type AgentOptions, type AgentType } from '../agent';
import { resolveNoriWorkflowConfig } from '../agent/nori-workflow';
import type { RuleConfig } from '../agent/turn/rule-engine';
import type { NoriMemoryProvider } from '../tools/builtin/nori/types';
import { renderPluginSessionStartReminder } from '../agent/injection/plugin-session-start';
import { HookEngine, type HookDef } from './hooks';
import type { PermissionManagerOptions, PermissionRule } from '../agent/permission';
import {
  appendWorkspaceAdditionalDir,
  normalizeAdditionalDirs,
  parseBooleanEnv,
  readWorkspaceAdditionalDirs,
  resolveWorkspaceAdditionalDirs,
  resolveConfigValue,
  type BackgroundConfig,
  type WorkspaceAdditionalDirsLoadResult,
} from '../config';
import { makeErrorPayload } from '../errors';
import {
  McpConnectionManager,
  McpOAuthService,
  type McpServerEntry,
  type SessionMcpConfig,
} from '../mcp';
import type { EnabledPluginSessionStart, PluginCommandDef } from '../plugin';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_INIT_PROMPT,
  loadAgentsMd,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import type { ProviderManager } from './provider-manager';
import {
  registerBuiltinSkills,
  SessionSkillRegistry,
  resolveSkillRoots,
  summarizeSkill,
  type SkillRoot,
  type SkillSummary,
} from '../skill';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import { SessionSubagentHost } from './subagent-host';
import type { BrowserProvider, ToolServices } from '../tools/support/services';
import TEAM_AGENT_PROMPT from './team-agent.md?raw';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import { abortError } from '../utils/abort';
import { loadNoriYamlConfig, createNoriProvidersFromConfig } from "./nori-providers";

export interface SessionOptions {
  readonly kaos: Kaos;
  readonly persistenceKaos?: Kaos;
  readonly config?: KimiConfig;
  readonly id?: string | undefined;
  readonly homedir: string;
  readonly kimiHomeDir?: string;
  readonly rpc: SDKSessionRPC;
  readonly toolServices?: ToolServices;
  readonly browserProvider?: BrowserProvider;
  readonly initializeMainAgent?: boolean | undefined;
  readonly providerManager?: ProviderManager | undefined;
  readonly background?: BackgroundConfig | undefined;
  readonly hooks?: readonly HookDef[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly skills?: SessionSkillConfig;
  readonly mcpConfig?: SessionMcpConfig;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly pluginCommands?: readonly PluginCommandDef[];
  readonly appVersion?: string;
  readonly experimentalFlags?: ExperimentalFlagResolver;
  readonly additionalDirs?: readonly string[];
  /** When set, the session will inject these providers into the main agent at creation time. */
  readonly noriProviders?: {
    readonly memory: NoriMemoryProvider;
    readonly coderWriteEnabled?: boolean;
  };
}

export interface SessionSkillConfig {
  readonly userHomeDir?: string;
  /** Brand data dir (NORI_CODE_HOME); user brand skills live under `<brandHomeDir>/skills`. */
  readonly brandHomeDir?: string;
  readonly explicitDirs?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly pluginSkillRoots?: readonly SkillRoot[];
  readonly mergeAllAvailableSkills?: boolean;
  readonly builtinDir?: string;
}

export interface AgentMeta {
  readonly homedir: string;
  readonly type: AgentType;
  readonly parentAgentId: string | null;
  readonly subagentItem?: string;
  /** `team` agents are durable collaborators; `sub` agents are SubAgent transcripts. */
  readonly kind?: 'team' | 'sub';
  readonly name?: string;
  readonly title?: string;
  readonly intro?: string;
  readonly mandate?: string;
  readonly role?: string;
  /** The lead that owns this durable team member or discussion transcript. */
  readonly teamLeaderAgentId?: string;
  /** A non-empty task grants this team member its otherwise read-only write capability. */
  readonly assignedTask?: string;
  readonly assignedAt?: string;
  /** Present only on an agent-scoped, archived-or-active team discussion transcript. */
  readonly discussion?: TeamDiscussionMeta;
  /** Completed SubAgent transcripts stay in the parent session archive. */
  readonly archived?: boolean;
  readonly completedAt?: string;
}

export interface TeamIdentity {
  readonly name: string;
  readonly title: string;
  readonly intro: string;
  readonly mandate: string;
  readonly role: string;
}

export interface TeamDiscussionMeta {
  readonly participantAgentIds: readonly string[];
  readonly status: 'active' | 'archived';
  readonly topic: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** Monotonic statement sequence used by participant-specific read cursors. */
  readonly nextStatementId?: number;
  /** Last shared statement delivered to each participant. Kept out of model prompts. */
  readonly readCursors?: Readonly<Record<string, number>>;
  /**
   * Durable shared-discussion transport. This remains available after the
   * discussion transcript is compacted, while model prompts receive only a
   * participant's unread suffix.
   */
  readonly statements?: readonly TeamDiscussionStatementRecord[];
}

export interface TeamDiscussionStatementRecord {
  readonly entryId: number;
  readonly agentId: string;
  readonly name: string;
  readonly message: string;
}

export interface TeamAssignment {
  readonly agentId: string;
  readonly task: string | null;
}

interface ResumedAgent {
  readonly agent: Agent;
  readonly warning?: string;
}

type AgentEntry = Agent | Promise<ResumedAgent>;

export interface CreateAgentOptions {
  readonly profile?: ResolvedAgentProfile;
  readonly parentAgentId?: string;
  readonly subagentItem?: string;
  readonly persistMetadata?: boolean;
  readonly kind?: 'team' | 'sub';
  readonly teamIdentity?: TeamIdentity;
  readonly teamLeaderAgentId?: string;
  readonly assignedTask?: string;
  readonly discussion?: TeamDiscussionMeta;
  readonly name?: string;
  readonly title?: string;
}

export interface SessionMeta {
  createdAt: string;
  updatedAt: string;
  title: string;
  isCustomTitle: boolean;
  lastPrompt?: string;
  forkedFrom?: string;
  agents: Record<string, AgentMeta>;
  custom: Record<string, any>;
}

const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'NORI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';
const ACTIVE_TURN_CLOSE_TIMEOUT_MS = 8_000;
const NORI_RUNTIME_METADATA_KEY = 'noriRuntime';

async function waitForSettlementOrTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export class Session {
  readonly rpc: SDKSessionRPC;
  readonly telemetry: TelemetryClient;
  readonly skills: SessionSkillRegistry;
  readonly agents: Map<string, AgentEntry> = new Map();
  readonly mcp: McpConnectionManager;
  readonly log: Logger;
  private readonly logHandle: SessionLogHandle | undefined;
  readonly hookEngine: HookEngine;
  readonly experimentalFlags: ExperimentalFlagResolver;
  private toolKaos: Kaos;
  private persistenceKaos: Kaos;
  private additionalDirs: readonly string[];
  private readonly pluginCommands: readonly PluginCommandDef[];
  private agentIdCounter = 0;
  private readonly skillsReady: Promise<void>;
  metadata: SessionMeta = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
  };
  private writeMetadataPromise = Promise.resolve();
  private agentsMdWarning: string | undefined;
  /** Explicit TeamSpeak calls awaiting their owning discussion round result. */
  private readonly teamDiscussionSpeaks = new Map<
    string,
    Map<string, TeamDiscussionStatementRecord>
  >();
  /** Only the member currently scheduled by the serial discussion loop may publish. */
  private readonly activeTeamDiscussionTurns = new Map<string, string>();

  constructor(public readonly options: SessionOptions) {
    // Attach the per-session log sink up front so the constructor's
    // fire-and-forget `loadSkills` / `loadMcpServers` failures (and
    // anything else that races) land in the session log, not just global.
    this.logHandle =
      options.id === undefined
        ? undefined
        : getRootLogger().attachSession({
          sessionId: options.id,
          sessionDir: options.homedir,
        });
    this.log =
      this.logHandle?.logger ??
      (options.id === undefined ? log : log.createChild({ sessionId: options.id }));
    this.rpc = options.rpc;
    this.experimentalFlags = options.experimentalFlags ?? new FlagResolver();
    this.hookEngine = new HookEngine(options.hooks, {
      cwd: options.kaos.getcwd(),
      sessionId: options.id,
    });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.toolKaos = options.kaos;
    this.persistenceKaos = options.persistenceKaos ?? options.kaos;
    this.additionalDirs = normalizeAdditionalDirs(options.additionalDirs ?? []);
    this.pluginCommands = options.pluginCommands ?? [];
    this.skills = new SessionSkillRegistry({
      sessionId: options.id,
    });
    this.mcp = new McpConnectionManager({
      oauthService: new McpOAuthService({ kimiHomeDir: options.kimiHomeDir }),
      log: this.log,
      stdioCwd: options.kaos.getcwd(),
    });
    this.mcp.onStatusChange((entry) => {
      this.onMcpServerStatusChange(entry);
    });
    this.skillsReady = this.loadSkills()
      .catch((error: unknown) => {
        this.log.error('skills load failed', error);
      })
      .then(() => {
        this.refreshAgentBuiltinTools();
      });
    void this.loadMcpServers().catch((error: unknown) => {
      this.emitInitialMcpLoadError(error);
    });
  }


  setToolKaos(kaos: Kaos) {
    this.toolKaos = kaos;
    for (const agent of this.readyAgents()) {
      agent.setKaos(kaos.withCwd(agent.config.cwd));
    }
    this.refreshAgentBuiltinTools();
  }

  getAdditionalDirs(): readonly string[] {
    return this.additionalDirs;
  }

  async setAdditionalDirs(additionalDirs: readonly string[]): Promise<void> {
    this.additionalDirs = normalizeAdditionalDirs(additionalDirs);
    for (const agent of this.readyAgents()) {
      agent.setAdditionalDirs(this.additionalDirs);
    }
  }

  async updateCustomAgents(customAgents: KimiConfig['customAgents']): Promise<void> {
    const config = this.options.config;
    if (config === undefined) return;

    config.customAgents = customAgents;
    await Promise.all(Array.from(this.readyAgents(), async (agent) => {
      if (agent.config.hasProvider) agent.tools.refreshBuiltinTools();
      await agent.refreshSystemPrompt();
    }));
  }

  async addAdditionalDir(
    path: string,
    persist = true,
  ): Promise<WorkspaceAdditionalDirsLoadResult & { readonly persisted: boolean }> {
    const cwd = this.toolKaos.getcwd();
    const systemKaos = this.systemContextKaos(cwd);
    if (persist) {
      const result = await appendWorkspaceAdditionalDir(systemKaos, cwd, path, this.additionalDirs);
      const additionalDirs = normalizeAdditionalDirs([...this.additionalDirs, ...result.additionalDirs]);
      await this.setAdditionalDirs(additionalDirs);
      this.notifyAdditionalDirAdded(path, true, result.configPath);
      return { ...result, additionalDirs, persisted: true };
    }

    const workspace = await readWorkspaceAdditionalDirs(systemKaos, cwd);
    const additionalDirs = await resolveWorkspaceAdditionalDirs(systemKaos, cwd, [path]);
    const nextAdditionalDirs = normalizeAdditionalDirs([...this.additionalDirs, ...additionalDirs]);
    await this.setAdditionalDirs(nextAdditionalDirs);
    this.notifyAdditionalDirAdded(path, false, workspace.configPath);
    return {
      projectRoot: workspace.projectRoot,
      configPath: workspace.configPath,
      additionalDirs: nextAdditionalDirs,
      persisted: false,
    };
  }

  private notifyAdditionalDirAdded(path: string, persisted: boolean, configPath: string): void {
    const message = persisted
      ? `Added workspace directory:\n  ${path}\n  Saved to:\n  ${configPath}`
      : `Added workspace directory:\n  ${path}\n  For this session only`;
    this.requireMainAgent().context.appendLocalCommandStdout(message);
  }

  /**
   * Kaos used by session-internal bootstrap (AGENTS.md context, cwd listing)
   * and metadata persistence. Always backed by the persistence sink (typically
   * the local filesystem) so a transient ACP-side failure on system files like
   * `AGENTS.md` never blocks `bootstrapAgentProfile`, so tool calls still route
   * through `agent.kaos` and continue to honor the ACP bridge.
   */
  systemContextKaos(cwd: string): Kaos {
    return this.persistenceKaos.withCwd(cwd);
  }

  async createMain() {
    const noriRules = await this.loadNoriRules();
    const optionsProviders = this.options.noriProviders;

    // Auto-detect nori.yaml from cwd and create providers
    const cwd = this.toolKaos.getcwd();
    const noriConfig = loadNoriYamlConfig(cwd);
    const autoProviders = createNoriProvidersFromConfig(
      noriConfig,
      this.options.config ?? { providers: {} },
      cwd,
    );
    const noriWorkflow = resolveNoriWorkflowConfig(noriConfig);

    // Prefer explicit options providers, fall back to auto-detected
    const effective = optionsProviders ?? autoProviders;

    const agentConfig: Partial<AgentOptions> = effective === null
      ? { type: 'main', noriRules, noriWorkflow }
      : {
          type: 'main',
          noriRules,
          noriWorkflow,
          obsidianMemory: effective.memory,
          coderWriteEnabled: effective.coderWriteEnabled ?? false,
        };

    const { agent } = await this.createAgent(agentConfig, {
      profile: DEFAULT_AGENT_PROFILES['nori-agent'] ?? DEFAULT_AGENT_PROFILES['agent'],
    });

    await this.persistDefaultNoriRuntimeSettings(agent);
    this.applyNoriRuntimeSettings(this.getNoriRuntimeSettings());

    await this.triggerSessionStart('startup');
    return agent;
  }

  private async loadNoriRules(): Promise<RuleConfig[]> {
    try {
      const cwd = this.toolKaos.getcwd();
      let dir = cwd;
      while (dir !== path.parse(dir).root) {
        const noriYaml = path.join(dir, 'nori.yaml');
        if (existsSync(noriYaml)) {
          const content = readFileSync(noriYaml, 'utf-8');
          const parsed = loadYaml(content) as any;
          return normalizeNoriRuleDefinitions(parsed?.rules?.definitions);
        }
        dir = path.dirname(dir);
      }
    } catch { /* no nori.yaml 閳?no custom rules */ }
    return [];
  }

  async resume(): Promise<{ warning?: string }> {
    await this.skillsReady;
    this.log.info('session resume', { app_version: this.options.appVersion });
    const { agents } = await this.readMetadata();
    this.agents.clear();
    // Only the main agent is needed to reopen the session; subagents replay
    // lazily when an RPC or Agent(resume=...) call asks for their state.
    const { warning } =
      agents['main'] === undefined ? { warning: undefined } : await this.resumeAgent('main');
    // A session migrated from an external tool ships a wire without the
    // `config.update` bootstrap events a natively-created agent writes, so the
    // main agent comes back with an empty system prompt and no tools. Apply the
    // default profile so the resumed session is usable. Native sessions always
    // replay a non-empty system prompt and never enter this branch.
    const main = this.getReadyAgent('main');
    const profile = DEFAULT_AGENT_PROFILES['nori-agent'] ?? DEFAULT_AGENT_PROFILES['agent'];
    if (main !== undefined && profile !== undefined && main.config.systemPrompt === '') {
      await this.bootstrapAgentProfile(main, profile);
    }
    if (main !== undefined) this.enableTeamLeadTools(main);
    this.applyNoriRuntimeSettings(this.getNoriRuntimeSettings());
    await this.triggerSessionStart('resume');
    return { warning };
  }

  async close(): Promise<void> {
    try {
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => agent.cron?.stop()),
      );
      await this.cancelActiveTurnsOnClose();
      await this.stopBackgroundTasksOnExit();
      await this.flushMetadata();
      await this.triggerSessionEnd('exit');
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  async closeForReload(): Promise<void> {
    try {
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => agent.cron?.stop()),
      );
      await this.flushMetadata();
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  private async cancelActiveTurnsOnClose(): Promise<void> {
    const backgroundAgentIds = this.activeBackgroundAgentIds();
    const cancellations: Array<Promise<void>> = [];
    for (const [agentId, entry] of this.agents) {
      if (!(entry instanceof Agent) || backgroundAgentIds.has(agentId)) continue;
      cancellations.push(this.cancelAgentTurnOnClose(entry));
    }
    await Promise.allSettled(cancellations);
  }

  private activeBackgroundAgentIds(): Set<string> {
    const agentIds = new Set<string>();
    for (const agent of this.readyAgents()) {
      for (const task of agent.background.list(true)) {
        if (task.kind === 'agent' && task.agentId !== undefined && task.detached !== false) {
          agentIds.add(task.agentId);
        }
      }
    }
    return agentIds;
  }

  private async cancelAgentTurnOnClose(agent: Agent): Promise<void> {
    if (!agent.turn.hasActiveTurn) return;

    let waitForTurn: Promise<unknown>;
    try {
      waitForTurn = agent.turn.waitForCurrentTurn();
    } catch (error: unknown) {
      this.log.debug('active turn wait unavailable during session close', {
        agentType: agent.type,
        agentHomedir: agent.homedir,
        error,
      });
      return;
    }

    agent.turn.cancel(undefined, abortError('Session closed'));
    const settled = await waitForSettlementOrTimeout(waitForTurn, ACTIVE_TURN_CLOSE_TIMEOUT_MS);
    if (!settled) {
      this.log.warn('timed out waiting for active turn to cancel during session close', {
        agentType: agent.type,
        agentHomedir: agent.homedir,
        timeoutMs: ACTIVE_TURN_CLOSE_TIMEOUT_MS,
      });
    }
  }

  private async stopBackgroundTasksOnExit(): Promise<void> {
    const keepAliveOnExit = resolveConfigValue({
      env: process.env,
      envKey: BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV,
      configValue: this.options.background?.keepAliveOnExit,
      defaultValue: false,
      parseEnv: parseBooleanEnv,
    });
    if (keepAliveOnExit) return;
    await Promise.all(
      Array.from(this.readyAgents(), async (agent) => {
        const activeTasks = agent.background.list(true);
        await Promise.all(
          activeTasks.map((task) =>
            agent.background.suppressTerminalNotification(task.taskId),
          ),
        );
        await agent.background.stopAll('Session closed');
      }),
    );
  }

  async createAgent(
    config: Partial<AgentOptions>,
    options: CreateAgentOptions = {},
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    await this.skillsReady;
    const type = config.type ?? 'main';
    const kind = options.kind ?? 'sub';
    const identity = options.teamIdentity;
    if (kind === 'team') {
      if (type !== 'sub') {
        throw new KimiError(
          ErrorCodes.SESSION_STATE_INVALID,
          'Only sub agents can be persistent team members.',
        );
      }
      validateTeamIdentity(identity);
    }
    if (options.discussion !== undefined && kind !== 'sub') {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'A discussion transcript must use the sub-agent kind.',
      );
    }
    const id = type === 'main' ? 'main' : this.nextGeneratedAgentId();
    const homedir = config.homedir ?? join(this.options.homedir, 'agents', id);
    const parentAgentId = options.parentAgentId ?? null;
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId);
    const profile = kind === 'team'
      ? teamProfile(options.profile ?? defaultTeamProfile(), identity!)
      : options.profile;
    if (profile) {
      await this.bootstrapAgentProfile(agent, profile);
    }
    if (type !== 'main' || this.hasPersistedNoriRuntimeSettings()) {
      this.applyNoriRuntimeSettingsToAgent(agent, this.getNoriRuntimeSettings());
    }

    this.agents.set(id, agent);
    if (options.persistMetadata !== false) {
      const metadata: AgentMeta = {
        homedir,
        type,
        parentAgentId,
        subagentItem: options.subagentItem,
        kind,
        name: identity?.name ?? options.name,
        title: identity?.title ?? options.title,
        intro: identity?.intro,
        mandate: identity?.mandate,
        role: identity?.role,
        teamLeaderAgentId: options.teamLeaderAgentId,
        assignedTask: options.assignedTask,
        assignedAt: options.assignedTask === undefined ? undefined : new Date().toISOString(),
        discussion: options.discussion,
      };
      this.metadata.agents[id] = metadata;
      if (kind === 'team') this.configureTeamAgentRuntime(agent, metadata);
      void this.writeMetadata();
    }
    if (type === 'main') this.enableTeamLeadTools(agent);

    return { id, agent };
  }

  /**
   * Completed SubAgent transcripts stay in the parent session. Mark them
   * archived so the live tree can drop them without destroying metadata.
   */
  async archiveCompletedSubagent(id: string): Promise<void> {
    const metadata = this.metadata.agents[id];
    if (
      metadata === undefined ||
      metadata.type !== 'sub' ||
      metadata.kind === 'team' ||
      metadata.discussion !== undefined ||
      metadata.archived
    ) return;

    this.metadata.agents[id] = {
      ...metadata,
      archived: true,
      completedAt: new Date().toISOString(),
    };
    await this.writeMetadata();
  }

  /** Creates a durable team member within this Session, never a child Session. */
  async createTeamMember(
    leaderAgentId: string,
    identity: TeamIdentity,
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    this.assertTeamLead(leaderAgentId);
    validateTeamIdentity(identity);
    const duplicates = this.teamMemberMetadata(leaderAgentId).some(
      ([, meta]) => meta.name?.localeCompare(identity.name, undefined, { sensitivity: 'accent' }) === 0,
    );
    if (duplicates) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `A team member named "${identity.name}" already exists.`,
      );
    }

    const leader = await this.ensureAgentResumed(leaderAgentId);
    const result = await this.createAgent(
      { type: 'sub', generate: leader.rawGenerate },
      {
        kind: 'team',
        teamIdentity: identity,
        teamLeaderAgentId: leaderAgentId,
        parentAgentId: leaderAgentId,
        profile: defaultTeamProfile(),
      },
    );
    result.agent.config.update({
      cwd: leader.config.cwd,
      modelAlias: leader.config.modelAlias,
      thinkingEffort: leader.config.thinkingEffort,
    });
    result.agent.tools.inheritUserTools(leader.tools);
    return result;
  }

  getAgentMetadata(id: string): AgentMeta | undefined {
    return this.metadata.agents[id];
  }

  teamMemberMetadata(leaderAgentId: string): Array<readonly [string, AgentMeta]> {
    return Object.entries(this.metadata.agents).filter(([, meta]) =>
      meta.kind === 'team' && meta.teamLeaderAgentId === leaderAgentId,
    );
  }

  async dismissTeamMembers(
    leaderAgentId: string,
    agentIds: readonly string[],
    reason: string,
    confirmActive: boolean,
  ): Promise<void> {
    this.assertTeamLead(leaderAgentId);
    if (reason.trim().length === 0) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'TeamDismiss requires a reason.');
    }
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length === 0 || uniqueIds.length !== agentIds.length) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Specify each team member once.');
    }
    const members = uniqueIds.map((id) => {
      const meta = this.metadata.agents[id];
      if (meta?.kind !== 'team' || meta.teamLeaderAgentId !== leaderAgentId) {
        throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Team member "${id}" was not found.`);
      }
      return [id, meta] as const;
    });
    // A dismissal owns the whole member branch. A direct member turn is not
    // the only in-flight work: an assigned partner can have temporary
    // SubAgent/background work below it. Treat that as active too so the
    // required confirmation cannot silently orphan live work.
    const descendantIds = this.descendantAgentIds(uniqueIds);
    const branchIds = [...uniqueIds, ...descendantIds];
    const active = branchIds.filter((id) => {
      const agent = this.getReadyAgent(id);
      return agent?.turn.hasActiveTurn === true || (agent?.background.list(true).length ?? 0) > 0;
    });
    if (active.length > 0 && !confirmActive) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'One or more team members or their temporary subagents are working. Retry TeamDismiss with confirm_active=true.',
      );
    }

    const cancellation = abortError(`Dismissed: ${reason.trim()}`);
    for (const id of branchIds) {
      const agent = this.getReadyAgent(id);
      agent?.subagentHost?.cancelAll(cancellation);
      agent?.turn.cancel(undefined, cancellation);
      await agent?.background.stopAll(`Dismissed: ${reason.trim()}`);
      this.agents.delete(id);
      delete this.metadata.agents[id];
    }
    const dismissed = new Set(uniqueIds);
    for (const [discussionAgentId, meta] of Object.entries(this.metadata.agents)) {
      const discussion = meta.discussion;
      if (discussion === undefined) continue;
      const participantAgentIds = discussion.participantAgentIds.filter((id) => !dismissed.has(id));
      if (participantAgentIds.length === discussion.participantAgentIds.length) continue;
      this.metadata.agents[discussionAgentId] = {
        ...meta,
        discussion: {
          ...discussion,
          participantAgentIds,
          status: participantAgentIds.length === 0 ? 'archived' : discussion.status,
          updatedAt: new Date().toISOString(),
        },
      };
    }
    await this.writeMetadata();
  }

  /** Returns all live/persisted descendants below the supplied agent roots. */
  private descendantAgentIds(rootIds: readonly string[]): string[] {
    const roots = new Set(rootIds);
    const descendants: string[] = [];
    const queue = [...roots];
    while (queue.length > 0) {
      const parentAgentId = queue.shift()!;
      for (const [agentId, meta] of Object.entries(this.metadata.agents)) {
        if (meta.parentAgentId !== parentAgentId || roots.has(agentId)) continue;
        roots.add(agentId);
        descendants.push(agentId);
        queue.push(agentId);
      }
    }
    return descendants;
  }

  async assignTeamTasks(
    leaderAgentId: string,
    assignments: readonly TeamAssignment[],
  ): Promise<Array<{ readonly agentId: string; readonly task: string | null; readonly agent: Agent }>> {
    this.assertTeamLead(leaderAgentId);
    const members = this.teamMemberMetadata(leaderAgentId);
    if (members.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Create a team before assigning work.');
    }
    const expected = new Set(members.map(([id]) => id));
    const seen = new Set<string>();
    for (const assignment of assignments) {
      if (seen.has(assignment.agentId) || !expected.delete(assignment.agentId)) {
        throw new KimiError(
          ErrorCodes.SESSION_STATE_INVALID,
          `TeamAssign contains an unknown or duplicate agent id "${assignment.agentId}".`,
        );
      }
      if (assignment.task !== null && assignment.task.trim().length === 0) {
        throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Assigned tasks must not be blank.');
      }
    }
    if (expected.size > 0) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `TeamAssign must explicitly include every team member; missing: ${[...expected].join(', ')}.`,
      );
    }
    if (assignments.every((assignment) => assignment.task === null)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'TeamAssign rejects an all-null assignment. Assign at least one concrete task.',
      );
    }

    const resolved = await Promise.all(
      assignments.map(async (assignment) => ({
        ...assignment,
        agent: await this.ensureAgentResumed(assignment.agentId),
      })),
    );
    const busy = resolved.filter(({ agent }) => agent.turn.hasActiveTurn);
    if (busy.length > 0) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Cannot assign work while team members are active: ${busy.map(({ agentId }) => agentId).join(', ')}.`,
      );
    }

    const assignedAt = new Date().toISOString();
    for (const assignment of resolved) {
      const current = this.metadata.agents[assignment.agentId]!;
      this.metadata.agents[assignment.agentId] = {
        ...current,
        assignedTask: assignment.task ?? undefined,
        assignedAt: assignment.task === null ? undefined : assignedAt,
      };
      this.configureTeamAgentRuntime(assignment.agent, this.metadata.agents[assignment.agentId]!);
    }
    await this.writeMetadata();
    const leader = await this.ensureAgentResumed(leaderAgentId);
    if (leader.discussMode.isActive) leader.discussMode.exit();
    return resolved;
  }

  /** Revoke every TeamAssign write lease. Used when re-entering Discuss or archiving. */
  async lockTeamAssignments(leaderAgentId: string): Promise<void> {
    this.assertTeamLead(leaderAgentId);
    const members = this.teamMemberMetadata(leaderAgentId);
    let changed = false;
    for (const [agentId, current] of members) {
      if (current.assignedTask === undefined && current.assignedAt === undefined) continue;
      this.metadata.agents[agentId] = {
        ...current,
        assignedTask: undefined,
        assignedAt: undefined,
      };
      const agent = this.getReadyAgent(agentId);
      if (agent !== undefined) this.configureTeamAgentRuntime(agent, this.metadata.agents[agentId]!);
      changed = true;
    }
    if (changed) await this.writeMetadata();
  }

  async assertTeamDiscussionMode(agentId: string): Promise<void> {
    this.assertTeamLead(agentId);
    const leader = await this.ensureAgentResumed(agentId);
    if (!leader.discussMode.isActive) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'EnterDiscussMode is required before starting or continuing a team discussion.',
      );
    }
  }

  async createTeamDiscussion(
    leaderAgentId: string,
    topic: string,
    participantAgentIds: readonly string[],
  ): Promise<{ readonly id: string; readonly agent: Agent; readonly discussion: TeamDiscussionMeta }> {
    this.assertTeamLead(leaderAgentId);
    if (topic.trim().length === 0) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A discussion topic is required.');
    }
    if (this.activeTeamDiscussion(leaderAgentId) !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A team discussion is already active.');
    }
    const members = new Set(this.teamMemberMetadata(leaderAgentId).map(([id]) => id));
    const participants = [...new Set(participantAgentIds)];
    if (participants.length === 0 || participants.length !== participantAgentIds.length) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A discussion needs distinct team participants.');
    }
    if (participants.some((id) => !members.has(id))) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Discussion participants must belong to the team.');
    }
    const now = new Date().toISOString();
    const discussion: TeamDiscussionMeta = {
      participantAgentIds: participants,
      status: 'active',
      topic: topic.trim(),
      startedAt: now,
      updatedAt: now,
      nextStatementId: 0,
      readCursors: Object.fromEntries(participants.map((agentId) => [agentId, 0])),
      statements: [],
    };
    const leader = await this.ensureAgentResumed(leaderAgentId);
    return this.createAgent(
      { type: 'sub', generate: leader.rawGenerate },
      {
        kind: 'sub',
        parentAgentId: leaderAgentId,
        teamLeaderAgentId: leaderAgentId,
        name: 'Discussion',
        title: discussion.topic,
        profile: discussionProfile(defaultTeamProfile(), discussion),
        discussion,
      },
    ).then((result) => ({ ...result, discussion }));
  }

  activeTeamDiscussion(leaderAgentId: string): readonly [string, AgentMeta] | undefined {
    return Object.entries(this.metadata.agents).find(([, meta]) =>
      meta.teamLeaderAgentId === leaderAgentId && meta.discussion?.status === 'active',
    );
  }

  async updateTeamDiscussion(
    discussionAgentId: string,
    update: Pick<TeamDiscussionMeta, 'participantAgentIds' | 'status' | 'topic'>,
  ): Promise<TeamDiscussionMeta> {
    const meta = this.metadata.agents[discussionAgentId];
    if (meta?.discussion === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Discussion "${discussionAgentId}" was not found.`);
    }
    const discussion: TeamDiscussionMeta = {
      ...meta.discussion,
      ...update,
      participantAgentIds: [...update.participantAgentIds],
      readCursors: {
        ...meta.discussion.readCursors,
        ...Object.fromEntries(
          update.participantAgentIds
            .filter((agentId) => meta.discussion!.readCursors?.[agentId] === undefined)
            .map((agentId) => [agentId, 0]),
        ),
      },
      updatedAt: new Date().toISOString(),
    };
    this.metadata.agents[discussionAgentId] = { ...meta, discussion };
    await this.writeMetadata();
    if (update.status === 'archived' && meta.teamLeaderAgentId !== undefined) {
      const leader = await this.ensureAgentResumed(meta.teamLeaderAgentId);
      if (leader.discussMode.isActive) leader.discussMode.exit();
    }
    return discussion;
  }

  async publishLeadDiscussionStatement(
    leaderAgentId: string,
    message: string,
  ): Promise<{ readonly discussionAgentId: string; readonly entryId: number }> {
    this.assertTeamLead(leaderAgentId);
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A lead discussion statement is required.');
    }
    const active = this.activeTeamDiscussion(leaderAgentId);
    if (active === undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'There is no active team discussion.');
    }
    const [discussionAgentId, discussionMeta] = active;
    const entryId = (discussionMeta.discussion!.nextStatementId ?? 0) + 1;
    const record: TeamDiscussionStatementRecord = {
      entryId,
      agentId: leaderAgentId,
      name: '主持',
      message: trimmed,
    };
    const discussion: TeamDiscussionMeta = {
      ...discussionMeta.discussion!,
      nextStatementId: entryId,
      statements: [...(discussionMeta.discussion!.statements ?? []), record],
      updatedAt: new Date().toISOString(),
    };
    this.metadata.agents[discussionAgentId] = { ...discussionMeta, discussion };
    const transcript = await this.ensureAgentResumed(discussionAgentId);
    transcript.context.appendUserMessage(
      [{ type: 'text', text: record.message }],
      {
        kind: 'system_trigger',
        name: 'team_discussion_statement',
        discussionEntryId: entryId,
        speaker: { from: 'lead', speakerId: leaderAgentId, speakerName: '主代理' },
      },
    );
    await this.writeMetadata();
    return { discussionAgentId, entryId };
  }

  async publishTeamDiscussionStatement(
    agentId: string,
    message: string,
  ): Promise<{ readonly discussionAgentId: string; readonly entryId: number }> {
    const member = this.metadata.agents[agentId];
    if (member?.kind !== 'team' || member.teamLeaderAgentId === undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'TeamSpeak is available only to a team member.');
    }
    const active = this.activeTeamDiscussion(member.teamLeaderAgentId);
    if (active === undefined || !active[1].discussion!.participantAgentIds.includes(agentId)) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'This team member is not in an active discussion.');
    }
    const [discussionAgentId, discussionMeta] = active;
    if (this.activeTeamDiscussionTurns.get(discussionAgentId) !== agentId) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'TeamSpeak is available only during this member\'s scheduled discussion turn.',
      );
    }
    const existing = this.teamDiscussionSpeaks.get(discussionAgentId)?.get(agentId);
    if (existing !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Each participant may call TeamSpeak at most once per discussion turn.');
    }

    const entryId = (discussionMeta.discussion!.nextStatementId ?? 0) + 1;
    const record: TeamDiscussionStatementRecord = {
      entryId,
      agentId,
      name: member.name ?? '团队成员',
      message: message.trim(),
    };
    const discussion: TeamDiscussionMeta = {
      ...discussionMeta.discussion!,
      nextStatementId: entryId,
      statements: [...(discussionMeta.discussion!.statements ?? []), record],
      updatedAt: new Date().toISOString(),
    };
    this.metadata.agents[discussionAgentId] = { ...discussionMeta, discussion };
    const transcript = await this.ensureAgentResumed(discussionAgentId);
    transcript.context.appendUserMessage(
      [{ type: 'text', text: record.message }],
      {
        kind: 'system_trigger',
        name: 'team_discussion_statement',
        discussionEntryId: entryId,
        speaker: { from: 'team', speakerId: agentId, speakerName: record.name },
      },
    );
    const speaks = this.teamDiscussionSpeaks.get(discussionAgentId) ?? new Map<string, TeamDiscussionStatementRecord>();
    speaks.set(agentId, record);
    this.teamDiscussionSpeaks.set(discussionAgentId, speaks);
    await this.writeMetadata();
    return { discussionAgentId, entryId };
  }

  consumeTeamDiscussionSpeak(
    discussionAgentId: string,
    agentId: string,
  ): TeamDiscussionStatementRecord | undefined {
    const speaks = this.teamDiscussionSpeaks.get(discussionAgentId);
    const statement = speaks?.get(agentId);
    if (statement === undefined) return undefined;
    speaks!.delete(agentId);
    if (speaks!.size === 0) this.teamDiscussionSpeaks.delete(discussionAgentId);
    return statement;
  }

  beginTeamDiscussionTurn(discussionAgentId: string, agentId: string): void {
    const active = this.activeTeamDiscussionTurns.get(discussionAgentId);
    if (active !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A discussion participant is already speaking.');
    }
    this.teamDiscussionSpeaks.get(discussionAgentId)?.delete(agentId);
    this.activeTeamDiscussionTurns.set(discussionAgentId, agentId);
  }

  endTeamDiscussionTurn(discussionAgentId: string, agentId: string): void {
    if (this.activeTeamDiscussionTurns.get(discussionAgentId) === agentId) {
      this.activeTeamDiscussionTurns.delete(discussionAgentId);
    }
  }

  async unreadTeamDiscussionStatements(
    discussionAgentId: string,
    recipientAgentId: string,
  ): Promise<{
    readonly statements: readonly TeamDiscussionStatementRecord[];
    readonly cursor: number;
  }> {
    const meta = this.metadata.agents[discussionAgentId];
    if (meta?.discussion === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Discussion "${discussionAgentId}" was not found.`);
    }
    const discussion = meta.discussion;
    const recipient = this.metadata.agents[recipientAgentId];
    const sameTeam = recipient?.kind === 'team' && recipient.teamLeaderAgentId === meta.teamLeaderAgentId;
    if (!discussion.participantAgentIds.includes(recipientAgentId) && !sameTeam) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Only discussion participants can read shared statements.');
    }
    const cursor = discussion.readCursors?.[recipientAgentId] ?? 0;
    const statements = discussion.statements === undefined
      ? await this.readLegacyTeamDiscussionStatements(discussionAgentId)
      : [...discussion.statements];
    const unread = statements.filter((statement) =>
      statement.entryId > cursor && statement.agentId !== recipientAgentId,
    );
    unread.sort((left, right) => left.entryId - right.entryId);
    // A read cursor is an acknowledgement of an actual prompt delivery, not
    // a transcript watermark. A compacted or malformed record must remain
    // unread instead of being silently skipped forever.
    return { statements: unread, cursor: unread.at(-1)?.entryId ?? cursor };
  }

  /** Legacy discussions stored shared statements only in the live transcript. */
  private async readLegacyTeamDiscussionStatements(
    discussionAgentId: string,
  ): Promise<TeamDiscussionStatementRecord[]> {
    const transcript = await this.ensureAgentResumed(discussionAgentId);
    const statements: TeamDiscussionStatementRecord[] = [];
    for (const message of transcript.context.history) {
      const origin = message.origin;
      const entryId = origin?.kind === 'system_trigger' && origin.name === 'team_discussion_statement'
        ? origin.discussionEntryId
        : undefined;
      if (message.role !== 'user' || entryId === undefined) continue;
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim();
      if (text.length === 0) continue;
      statements.push({
        entryId,
        agentId: origin?.speaker?.speakerId ?? 'unknown',
        name: origin?.speaker?.speakerName ?? '团队成员',
        message: text,
      });
    }
    return statements;
  }

  async acknowledgeTeamDiscussionStatements(
    discussionAgentId: string,
    recipientAgentId: string,
    cursor: number,
  ): Promise<void> {
    const meta = this.metadata.agents[discussionAgentId];
    const discussion = meta?.discussion;
    if (
      meta === undefined ||
      discussion === undefined
    ) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Only discussion participants can acknowledge shared statements.');
    }
    const recipient = this.metadata.agents[recipientAgentId];
    const sameTeam = recipient?.kind === 'team' && recipient.teamLeaderAgentId === meta.teamLeaderAgentId;
    if (!discussion.participantAgentIds.includes(recipientAgentId) && !sameTeam) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Only discussion participants can acknowledge shared statements.');
    }
    const previous = discussion.readCursors?.[recipientAgentId] ?? 0;
    if (cursor <= previous) return;
    const nextCursor = Math.min(cursor, discussion.nextStatementId ?? 0);
    this.metadata.agents[discussionAgentId] = {
      ...meta,
      discussion: {
        ...discussion,
        readCursors: { ...discussion.readCursors, [recipientAgentId]: nextCursor },
        updatedAt: new Date().toISOString(),
      },
    };
    await this.writeMetadata();
  }

  async ensureAgentResumed(id: string): Promise<Agent> {
    const entry = this.agents.get(id);
    if (entry !== undefined) return (await this.resolveAgentEntry(entry)).agent;
    if (this.metadata.agents[id] === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${id}" was not found`);
    }
    return (await this.resumeAgent(id)).agent;
  }

  /**
   * Applies a profile's derived config 閳?cwd, system prompt, active tools 閳?to
   * an agent. Fresh creation and resume-of-an-incomplete-wire both route
   * through here so the two paths cannot drift apart.
   */
  private async bootstrapAgentProfile(
    agent: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    const context = await prepareSystemPromptContext(
      this.systemContextKaos(agent.kaos.getcwd()),
      this.options.kimiHomeDir,
      { additionalDirs: this.additionalDirs, customAgents: this.options.config?.customAgents },
    );
    agent.useProfile(profile, context, this.options.kimiHomeDir);
    const { agentsMdWarning } = context;
    if (agentsMdWarning !== undefined) {
      this.agentsMdWarning = agentsMdWarning;
      log.warn('AGENTS.md exceeds recommended size', { message: agentsMdWarning });
      agent.emitEvent({
        type: 'warning',
        message: agentsMdWarning,
        code: 'agents-md-oversized',
      });
    }
  }

  async getSessionWarnings(): Promise<readonly SessionWarning[]> {
    const warnings: SessionWarning[] = [];
    const agentsMdWarning = await this.computeAgentsMdWarning();
    if (agentsMdWarning !== undefined) {
      warnings.push({
        code: 'agents-md-oversized',
        message: agentsMdWarning,
        severity: 'warning',
      });
    }
    return warnings;
  }

  private async computeAgentsMdWarning(): Promise<string | undefined> {
    if (this.agentsMdWarning !== undefined) {
      return this.agentsMdWarning;
    }
    // Resumed sessions skip bootstrap when their system prompt is already set, so
    // the cached value may be missing; recompute on demand so the warning still
    // surfaces for long-lived sessions.
    try {
      const context = await prepareSystemPromptContext(
        this.systemContextKaos(this.toolKaos.getcwd()),
        this.options.kimiHomeDir,
        { additionalDirs: this.additionalDirs, customAgents: this.options.config?.customAgents },
      );
      this.agentsMdWarning = context.agentsMdWarning;
    } catch (error) {
      log.warn('failed to compute AGENTS.md warning', { error });
    }
    return this.agentsMdWarning;
  }

  async generateAgentsMd(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();

    let spawnedAgentId: string | undefined;
    try {
      const handle = await mainAgent.subagentHost!.spawn({
        profileName: 'coder',
        parentToolCallId: 'generate-agents-md',
        prompt: DEFAULT_INIT_PROMPT,
        description: 'Initialize AGENTS.md',
        runInBackground: false,
        signal: new AbortController().signal,
      });
      spawnedAgentId = handle.agentId;
      await handle.completion;

      const agentsMd = await loadAgentsMd(mainAgent.kaos, this.options.kimiHomeDir);
      mainAgent.context.appendSystemReminder(initCompletionReminder(agentsMd), {
        kind: 'injection',
        variant: 'init',
      });
      await mainAgent.records.flush();
    } catch (error) {
      throw new KimiError(
        ErrorCodes.SESSION_INIT_FAILED,
        error instanceof Error ? error.message : 'Init failed',
        { cause: error },
      );
    } finally {
      // AGENTS.md generation is a one-shot internal task. Keep its result in
      // the parent reminder, but never leave the temporary worker in the
      // session agent tree after completion or failure.
      if (spawnedAgentId !== undefined) {
        await mainAgent.subagentHost!.discard(spawnedAgentId).catch((error) => {
          log.warn('failed to discard AGENTS.md generator', {
            agentId: spawnedAgentId,
            error,
          });
        });
      }
    }
  }

  /**
   * Appends a fresh `<plugin_session_start>` system reminder to the main agent
   * using the currently enabled plugins, then flushes records so the reminder is
   * persisted and visible on the wire. Used by the explicit `/reload` flow after
   * the session has been re-resumed with reloaded plugin state.
   *
   * When no plugin session start is currently resolvable but an earlier
   * When no plugin session start is currently resolvable but the context may still
   * carry stale plugin guidance 閳?either an earlier `<plugin_session_start>`
   * reminder, or a compaction summary that may have folded one in 閳?appends a
   * neutralizing reminder instead, so the model does not keep following stale
   * plugin instructions and the turn-loop injector does not dedup against them.
   */
  async appendPluginSessionStartReminder(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();
    const reminder = renderPluginSessionStartReminder({
      sessionStarts: mainAgent.pluginSessionStarts,
      registry: mainAgent.skills?.registry,
      log: mainAgent.log,
    });
    if (reminder !== undefined) {
      mainAgent.context.appendSystemReminder(
        `${reminder}\n\nThis supersedes any earlier plugin_session_start reminder in this session.`,
        { kind: 'injection', variant: 'plugin_session_start' },
      );
    } else if (this.shouldNeutralizePluginSessionStart(mainAgent)) {
      mainAgent.context.appendSystemReminder(
        'There are currently no active plugin session starts. This supersedes any earlier plugin_session_start reminder in this session.',
        { kind: 'injection', variant: 'plugin_session_start' },
      );
    } else {
      return;
    }
    await mainAgent.records.flush();
  }

  private shouldNeutralizePluginSessionStart(mainAgent: Agent): boolean {
    return mainAgent.context.history.some((message) => {
      const kind = message.origin?.kind;
      if (kind === 'injection') {
        return message.origin?.variant === 'plugin_session_start';
      }
      // A compaction summary replaces earlier messages (including any plugin
      // session-start reminder) with a single summary that may still carry stale
      // plugin guidance, so the origin-only check above is not sufficient.
      return kind === 'compaction_summary';
    });
  }

  get hasActiveTurn(): boolean {
    for (const agent of this.readyAgents()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  protected get metadataPath() {
    return join(this.options.homedir, 'state.json');
  }

  writeMetadata() {
    const text = JSON.stringify(this.metadata, null, 2);
    const write = async () => {
      await this.persistenceKaos.mkdir(this.options.homedir, { parents: true, existOk: true });
      await this.persistenceKaos.writeText(this.metadataPath, text);
    };
    this.writeMetadataPromise = this.writeMetadataPromise.then(write, write);
    return this.writeMetadataPromise;
  }

  async readMetadata() {
    const text = await this.persistenceKaos.readText(this.metadataPath);
    this.metadata = JSON.parse(text);
    return this.metadata;
  }

  async flushMetadata() {
    await this.skillsReady;
    await this.writeMetadataPromise;
    await Promise.all(Array.from(this.readyAgents()).map((agent) => agent.records.flush()));
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    await this.skillsReady;
    return this.skills.listSkills().map(summarizeSkill);
  }

  listPluginCommands(): readonly PluginCommandDef[] {
    return this.pluginCommands;
  }

  private async loadSkills(): Promise<void> {
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: this.options.skills?.userHomeDir ?? homedir(),
        brandHomeDir: this.options.skills?.brandHomeDir ?? this.options.kimiHomeDir,
        workDir: this.options.kaos.getcwd(),
      },
      explicitDirs: this.options.skills?.explicitDirs,
      extraDirs: this.options.skills?.extraDirs,
      pluginSkillRoots: this.options.skills?.pluginSkillRoots,
      mergeAllAvailableSkills: this.options.skills?.mergeAllAvailableSkills,
      builtinDir: this.options.skills?.builtinDir,
    });
    await this.skills.loadRoots(roots);
    registerBuiltinSkills(this.skills);
  }

  private async loadMcpServers(): Promise<void> {
    const servers = this.options.mcpConfig?.servers;
    if (servers === undefined || Object.keys(servers).length === 0) return;
    await this.mcp.connectAll(servers);
    const entries = this.mcp.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }

  private emitInitialMcpLoadError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('mcp initial load failed', error);
    void this.rpc.emitEvent({
      type: 'error',
      agentId: 'main',
      ...makeErrorPayload(ErrorCodes.MCP_STARTUP_FAILED, message),
    });
  }

  private onMcpServerStatusChange(entry: McpServerEntry): void {
    // Always surface server-level status changes to clients so the TUI/SDK
    // can keep its dashboard in sync, even before the main agent exists.
    void this.rpc.emitEvent({
      type: 'mcp.server.status',
      agentId: 'main',
      server: {
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        error: entry.error,
      },
    });
  }

  private refreshAgentBuiltinTools(): void {
    for (const agent of this.readyAgents()) {
      if (!agent.config.hasProvider) continue;
      agent.tools.initializeBuiltinTools();
    }
  }

  /** Shared guard for every lead-only team-management operation. */
  assertTeamLead(leaderAgentId: string): void {
    if (leaderAgentId !== 'main' || this.metadata.agents['main'] === undefined) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'Team management is available only to the main agent.',
      );
    }
  }

  private configureTeamAgentRuntime(agent: Agent, meta: AgentMeta): void {
    agent.teamWriteLocked = true;
    agent.teamWriteEnabled = meta.assignedTask !== undefined;
    agent.permission.setToolsReadonly(true);
    agent.permission.setMode(meta.assignedTask === undefined ? 'manual' : 'auto');
    agent.tools.setActiveTools(
      meta.assignedTask === undefined ? TEAM_READONLY_TOOLS : TEAM_ASSIGNED_TOOLS,
    );
  }

  private enableTeamLeadTools(agent: Agent): void {
    agent.tools.setActiveTools([
      // Team controls supplement the lead profile. Replacing the active set
      // would silently remove normal tools such as SubAgent and user tools.
      // This must not depend on builtin registration: profiles are selected
      // before a provider can initialize every builtin tool.
      ...agent.tools.activeToolNames(),
      ...TEAM_LEAD_TOOLS,
    ]);
  }

  private instantiateAgent(
    id: string,
    homedir: string,
    type: AgentType,
    config: Partial<AgentOptions> = {},
    parentAgentId: string | null = null,
  ): Agent {
    const parentAgent = parentAgentId !== null ? this.getReadyAgent(parentAgentId) : undefined;
    const cwd = parentAgent?.config.cwd ?? this.toolKaos.getcwd();
    let agent!: Agent;
    const browser = this.options.id === undefined
      ? undefined
      : this.options.browserProvider?.bind({ sessionId: this.options.id, agentId: id });
    const toolServices = browser === undefined
      ? this.options.toolServices
      : { ...this.options.toolServices, browser };
    agent = new Agent({
      ...config,
      type,
      kaos: this.toolKaos.withCwd(cwd),
      toolServices,
      config: this.options.config,
      homedir,
      skills: this.skills,
      rpc: proxyWithExtraPayload(this.rpc, { agentId: id }),
      // Keep the established main-session cache key, while each concurrent
      // sub-transcript gets a stable key of its own rather than evicting it.
      modelProvider: this.options.id === undefined
        ? this.options.providerManager
        : this.options.providerManager?.withPromptCacheKey(
          id === 'main' ? this.options.id : `${this.options.id}:${id}`,
        ),
      hookEngine: config.hookEngine ?? this.hookEngine,
      subagentHost: config.subagentHost ?? new SessionSubagentHost(this, id),
      mcp: this.mcp,
      permission: this.permissionOptions(parentAgentId, config.permission),
      telemetry: this.telemetry,
      log: this.log.createChild({ agentId: id }),
      pluginSessionStarts: type === 'main' ? this.options.pluginSessionStarts : undefined,
      pluginCommands: type === 'main' ? this.options.pluginCommands : undefined,
      experimentalFlags: this.experimentalFlags,
      additionalDirs: parentAgent?.getAdditionalDirs() ?? this.additionalDirs,
      coderWriteEnabled: parentAgent?.coderWriteEnabled ?? false,
      obsidianMemory: config.obsidianMemory ?? parentAgent?.obsidianMemory,
      noriWorkflow: config.noriWorkflow ?? parentAgent?.noriWorkflow,
      systemPromptContextProvider: () =>
        prepareSystemPromptContext(
          this.systemContextKaos(agent.kaos.getcwd()),
          this.options.kimiHomeDir,
          { additionalDirs: agent.getAdditionalDirs(), customAgents: this.options.config?.customAgents },
        ),
    });
    return agent;
  }

  private permissionOptions(
    parentAgentId: string | null,
    input?: PermissionManagerOptions | undefined,
  ): PermissionManagerOptions {
    if (parentAgentId === null) {
      return {
        ...input,
        initialRules: input?.initialRules ?? this.options.permissionRules,
      };
    }
    return {
      ...input,
      parent: input?.parent ?? this.getReadyAgent(parentAgentId)?.permission,
    };
  }

  getReadyAgent(id: string): Agent | undefined {
    const entry = this.agents.get(id);
    return entry instanceof Agent ? entry : undefined;
  }

  *readyAgents(): Iterable<Agent> {
    for (const entry of this.agents.values()) {
      if (entry instanceof Agent) yield entry;
    }
  }

  getNoriRuntimeSettings(): NoriRuntimeSettings {
    const raw = this.metadata.custom[NORI_RUNTIME_METADATA_KEY];
    const fallbackReadonly = this.getReadyAgent('main')?.permission.toolsReadonly ?? true;
    return normalizeNoriRuntimeSettings(raw, {
      coderWriteEnabled: false,
      toolsReadonly: fallbackReadonly,
    });
  }

  async setNoriRuntimeSettings(
    patch: SetNoriRuntimeSettingsPayload,
  ): Promise<NoriRuntimeSettings> {
    const current = this.getNoriRuntimeSettings();
    const next = normalizeNoriRuntimeSettings({ ...current, ...patch }, current);
    this.metadata = {
      ...this.metadata,
      updatedAt: new Date().toISOString(),
      custom: {
        ...this.metadata.custom,
        [NORI_RUNTIME_METADATA_KEY]: next,
      },
    };
    await this.writeMetadata();
    this.applyNoriRuntimeSettings(next);
    const main = this.getReadyAgent('main');
    main?.emitStatusUpdated();
    return next;
  }

  private hasPersistedNoriRuntimeSettings(): boolean {
    return this.metadata.custom[NORI_RUNTIME_METADATA_KEY] !== undefined;
  }

  private async persistDefaultNoriRuntimeSettings(agent: Agent): Promise<void> {
    if (this.hasPersistedNoriRuntimeSettings()) return;
    this.metadata = {
      ...this.metadata,
      custom: {
        ...this.metadata.custom,
        [NORI_RUNTIME_METADATA_KEY]: {
          coderWriteEnabled: agent.coderWriteEnabled,
          toolsReadonly: agent.permission.toolsReadonly,
        },
      },
    };
    await this.writeMetadata();
  }

  private applyNoriRuntimeSettings(settings: NoriRuntimeSettings): void {
    for (const agent of this.readyAgents()) {
      this.applyNoriRuntimeSettingsToAgent(agent, settings);
    }
  }

  private applyNoriRuntimeSettingsToAgent(
    agent: Agent,
    settings: NoriRuntimeSettings,
  ): void {
    agent.coderWriteEnabled = settings.coderWriteEnabled;
    if (agent.type === 'main') {
      agent.permission.setToolsReadonly(settings.toolsReadonly);
    }
    if (settings.coderWriteEnabled && agent.type === 'sub') {
      agent.permission.setMode('auto');
    }
    if (agent.config.hasProvider) {
      agent.tools.refreshBuiltinTools();
    }
  }

  private async resolveAgentEntry(entry: AgentEntry): Promise<ResumedAgent> {
    if (entry instanceof Agent) return { agent: entry };
    return entry;
  }

  private resumeAgent(
    id: string,
    stack: readonly string[] = [],
  ): Promise<ResumedAgent> {
    if (stack.includes(id)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session agent parent chain contains a cycle: ${[...stack, id].join(' -> ')}`,
      );
    }

    const entry = this.agents.get(id);
    if (entry !== undefined) return this.resolveAgentEntry(entry);

    const promise = this.resumePersistedAgent(id, stack);
    this.agents.set(id, promise);
    return promise;
  }

  private async resumePersistedAgent(
    id: string,
    stack: readonly string[] = [],
  ): Promise<ResumedAgent> {
    await this.skillsReady;
    const meta = this.metadata.agents[id];
    if (meta === undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session agent "${id}" is missing`);
    }

    const parentAgentId = meta.parentAgentId ?? null;
    const parent =
      parentAgentId === null
        ? undefined
        : await this.resumeAgent(parentAgentId, [...stack, id]);

    let config: Partial<AgentOptions> = {};
    let effective: { memory: NoriMemoryProvider; coderWriteEnabled?: boolean } | null = null;
    if (meta.type === 'main') {
      const cwd = this.toolKaos.getcwd();
      const noriConfig = loadNoriYamlConfig(cwd);
      const autoProviders = createNoriProvidersFromConfig(
        noriConfig,
        this.options.config ?? { providers: {} },
        cwd,
      );
      const optionsProviders = this.options.noriProviders;
      effective = optionsProviders ?? autoProviders;
      const noriWorkflow = resolveNoriWorkflowConfig(noriConfig);
      const rulesConfig = noriConfig?.['rules'];
      const definitions =
        typeof rulesConfig === 'object' && rulesConfig !== null
          ? (rulesConfig as Record<string, unknown>)['definitions']
          : undefined;
      const noriRules = normalizeNoriRuleDefinitions(definitions);
      config = { noriRules, noriWorkflow };
      if (effective !== null) {
        config = {
          ...config,
          obsidianMemory: effective.memory,
          coderWriteEnabled: effective.coderWriteEnabled ?? false,
        };
      }
    }

    try {
      const agent = this.instantiateAgent(id, meta.homedir, meta.type, config, parentAgentId);
      const result = await agent.resume();
      this.restoreAgentProfileHandle(agent, meta, parent?.agent);
      if (meta.kind === 'team') this.configureTeamAgentRuntime(agent, meta);
      if (meta.type === 'main') this.enableTeamLeadTools(agent);
      await this.refreshMainAgentProfileCapabilities(agent, meta, parent?.agent);

      this.agents.set(id, agent);
      return { agent, warning: parent?.warning ?? result.warning };
    } catch (error) {
      const entry = this.agents.get(id);
      if (entry instanceof Promise) {
        this.agents.delete(id);
      }
      throw error;
    }
  }

  private restoreAgentProfileHandle(
    agent: Agent,
    meta: AgentMeta,
    parentAgent: Agent | undefined,
  ): void {
    if (agent.config.systemPrompt === '') return;
    const profile = this.resolvePersistedProfile(agent, meta, parentAgent);
    if (profile === undefined) return;
    agent.setActiveProfile(profile, this.options.kimiHomeDir);
  }

  private async refreshMainAgentProfileCapabilities(
    agent: Agent,
    meta: AgentMeta,
    parentAgent: Agent | undefined,
  ): Promise<void> {
    if (meta.type !== 'main') return;
    const profile =
      this.resolvePersistedProfile(agent, meta, parentAgent) ??
      DEFAULT_AGENT_PROFILES['nori-agent'] ??
      DEFAULT_AGENT_PROFILES['agent'];
    if (profile === undefined) return;
    if (!mainProfileNeedsCapabilityRefresh(agent)) return;
    await this.bootstrapAgentProfile(agent, profile);
  }

  private resolvePersistedProfile(
    agent: Agent,
    meta: AgentMeta,
    parentAgent: Agent | undefined,
  ): ResolvedAgentProfile | undefined {
    const profileName = agent.config.profileName;
    if (profileName === undefined) return undefined;
    if (meta.type === 'sub') {
      const parentProfileName = parentAgent?.config.profileName;
      const profile = (
        DEFAULT_AGENT_PROFILES[parentProfileName ?? 'agent']?.subagents?.[profileName] ??
        DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName]
      );
      if (meta.kind === 'team') return teamProfile(profile ?? defaultTeamProfile(), teamIdentityFromMeta(meta));
      if (meta.discussion !== undefined) return discussionProfile(profile ?? defaultTeamProfile(), meta.discussion);
      return profile;
    }
    return DEFAULT_AGENT_PROFILES[profileName];
  }

  private nextGeneratedAgentId(): string {
    while (true) {
      const id = `agent-${this.agentIdCounter++}`;
      if (this.agents.has(id)) continue;
      if (this.metadata.agents[id] !== undefined) continue;
      return id;
    }
  }

  private requireMainAgent(): Agent {
    const agent = this.getReadyAgent('main');
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return agent;
  }

  private async triggerSessionStart(source: 'startup' | 'resume'): Promise<void> {
    await this.hookEngine.trigger('SessionStart', {
      matcherValue: source,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: 'exit'): Promise<void> {
    await this.hookEngine.trigger('SessionEnd', {
      matcherValue: reason,
      inputData: { reason },
    });
  }
}

export * from './subagent-host';

const TEAM_LEAD_TOOLS = [
  'TeamCreate',
  'TeamDismiss',
  'TeamAssign',
  'TeamBroadcast',
  'TeamDM',
  'TeamStatus',
  'TeamDiscussInvite',
  'TeamDiscussKick',
  'TeamDecide',
] as const;

const TEAM_READONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'WebSearch',
  'FetchURL',
  'TeamSpeak',
  'TeamDM',
  'TeamStatus',
] as const;

const TEAM_ASSIGNED_TOOLS = [
  ...TEAM_READONLY_TOOLS,
  'Write',
  'Edit',
  'Bash',
  'SubAgent',
] as const;

function validateTeamIdentity(identity: TeamIdentity | undefined): asserts identity is TeamIdentity {
  if (identity === undefined) {
    throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A team identity is required.');
  }
  for (const [field, value] of Object.entries(identity)) {
    if (value.trim().length === 0) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Team identity field "${field}" must not be blank.`,
      );
    }
  }
}

function teamIdentityFromMeta(meta: AgentMeta): TeamIdentity {
  return {
    name: meta.name ?? 'Team member',
    title: meta.title ?? 'Team partner',
    intro: meta.intro ?? '',
    mandate: meta.mandate ?? '',
    role: meta.role ?? '',
  };
}

function defaultTeamProfile(): ResolvedAgentProfile {
  const profile = DEFAULT_AGENT_PROFILES['nori-agent'] ?? DEFAULT_AGENT_PROFILES['agent'];
  if (profile === undefined) {
    throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'The default team agent profile is unavailable.');
  }
  return profile;
}

function teamProfile(
  profile: ResolvedAgentProfile,
  identity: TeamIdentity,
): ResolvedAgentProfile {
  return {
    ...profile,
    systemPrompt: (context) => [
      '<team_identity>',
      `Name: ${escapeTeamIdentity(identity.name)}`,
      `Title: ${escapeTeamIdentity(identity.title)}`,
      `Introduction: ${escapeTeamIdentity(identity.intro)}`,
      `Mandate: ${escapeTeamIdentity(identity.mandate)}`,
      `Role: ${escapeTeamIdentity(identity.role)}`,
      '</team_identity>',
      profile.systemPrompt({ ...context, roleAdditional: '' }),
      TEAM_AGENT_PROMPT.trim(),
    ].join('\n'),
  };
}

function discussionProfile(
  profile: ResolvedAgentProfile,
  discussion: TeamDiscussionMeta,
): ResolvedAgentProfile {
  return {
    ...profile,
    systemPrompt: (context) => [
      profile.systemPrompt(context),
      '<team_discussion_transcript>',
      `Topic: ${escapeTeamIdentity(discussion.topic)}`,
      'This is the durable shared transcript for a team discussion. Preserve actual participant statements. Do not fabricate statements for participants who did not call TeamSpeak.',
      '</team_discussion_transcript>',
    ].join('\n'),
  };
}

function escapeTeamIdentity(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const MAIN_PROFILE_REQUIRED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'] as const;

function mainProfileNeedsCapabilityRefresh(agent: Agent): boolean {
  const activeTools = new Set(
    agent.tools.data().filter((tool) => tool.active).map((tool) => tool.name),
  );
  if (MAIN_PROFILE_REQUIRED_TOOLS.some((tool) => !activeTools.has(tool))) return true;
  return mainSystemPromptLooksPermissionLocked(agent.config.systemPrompt);
}

function mainSystemPromptLooksPermissionLocked(systemPrompt: string): boolean {
  return (
    systemPrompt.includes('do NOT write code or execute shell commands directly') ||
    systemPrompt.includes('For any file write, code edit, or shell execution') ||
    systemPrompt.includes('Direct Write/Edit/Bash calls')
  );
}

function normalizeNoriRuntimeSettings(
  raw: unknown,
  fallback: NoriRuntimeSettings,
): NoriRuntimeSettings {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const coderWriteEnabled =
    typeof input['coderWriteEnabled'] === 'boolean'
      ? input['coderWriteEnabled']
      : fallback.coderWriteEnabled;
  const toolsReadonly =
    typeof input['toolsReadonly'] === 'boolean'
      ? input['toolsReadonly']
      : fallback.toolsReadonly;
  return { coderWriteEnabled, toolsReadonly };
}

function normalizeNoriRuleDefinitions(raw: unknown): RuleConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((rule): rule is Record<string, unknown> =>
      typeof rule === 'object' && rule !== null,
    )
    .map((rule) => {
      const condition = typeof rule['condition'] === 'object' && rule['condition'] !== null
        ? { ...(rule['condition'] as Record<string, unknown>) }
        : {};
      if (condition['stage'] === 'entry') {
        condition['stage'] = 'enter';
      }
      return {
        ...rule,
        condition,
      } as unknown as RuleConfig;
    });
}

function initCompletionReminder(agentsMd: string): string {
  const latest =
    agentsMd.trim().length === 0
      ? 'No AGENTS.md content was found after `/init` completed.'
      : agentsMd;
  return [
    'The user just ran `/init` slash command.',
    'The system has analyzed the codebase and generated an `AGENTS.md` file.',
    '',
    'Latest AGENTS.md file content:',
    latest,
  ].join('\n');
}
