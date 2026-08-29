import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import { PluginManager } from '#/plugin';
import { LocalFetchURLProvider } from '#/tools/providers/local-fetch-url';
import type { PromisableMethods } from '#/utils/types';
import { getCoreVersion } from '#/version';
import { resolveThinkingEffort } from '../agent/config/thinking';
import { Agent } from '../agent';
import {
  ensureKimiHome,
  loadRuntimeConfigSafe,
  mergeConfigPatch,
  readConfigFileForUpdate,
  normalizeAdditionalDirs,
  readWorkspaceAdditionalDirs,
  resolveWorkspaceAdditionalDirs,
  resolveConfigPath,
  resolveKimiHome,
  writeConfigFile,
  type KimiConfig,
  type McpServerConfig,
} from '../config';
import {
  FLAG_DEFINITIONS,
  FlagResolver,
  type ExperimentalFeatureState,
} from '../flags';
import type { Logger } from '../logging/types';
import { resolveSessionMcpConfig, mergeCallerMcpServers, type SessionMcpConfig } from '../mcp';
import { Session, type SessionMeta, type SessionSkillConfig } from '../session';
import { exportSessionDirectory } from '../session/export';
import {
  ProviderManager,
  type OAuthTokenProviderResolver
} from '../session/provider-manager';
import { SessionAPIImpl } from '../session/rpc';
import { normalizeWorkDir, SessionStore } from '../session/store/index';
import {
  noopTelemetryClient,
  withTelemetryContext,
  withTelemetryProperties,
  type TelemetryClient,
  type TelemetryProperties,
} from '../telemetry';
import type { CoreRPCClient } from './client';
import type {
  ActivateSkillPayload,
  ActivatePluginCommandPayload,
  AddAdditionalDirPayload,
  AddAdditionalDirResult,
  ArchiveSessionPayload,
  DeleteSessionPayload,
  BeginCompactionPayload,
  CancelPayload,
  CancelDiscussPayload,
  CancelShellCommandPayload,
  CloseSessionPayload,
  ConfigDiagnostics,
  CoreAPI,
  CoreInfo,
  CreateGoalPayload,
  CronCreateRequest,
  CreateSessionPayload,
  DetachBackgroundPayload,
  ClientTelemetryInfo,
  EmptyPayload,
  GoalSnapshot,
  GoalToolResult,
  ExportSessionPayload,
  ExportSessionResult,
  ForkSessionPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  GetKimiConfigPayload,
  GetPluginInfoPayload,
  InjectSystemReminderPayload,
  AttachMountedTeamMemberPayload,
  AttachMountedTeamMemberResult,
  DetachMountedTeamMemberPayload,
  DetachMountedTeamMemberResult,
  InstallPluginPayload,
  ListSessionsPayload,
  MountSessionPayload,
  McpServerInfo,
  SessionGraphEdgeSummary,
  SessionGraphSummary,
  UnmountSessionPayload,
  McpStartupMetrics,
  ManageBackgroundPayload,
  PluginInfo,
  PluginSummary,
  PromptPayload,
  RunShellCommandPayload,
  ReconnectMcpServerPayload,
  RegisterToolPayload,
  ReloadSessionPayload,
  ReloadPluginsResult,
  RemoveKimiProviderPayload,
  RemovePluginPayload,
  RenameSessionPayload,
  ResumeSessionPayload,
  SessionSummary,
  SetActiveToolsPayload,
  SetKimiConfigPayload,
  SetModelPayload,
  SetModelResult,
  SetNoriRuntimeSettingsPayload,
  SetPermissionPayload,
  SetPluginEnabledPayload,
  SetPluginMcpServerEnabledPayload,
  SetThinkingPayload,
  SkillSummary,
  PluginCommandDef,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
} from './core-api';
import type { ResumedAgentState, ResumeSessionResult } from './resumed';
import type { SDKRPC } from './sdk-api';
import type { SessionWarning } from '@nori-code/protocol';
import { proxyWithExtraPayload } from './types';
import { KaosShellNotFoundError, LocalKaos, type Kaos } from '@nori-code/kaos';
import type { BrowserProvider, ToolServices } from '../tools/support/services';
import { SessionMountCycleError } from '../services/session/session';
import {
  formatMountChangeNotice,
  formatSessionSelf,
  type MountChangeInfo,
  type MountChangeRecipientRole,
} from '../session/session-self';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  DEFAULT_MOUNT_MEMBER_MANDATE,
  DEFAULT_MOUNT_MEMBER_ROLE,
  MOUNT_MANDATE_KEY,
  MOUNT_NAME_KEY,
  MOUNT_ROLE_KEY,
  normalizeOptionalMountString,
  PARENT_SESSION_ID_KEY,
  readMountMandate,
  readMountName,
  readMountRole,
  readParentSessionId,
  wouldCreateMountCycle,
} from '../session/mount-metadata';
import { withMountTreeMutation } from '../session/mount-mutation';

const KIMI_CODE_PROVIDER_NAME = 'managed:nori-code';
const NORI_CODE_BASE_URL_ENV = 'NORI_CODE_BASE_URL';
const NORI_CODE_OAUTH_HOST_ENV = 'NORI_CODE_OAUTH_HOST';
const KIMI_OAUTH_HOST_ENV = 'KIMI_OAUTH_HOST';
type AgentScopedPayload<T> = T & { readonly agentId: string };
type SessionScopedPayload<T> = T & { readonly sessionId: string };
type SessionAgentPayload<T> = SessionScopedPayload<AgentScopedPayload<T>>;
type RenameSessionRequest = SessionScopedPayload<RenameSessionPayload>;
type UpdateSessionMetadataRequest = SessionScopedPayload<UpdateSessionMetadataPayload>;

export interface KimiCoreOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly runtime?: ToolServices | undefined;
  readonly browserProvider?: BrowserProvider | undefined;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
  readonly appVersion?: string;
}

export class KimiCore implements PromisableMethods<CoreAPI> {
  readonly sdk: Promise<SDKRPC>;
  readonly homeDir: string;
  readonly configPath: string;
  readonly sessions = new Map<string, Session>();
  readonly telemetry: TelemetryClient;

  private kaos: Promise<Kaos> | undefined;
  private runtime: ToolServices | undefined;
  private config: KimiConfig;
  private configWarnings: readonly string[] = [];
  private readonly runtimeOverride: ToolServices | undefined;
  private readonly browserProvider: BrowserProvider | undefined;
  private readonly userHomeDir: string;
  private readonly kimiRequestHeaders: Record<string, string> | undefined;
  private readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver | undefined;
  private readonly skillDirs: readonly string[];
  private readonly sessionStore: SessionStore;
  private readonly sessionLifecycleTails = new Map<string, Promise<void>>();
  readonly plugins: PluginManager;
  private pluginsReady: Promise<void>;
  private pluginsLoadError: Error | undefined;
  private readonly appVersion: string | undefined;
  private readonly experimentalFlags: FlagResolver;

  constructor(
    protected readonly rpcClient: CoreRPCClient,
    options: KimiCoreOptions = {},
  ) {
    this.homeDir = resolveKimiHome(options.homeDir);
    this.userHomeDir = homedir();
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.runtimeOverride = options.runtime;
    this.runtime = options.runtime;
    this.browserProvider = options.browserProvider;
    this.kimiRequestHeaders = options.kimiRequestHeaders;
    this.resolveOAuthTokenProvider = options.resolveOAuthTokenProvider;
    this.skillDirs = options.skillDirs ?? [];
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.appVersion = options.appVersion;
    ensureKimiHome(this.homeDir);
    // Schema errors degrade (invalid sections are dropped with warnings) so a
    // typo cannot prevent startup, but a file that cannot be used at all —
    // TOML syntax error, unreadable — fails fast: defaults-only would start
    // the app looking logged out, which is worse than the parse error.
    const loaded = loadRuntimeConfigSafe(this.configPath);
    if (loaded.fileError !== undefined) {
      throw loaded.fileError;
    }
    this.config = loaded.config;
    this.configWarnings = [...loaded.fileWarnings, ...loaded.envWarnings];
    if (this.configWarnings.length > 0) {
      log.warn('config load degraded', { warnings: this.configWarnings });
    }
    this.experimentalFlags = new FlagResolver(
      process.env,
      FLAG_DEFINITIONS,
      this.config.experimental,
    );
    this.sessionStore = new SessionStore(this.homeDir);
    this.plugins = new PluginManager({ kimiHomeDir: this.homeDir });
    // Capture the error rather than swallow it: mutators and explicit /plugins
    // reads rethrow so the user sees what's wrong; createSession/resumeSession
    // degrade silently (no plugin skills, no sessionStart injections) so the harness still
    // starts. Reload clears the error on success.
    this.pluginsReady = this.plugins.load().catch((error: unknown) => {
      this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
    });
    log.info('experimental flags enabled', { flags: this.experimentalFlags.enabledIds() });

    this.sdk = rpcClient(this);
  }

