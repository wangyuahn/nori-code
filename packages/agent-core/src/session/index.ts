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
import type { PermissionManagerOptions, PermissionMode, PermissionRule } from '../agent/permission';
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
import {
  activeDiscussionAsParticipant,
  canCreateDepartmentInTree,
  DEFAULT_TEAM_MAX_DEPTH,
  departmentDepth,
  teamDepth,
} from './team-tree';
import { withMountTreeMutation } from './mount-mutation';
import { formatSessionSelf, type SessionSelfInfo } from './session-self';
import type { BrowserProvider, ToolServices } from '../tools/support/services';
import TEAM_AGENT_PROMPT from './team-agent.md?raw';
import TEAM_MEMBER_ROLE_PROMPT from './team-member-role.md?raw';
import TEAM_ENGINEERING_PROMPT from '../profile/default/team-engineering.md?raw';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import { abortError } from '../utils/abort';
import { loadNoriYamlConfig, createNoriProvidersFromConfig } from "./nori-providers";

export interface SessionOptions {
  readonly kaos: Kaos;
  readonly persistenceKaos?: Kaos;
  /**
   * The runtime config. Pass a function to read it live: `config.toml` is
   * rewritten while sessions run (`setKimiConfig`), and a session that captured
   * one object keeps answering from the file as it was at startup. Values the
   * settings UI edits — `team.maxDepth`, `customAgents` — must be read live or
   * the setting silently does nothing until restart.
   */
  readonly config?: KimiConfig | (() => KimiConfig);
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
  /** Parent map for mount-depth checks (sessionId → parentSessionId). */
  readonly listMountParentById?: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** Creates the standalone session shown for a TeamCreate member. */
  readonly createMountedMember?: (
    input: { readonly identity: TeamIdentity; readonly parentSessionId?: string },
  ) => Promise<{ readonly sessionId: string }>;
  /** Deletes the standalone session owned by a dismissed TeamCreate member. */
  readonly deleteMountedMember?: (sessionId: string) => Promise<void>;
  /** Rebuilds the cached session identity block after team membership changes. */
  readonly refreshSessionSelf?: () => Promise<void>;
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
  /** `team` agents are durable members; `sub` agents are discussion transcripts. */
  readonly kind?: 'team' | 'sub';
  readonly name?: string;
  /** @deprecated Read legacy metadata only; never emit or display it for new agents. */
  readonly title?: string;
  /** @deprecated Read legacy metadata only; never emit or display it for new agents. */
  readonly intro?: string;
  readonly mandate?: string;
  readonly role?: string;
  /** The lead that owns this durable team member or discussion transcript. */
  readonly teamLeaderAgentId?: string;
  /** Current scheduling metadata; it does not gate the member's tool permissions. */
  readonly assignedTask?: string;
  readonly assignedAt?: string;
  /** Latest report for the current or most recent TeamAssign lease. */
  readonly teamReport?: TeamReportRecord;
  /** Standalone session shown for this member on the conversation map. */
  readonly mountedSessionId?: string;
  /** Present only on an agent-scoped, archived-or-active team discussion transcript. */
  readonly discussion?: TeamDiscussionMeta;
  /**
   * This node's own department chat log — messages among its direct members
   * only. Never includes this node itself. Persists for the agent's lifetime;
   * unlike `discussion`, it is never archived or replaced.
   */
  readonly chat?: TeamChatMeta;
}

export interface TeamChatMeta {
  readonly nextMessageId?: number;
  readonly messages?: readonly TeamChatMessageRecord[];
}

export interface TeamChatMessageRecord {
  readonly messageId: number;
  readonly agentId: string;
  readonly name: string;
  readonly message: string;
  readonly mentions: readonly string[];
  readonly sentAt: string;
}

export interface TeamIdentity {
  readonly name: string;
  readonly role: string;
  readonly mandate: string;
}

export interface TeamDiscussionMeta {
  readonly participantAgentIds: readonly string[];
  readonly status: 'active' | 'archived';
  readonly topic: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** Monotonic statement sequence used by participant-specific read cursors. */
  readonly nextStatementId?: number;
  /** Number of completed or currently running discussion rounds. */
  readonly round?: number;
  /** Runtime marker used by the session tree to highlight the current speaker. */
  readonly currentTurnAgentId?: string;
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

export type TeamReportStatus = 'unreported' | 'completed' | 'blocked' | 'needs_decision';

export interface TeamReportRecord {
  readonly assignmentId: string;
  readonly task: string;
  readonly status: TeamReportStatus;
  readonly summary?: string;
  readonly reportedAt?: string;
  readonly receivedAt?: string;
  readonly missingReminderAt?: string;
}

interface ResumedAgent {
  readonly agent: Agent;
  readonly warning?: string;
}

type AgentEntry = Agent | Promise<ResumedAgent>;

export interface CreateAgentOptions {
  readonly profile?: ResolvedAgentProfile;
  readonly parentAgentId?: string;
  readonly persistMetadata?: boolean;
  readonly kind?: 'team' | 'sub';
  readonly teamIdentity?: TeamIdentity;
  readonly teamLeaderAgentId?: string;
  readonly assignedTask?: string;
  readonly discussion?: TeamDiscussionMeta;
  readonly name?: string;
  readonly mountedSessionId?: string;
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
  /**
   * 会话级权限模式：整个会话（主智能体 + 所有成员）共用同一个值。
   * `applySessionPermissionMode` 写它，招人和 Discuss 结束后的重新配置都从它取值。
   */
  private sessionPermissionMode: PermissionMode | undefined;

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

  /**
   * The runtime config as it stands right now. Resolves the accessor form of
   * `options.config` on every read, so a session started before a `config.toml`
   * rewrite answers from the current file rather than from a startup snapshot.
   */
  private get runtimeConfig(): KimiConfig | undefined {
    const { config } = this.options;
    return typeof config === 'function' ? config() : config;
  }