  async createSession(input: CreateSessionPayload): Promise<SessionSummary> {
    return this.createSessionWithOverrides(input, {});
  }

  async createSessionWithOverrides(
    input: CreateSessionPayload,
    overrides: { kaos?: Kaos; persistenceKaos?: Kaos },
  ): Promise<SessionSummary> {
    const options = input;
    const workDir = requiredWorkDir('createSession', options.workDir);
    const config = this.reloadProviderManager();
    const id = options.id ?? createSessionId();
    const modelAlias = options.model ?? config.defaultModel;
    const model = modelAlias !== undefined ? config.models?.[modelAlias] : undefined;
    const thinkingEffort = resolveThinkingEffort(options.thinking, config.thinking, model);
    const permissionMode = options.permission ?? config.defaultPermissionMode;
    const baseMcpConfig = await resolveSessionMcpConfig({
      cwd: workDir,
      homeDir: this.homeDir,
    });
    const withCallerMcp = mergeCallerMcpServers(baseMcpConfig, options.mcpServers);
    const parentKaos = overrides.kaos ?? (await this.getKaos());
    const persistenceKaos = overrides.persistenceKaos ?? parentKaos;
    // Read the workspace local config (`.nori-code/local.toml`) through the
    // persistence (local) kaos, not the tool kaos. In ACP mode the tool kaos is
    // the reverse-RPC bridge and the client does not know the session yet during
    // `session/new`, so reading through it fails with "unknown session"
    // (https://github.com/MoonshotAI/kimi-code/issues/988). The local config is
    // a system file and must not depend on the tool bridge — same reason
    // `Session.systemContextKaos` is backed by the persistence sink.
    const localWorkspaceDirs = await readWorkspaceAdditionalDirs(persistenceKaos, workDir);
    const callerAdditionalDirs = await resolveWorkspaceAdditionalDirs(
      parentKaos,
      workDir,
      options.additionalDirs ?? [],
    );
    const additionalDirs = normalizeAdditionalDirs([
      ...localWorkspaceDirs.additionalDirs,
      ...callerAdditionalDirs,
    ]);
    const summary = await this.sessionStore.create({
      id,
      workDir,
    });
    const result: SessionSummary = {
      ...summary,
      metadata: options.metadata,
    };
    const clientTelemetry = clientTelemetryProperties(options.client);
    const sessionTelemetryBase = withTelemetryContext(this.telemetry, { sessionId: summary.id });
    const sessionTelemetry =
      Object.keys(clientTelemetry).length === 0
        ? sessionTelemetryBase
        : withTelemetryProperties(sessionTelemetryBase, clientTelemetry);

    await this.pluginsReady;
    const pluginSessionStarts = this.plugins.enabledSessionStarts();
    const pluginCommands = await this.plugins.enabledCommands();
    const mcpConfig = this.mergePluginMcpConfig(withCallerMcp);

    // Session ctor attaches its own log sink. If anything in the setup-after-
    // ctor block throws, `session.close()` releases the sink (and mcp).
    const runtime = await this.resolveRuntime(config);
    const session = new Session({
      kaos: parentKaos.withCwd(workDir),
      persistenceKaos,
      toolServices: runtime,
      browserProvider: this.browserProvider,
      // Read live, not captured: `setKimiConfig` rewrites config.toml and
      // reloads while this session runs, and settings the user edits there
      // (team.maxDepth, customAgents) must reach an already-running session.
      config: () => this.config,
      id,
      homedir: summary.sessionDir,
      kimiHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      providerManager: this.resolveProviderManager(summary.id),
      background: config.background,
      hooks: [...(config.hooks ?? []), ...this.plugins.enabledHooks()],
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      mcpConfig,
      experimentalFlags: this.experimentalFlags,
      telemetry: sessionTelemetry,
      pluginSessionStarts,
      pluginCommands,
      appVersion: this.appVersion,
      additionalDirs,
      listMountParentById: () => this.listMountParentById(),
      createMountedMember: ({ identity, parentSessionId }) =>
        this.createMountedMemberSession({
          parentSessionId: parentSessionId ?? id,
          identity,
        }),
      deleteMountedMember: (mountedSessionId) => this.deleteMountedMemberSession(mountedSessionId),
      refreshSessionSelf: () => this.refreshCoreSessionSelf(id),
    });
    try {
      session.metadata = {
        ...session.metadata,
        createdAt: new Date(summary.createdAt).toISOString(),
        updatedAt: new Date(summary.updatedAt).toISOString(),
        ...(summary.title !== undefined
          ? {
              title: summary.title,
              isCustomTitle: true,
            }
          : {}),
        custom: options.metadata === undefined ? {} : { ...options.metadata },
      };
      const mainAgent = await session.createMain();
      mainAgent.config.update({
        modelAlias: options.model ?? config.defaultModel,
        thinkingEffort,
      });
      if (permissionMode !== undefined) {
        // 记成会话级模式，这样之后招进来的成员默认也是这个模式。
        session.applySessionPermissionMode(permissionMode);
      }
      // A new session has no department yet, so Discuss cannot start here: it
      // would deny Write/Edit/Bash while TeamAssign — the only exit — has nobody
      // to assign to. The preference still matters; the lead enters Discuss
      // through TeamDecide once TeamCreate has hired someone. `canEnter()` is
      // false for every fresh main agent, so this is a no-op in practice and a
      // guard if session creation ever restores a team.
      if ((options.discussMode ?? config.defaultDiscussMode ?? true) && mainAgent.discussMode.canEnter()) {
        await mainAgent.discussMode.enter();
      }
      await session.writeMetadata();
      await session.flushMetadata();
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
    this.sessions.set(id, session);
    if (Object.keys(clientTelemetry).length > 0) {
      sessionTelemetry.track('session_started', { resumed: false });
    }
    return withAdditionalDirs(result, session);
  }

  getCoreInfo(): CoreInfo {
    return { version: getCoreVersion() };
  }

  getExperimentalFeatures(): readonly ExperimentalFeatureState[] {
    return this.experimentalFlags.explainAll();
  }

  async closeSession({ sessionId }: CloseSessionPayload): Promise<void> {
    return this.withSessionLifecycle(sessionId, () => this.closeSessionUnlocked(sessionId));
  }

  private async closeSessionUnlocked(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      await session.close();
    }
  }

  async archiveSession({ sessionId }: ArchiveSessionPayload): Promise<void> {
    await this.withSessionLifecycle(sessionId, async () => {
      await this.closeSessionUnlocked(sessionId);
      await this.sessionStore.archive(sessionId);
    });
  }

  async deleteSession({ sessionId }: DeleteSessionPayload): Promise<void> {
    return withMountTreeMutation(async () => {
      await this.withSessionLifecycle(sessionId, async () => {
        const summary = await this.sessionStore.get(sessionId);
        const oldParentSessionId =
          readParentSessionId(summary.metadata as Record<string, unknown> | undefined) ?? null;
        await this.detachMountedTeamAgentsEverywhere(sessionId);
        await this.closeSessionUnlocked(sessionId);
        await this.sessionStore.delete(sessionId);
        if (oldParentSessionId !== null) {
          try {
            await this.emitCoreMountChanged({
              sessionId,
              oldParentSessionId,
              newParentSessionId: null,
              reason: 'unmount',
            });
          } catch {
            // Deletion is already durable; the structural notification is best effort.
          }
        }
      });
    });
  }

  async resumeSession(input: ResumeSessionPayload): Promise<ResumeSessionResult> {
    return this.resumeSessionWithOverrides(input, {});
  }

  async resumeSessionWithOverrides(
    input: ResumeSessionPayload,
    overrides: {
      kaos?: Kaos;
      persistenceKaos?: Kaos;
      forcePluginSessionStartReminder?: boolean;
    },
  ): Promise<ResumeSessionResult> {
    return this.withSessionLifecycle(input.sessionId, () =>
      this.resumeSessionWithOverridesUnlocked(input, overrides),
    );
  }

  private async resumeSessionWithOverridesUnlocked(
    input: ResumeSessionPayload,
    overrides: {
      kaos?: Kaos;
      persistenceKaos?: Kaos;
      forcePluginSessionStartReminder?: boolean;
    },
  ): Promise<ResumeSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const parentKaosForRead = overrides.kaos ?? (await this.getKaos());
    // Read `.nori-code/local.toml` through the persistence (local) kaos, not the
    // tool kaos — see createSessionWithOverrides and issue #988.
    const localWorkspaceDirs = await readWorkspaceAdditionalDirs(
      overrides.persistenceKaos ?? parentKaosForRead,
      summary.workDir,
    );
    const callerAdditionalDirs = await resolveWorkspaceAdditionalDirs(
      parentKaosForRead,
      summary.workDir,
      input.additionalDirs ?? [],
    );
    const additionalDirs = normalizeAdditionalDirs([
      ...localWorkspaceDirs.additionalDirs,
      ...callerAdditionalDirs,
    ]);
    const active = this.sessions.get(summary.id);
    if (active !== undefined) {
      if (overrides.kaos !== undefined) {
        active.setToolKaos(overrides.kaos.withCwd(summary.workDir));
      }
      await active.setAdditionalDirs(additionalDirs);
      return withAdditionalDirs(await resumeSessionResult(summary, active), active);
    }