  async updateCustomAgents(customAgents: KimiConfig['customAgents']): Promise<void> {
    const config = this.runtimeConfig;
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
      this.runtimeConfig ?? { providers: {} },
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
    const cancellations: Array<Promise<void>> = [];
    for (const entry of this.agents.values()) {
      if (!(entry instanceof Agent)) continue;
      cancellations.push(this.cancelAgentTurnOnClose(entry));
    }
    await Promise.allSettled(cancellations);
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
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId, kind === 'team');
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
        kind,
        name: identity?.name ?? options.name,
        mandate: identity?.mandate,
        role: identity?.role,
        teamLeaderAgentId: options.teamLeaderAgentId,
        assignedTask: options.assignedTask,
        assignedAt: options.assignedTask === undefined ? undefined : new Date().toISOString(),
        discussion: options.discussion,
        mountedSessionId: options.mountedSessionId,
      };
      this.metadata.agents[id] = metadata;
      try {
        if (kind === 'team') this.invalidateSessionSelfBlock();
        if (kind === 'team') this.configureTeamAgentRuntime(agent, metadata);
        await this.writeMetadata();
        if (kind === 'team') this.emitTeamAgentsUpdated();
      } catch (error) {
        delete this.metadata.agents[id];
        this.agents.delete(id);
        if (kind === 'team') this.invalidateSessionSelfBlock();
        throw error;
      }
    }
    if (type === 'main') this.enableTeamLeadTools(agent);

    return { id, agent };
  }

  /**
   * Creates a durable member of `leaderAgentId`'s department.
   *
   * A hire is exactly one entity: an agent in this session. It is *not* also
   * mirrored into a freshly created standalone session — that dual-write is why
   * the conversation map used to show every member twice and open an empty copy
   * instead of the member's real transcript. The map reads members straight off
   * the agent tree and talks to them through `(sessionId, agentId)`.
   */
  async createTeamMember(
    leaderAgentId: string,
    identity: TeamIdentity,
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    return withMountTreeMutation(() => this.createTeamMemberUnlocked(leaderAgentId, identity));
  }

  private async createTeamMemberUnlocked(
    leaderAgentId: string,
    identity: TeamIdentity,
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    this.assertTeamManager(leaderAgentId);
    await this.assertCanCreateDepartment(leaderAgentId);
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
    const leaderMeta = this.metadata.agents[leaderAgentId];
    const mounted = await this.options.createMountedMember?.({
      identity,
      parentSessionId: leaderMeta?.mountedSessionId ?? this.options.id,
    });
    let createdAgentId: string | undefined;
    try {
      const result = await this.createAgent(
        { type: 'sub', generate: leader.rawGenerate },
        {
          kind: 'team',
          teamIdentity: identity,
          teamLeaderAgentId: leaderAgentId,
          parentAgentId: leaderAgentId,
          profile: defaultTeamProfile(),
          mountedSessionId: mounted?.sessionId,
        },
      );
      createdAgentId = result.id;
      result.agent.config.update({
        cwd: leader.config.cwd,
        modelAlias: leader.config.modelAlias,
        thinkingEffort: leader.config.thinkingEffort,
      });
      result.agent.tools.inheritUserTools(leader.tools);
      await leader.refreshSystemPrompt();
      await this.options.refreshSessionSelf?.();
      return result;
    } catch (error) {
      try {
        if (createdAgentId !== undefined) {
          await this.dismissTeamMembers(
            leaderAgentId,
            [createdAgentId],
            'Rolling back a failed team member creation.',
            true,
          );
        } else if (mounted !== undefined) {
          await this.options.deleteMountedMember?.(mounted.sessionId);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Team member creation failed and could not be rolled back.',
        );
      }
      throw error;
    }
  }

  getAgentMetadata(id: string): AgentMeta | undefined {
    return this.metadata.agents[id];
  }

  teamMemberMetadata(leaderAgentId: string): Array<readonly [string, AgentMeta]> {
    return Object.entries(this.metadata.agents).filter(([, meta]) =>
      meta.kind === 'team' && meta.teamLeaderAgentId === leaderAgentId,
    );
  }

  async attachMountedTeamMember(input: {
    readonly mountedSessionId: string;
    readonly identity: TeamIdentity;
    readonly teamLeaderAgentId?: string;
  }): Promise<{ readonly agentId: string }> {
    return withMountTreeMutation(() => this.attachMountedTeamMemberUnlocked(input));
  }

  private async attachMountedTeamMemberUnlocked(input: {
    readonly mountedSessionId: string;
    readonly identity: TeamIdentity;
    readonly teamLeaderAgentId?: string;
  }): Promise<{ readonly agentId: string }> {
    const leaderAgentId = input.teamLeaderAgentId ?? 'main';
    this.assertTeamManager(leaderAgentId);
    validateTeamIdentity(input.identity);

    const existing = this.teamMemberMetadata(leaderAgentId).find(
      ([, meta]) => meta.mountedSessionId === input.mountedSessionId,
    );
    if (existing !== undefined) {
      const [agentId, current] = existing;
      const next: AgentMeta = {
        ...current,
        name: input.identity.name,
        role: input.identity.role,
        mandate: input.identity.mandate,
      };
      this.metadata.agents[agentId] = next;
      this.invalidateSessionSelfBlock();
      const agent = await this.ensureAgentResumed(agentId);
      this.configureTeamAgentRuntime(agent, next);
      await this.writeMetadata();
      this.emitTeamAgentsUpdated();
      await this.ensureAgentResumed(leaderAgentId).then((leader) => leader.refreshSystemPrompt());
      await this.options.refreshSessionSelf?.();
      return { agentId };
    }

    await this.assertCanCreateDepartment(leaderAgentId);
    const leader = await this.ensureAgentResumed(leaderAgentId);
    let createdAgentId: string | undefined;
    try {
      const result = await this.createAgent(
        { type: 'sub', generate: leader.rawGenerate },
        {
          kind: 'team',
          teamIdentity: input.identity,
          teamLeaderAgentId: leaderAgentId,
          parentAgentId: leaderAgentId,
          profile: defaultTeamProfile(),
          mountedSessionId: input.mountedSessionId,
        },
      );
      createdAgentId = result.id;
      result.agent.config.update({
        cwd: leader.config.cwd,
        modelAlias: leader.config.modelAlias,
        thinkingEffort: leader.config.thinkingEffort,
      });
      result.agent.tools.inheritUserTools(leader.tools);
      await leader.refreshSystemPrompt();
      await this.options.refreshSessionSelf?.();
      return { agentId: result.id };
    } catch (error) {
      try {
        if (createdAgentId !== undefined) {
          await this.detachMountedTeamMember(input.mountedSessionId);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Mounted team member attach failed and could not be rolled back.',
        );
      }
      throw error;
    }
  }

  async detachMountedTeamMember(
    mountedSessionId: string,
  ): Promise<{ readonly detachedAgentIds: readonly string[] }> {
    return withMountTreeMutation(() => this.detachMountedTeamMemberUnlocked(mountedSessionId));
  }

  private async detachMountedTeamMemberUnlocked(
    mountedSessionId: string,
  ): Promise<{ readonly detachedAgentIds: readonly string[] }> {
    const roots = Object.entries(this.metadata.agents)
      .filter(([, meta]) => meta.kind === 'team' && meta.mountedSessionId === mountedSessionId)
      .map(([agentId]) => agentId);
    if (roots.length === 0) return { detachedAgentIds: [] };

    const branchIds = [...roots, ...this.descendantAgentIds(roots)];
    const leaders = new Set(
      roots
        .map((agentId) => this.metadata.agents[agentId]?.teamLeaderAgentId)
        .filter((agentId): agentId is string => agentId !== undefined),
    );
    for (const agentId of branchIds) {
      const agent = this.getReadyAgent(agentId);
      agent?.turn.cancel(undefined, abortError('Mounted member detached'));
      await agent?.background.stopAll('Mounted member detached');
      this.agents.delete(agentId);
      delete this.metadata.agents[agentId];
    }
    const archivedDiscussionLeaders = this.removeDismissedAgentsFromDiscussions(new Set(branchIds));
    this.invalidateSessionSelfBlock();
    await this.writeMetadata();
    this.emitTeamAgentsUpdated();
    await this.options.refreshSessionSelf?.();
    for (const leaderAgentId of leaders) {
      this.configureTeamMembers(leaderAgentId);
      const leader = await this.ensureAgentResumed(leaderAgentId);
      if (archivedDiscussionLeaders.has(leaderAgentId)) leader.discussMode.exit();
      else leader.discussMode.deactivateIfOrphaned();
      await leader.refreshSystemPrompt();
    }
    return { detachedAgentIds: roots };
  }

  async dismissTeamMembers(
    leaderAgentId: string,
    agentIds: readonly string[],
    reason: string,
    confirmActive: boolean,
  ): Promise<void> {
    return withMountTreeMutation(() =>
      this.dismissTeamMembersUnlocked(leaderAgentId, agentIds, reason, confirmActive),
    );
  }

  private async dismissTeamMembersUnlocked(
    leaderAgentId: string,
    agentIds: readonly string[],
    reason: string,
    confirmActive: boolean,
  ): Promise<void> {
    this.assertTeamManager(leaderAgentId);
    if (reason.trim().length === 0) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'TeamDismiss requires a reason.');
    }
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length === 0 || uniqueIds.length !== agentIds.length) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Specify each team member once.');
    }
    for (const id of uniqueIds) {
      const meta = this.metadata.agents[id];
      if (meta?.kind !== 'team' || meta.teamLeaderAgentId !== leaderAgentId) {
        throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Team member "${id}" was not found.`);
      }
    }
    // A dismissal owns the whole member branch. A direct member turn is not
    // the only in-flight work: an assigned partner can have temporary
    // background work below it. Treat that as active too so the
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
        'One or more team members are working. Retry TeamDismiss with confirm_active=true.',
      );
    }

    const cancellation = abortError(`Dismissed: ${reason.trim()}`);
    // Capture mount targets before mutating agent metadata so a later
    // persistence failure can abort without deleting map sessions first.
    const mountedSessionIds = [
      ...new Set(
        branchIds
          .map((id) => this.metadata.agents[id]?.mountedSessionId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const removedMetas = new Map<string, AgentMeta>();
    for (const id of branchIds) {
      const meta = this.metadata.agents[id];
      if (meta !== undefined) removedMetas.set(id, meta);
    }
    const cleanupErrors: unknown[] = [];
    for (const id of branchIds) {
      const agent = this.getReadyAgent(id);
      agent?.turn.cancel(undefined, cancellation);
      try {
        await agent?.background.stopAll(`Dismissed: ${reason.trim()}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
      this.agents.delete(id);
      delete this.metadata.agents[id];
    }
    const archivedDiscussionLeaders = this.removeDismissedAgentsFromDiscussions(new Set(branchIds));
    this.invalidateSessionSelfBlock();
    try {
      await this.writeMetadata();
    } catch (error) {
      try {
        await this.writeMetadata();
      } catch (retryError) {
        for (const [id, meta] of removedMetas) {
          this.metadata.agents[id] = meta;
        }
        this.invalidateSessionSelfBlock();
        throw new AggregateError(
          [error, retryError],
          'Team member dismissal aborted: agent removal could not be persisted.',
        );
      }
    }
    this.emitTeamAgentsUpdated();

    // Mounted sessions are deleted only after agent metadata is durable.
    // A failed delete leaves an orphan map node, which is safer than an agent
    // whose mounted_session_id points at a session that no longer exists.
    for (const mountedSessionId of mountedSessionIds) {
      try {
        await this.options.deleteMountedMember?.(mountedSessionId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await this.options.refreshSessionSelf?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    const leadersToRefresh = new Set([leaderAgentId, ...archivedDiscussionLeaders]);
    for (const departmentLeaderId of leadersToRefresh) {
      try {
        const leader = await this.ensureAgentResumed(departmentLeaderId);
        this.configureTeamMembers(departmentLeaderId);
        if (archivedDiscussionLeaders.has(departmentLeaderId)) leader.discussMode.exit();
        else leader.discussMode.deactivateIfOrphaned();
        await leader.refreshSystemPrompt();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Team member dismissal completed with cleanup errors.',
      );
    }
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

  /**
   * Remove dismissed members from every surviving discussion and its runtime
   * turn state. A dismissed member can be below the direct target, and a
   * discussion transcript can itself be in that deleted branch, so clean both
   * persisted metadata and in-memory scheduling maps.
   */
  private removeDismissedAgentsFromDiscussions(dismissed: ReadonlySet<string>): ReadonlySet<string> {
    const archivedDiscussionLeaders = new Set<string>();
    for (const discussionAgentId of dismissed) {
      this.activeTeamDiscussionTurns.delete(discussionAgentId);
      this.teamDiscussionSpeaks.delete(discussionAgentId);
    }
    const clearedDiscussionTurns = new Set<string>();
    for (const [discussionAgentId, turnAgentId] of this.activeTeamDiscussionTurns) {
      if (dismissed.has(turnAgentId)) {
        this.activeTeamDiscussionTurns.delete(discussionAgentId);
        clearedDiscussionTurns.add(discussionAgentId);
      }
    }
    for (const [discussionAgentId, speaks] of this.teamDiscussionSpeaks) {
      for (const agentId of dismissed) speaks.delete(agentId);
      if (speaks.size === 0) this.teamDiscussionSpeaks.delete(discussionAgentId);
    }

    for (const [discussionAgentId, meta] of Object.entries(this.metadata.agents)) {
      const discussion = meta.discussion;
      if (discussion === undefined) continue;
      const participantAgentIds = discussion.participantAgentIds.filter((id) => !dismissed.has(id));
      const currentTurnCleared =
        (discussion.currentTurnAgentId !== undefined && dismissed.has(discussion.currentTurnAgentId))
        || clearedDiscussionTurns.has(discussionAgentId);
      const nextReadCursors = discussion.readCursors === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(discussion.readCursors).filter(([agentId]) => !dismissed.has(agentId)),
          );
      const cursorsChanged =
        discussion.readCursors !== undefined
        && Object.keys(nextReadCursors ?? {}).length !== Object.keys(discussion.readCursors).length;
      const participantsChanged = participantAgentIds.length !== discussion.participantAgentIds.length;
      const statusChanged = participantAgentIds.length === 0 && discussion.status === 'active';
      if (participantAgentIds.length === 0 && meta.teamLeaderAgentId !== undefined) {
        archivedDiscussionLeaders.add(meta.teamLeaderAgentId);
      }
      if (!participantsChanged && !statusChanged && !cursorsChanged && !currentTurnCleared) continue;
      this.metadata.agents[discussionAgentId] = {
        ...meta,
        discussion: {
          ...discussion,
          participantAgentIds,
          status: participantAgentIds.length === 0 ? 'archived' : discussion.status,
          currentTurnAgentId: currentTurnCleared ? undefined : discussion.currentTurnAgentId,
          readCursors: nextReadCursors,
          updatedAt: new Date().toISOString(),
        },
      };
      this.getReadyAgent(discussionAgentId)?.emitEvent({
        type: 'discussion.updated',
        discussionAgentId,
        kind: 'lifecycle',
        currentTurnAgentId: currentTurnCleared ? null : undefined,
      });
    }
    return archivedDiscussionLeaders;
  }

  async assignTeamTasks(
    leaderAgentId: string,
    assignments: readonly TeamAssignment[],
  ): Promise<Array<{
    readonly agentId: string;
    readonly task: string | null;
    readonly agent: Agent;
    readonly assignedAt?: string;
  }>> {
    this.assertTeamManager(leaderAgentId);
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
        teamReport: assignment.task === null
          ? current.teamReport
          : {
              assignmentId: assignedAt,
              task: assignment.task,
              status: 'unreported',
            },
      };
      this.configureTeamAgentRuntime(assignment.agent, this.metadata.agents[assignment.agentId]!);
      this.emitTeamStatus(assignment.agentId);
    }
    await this.writeMetadata();
    const leader = await this.ensureAgentResumed(leaderAgentId);
    if (leader.discussMode.isActive) {
      leader.discussMode.exit();
      this.configureTeamMembers(leaderAgentId);
    }
    return resolved.map((assignment) => ({
      ...assignment,
      assignedAt: assignment.task === null ? undefined : assignedAt,
    }));
  }

  /**
   * Release one member's write lease only if it still belongs to the observed
   * TeamAssign call. A late completion from an older turn must never revoke a
   * newer assignment for the same durable member.
   */
  async releaseTeamAssignment(
    leaderAgentId: string,
    agentId: string,
    assignedAt: string,
  ): Promise<boolean> {
    this.assertTeamManager(leaderAgentId);
    const current = this.metadata.agents[agentId];
    if (
      current?.kind !== 'team'
      || current.teamLeaderAgentId !== leaderAgentId
      || current.assignedAt !== assignedAt
    ) {
      return false;
    }
    this.metadata.agents[agentId] = {
      ...current,
      assignedTask: undefined,
      assignedAt: undefined,
    };
    const agent = this.getReadyAgent(agentId);
    if (agent !== undefined) this.configureTeamAgentRuntime(agent, this.metadata.agents[agentId]!);
    await this.writeMetadata();
    this.emitTeamStatus(agentId);
    return true;
  }

  async recordTeamReport(
    agentId: string,
    status: Exclude<TeamReportStatus, 'unreported'>,
    summary: string,
  ): Promise<boolean> {
    const meta = this.metadata.agents[agentId];
    const current = meta?.teamReport;
    if (
      meta?.kind !== 'team'
      || current === undefined
      || current.receivedAt !== undefined
      || summary.trim().length === 0
    ) {
      return false;
    }
    this.metadata.agents[agentId] = {
      ...meta,
      teamReport: {
        ...current,
        status,
        summary: summary.trim(),
        reportedAt: new Date().toISOString(),
        missingReminderAt: undefined,
      },
    };
    await this.writeMetadata();
    this.emitTeamStatus(agentId);
    return true;
  }

  async acknowledgeTeamReport(agentId: string): Promise<boolean> {
    const meta = this.metadata.agents[agentId];
    const report = meta?.teamReport;
    if (
      meta?.kind !== 'team'
      || report === undefined
      || report.status === 'unreported'
      || report.receivedAt !== undefined
    ) {
      return false;
    }
    this.metadata.agents[agentId] = {
      ...meta,
      teamReport: {
        ...report,
        receivedAt: new Date().toISOString(),
      },
    };
    await this.writeMetadata();
    this.emitTeamStatus(agentId);
    return true;
  }

  /**
   * Appends one message to `departmentLeaderAgentId`'s department Chat log.
   * Chat is a sibling-only, never-archived channel, isolated from Discuss —
   * the log lives on the parent's own metadata but the parent is never a
   * participant (see `directMessageRelation`'s `'sibling'` case).
   */
  async postTeamChatMessage(
    departmentLeaderAgentId: string,
    senderAgentId: string,
    senderName: string,
    message: string,
    mentions: readonly string[],
  ): Promise<TeamChatMessageRecord> {
    const meta = this.metadata.agents[departmentLeaderAgentId];
    if (meta === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Department leader "${departmentLeaderAgentId}" was not found.`);
    }
    const chat = meta.chat ?? {};
    const messageId = chat.nextMessageId ?? 1;
    const record: TeamChatMessageRecord = {
      messageId,
      agentId: senderAgentId,
      name: senderName,
      message,
      mentions,
      sentAt: new Date().toISOString(),
    };
    this.metadata.agents[departmentLeaderAgentId] = {
      ...meta,
      chat: {
        nextMessageId: messageId + 1,
        messages: [...(chat.messages ?? []), record],
      },
    };
    await this.writeMetadata();
    // One notice per posted message: `team.chat.updated` is session-wide state,
    // so the gateway delivers it to every subscriber of the session regardless
    // of the per-agent subscription filter. Emitting once (stamped with the
    // sender) reaches members that have no live agent yet, which the old
    // per-ready-member fan-out silently skipped.
    void this.rpc.emitEvent({
      type: 'team.chat.updated',
      agentId: senderAgentId,
      departmentLeaderAgentId,
      senderAgentId,
    });
    return record;
  }

  async notifyMissingTeamReport(agentId: string, assignmentId: string): Promise<boolean> {
    const meta = this.metadata.agents[agentId];
    const report = meta?.teamReport;
    if (
      meta?.kind !== 'team'
      || meta.teamLeaderAgentId === undefined
      || report === undefined
      || report.assignmentId !== assignmentId
      || report.status !== 'unreported'
      || report.missingReminderAt !== undefined
    ) {
      return false;
    }
    const missingReminderAt = new Date().toISOString();
    this.metadata.agents[agentId] = {
      ...meta,
      teamReport: { ...report, missingReminderAt },
    };
    await this.writeMetadata();
    const member = await this.ensureAgentResumed(agentId);
    const leader = await this.ensureAgentResumed(meta.teamLeaderAgentId);
    member.context.appendSystemReminder(
      `Your assigned task "${report.task}" finished its turn without a TeamDM report. Send TeamDM to your parent with report_status set to completed, blocked, or needs_decision and a concrete summary.`,
      { kind: 'injection', variant: `team_report_required:${assignmentId}` },
    );
    leader.context.appendSystemReminder(
      `Team member "${meta.name ?? agentId}" finished "${report.task}" without a TeamDM report. Wait for the report; do not take over or repeat the work.`,
      { kind: 'injection', variant: `team_report_pending:${agentId}:${assignmentId}` },
    );
    this.emitTeamStatus(agentId);
    return true;
  }

  notifyRunningTeamMember(agentId: string, assignmentId: string): void {
    const meta = this.metadata.agents[agentId];
    if (
      meta?.kind !== 'team'
      || meta.teamLeaderAgentId === undefined
      || meta.assignedAt !== assignmentId
      || meta.assignedTask === undefined
    ) {
      return;
    }
    const leader = this.getReadyAgent(meta.teamLeaderAgentId);
    if (leader === undefined || leader.context.history.some((message) =>
      message.origin?.kind === 'injection'
      && message.origin.variant === `team_member_running:${agentId}:${assignmentId}`
    )) {
      return;
    }
    leader.context.appendSystemReminder(
      `Team member "${meta.name ?? agentId}" is still working on "${meta.assignedTask}". Do not take over or repeat the work; query TeamStatus or wait for a TeamDM report.`,
      { kind: 'injection', variant: `team_member_running:${agentId}:${assignmentId}` },
    );
    this.emitTeamStatus(agentId);
  }

  private emitTeamStatus(agentId: string): void {
    const meta = this.metadata.agents[agentId];
    if (meta?.kind !== 'team') return;
    const report = meta.teamReport;
    const status = this.getReadyAgent(agentId)?.turn.hasActiveTurn === true ? 'running' : 'idle';
    const team = {
      assignedTask: meta.assignedTask ?? null,
      status,
      reportStatus: report?.status ?? 'unreported',
      reportSummary: report?.summary ?? null,
      reportReceived: report?.receivedAt !== undefined,
    } as const;
    this.getReadyAgent(agentId)?.emitEvent({ type: 'agent.status.updated', team });
    this.getReadyAgent(meta.teamLeaderAgentId ?? 'main')?.emitEvent({
      type: 'agent.status.updated',
      team,
    });
  }

  /** Notify clients that the durable Team-agent tree changed. */
  private emitTeamAgentsUpdated(): void {
    void this.rpc.emitEvent({
      type: 'session.meta.updated',
      agentId: 'main',
      patch: { agents: { ...this.metadata.agents } },
    });
  }

  /** Revoke every TeamAssign write lease. Used when re-entering Discuss or archiving. */
  async lockTeamAssignments(leaderAgentId: string): Promise<void> {
    this.assertTeamManager(leaderAgentId);
    const members = this.teamMemberMetadata(leaderAgentId);
    let changed = false;
    for (const [agentId, current] of members) {
      const next = current.assignedTask === undefined && current.assignedAt === undefined
        ? current
        : {
            ...current,
            assignedTask: undefined,
            assignedAt: undefined,
          };
      if (next !== current) {
        this.metadata.agents[agentId] = next;
        changed = true;
      }
      const agent = this.getReadyAgent(agentId);
      if (agent !== undefined) this.configureTeamAgentRuntime(agent, next);
    }
    if (changed) await this.writeMetadata();
  }

  async assertTeamDiscussionMode(agentId: string): Promise<void> {
    this.assertTeamManager(agentId);
    const leader = await this.ensureAgentResumed(agentId);
    if (!leader.discussMode.isActive) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'Discuss mode is required for this team discussion operation.',
      );
    }
  }

  /**
   * TeamDecide owns the Discuss lifecycle. Re-enter the mode when a persisted
   * active discussion is resumed from a non-Discuss UI state, and synchronize
   * member permissions with the resulting mode.
   */
  async ensureTeamDiscussionMode(agentId: string): Promise<void> {
    this.assertTeamManager(agentId);
    const leader = await this.ensureAgentResumed(agentId);
    if (!leader.discussMode.isActive) {
      await leader.discussMode.enter();
    }
    await this.lockTeamAssignments(agentId);
  }

  async createTeamDiscussion(
    leaderAgentId: string,
    topic: string,
    participantAgentIds: readonly string[],
  ): Promise<{ readonly id: string; readonly agent: Agent; readonly discussion: TeamDiscussionMeta }> {
    this.assertTeamManager(leaderAgentId);
    if (topic.trim().length === 0) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A discussion topic is required.');
    }
    if (this.activeTeamDiscussion(leaderAgentId) !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A team discussion is already active.');
    }
    // A node discusses in one department at a time. While it still owes its
    // parent a statement it cannot also chair its own discussion: the same agent
    // would be scheduled for two turns at once, and its own members would block
    // waiting on statements it is not free to write.
    if (activeDiscussionAsParticipant(this.metadata.agents, leaderAgentId) !== undefined) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'You are a participant in your parent department\'s discussion. Finish that discussion before starting one in your own department.',
      );
    }
    const members = new Set(this.teamMemberMetadata(leaderAgentId).map(([id]) => id));
    const participants = [...new Set(participantAgentIds)];
    if (participants.length === 0 || participants.length !== participantAgentIds.length) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A discussion needs distinct team participants.');
    }
    if (participants.some((id) => !members.has(id))) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'Discussion participants must belong to the team.');
    }
    const leader = await this.ensureAgentResumed(leaderAgentId);
    const enteredDiscuss = !leader.discussMode.isActive;
    if (enteredDiscuss) await leader.discussMode.enter();
    try {
      await this.lockTeamAssignments(leaderAgentId);
      const now = new Date().toISOString();
      const discussion: TeamDiscussionMeta = {
        participantAgentIds: participants,
        status: 'active',
        topic: topic.trim(),
        startedAt: now,
        updatedAt: now,
        nextStatementId: 0,
        round: 0,
        readCursors: Object.fromEntries(participants.map((agentId) => [agentId, 0])),
        statements: [],
      };
      const result = await this.createAgent(
        { type: 'sub', generate: leader.rawGenerate },
        {
          kind: 'sub',
          parentAgentId: leaderAgentId,
          teamLeaderAgentId: leaderAgentId,
          name: 'Discussion',
          profile: discussionProfile(defaultTeamProfile(), discussion),
          discussion,
        },
      );
      return { ...result, discussion };
    } catch (error) {
      if (enteredDiscuss) {
        leader.discussMode.exit();
        this.configureTeamMembers(leaderAgentId);
      }
      throw error;
    }
  }

  activeTeamDiscussion(leaderAgentId: string): readonly [string, AgentMeta] | undefined {
    return Object.entries(this.metadata.agents).find(([, meta]) =>
      meta.teamLeaderAgentId === leaderAgentId && meta.discussion?.status === 'active',
    );
  }

  async updateTeamDiscussion(
    discussionAgentId: string,
    update: Pick<TeamDiscussionMeta, 'participantAgentIds' | 'status' | 'topic'> & Pick<Partial<TeamDiscussionMeta>, 'round'>,
  ): Promise<TeamDiscussionMeta> {
    const meta = this.metadata.agents[discussionAgentId];
    if (meta?.discussion === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Discussion "${discussionAgentId}" was not found.`);
    }
    const participantAgentIds = [...update.participantAgentIds];
    const activeTurnAgentId = this.activeTeamDiscussionTurns.get(discussionAgentId);
    const currentTurnAgentId = meta.discussion.currentTurnAgentId;
    const turnStillValid =
      update.status === 'active'
      && (activeTurnAgentId === undefined || participantAgentIds.includes(activeTurnAgentId))
      && (currentTurnAgentId === undefined || participantAgentIds.includes(currentTurnAgentId));
    if (!turnStillValid) {
      this.activeTeamDiscussionTurns.delete(discussionAgentId);
      this.teamDiscussionSpeaks.delete(discussionAgentId);
    }
    const discussion: TeamDiscussionMeta = {
      ...meta.discussion,
      ...update,
      participantAgentIds,
      currentTurnAgentId: turnStillValid ? currentTurnAgentId : undefined,
      readCursors: {
        ...meta.discussion.readCursors,
        ...Object.fromEntries(
          participantAgentIds
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
      if (leader.discussMode.isActive) {
        leader.discussMode.exit();
        this.configureTeamMembers(meta.teamLeaderAgentId);
      }
    }
    return discussion;
  }

  async publishLeadDiscussionStatement(
    leaderAgentId: string,
    message: string,
  ): Promise<{ readonly discussionAgentId: string; readonly entryId: number }> {
    this.assertTeamManager(leaderAgentId);
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
    transcript.emitEvent({
      type: 'discussion.updated',
      discussionAgentId,
      kind: 'message',
    });
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
    transcript.emitEvent({
      type: 'discussion.updated',
      discussionAgentId,
      kind: 'message',
    });
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
    const meta = this.metadata.agents[discussionAgentId];
    if (meta?.discussion === undefined || !meta.discussion.participantAgentIds.includes(agentId)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'Only active discussion participants can take a discussion turn.',
      );
    }
    const active = this.activeTeamDiscussionTurns.get(discussionAgentId);
    if (active !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'A discussion participant is already speaking.');
    }
    this.teamDiscussionSpeaks.get(discussionAgentId)?.delete(agentId);
    this.activeTeamDiscussionTurns.set(discussionAgentId, agentId);
    if (meta?.discussion !== undefined) {
      this.metadata.agents[discussionAgentId] = {
        ...meta,
        discussion: {
          ...meta.discussion,
          currentTurnAgentId: agentId,
          updatedAt: new Date().toISOString(),
        },
      };
      void this.writeMetadata();
      this.getReadyAgent(discussionAgentId)?.emitEvent({
        type: 'discussion.updated',
        discussionAgentId,
        kind: 'lifecycle',
        currentTurnAgentId: agentId,
      });
    }
  }

  endTeamDiscussionTurn(discussionAgentId: string, agentId: string): void {
    if (this.activeTeamDiscussionTurns.get(discussionAgentId) === agentId) {
      this.activeTeamDiscussionTurns.delete(discussionAgentId);
    }
    const meta = this.metadata.agents[discussionAgentId];
    if (meta?.discussion?.currentTurnAgentId === agentId) {
      this.metadata.agents[discussionAgentId] = {
        ...meta,
        discussion: {
          ...meta.discussion,
          currentTurnAgentId: undefined,
          updatedAt: new Date().toISOString(),
        },
      };
      void this.writeMetadata();
      this.getReadyAgent(discussionAgentId)?.emitEvent({
        type: 'discussion.updated',
        discussionAgentId,
        kind: 'lifecycle',
        currentTurnAgentId: null,
      });
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
      { additionalDirs: this.additionalDirs, customAgents: this.runtimeConfig?.customAgents },
    );
    agent.useProfile(this.withSessionSelf(profile), context, this.options.kimiHomeDir);
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

  /** Append latest `<session_self>` from mount metadata on every prompt render. */
  private withSessionSelf(profile: ResolvedAgentProfile): ResolvedAgentProfile {
    return {
      ...profile,
      systemPrompt: (context) => {
        const base = profile.systemPrompt(context);
        const block = this.readSessionSelfBlock();
        return block === undefined ? base : `${base}\n\n${block}`;
      },
    };
  }

  private invalidateSessionSelfBlock(): void {
    delete this.metadata.custom['session_self'];
  }

  private readSessionSelfBlock(): string | undefined {
    const cached = this.metadata.custom['session_self'];
    if (typeof cached === 'string' && cached.includes('<session_self>')) return cached;
    const sessionId = this.options.id;
    if (sessionId === undefined) return undefined;
    const parentSessionId = typeof this.metadata.custom['parent_session_id'] === 'string'
      ? this.metadata.custom['parent_session_id'] as string
      : undefined;
    const role = typeof this.metadata.custom['mount_role'] === 'string'
      ? this.metadata.custom['mount_role'] as string
      : undefined;
    const mandate = typeof this.metadata.custom['mount_mandate'] === 'string'
      ? this.metadata.custom['mount_mandate'] as string
      : undefined;
    const directChildren = Object.entries(this.metadata.agents)
      .filter(([, meta]) => meta.kind === 'team' && meta.teamLeaderAgentId === 'main')
      .map(([agentId, meta]) => ({
        sessionId: meta.mountedSessionId ?? agentId,
        title: meta.name ?? agentId,
        role: meta.role,
        mandate: meta.mandate,
      }));
    // Keep ordinary top-level / BTW prompts clean. Identity belongs on mounted
    // members and on hosts that already hired a department.
    if (
      parentSessionId === undefined
      && role === undefined
      && mandate === undefined
      && directChildren.length === 0
    ) {
      return undefined;
    }
    const info: SessionSelfInfo = {
      sessionId,
      title: this.metadata.title || sessionId,
      parentSessionId,
      role,
      mandate,
      depth: parentSessionId === undefined ? 0 : 1,
      position: parentSessionId === undefined ? 'top-level' : 'member',
      directChildren,
    };
    return formatSessionSelf(info);
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
        { additionalDirs: this.additionalDirs, customAgents: this.runtimeConfig?.customAgents },
      );
      this.agentsMdWarning = context.agentsMdWarning;
    } catch (error) {
      log.warn('failed to compute AGENTS.md warning', { error });
    }
    return this.agentsMdWarning;
  }

  /**
   * Run `/init` as one system-trigger turn on the main agent.
   *
   * The exploration stays in the main transcript so the user can watch it,
   * and the resulting AGENTS.md is injected afterwards so later turns read the
   * file the run just wrote.
   */
  async generateAgentsMd(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();

    try {
      const turnId = mainAgent.turn.prompt(
        [{ type: 'text', text: DEFAULT_INIT_PROMPT }],
        { kind: 'system_trigger', name: 'init' },
      );
      if (turnId === null) {
        throw new Error('The main agent is busy; retry `/init` once the current turn finishes.');
      }
      const completion = await mainAgent.turn.waitForCurrentTurn();
      if (completion.event.reason !== 'completed') {
        throw new Error(
          completion.event.error === undefined
            ? `Init turn ${completion.event.reason}`
            : `[${completion.event.error.code}] ${completion.event.error.message}`,
        );
      }

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

  /**
   * Shared guard for every team-management operation. Every node in the
   * department tree manages its own department: `main` plus every durable Team
   * Agent. A discussion transcript is a record of a department's discussion, not
   * a node in the tree, so it manages nothing.
   */
  assertTeamManager(agentId: string): void {
    const meta = this.metadata.agents[agentId];
    if (meta === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" was not found.`);
    }
    if (agentId !== 'main' && meta.kind !== 'team') {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        'Only the main agent and Team Agents manage a department.',
      );
    }
  }

  /** Team levels allowed below `main`, from `team.maxDepth` in config. */
  teamMaxDepth(): number {
    return this.runtimeConfig?.team?.maxDepth ?? DEFAULT_TEAM_MAX_DEPTH;
  }

  /**
   * Guard for hiring specifically. The depth limit is checked when a member is
   * created rather than by withholding `TeamCreate`, because the limit is a
   * setting the user can change while agents are already running — a tool set
   * frozen at creation time would go stale, while this message is always true.
   *
   * When a leader has a mounted session, that session's mount depth is the
   * authoritative department depth; otherwise use the in-session agent tree.
   */
  private async assertCanCreateDepartment(leaderAgentId: string): Promise<void> {
    const maxDepth = this.teamMaxDepth();
    const parentById = await this.options.listMountParentById?.();
    const scope = {
      agents: this.metadata.agents,
      agentId: leaderAgentId,
      parentById,
      sessionIdForAgent: this.metadata.agents[leaderAgentId]?.mountedSessionId ?? this.options.id,
    };
    if (canCreateDepartmentInTree({ ...scope, maxDepth })) return;
    throw new KimiError(
      ErrorCodes.SESSION_STATE_INVALID,
      `Team depth limit reached: this agent is at depth ${String(departmentDepth(scope))} of ${String(maxDepth)} and cannot hire its own members. Do the work in this department, or ask your parent to raise team.maxDepth.`,
    );
  }

  private configureTeamAgentRuntime(agent: Agent, meta: AgentMeta): void {
    // Assignment is scheduling metadata, not a capability boundary.
    agent.teamWriteEnabled = true;
    const leader = meta.teamLeaderAgentId === undefined
      ? undefined
      : this.getReadyAgent(meta.teamLeaderAgentId);
    const inheritedTools = [
      ...(leader?.tools.activeToolNames() ?? agent.tools.activeToolNames()),
      ...TEAM_MEMBER_TOOLS,
    ];
    agent.tools.setActiveTools(inheritedTools);
    // Discuss is the only team-wide write lock. `/setting readonly` is main-only
    // (see applyNoriRuntimeSettingsToAgent) and must not cascade onto members —
    // otherwise Code-phase TeamAssign work stays blocked while the footer still
    // shows readonly for the lead.
    const discussReadonly = leader?.discussMode.isActive ?? false;
    agent.teamWriteLocked = discussReadonly;
    agent.permission.setToolsReadonly(discussReadonly);
    agent.permission.setMode(
      discussReadonly ? 'manual' : (this.sessionPermissionMode ?? leader?.permission.mode ?? 'manual'),
    );
  }

  /**
   * 权限模式是整个会话共用的一个开关。用户在任何一个智能体的窗口里选了 auto，
   * 主智能体和所有团队成员都跟着变成 auto——而不是只有他当时正在看的那个窗口，
   * 之后新招进来的成员也从这里取初始值。
   *
   * 唯一的例外是 Discuss 期间被强制只读的成员：那是讨论轮次的约束，不是用户的
   * 权限选择，所以 `configureTeamAgentRuntime` 仍然把他们压回 manual。
   * 临时子智能体（`sub`）不在这里改：它们没有自己的模式，本来就顺着父级继承。
   */
  applySessionPermissionMode(mode: PermissionMode): void {
    this.sessionPermissionMode = mode;
    const main = this.getReadyAgent('main');
    if (main !== undefined && main.permission.mode !== mode) main.permission.setMode(mode);
    for (const [agentId, meta] of Object.entries(this.metadata.agents)) {
      if (meta.kind !== 'team') continue;
      const agent = this.getReadyAgent(agentId);
      if (agent !== undefined) this.configureTeamAgentRuntime(agent, meta);
    }
  }

  private configureTeamMembers(leaderAgentId: string): void {
    for (const [agentId, meta] of this.teamMemberMetadata(leaderAgentId)) {
      const agent = this.getReadyAgent(agentId);
      if (agent !== undefined) this.configureTeamAgentRuntime(agent, meta);
    }
  }

  private enableTeamLeadTools(agent: Agent): void {
    agent.tools.setActiveTools([
      // Team controls supplement the lead profile. Replacing the active set
      // would silently remove normal tools and user tools.
      // This must not depend on builtin registration: profiles are selected
      // before a provider can initialize every builtin tool.
      ...agent.tools.activeToolNames(),
      ...TEAM_MANAGEMENT_TOOLS,
    ]);
  }

  private instantiateAgent(
    id: string,
    homedir: string,
    type: AgentType,
    config: Partial<AgentOptions> = {},
    parentAgentId: string | null = null,
    teamMember = false,
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
      teamMember,
      kaos: this.toolKaos.withCwd(cwd),
      toolServices,
      config: this.runtimeConfig,
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
          { additionalDirs: agent.getAdditionalDirs(), customAgents: this.runtimeConfig?.customAgents },
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
        this.runtimeConfig ?? { providers: {} },
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
      const agent = this.instantiateAgent(id, meta.homedir, meta.type, config, parentAgentId, meta.kind === 'team');
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
    agent.setActiveProfile(this.withSessionSelf(profile), this.options.kimiHomeDir);
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
    const profile = DEFAULT_AGENT_PROFILES[profileName];
    if (meta.type === 'sub') {
      if (meta.kind === 'team') return teamProfile(profile ?? defaultTeamProfile(), teamIdentityFromMeta(meta));
      if (meta.discussion !== undefined) return discussionProfile(profile ?? defaultTeamProfile(), meta.discussion);
    }
    return profile;
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

/**
 * Tools that manage a department. Every node in the tree gets them: `main`
 * because it is the root, and every Team Agent because it may run a department
 * of its own. `team.maxDepth` bounds how deep that goes, enforced when a member
 * is created rather than by withholding the tool.
 */
const TEAM_MANAGEMENT_TOOLS = [
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

/**
 * A member additionally speaks in its parent's discussion, chats with its
 * siblings, and can put a blocking question to its parent. `main` has no
 * parent, so it never takes a participant turn and gets none of these.
 */
const TEAM_MEMBER_TOOLS = [...TEAM_MANAGEMENT_TOOLS, 'TeamSpeak', 'TeamChat', 'nori_ask_parent'] as const;


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
    role: meta.role ?? '',
    mandate: meta.mandate ?? '',
  };
}

function defaultTeamProfile(): ResolvedAgentProfile {
  const profile = DEFAULT_AGENT_PROFILES['nori-agent'] ?? DEFAULT_AGENT_PROFILES['agent'];
  if (profile === undefined) {
    throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'The default team agent profile is unavailable.');
  }
  return profile;
}