    const config = this.reloadProviderManager();
    const baseMcpConfig = await resolveSessionMcpConfig({
      cwd: summary.workDir,
      homeDir: this.homeDir,
    });
    const withCallerMcp = mergeCallerMcpServers(baseMcpConfig, input.mcpServers);
    await this.pluginsReady;
    const pluginSessionStarts = this.plugins.enabledSessionStarts();
    const pluginCommands = await this.plugins.enabledCommands();
    const mcpConfig = this.mergePluginMcpConfig(withCallerMcp);
    const runtime = await this.resolveRuntime(config);
    const parentKaos = parentKaosForRead;
    const persistenceKaos = overrides.persistenceKaos ?? parentKaos;
    const session = new Session({
      kaos: parentKaos.withCwd(summary.workDir),
      persistenceKaos,
      toolServices: runtime,
      browserProvider: this.browserProvider,
      // Live, for the same reason as in `createSession` above.
      config: () => this.config,
      id: summary.id,
      homedir: summary.sessionDir,
      kimiHomeDir: this.homeDir,
      rpc: proxyWithExtraPayload(await this.sdk, { sessionId: summary.id }),
      providerManager: this.resolveProviderManager(summary.id),
      background: config.background,
      hooks: [...(config.hooks ?? []), ...this.plugins.enabledHooks()],
      permissionRules: config.permission?.rules,
      skills: this.resolveSessionSkillConfig(config),
      mcpConfig,
      experimentalFlags: this.experimentalFlags,
      telemetry: withTelemetryContext(this.telemetry, { sessionId: summary.id }),
      initializeMainAgent: false,
      pluginSessionStarts,
      pluginCommands,
      appVersion: this.appVersion,
      additionalDirs,
      listMountParentById: () => this.listMountParentById(),
      createMountedMember: ({ identity, parentSessionId }) =>
        this.createMountedMemberSession({
          parentSessionId: parentSessionId ?? summary.id,
          identity,
        }),
      deleteMountedMember: (mountedSessionId) => this.deleteMountedMemberSession(mountedSessionId),
      refreshSessionSelf: () => this.refreshCoreSessionSelf(summary.id),
    });
    let warning: string | undefined;
    try {
      const resumeResult = await session.resume();
      warning = resumeResult.warning;
      await this.refreshSessionRuntimeConfig(session, config);
    } catch (error) {
      await session.close().catch(() => {});
      withTelemetryContext(this.telemetry, { sessionId: summary.id }).track('session_load_failed', {
        reason: telemetryErrorReason(error),
      });
      throw error;
    }
    this.sessions.set(summary.id, session);
    if (overrides.forcePluginSessionStartReminder === true) {
      // Append before constructing the result so the returned ResumeSessionResult
      // (and any SDK caller's resumeState) reflects the refreshed plugin context.
      await session.appendPluginSessionStartReminder();
    }
    return resumeSessionResult(summary, session, warning);
  }

  async reloadSession(input: ReloadSessionPayload): Promise<ResumeSessionResult> {
    return this.withSessionLifecycle(input.sessionId, async () => {
      const summary = await this.sessionStore.get(input.sessionId);
      const active = this.sessions.get(summary.id);
      if (active?.hasActiveTurn === true) {
        throw new KimiError(
          ErrorCodes.TURN_AGENT_BUSY,
          `Session "${summary.id}" cannot be reloaded while a turn is running`,
          { details: { sessionId: summary.id } },
        );
      }

      this.reloadProviderManager();
      this.clearRuntimeCache();
      await this.reloadPlugins({});

      if (active !== undefined) {
        this.sessions.delete(summary.id);
        await active.closeForReload();
      }
      return this.resumeSessionWithOverridesUnlocked(
        { sessionId: summary.id },
        { forcePluginSessionStartReminder: input.forcePluginSessionStartReminder },
      );
    });
  }

  async forkSession(input: ForkSessionPayload): Promise<ResumeSessionResult> {
    const source = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(source.id);
    if (active?.hasActiveTurn === true) {
      throw new KimiError(
        ErrorCodes.SESSION_FORK_ACTIVE_TURN,
        `Session "${source.id}" cannot be forked while a turn is running`,
        { details: { sessionId: source.id } },
      );
    }

    if (active !== undefined) {
      await active.flushMetadata();
    }

    const id = input.id ?? createSessionId();
    await this.sessionStore.fork({
      sourceId: source.id,
      targetId: id,
      title: input.title,
      metadata: input.metadata,
    });
    return this.resumeSession({ sessionId: id });
  }

  async listSessions(input: ListSessionsPayload = {}): Promise<readonly SessionSummary[]> {
    return this.sessionStore.list(input);
  }

  async getSessionGraph(input: ListSessionsPayload = {}): Promise<SessionGraphSummary> {
    const nodes = await this.sessionStore.list(input);
    const idSet = new Set(nodes.map((node) => node.id));
    const edges: SessionGraphEdgeSummary[] = [];
    for (const node of nodes) {
      const parentId = readParentSessionId(node.metadata as Record<string, unknown> | undefined);
      if (parentId !== undefined && idSet.has(parentId)) {
        edges.push({ childSessionId: node.id, parentSessionId: parentId });
      }
    }
    return { nodes, edges };
  }

  async mountSession(input: MountSessionPayload): Promise<SessionSummary> {
    return withMountTreeMutation(() =>
      this.withSessionLifecycle(input.sessionId, () => this.applySessionMount(input, 'mount')),
    );
  }

  async remountSession(input: MountSessionPayload): Promise<SessionSummary> {
    return withMountTreeMutation(() =>
      this.withSessionLifecycle(input.sessionId, () => this.applySessionMount(input, 'remount')),
    );
  }

  async unmountSession(input: UnmountSessionPayload): Promise<SessionSummary> {
    return withMountTreeMutation(() => this.withSessionLifecycle(input.sessionId, async () => {
      const summary = await this.sessionStore.get(input.sessionId);
      const oldParentId =
        readParentSessionId(summary.metadata as Record<string, unknown> | undefined) ?? null;
      if (oldParentId === null) {
        return summary;
      }
      const previousRole = readMountRole(summary.metadata as Record<string, unknown> | undefined);
      const previousMandate = readMountMandate(summary.metadata as Record<string, unknown> | undefined);
      await this.writeSessionMountMetadata(input.sessionId, {
        parentSessionId: null,
        role: undefined,
        mandate: undefined,
        clearIdentity: true,
      });
      await this.syncCoreMountWithRollback({
        childSessionId: input.sessionId,
        oldParentSessionId: oldParentId,
        newParentSessionId: null,
        role: undefined,
        mandate: undefined,
        previousRole,
        previousMandate,
        afterSync: () => this.emitCoreMountChanged({
          sessionId: input.sessionId,
          oldParentSessionId: oldParentId,
          newParentSessionId: null,
          reason: 'unmount',
        }),
      });
      return this.sessionStore.get(input.sessionId);
    }));
  }

  async renameSession({ sessionId, ...payload }: RenameSessionRequest): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      await new SessionAPIImpl(session).renameSession(payload);
      return;
    }
    await this.sessionStore.rename(sessionId, payload.title);
  }

  async exportSession(input: ExportSessionPayload): Promise<ExportSessionResult> {
    const summary = await this.sessionStore.get(input.sessionId);
    const active = this.sessions.get(input.sessionId);
    // Closed sessions have no `Session.log`; create an ad-hoc child bound to
    // their id so the entries still route to the session log file.
    const exportLog =
      active?.log ?? log.createChild({ sessionId: input.sessionId });
    if (active !== undefined) {
      try {
        await active.flushMetadata();
      } catch (error) {
        exportLog.warn('flushMetadata failed before export', { error });
      }
    }
    await warnIfLogFlushFails(exportLog, 'export session log flush failed', () =>
      getRootLogger().flushSession(input.sessionId),
    );
    if (input.includeGlobalLog === true) {
      await warnIfLogFlushFails(exportLog, 'export global log flush failed', () =>
        getRootLogger().flushGlobal(),
      );
    }
    const result = await exportSessionDirectory({
      request: input,
      summary,
      homeDir: this.homeDir,
      globalLogPath: getRootLogger().getConfig()?.globalLogPath,
    });
    return result;
  }

  async getKimiConfig(input?: GetKimiConfigPayload): Promise<KimiConfig> {
    if (input?.reload) {
      this.reloadRuntimeConfig();
    }
    return this.config;
  }

  async getConfigDiagnostics(_input?: EmptyPayload): Promise<ConfigDiagnostics> {
    return { warnings: this.configWarnings };
  }

  async setKimiConfig(input: SetKimiConfigPayload): Promise<KimiConfig> {
    const config = mergeConfigPatch(this.readConfigForWrite(), input);
    await writeConfigFile(this.configPath, config);
    const updated = this.reloadRuntimeConfig();
    if ('customAgents' in input) {
      await Promise.all(
        Array.from(this.sessions.values(), (session) =>
          session.updateCustomAgents(updated.customAgents),
        ),
      );
    }
    return updated;
  }

  async removeKimiProvider(input: RemoveKimiProviderPayload): Promise<KimiConfig> {
    const config = this.readConfigForWrite();
    delete config.providers[input.providerId];

    let removedDefault = false;
    const existingModels = config.models ?? {};
    for (const [key, model] of Object.entries(existingModels)) {
      if (
        typeof model === 'object' &&
        model !== null &&
        !Array.isArray(model) &&
        model['provider'] === input.providerId
      ) {
        delete existingModels[key];
        if (config.defaultModel === key) removedDefault = true;
      }
    }
    config.models = existingModels;

    if (removedDefault) {
      config.defaultModel = undefined;
    }

    if (config.defaultProvider === input.providerId) {
      config.defaultProvider = undefined;
    }

    await writeConfigFile(this.configPath, config);
    return this.reloadRuntimeConfig();
  }

  prompt({ sessionId, ...payload }: SessionAgentPayload<PromptPayload>) {
    return this.sessionApi(sessionId).prompt(payload);
  }

  getRuntimeState({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getRuntimeState(payload);
  }

  runShellCommand({ sessionId, ...payload }: SessionAgentPayload<RunShellCommandPayload>) {
    return this.sessionApi(sessionId).runShellCommand(payload);
  }

  cancelShellCommand({ sessionId, ...payload }: SessionAgentPayload<CancelShellCommandPayload>) {
    return this.sessionApi(sessionId).cancelShellCommand(payload);
  }

  steer({ sessionId, ...payload }: SessionAgentPayload<SteerPayload>) {
    return this.sessionApi(sessionId).steer(payload);
  }

  injectSystemReminder({
    sessionId,
    ...payload
  }: SessionAgentPayload<InjectSystemReminderPayload>) {
    return this.sessionApi(sessionId).injectSystemReminder(payload);
  }

  cancel({ sessionId, ...payload }: SessionAgentPayload<CancelPayload>) {
    return this.sessionApi(sessionId).cancel(payload);
  }

  undoHistory({ sessionId, ...payload }: SessionAgentPayload<UndoHistoryPayload>) {
    return this.sessionApi(sessionId).undoHistory(payload);
  }

  captureRewindCheckpoint({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).captureRewindCheckpoint(payload);
  }

  discardRewindCheckpoint({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).discardRewindCheckpoint(payload);
  }

  async setModel({
    sessionId,
    ...payload
  }: SessionAgentPayload<SetModelPayload>): Promise<SetModelResult> {
    this.reloadProviderManager();
    return this.sessionApi(sessionId).setModel(payload);
  }

  setThinking({ sessionId, ...payload }: SessionAgentPayload<SetThinkingPayload>) {
    return this.sessionApi(sessionId).setThinking(payload);
  }

  setPermission({ sessionId, ...payload }: SessionAgentPayload<SetPermissionPayload>) {
    return this.sessionApi(sessionId).setPermission(payload);
  }

  setNoriRuntimeSettings({
    sessionId,
    ...payload
  }: SessionAgentPayload<SetNoriRuntimeSettingsPayload>) {
    return this.sessionApi(sessionId).setNoriRuntimeSettings(payload);
  }

  getNoriRuntimeSettings({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getNoriRuntimeSettings(payload);
  }

  getModel({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getModel(payload);
  }

  enterDiscuss({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).enterDiscuss(payload);
  }

  cancelDiscuss({ sessionId, ...payload }: SessionAgentPayload<CancelDiscussPayload>) {
    return this.sessionApi(sessionId).cancelDiscuss(payload);
  }

  getDiscussMode({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getDiscussMode(payload);
  }

  beginCompaction({ sessionId, ...payload }: SessionAgentPayload<BeginCompactionPayload>) {
    return this.sessionApi(sessionId).beginCompaction(payload);
  }

  cancelCompaction({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).cancelCompaction(payload);
  }

  registerTool({ sessionId, ...payload }: SessionAgentPayload<RegisterToolPayload>) {
    return this.sessionApi(sessionId).registerTool(payload);
  }

  unregisterTool({ sessionId, ...payload }: SessionAgentPayload<UnregisterToolPayload>) {
    return this.sessionApi(sessionId).unregisterTool(payload);
  }

  setActiveTools({ sessionId, ...payload }: SessionAgentPayload<SetActiveToolsPayload>) {
    return this.sessionApi(sessionId).setActiveTools(payload);
  }

  stopBackground({ sessionId, ...payload }: SessionAgentPayload<StopBackgroundPayload>) {
    return this.sessionApi(sessionId).stopBackground(payload);
  }

  pauseBackground({ sessionId, ...payload }: SessionAgentPayload<ManageBackgroundPayload>) {
    return this.sessionApi(sessionId).pauseBackground(payload);
  }

  guideBackground({ sessionId, ...payload }: SessionAgentPayload<ManageBackgroundPayload>) {
    return this.sessionApi(sessionId).guideBackground(payload);
  }

  resumeBackground({ sessionId, ...payload }: SessionAgentPayload<ManageBackgroundPayload>) {
    return this.sessionApi(sessionId).resumeBackground(payload);
  }

  detachBackground({ sessionId, ...payload }: SessionAgentPayload<DetachBackgroundPayload>) {
    return this.sessionApi(sessionId).detachBackground(payload);
  }

  clearContext({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).clearContext(payload);
  }

  activateSkill({
    sessionId,
    ...payload
  }: SessionAgentPayload<ActivateSkillPayload>): Promise<void> {
    return this.sessionApi(sessionId).activateSkill(payload);
  }

  activatePluginCommand({
    sessionId,
    ...payload
  }: SessionAgentPayload<ActivatePluginCommandPayload>): Promise<void> {
    return this.sessionApi(sessionId).activatePluginCommand(payload);
  }

  getBackgroundOutput({ sessionId, ...payload }: SessionAgentPayload<GetBackgroundOutputPayload>) {
    return this.sessionApi(sessionId).getBackgroundOutput(payload);
  }

  getContext({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getContext(payload);
  }

  getConfig({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getConfig(payload);
  }

  getPermission({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getPermission(payload);
  }

  getUsage({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getUsage(payload);
  }

  getTools({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).getTools(payload);
  }

  getBackground({ sessionId, ...payload }: SessionAgentPayload<GetBackgroundPayload>) {
    return this.sessionApi(sessionId).getBackground(payload);
  }

  listCron({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>) {
    return this.sessionApi(sessionId).listCron(payload);
  }

  createCron({ sessionId, ...payload }: SessionAgentPayload<CronCreateRequest>) {
    return this.sessionApi(sessionId).createCron(payload);
  }

  deleteCron({ sessionId, ...payload }: SessionAgentPayload<{ readonly id: string }>) {
    return this.sessionApi(sessionId).deleteCron(payload);
  }

  updateSessionMetadata({ sessionId, ...payload }: UpdateSessionMetadataRequest): Promise<void> {
    return this.sessionApi(sessionId).updateSessionMetadata(payload);
  }

  getSessionMetadata({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): SessionMeta {
    return this.sessionApi(sessionId).getSessionMetadata(payload);
  }

  detachMountedTeamMember({
    sessionId,
    ...payload
  }: SessionScopedPayload<DetachMountedTeamMemberPayload>): Promise<DetachMountedTeamMemberResult> {
    return this.sessionApi(sessionId).detachMountedTeamMember(payload);
  }

  attachMountedTeamMember({
    sessionId,
    ...payload
  }: SessionScopedPayload<AttachMountedTeamMemberPayload>): Promise<AttachMountedTeamMemberResult> {
    return this.sessionApi(sessionId).attachMountedTeamMember(payload);
  }

  listSkills({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): Promise<readonly SkillSummary[]> {
    return this.sessionApi(sessionId).listSkills(payload);
  }

  listPluginCommands({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): readonly PluginCommandDef[] {
    return this.sessionApi(sessionId).listPluginCommands(payload);
  }

  listMcpServers({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): readonly McpServerInfo[] {
    return this.sessionApi(sessionId).listMcpServers(payload);
  }

  getMcpStartupMetrics({
    sessionId,
    ...payload
  }: SessionScopedPayload<EmptyPayload>): Promise<McpStartupMetrics> {
    return this.sessionApi(sessionId).getMcpStartupMetrics(payload);
  }

  reconnectMcpServer({
    sessionId,
    ...payload
  }: SessionScopedPayload<ReconnectMcpServerPayload>): Promise<void> {
    return this.sessionApi(sessionId).reconnectMcpServer(payload);
  }

  generateAgentsMd({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): Promise<void> {
    return this.sessionApi(sessionId).generateAgentsMd(payload);
  }

  getSessionWarnings({ sessionId, ...payload }: SessionScopedPayload<EmptyPayload>): Promise<readonly SessionWarning[]> {
    return this.sessionApi(sessionId).getSessionWarnings(payload);
  }

  addAdditionalDir({
    sessionId,
    ...payload
  }: SessionScopedPayload<AddAdditionalDirPayload>): Promise<AddAdditionalDirResult> {
    return this.requireSession(sessionId).addAdditionalDir(payload.path, payload.persist);
  }

  startBtw({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>): Promise<string> {
    return this.sessionApi(sessionId).startBtw(payload);
  }

  createGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<CreateGoalPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).createGoal(payload));
  }

  getGoal({ sessionId, ...payload }: SessionAgentPayload<EmptyPayload>): Promise<GoalToolResult> {
    return Promise.resolve(this.sessionApi(sessionId).getGoal(payload));
  }

  pauseGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<EmptyPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).pauseGoal(payload));
  }

  resumeGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<EmptyPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).resumeGoal(payload));
  }

  cancelGoal({
    sessionId,
    ...payload
  }: SessionAgentPayload<EmptyPayload>): Promise<GoalSnapshot> {
    return Promise.resolve(this.sessionApi(sessionId).cancelGoal(payload));
  }

  async installPlugin(payload: InstallPluginPayload): Promise<PluginSummary> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const record = await this.plugins.install(payload.source);
    return this.plugins.summaries().find((s) => s.id === record.id)!;
  }

  async listPlugins(_: EmptyPayload): Promise<readonly PluginSummary[]> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    return this.plugins.summaries();
  }

  async setPluginEnabled({ id, enabled }: SetPluginEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setEnabled(id, enabled);
  }

  async setPluginMcpServerEnabled({
    id,
    server,
    enabled,
  }: SetPluginMcpServerEnabledPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.setMcpServerEnabled(id, server, enabled);
  }

  async removePlugin({ id }: RemovePluginPayload): Promise<void> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    await this.plugins.remove(id);
  }

  async reloadPlugins(_: EmptyPayload): Promise<ReloadPluginsResult> {
    try {
      const summary = await this.plugins.reload();
      this.pluginsLoadError = undefined;
      return summary;
    } catch (error) {
      this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
      throw new KimiError(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Failed to reload plugins: ${this.pluginsLoadError.message}`,
        { cause: error, details: { kimiHomeDir: this.homeDir } },
      );
    }
  }

  async getPluginInfo({ id }: GetPluginInfoPayload): Promise<PluginInfo> {
    await this.pluginsReady;
    this.assertPluginsLoaded();
    const info = this.plugins.info(id);
    if (info === undefined) {
      throw new KimiError(
        ErrorCodes.PLUGIN_NOT_FOUND,
        `Plugin "${id}" is not installed`,
        { details: { id } },
      );
    }
    return info;
  }

  private assertPluginsLoaded(): void {
    if (this.pluginsLoadError === undefined) return;
    throw new KimiError(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Plugin state failed to load: ${this.pluginsLoadError.message}. ` +
        `Fix the file at ${this.homeDir}/plugins/installed.json and run /plugins reload.`,
      { cause: this.pluginsLoadError, details: { kimiHomeDir: this.homeDir } },
    );
  }

  private async resolveRuntime(config: KimiConfig): Promise<ToolServices> {
    if (this.runtime !== undefined) return this.runtime;
    const runtime = await createRuntimeConfig({
      config,
      kimiRequestHeaders: this.kimiRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
    });
    this.runtime = runtime;
    return runtime;
  }

  private getKaos(): Promise<Kaos> {
    this.kaos ??= LocalKaos.create().catch((error: unknown) => {
      if (error instanceof KaosShellNotFoundError) {
        throw new KimiError(ErrorCodes.SHELL_GIT_BASH_NOT_FOUND, error.message);
      }
      throw error;
    });
    return this.kaos;
  }

  private resolveSessionSkillConfig(config: KimiConfig): SessionSkillConfig {
    const explicitDirs = this.skillDirs.length > 0 ? this.skillDirs : undefined;
    return {
      userHomeDir: this.userHomeDir,
      brandHomeDir: this.homeDir,
      explicitDirs,
      extraDirs: config.extraSkillDirs,
      pluginSkillRoots: this.plugins.pluginSkillRoots(),
      mergeAllAvailableSkills: config.mergeAllAvailableSkills,
    };
  }

  private resolveProviderManager(sessionId: string): ProviderManager {
    return new ProviderManager({
      config: () => this.config,
      kimiRequestHeaders: this.kimiRequestHeaders,
      resolveOAuthTokenProvider: this.resolveOAuthTokenProvider,
      promptCacheKey: sessionId,
    });
  }

  private mergePluginMcpConfig(base: SessionMcpConfig | undefined): SessionMcpConfig | undefined {
    const pluginServers = this.withManagedKimiPluginEnv(this.plugins.enabledMcpServers());
    if (Object.keys(pluginServers).length === 0) return base;
    return {
      servers: {
        ...base?.servers,
        ...pluginServers,
      },
    };
  }

  private withManagedKimiPluginEnv(
    pluginServers: Record<string, McpServerConfig>,
  ): Record<string, McpServerConfig> {
    const managedEnv = this.managedKimiCodeEnvForPlugins();
    if (Object.keys(managedEnv).length === 0) return pluginServers;

    const out: Record<string, McpServerConfig> = {};
    for (const [name, server] of Object.entries(pluginServers)) {
      out[name] =
        server.transport === 'stdio'
          ? { ...server, env: { ...server.env, ...managedEnv } }
          : server;
    }
    return out;
  }

  private managedKimiCodeEnvForPlugins(): Record<string, string> {
    const provider = this.config.providers[KIMI_CODE_PROVIDER_NAME];
    const envBaseUrl = process.env[NORI_CODE_BASE_URL_ENV];
    const envOAuthHost = process.env[NORI_CODE_OAUTH_HOST_ENV] ?? process.env[KIMI_OAUTH_HOST_ENV];
    const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
    const baseUrl =
      envBaseUrl !== undefined ? envBaseUrl.replace(/\/+$/, '') : provider?.baseUrl;
    const oauthHost = hasEnvOverride ? envOAuthHost : provider?.oauth?.oauthHost;
    const env: Record<string, string> = {};
    if (baseUrl !== undefined) env[NORI_CODE_BASE_URL_ENV] = baseUrl;
    if (oauthHost !== undefined) env[NORI_CODE_OAUTH_HOST_ENV] = oauthHost;
    return env;
  }

  private withSessionLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLifecycleTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.sessionLifecycleTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionLifecycleTails.get(sessionId) === tail) {
        this.sessionLifecycleTails.delete(sessionId);
      }
    });
    return result;
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
        details: { sessionId },
      });
    }
    return session;
  }

  private sessionApi(sessionId: string): SessionAPIImpl {
    return new SessionAPIImpl(this.requireSession(sessionId));
  }

  private reloadProviderManager(): KimiConfig {
    return this.reloadRuntimeConfig();
  }

  private readConfigForWrite(): KimiConfig {
    return readConfigFileForUpdate(this.configPath);
  }

  private reloadRuntimeConfig(): KimiConfig {
    const loaded = loadRuntimeConfigSafe(this.configPath);
    if (loaded.fileWarnings.length > 0) {
      // Keep the last good config: adopting a salvaged config mid-run could
      // silently drop providers or models a live session depends on.
      this.configWarnings = [
        ...loaded.fileWarnings,
        ...loaded.envWarnings,
        'config.toml has errors; keeping the previously loaded configuration.',
      ];
      log.warn('config reload degraded; keeping previous config', {
        warnings: loaded.fileWarnings,
      });
      return this.config;
    }
    this.configWarnings = loaded.envWarnings;
    return this.setRuntimeConfig(loaded.config);
  }

  private setRuntimeConfig(config: KimiConfig): KimiConfig {
    this.config = config;
    this.experimentalFlags.setConfigOverrides(config.experimental);
    return this.config;
  }

  private clearRuntimeCache(): void {
    if (this.runtimeOverride !== undefined) return;
    this.runtime = undefined;
  }

  private async refreshSessionRuntimeConfig(
    session: Session,
    config: KimiConfig,
  ): Promise<void> {
    const api = new SessionAPIImpl(session);
    // A session migrated from an external tool carries no model, and any
    // session may reference a model alias that no longer exists in config.toml.
    // Try the session's own model first, then fall back to the configured
    // default, so resume degrades gracefully instead of hard-failing.
    const requested = (await api.getModel({ agentId: 'main' })).trim();
    const fallback = config.defaultModel?.trim() ?? '';
    const candidates = [...new Set([requested, fallback].filter((model) => model.length > 0))];
    for (const model of candidates) {
      try {
        await api.setModel({ agentId: 'main', model });
        await session.flushMetadata();
        return;
      } catch (error) {
        // Skip a candidate only when the alias is genuinely absent from
        // config (a stale or migrated model) — that is the graceful-degrade
        // case. A *configured* alias that fails to resolve (missing provider,
        // no credentials, bad max_context_size) is an actionable config error
        // the user must see; surface it instead of silently swapping models.
        const aliasMissing = config.models?.[model] === undefined;
        if (
          aliasMissing &&
          error instanceof KimiError &&
          error.code === ErrorCodes.CONFIG_INVALID
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  private async listMountParentById(): Promise<Readonly<Record<string, string | undefined>>> {
    const all = await this.sessionStore.list({});
    const out: Record<string, string | undefined> = {};
    for (const summary of all) {
      const parent = summary.metadata?.['parent_session_id'];
      out[summary.id] = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
    }
    return out;
  }

  private async applySessionMount(
    input: MountSessionPayload,
    reason: 'mount' | 'remount',
  ): Promise<SessionSummary> {
    if (input.sessionId === input.parentSessionId) {
      throw new SessionMountCycleError(input.sessionId, input.parentSessionId);
    }
    const summary = await this.sessionStore.get(input.sessionId);
    await this.sessionStore.get(input.parentSessionId);
    const oldParentId =
      readParentSessionId(summary.metadata as Record<string, unknown> | undefined) ?? null;
    const oldRole = readMountRole(summary.metadata as Record<string, unknown> | undefined);
    const oldMandate = readMountMandate(summary.metadata as Record<string, unknown> | undefined);
    const role = normalizeOptionalMountString(input.role);
    const mandate = normalizeOptionalMountString(input.mandate);
    if (oldParentId === input.parentSessionId) {
      if (role === undefined && mandate === undefined) {
        // The parent link may have survived a crash after the dual-write
        // attach failed. Treat an identical remount as a repair request.
        await this.syncCoreMountWithRollback({
          childSessionId: input.sessionId,
          oldParentSessionId: oldParentId,
          newParentSessionId: input.parentSessionId,
          role: oldRole,
          mandate: oldMandate,
          previousRole: oldRole,
          previousMandate: oldMandate,
        });
        return this.sessionStore.get(input.sessionId);
      }
      await this.writeSessionMountMetadata(input.sessionId, {
        parentSessionId: input.parentSessionId,
        role,
        mandate,
        clearIdentity: false,
      });
      await this.syncCoreMountWithRollback({
        childSessionId: input.sessionId,
        oldParentSessionId: oldParentId,
        newParentSessionId: input.parentSessionId,
        role,
        mandate,
        previousRole: oldRole,
        previousMandate: oldMandate,
        afterSync: () => this.emitCoreMountChanged({
          sessionId: input.sessionId,
          oldParentSessionId: oldParentId,
          newParentSessionId: input.parentSessionId,
          role,
          mandate,
          reason,
        }),
      });
      return this.sessionStore.get(input.sessionId);
    }

    const parentById = new Map<string, string | undefined>();
    for (const entry of await this.sessionStore.list({ includeArchive: true })) {
      parentById.set(
        entry.id,
        readParentSessionId(entry.metadata as Record<string, unknown> | undefined),
      );
    }
    parentById.set(input.sessionId, input.parentSessionId);
    if (wouldCreateMountCycle(input.sessionId, input.parentSessionId, parentById)) {
      throw new SessionMountCycleError(input.sessionId, input.parentSessionId);
    }

    await this.writeSessionMountMetadata(input.sessionId, {
      parentSessionId: input.parentSessionId,
      role,
      mandate,
      clearIdentity: false,
    });
    await this.syncCoreMountWithRollback({
      childSessionId: input.sessionId,
      oldParentSessionId: oldParentId,
      newParentSessionId: input.parentSessionId,
      role,
      mandate,
      previousRole: oldRole,
      previousMandate: oldMandate,
      afterSync: () => this.emitCoreMountChanged({
        sessionId: input.sessionId,
        oldParentSessionId: oldParentId,
        newParentSessionId: input.parentSessionId,
        role,
        mandate,
        reason: oldParentId === null ? 'mount' : reason,
      }),
    });
    return this.sessionStore.get(input.sessionId);
  }

  private async syncCoreMountWithRollback(input: {
    readonly childSessionId: string;
    readonly oldParentSessionId: string | null;
    readonly newParentSessionId: string | null;
    readonly role: string | undefined;
    readonly mandate: string | undefined;
    readonly previousRole: string | undefined;
    readonly previousMandate: string | undefined;
    readonly afterSync?: () => Promise<void>;
  }): Promise<void> {
    try {
      await this.syncTeamAgentsFromCoreMount(input);
      await input.afterSync?.();
    } catch (error) {
      try {
        await this.writeSessionMountMetadata(input.childSessionId, {
          parentSessionId: input.oldParentSessionId,
          role: input.previousRole,
          mandate: input.previousMandate,
          clearIdentity: true,
        });
        await this.syncTeamAgentsFromCoreMount({
          childSessionId: input.childSessionId,
          oldParentSessionId: input.newParentSessionId,
          newParentSessionId: input.oldParentSessionId,
          role: input.previousRole,
          mandate: input.previousMandate,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Session mount synchronization failed and could not be rolled back.',
        );
      }
      throw error;
    }
  }

  private async writeSessionMountMetadata(
    sessionId: string,
    opts: {
      parentSessionId: string | null;
      role: string | undefined;
      mandate: string | undefined;
      clearIdentity: boolean;
    },
  ): Promise<void> {
    // Mount mutations already run inside this session's lifecycle queue.
    // Calling the public resumeSession wrapper here would enqueue behind the
    // mutation that is currently awaiting this method and deadlock forever.
    await this.resumeSessionWithOverridesUnlocked({ sessionId }, {});
    const active = this.sessions.get(sessionId);
    const summary = await this.sessionStore.get(sessionId);
    const nextCustom: Record<string, unknown> = {
      ...(summary.metadata ?? {}),
      ...(active?.metadata.custom ?? {}),
    };
    if (opts.parentSessionId === null) {
      delete nextCustom[PARENT_SESSION_ID_KEY];
      delete nextCustom[CHILD_SESSION_KIND_KEY];
    } else {
      nextCustom[PARENT_SESSION_ID_KEY] = opts.parentSessionId;
      nextCustom[CHILD_SESSION_KIND_KEY] = CHILD_SESSION_KIND;
    }
    if (opts.clearIdentity) {
      delete nextCustom[MOUNT_ROLE_KEY];
      delete nextCustom[MOUNT_MANDATE_KEY];
      delete nextCustom[MOUNT_NAME_KEY];
    }
    if (opts.role !== undefined) nextCustom[MOUNT_ROLE_KEY] = opts.role;
    if (opts.mandate !== undefined) nextCustom[MOUNT_MANDATE_KEY] = opts.mandate;
    await this.updateSessionMetadata({
      sessionId,
      metadata: { custom: nextCustom },
    });
  }

  private async syncTeamAgentsFromCoreMount(input: {
    readonly childSessionId: string;
    readonly oldParentSessionId: string | null;
    readonly newParentSessionId: string | null;
    readonly role?: string;
    readonly mandate?: string;
  }): Promise<void> {
    const sameParent =
      input.oldParentSessionId !== null
      && input.oldParentSessionId === input.newParentSessionId;
    if (!sameParent) {
      const all = await this.sessionStore.list({ includeArchive: true });
      for (const entry of all) {
        if (entry.id === input.childSessionId) continue;
        await this.resumeSession({ sessionId: entry.id });
        await this.detachMountedTeamMember({
          sessionId: entry.id,
          mountedSessionId: input.childSessionId,
        });
      }
    }
    if (input.newParentSessionId === null) {
      return;
    }
    const identity = await this.resolveCoreMountIdentity(
      input.childSessionId,
      input.role,
      input.mandate,
    );
    await this.resumeSession({ sessionId: input.newParentSessionId });
    await this.attachMountedTeamMember({
      sessionId: input.newParentSessionId,
      mountedSessionId: input.childSessionId,
      identity,
      teamLeaderAgentId: 'main',
    });
  }

  private async detachMountedTeamAgentsEverywhere(mountedSessionId: string): Promise<void> {
    const all = await this.sessionStore.list({ includeArchive: true });
    for (const entry of all) {
      if (entry.id === mountedSessionId) continue;
      await this.resumeSession({ sessionId: entry.id });
      await this.detachMountedTeamMember({
        sessionId: entry.id,
        mountedSessionId,
      });
    }
  }

  private async resolveCoreMountIdentity(
    childSessionId: string,
    role: string | undefined,
    mandate: string | undefined,
  ): Promise<{ name: string; role: string; mandate: string }> {
    // The caller is synchronizing a mount mutation for this exact child.
    // Resume without re-entering the per-session lifecycle queue.
    await this.resumeSessionWithOverridesUnlocked({ sessionId: childSessionId }, {});
    const active = this.sessions.get(childSessionId);
    const summary = await this.sessionStore.get(childSessionId);
    const custom = {
      ...(summary.metadata ?? {}),
      ...(active?.metadata.custom ?? {}),
    } as Record<string, unknown>;
    const name =
      normalizeOptionalMountString(active?.metadata.title)
      ?? normalizeOptionalMountString(summary.title)
      ?? readMountName(custom)
      ?? childSessionId;
    return {
      name,
      role: normalizeOptionalMountString(role)
        ?? readMountRole(custom)
        ?? DEFAULT_MOUNT_MEMBER_ROLE,
      mandate: normalizeOptionalMountString(mandate)
        ?? readMountMandate(custom)
        ?? DEFAULT_MOUNT_MEMBER_MANDATE,
    };
  }

  private async emitCoreMountChanged(input: {
    sessionId: string;
    oldParentSessionId: string | null;
    newParentSessionId: string | null;
    role?: string;
    mandate?: string;
    reason: 'mount' | 'unmount' | 'remount' | 'parent_deleted';
  }): Promise<void> {
    const change: MountChangeInfo = {
      session_id: input.sessionId,
      old_parent_session_id: input.oldParentSessionId,
      new_parent_session_id: input.newParentSessionId,
      role: input.role,
      mandate: input.mandate,
      reason: input.reason,
    };
    const recipients: Array<{ sessionId: string; role: MountChangeRecipientRole }> = [
      { sessionId: input.sessionId, role: 'subject' },
    ];
    if (input.oldParentSessionId !== null) {
      recipients.push({ sessionId: input.oldParentSessionId, role: 'old_parent' });
    }
    if (input.newParentSessionId !== null && input.newParentSessionId !== input.oldParentSessionId) {
      recipients.push({ sessionId: input.newParentSessionId, role: 'new_parent' });
    }
    const all = await this.sessionStore.list({});
    for (const summary of all) {
      if (readParentSessionId(summary.metadata as Record<string, unknown> | undefined) === input.sessionId) {
        recipients.push({ sessionId: summary.id, role: 'direct_child' });
      }
    }
    const seen = new Set<string>();
    const sdk = await this.sdk;
    for (const recipient of recipients) {
      if (seen.has(recipient.sessionId)) continue;
      seen.add(recipient.sessionId);
      void sdk.emitEvent({
        type: 'event.session.mount_changed',
        agentId: 'main',
        sessionId: recipient.sessionId,
        change,
        recipient_role: recipient.role,
      } as never);
      try {
        // This helper is called from a mount mutation. The subject recipient
        // is the mutation's session, so using the public wrapper here would
        // enqueue behind the current operation and deadlock it.
        await this.resumeSessionWithOverridesUnlocked({ sessionId: recipient.sessionId }, {});
        await this.injectSystemReminder({
          sessionId: recipient.sessionId,
          agentId: 'main',
          content: formatMountChangeNotice(change, recipient.role),
          variant: 'mount_changed',
        });
        await this.refreshCoreSessionSelf(recipient.sessionId);
      } catch {
        // Best-effort inject for dormant sessions.
      }
    }
  }

  private async refreshCoreSessionSelf(sessionId: string): Promise<void> {
    // Refreshes are triggered from mount lifecycle callbacks, including for
    // the subject session. Avoid queueing behind the lifecycle operation that
    // is waiting for this refresh to finish.
    await this.resumeSessionWithOverridesUnlocked({ sessionId }, {});
    const active = this.sessions.get(sessionId);
    if (active === undefined) return;
    const summary = await this.sessionStore.get(sessionId);
    const custom = {
      ...(summary.metadata ?? {}),
      ...(active.metadata.custom ?? {}),
    } as Record<string, unknown>;
    const parentId = readParentSessionId(custom);
    const all = await this.sessionStore.list({});
    const parentById = new Map(
      all.map((entry) => [
        entry.id,
        readParentSessionId(entry.metadata as Record<string, unknown> | undefined),
      ] as const),
    );
    const children = all
      .filter(
        (entry) =>
          readParentSessionId(entry.metadata as Record<string, unknown> | undefined) === sessionId,
      )
      .map((entry) => ({
        sessionId: entry.id,
        title: entry.title ?? entry.id,
        role: readMountRole(entry.metadata as Record<string, unknown> | undefined),
        mandate: readMountMandate(entry.metadata as Record<string, unknown> | undefined),
      }));
    let depth = 0;
    let cursor = parentId;
    const seen = new Set<string>([sessionId]);
    while (cursor !== undefined && !seen.has(cursor)) {
      depth += 1;
      seen.add(cursor);
      cursor = parentById.get(cursor);
    }
    let parentTitle: string | undefined;
    if (parentId !== undefined) {
      const parent = all.find((entry) => entry.id === parentId);
      parentTitle = parent?.title ?? parentId;
    }
    const block = formatSessionSelf({
      sessionId,
      title: active.metadata.title ?? summary.title ?? sessionId,
      parentSessionId: parentId,
      parentTitle,
      role: readMountRole(custom),
      mandate: readMountMandate(custom),
      depth,
      position: parentId === undefined ? 'top-level' : 'member',
      directChildren: children.map((child) => ({
        sessionId: child.sessionId,
        title: child.title,
        role: child.role,
        mandate: child.mandate,
      })),
    });
    await this.updateSessionMetadata({
      sessionId,
      metadata: {
        custom: {
          ...custom,
          session_self: block,
        },
      },
    });
  }

  /**
   * TeamCreate hire path: empty child session + mount metadata + mount_changed
   * events (consumed by SessionService for identity notices).
   */
  private async createMountedMemberSession(input: {
    readonly parentSessionId: string;
    readonly identity: { readonly name: string; readonly role: string; readonly mandate: string };
  }): Promise<{ readonly sessionId: string }> {
    const parent = await this.sessionStore.get(input.parentSessionId);
    const child = await this.createSession({
      workDir: parent.workDir,
      metadata: {
        cwd: parent.workDir,
        parent_session_id: input.parentSessionId,
        child_session_kind: 'child',
        mount_role: input.identity.role,
        mount_mandate: input.identity.mandate,
        mount_name: input.identity.name,
      },
    });
    try {
      const active = this.sessions.get(child.id);
      if (active !== undefined) {
        active.metadata = {
          ...active.metadata,
          title: input.identity.name,
          isCustomTitle: true,
          custom: {
            ...active.metadata.custom,
            parent_session_id: input.parentSessionId,
            child_session_kind: 'child',
            mount_role: input.identity.role,
            mount_mandate: input.identity.mandate,
            mount_name: input.identity.name,
          },
        };
        await active.writeMetadata();
        await active.flushMetadata();
        await (await active.ensureAgentResumed('main')).refreshSystemPrompt();
      }
    } catch (error) {
      try {
        await this.deleteSession({ sessionId: child.id });
        await this.refreshCoreSessionSelf(input.parentSessionId).catch(() => undefined);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Mounted member session creation failed and could not be rolled back.',
        );
      }
      throw error;
    }
    try {
      await this.sessionStore.rename(child.id, input.identity.name);
    } catch {
      // Title is best-effort; mount metadata is the authority.
    }

    // TeamCreate creates the map node before it creates the dual-written team
    // agent. Refresh the owning session now so a cached <session_self> block
    // cannot keep advertising the pre-hire child list.
    try {
      await this.refreshCoreSessionSelf(input.parentSessionId);

      const change = {
        session_id: child.id,
        old_parent_session_id: null as string | null,
        new_parent_session_id: input.parentSessionId,
        role: input.identity.role,
        mandate: input.identity.mandate,
        reason: 'mount' as const,
      };
      const sdk = await this.sdk;
      for (const recipient of [
        { sessionId: child.id, role: 'subject' as const },
        { sessionId: input.parentSessionId, role: 'new_parent' as const },
      ]) {
        void sdk.emitEvent({
          type: 'event.session.mount_changed',
          agentId: 'main',
          sessionId: recipient.sessionId,
          change,
          recipient_role: recipient.role,
        } as never);
      }
      return { sessionId: child.id };
    } catch (error) {
      try {
        await this.deleteSession({ sessionId: child.id });
        await this.refreshCoreSessionSelf(input.parentSessionId).catch(() => undefined);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Mounted member session creation failed and could not be rolled back.',
        );
      }
      throw error;
    }
  }

  /**
   * TeamDismiss removes the member's map session, but its own mounted children
   * are still independent sessions. Promote those children before deleting the
   * parent so dismissing one member never destroys a deeper branch.
   */
  private async deleteMountedMemberSession(sessionId: string): Promise<void> {
    let summary: SessionSummary;
    try {
      summary = await this.sessionStore.get(sessionId);
    } catch (error) {
      // Generic session deletion may already have removed the map node and
      // detached its agent. TeamDismiss is intentionally idempotent at this
      // boundary so a stale in-memory member cannot make cleanup fail again.
      if (error instanceof KimiError && error.code === ErrorCodes.SESSION_NOT_FOUND) return;
      throw error;
    }
    const parentSessionId = readParentSessionId(
      summary.metadata as Record<string, unknown> | undefined,
    );
    const children = (await this.sessionStore.list({ includeArchive: true }))
      .filter((summary) => readParentSessionId(summary.metadata as Record<string, unknown> | undefined) === sessionId);
    const promoted: Array<{
      readonly sessionId: string;
      readonly role: string | undefined;
      readonly mandate: string | undefined;
    }> = [];
    try {
      for (const child of children) {
        try {
          await this.unmountSession({ sessionId: child.id });
        } catch (error) {
          if (!(error instanceof KimiError) || error.code !== ErrorCodes.SESSION_NOT_FOUND) {
            throw error;
          }
          continue;
        }
        promoted.push({
          sessionId: child.id,
          role: readMountRole(child.metadata as Record<string, unknown> | undefined),
          mandate: readMountMandate(child.metadata as Record<string, unknown> | undefined),
        });
      }
      await this.deleteSession({ sessionId });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const child of promoted.toReversed()) {
        try {
          await this.mountSession({
            sessionId: child.sessionId,
            parentSessionId: sessionId,
            role: child.role,
            mandate: child.mandate,
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Mounted member session deletion failed and could not be rolled back.',
        );
      }
      throw error;
    }
    if (parentSessionId !== undefined) {
      try {
        await this.refreshCoreSessionSelf(parentSessionId);
      } catch {
        // Deletion is authoritative; a prompt cache refresh can be retried on
        // the next parent operation and must not leave a stale team agent
        // pointing at a session that was already removed.
      }
    }
  }
}

async function createRuntimeConfig(_input: {
  readonly config: KimiConfig;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
}): Promise<ToolServices> {
  const localFetcher = new LocalFetchURLProvider();

  return {
    urlFetcher: localFetcher,
    webSearcher: undefined,
  };
}

function requiredWorkDir(operation: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, `${operation} requires workDir`);
  }
  return normalizeWorkDir(value);
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function withAdditionalDirs<T>(
  result: T,
  session: Session,
): T & { readonly additionalDirs: readonly string[] } {
  return {
    ...result,
    additionalDirs: session.getAdditionalDirs(),
  };
}

function telemetryErrorReason(error: unknown): string {
  if (error instanceof KimiError) return error.code;
  if (error instanceof Error && error.name.length > 0) return error.name;
  return typeof error;
}

function clientTelemetryProperties(client: ClientTelemetryInfo | undefined): TelemetryProperties {
  if (client === undefined) return {};
  // Emit a fixed key set (null when the client did not provide a field) so
  // `session_started` has a stable schema across clients, matching the harness
  // producer in `kimi-harness.ts`. Other session events also inherit these as
  // context properties, so they share the same stable client-attribution shape.
  return {
    client_id: client.id ?? null,
    client_name: client.name ?? null,
    client_version: client.version ?? null,
    ui_mode: client.uiMode ?? null,
  };
}

async function resumeSessionResult(
  summary: SessionSummary,
  session: Session,
  warning?: string,
): Promise<ResumeSessionResult> {
  const api = new SessionAPIImpl(session);
  const agents: Record<string, ResumedAgentState> = {};
  for (const [agentId, entry] of session.agents) {
    if (!(entry instanceof Agent)) continue;
    const agent = entry;
    const config = await api.getConfig({ agentId });
    const context = await api.getContext({ agentId });
    const permission = await api.getPermission({ agentId });
    const discussMode = await api.getDiscussMode({ agentId });
    const usage = await api.getUsage({ agentId });
    agents[agentId] = {
      type: agent.type,
      config,
      context,
      replay: agent.replayBuilder.buildResult(),
      permission,
      discussMode,
      usage,
      tools: await api.getTools({ agentId }),
      toolStore: agent.tools.storeData(),
      background: agent.background.list(false),
    };
  }
  return withAdditionalDirs(
    {
      ...summary,
      sessionMetadata: api.getSessionMetadata({}),
      agents,
      warning,
    },
    session,
  );
}

async function warnIfLogFlushFails(
  exportLog: Logger,
  message: string,
  flush: () => Promise<boolean>,
): Promise<void> {
  try {
    if (await flush()) return;
    exportLog.warn(message);
  } catch (error) {
    exportLog.warn(message, { error });
  }
  try {
    await flush();
  } catch {}
}