/**
 * Composes a member's prompt: identity, then the role correction, then the base
 * profile prompt, the shared contract, and the member contract.
 *
 * The base prompt is a main-Agent prompt (every node can lead a department, so
 * they share one profile set), which on its own would tell a member it is "the
 * main Agent", that execution belongs to somebody else, and that it should not
 * reach for Write/Edit/Bash — the opposite of what an assigned member must do.
 * `<team_role>` states the override up front, before that text is read, and
 * `## Team Agent` spells out the duties.
 */
function teamProfile(
  profile: ResolvedAgentProfile,
  identity: TeamIdentity,
): ResolvedAgentProfile {
  return {
    ...profile,
    systemPrompt: (context) => {
      const basePrompt = profile.systemPrompt({ ...context, roleAdditional: '' });
      return [
        '<team_identity>',
        `Name: ${escapeTeamIdentity(identity.name)}`,
        `Role: ${escapeTeamIdentity(identity.role)}`,
        `Mandate: ${escapeTeamIdentity(identity.mandate)}`,
        '</team_identity>',
        TEAM_MEMBER_ROLE_PROMPT.trim(),
        basePrompt,
        basePrompt.includes('## Team Engineering') ? '' : TEAM_ENGINEERING_PROMPT.trim(),
        TEAM_AGENT_PROMPT.trim(),
      ].filter(Boolean).join('\n');
    },
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
