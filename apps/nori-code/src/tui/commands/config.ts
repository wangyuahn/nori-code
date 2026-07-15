import {
  effectiveModelAlias,
  type ExperimentalFeatureState,
  type FlagId,
  type ModelAlias,
  type PermissionMode,
  type Session,
  type ThinkingEffort,
} from '@nori-code/sdk';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { EffortSelectorComponent } from '../components/dialogs/effort-selector';
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '../components/dialogs/experiments-selector';
import { modelDisplayName, segmentsFor } from '../components/dialogs/model-selector';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import {
  SettingAutoWizardComponent,
  type WizardAnswers,
} from '../components/dialogs/setting-auto-wizard';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import {
  StartPermissionPromptComponent,
  goalStartOptions,
  SWARM_OPTIONS,
  GOAL_MANUAL_NOTICE,
  GOAL_YOLO_NOTICE,
  SWARM_NOTICE,
} from '../components/dialogs/start-permission-prompt';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { UpdatePreferenceSelectorComponent } from '../components/dialogs/update-preference-selector';
import { saveTuiConfig } from '../config';
import type { ThemeName } from '#/tui/theme';
import { currentTheme, isBuiltInTheme, lightColors, loadCustomThemeMerged } from '#/tui/theme';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  loadNoteRuleFlags,
  setNoteRuleFlag,
  type NoteRuleFlags,
  loadWorkflowConfig,
  saveWorkflowConfig,
  type WorkflowConfig,
} from '../utils/nori-config';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { showUsage } from './info';
import { setExperimentalFeatures } from './experimental-flags';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

const MODEL_PICKER_REFRESH_TIMEOUT_MS = 2_000;

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === 'clear') {
    await session.clearPlan();
    host.showNotice('Plan cleared');
    return;
  }

  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.planMode;
  else if (subcmd === 'on') enabled = true;
  else if (subcmd === 'off') enabled = false;
  else {
    host.showError(`Unknown plan subcommand: ${subcmd}`);
    return;
  }

  await applyPlanMode(host, session, enabled);
}

async function applyPlanMode(host: SlashCommandHost, session: Session, enabled: boolean): Promise<void> {
  try {
    await session.setPlanMode(enabled);
    host.setAppState({ planMode: enabled });
    if (enabled) {
      const plan = await session.getPlan().catch(() => null);
      host.showNotice(
        'Plan mode: ON',
        plan?.path !== undefined ? `Plan will be created here: ${plan.path}` : undefined,
      );
      return;
    }
    host.showNotice('Plan mode: OFF');
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set plan mode: ${msg}`);
  }
}

export async function handleSettingPermission(host: SlashCommandHost, mode: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const normalized = mode.trim().toLowerCase();

  if (normalized !== 'manual' && normalized !== 'auto' && normalized !== 'yolo') {
    host.showError(`Unknown permission mode: "${mode}". Available: manual, auto, yolo.`);
    return;
  }

  const currentMode = host.state.appState.permissionMode;
  if (normalized === currentMode) {
    host.showNotice(`Permission mode is already ${currentMode}`);
    return;
  }

  await session.setPermission(normalized as PermissionMode);
  host.setAppState({ permissionMode: normalized as PermissionMode });
  host.showNotice(`Permission mode: ${normalized}`);
}

// ---------------------------------------------------------------------------
// Shared permission guard for Goal / Swarm start flows
// ---------------------------------------------------------------------------

/**
 * Ensures the session has a permissive-enough mode before starting a goal or
 * swarm task.  When the current permission is `auto` (or `yolo` for swarm) the
 * callback runs immediately; otherwise a permission prompt is shown so the
 * user can switch modes or proceed in Manual.
 */
export async function ensureAutoPermission(
  host: SlashCommandHost,
  action: 'goal' | 'swarm',
  commandText: string,
  onStart: () => Promise<void>,
): Promise<void> {
  const currentMode = host.state.appState.permissionMode;

  // Already permissive — start right away.
  if (currentMode === 'auto') {
    await onStart();
    return;
  }

  // Swarm runs fine under yolo; only prompt on manual.
  if (action === 'swarm' && currentMode === 'yolo') {
    await onStart();
    return;
  }

  const cancelStatus = action === 'goal' ? 'Goal not started.' : 'Swarm task not started.';

  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };

  const isYolo = currentMode === 'yolo';
  const title = action === 'goal'
    ? (isYolo ? 'Start a goal in YOLO mode?' : 'Start a goal with approvals on?')
    : 'Start a swarm task with approvals on?';

  const noticeLines = action === 'goal'
    ? (isYolo ? GOAL_YOLO_NOTICE : GOAL_MANUAL_NOTICE)
    : SWARM_NOTICE;

  const options = action === 'goal'
    ? goalStartOptions(isYolo ? 'yolo' : 'manual')
    : SWARM_OPTIONS;

  host.mountEditorReplacement(
    new StartPermissionPromptComponent({
      title,
      noticeLines,
      options,
      onSelect: async (choice) => {
        host.restoreEditor();
        if (choice === 'cancel') {
          cancelStart();
          return;
        }
        if (choice !== currentMode) {
          try {
            await host.requireSession().setPermission(choice as PermissionMode);
          } catch (error) {
            host.showError(`Failed to set permission mode: ${formatErrorMessage(error)}`);
            return;
          }
          host.setAppState({ permissionMode: choice as PermissionMode });
        }
        await onStart();
      },
      onCancel: cancelStart,
    }),
  );
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const customInstruction = args.trim() || undefined;
  await session.compact({ instruction: customInstruction });
}

export async function handleEditorCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

export async function handleThemeCommand(host: SlashCommandHost, args: string): Promise<void> {
  const theme = args.trim();
  if (theme.length === 0) {
    showThemePicker(host);
    return;
  }
  if (!isBuiltInTheme(theme)) {
    const custom = await loadCustomThemeMerged(theme);
    if (custom === null) {
      host.showError(`Unknown theme: ${theme}`);
      return;
    }
  }
  await applyThemeChoice(host, theme);
}

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  if (alias.length === 0) {
    showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  showModelPicker(host, alias);
}

export async function handleEffortCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (model === undefined) {
    host.showError('No model selected. Run /model to select one first.');
    return;
  }
  const effective = effectiveModelAlias(model);
  const segments = segmentsFor(effective);
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    showEffortPicker(host, effective, segments);
    return;
  }
  if (!segments.includes(arg)) {
    host.showError(
      `Unsupported thinking effort "${arg}" for ${alias}. Available: ${segments.join(', ')}`,
    );
    return;
  }
  await performModelSwitch(host, alias, arg, true);
}

function showEffortPicker(
  host: SlashCommandHost,
  model: ModelAlias,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort) ? liveEffort : (segments[0] ?? 'off');
  const alias = host.state.appState.model;
  host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      onSelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, true);
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Pickers & config apply
// ---------------------------------------------------------------------------

function showEditorPicker(host: SlashCommandHost): void {
  const currentValue = host.state.appState.editorCommand ?? '';
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
      onSelect: (value) => {
        host.restoreEditor();
        void applyEditorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function refreshModelsForPicker(host: SlashCommandHost): Promise<void> {
  try {
    const result = await withTimeout(
      host.authFlow.refreshOAuthProviderModels(),
      MODEL_PICKER_REFRESH_TIMEOUT_MS,
    );
    if (result === undefined) return;
    for (const f of result.failed) {
      host.showStatus(`Skipped refreshing ${f.provider}: ${f.reason}`, 'warning');
    }
  } catch (error) {
    host.showStatus(`Skipped refreshing models: ${formatErrorMessage(error)}`, 'warning');
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function applyEditorChoice(host: SlashCommandHost, value: string): Promise<void> {
  const previous = host.state.appState.editorCommand ?? '';
  if (value === previous && value.length > 0) {
    host.showStatus(`Editor unchanged: ${value.length > 0 ? value : 'auto-detect'}`);
    return;
  }

  const editorCommand = value.length > 0 ? value : null;
  try {
    await saveTuiConfig({
      theme: host.state.appState.theme,
      editorCommand,
      notifications: host.state.appState.notifications,
      upgrade: host.state.appState.upgrade,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save editor: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  host.setAppState({ editorCommand });
  host.showStatus(
    value.length > 0
      ? `Editor set to "${value}".`
      : 'Editor set to auto-detect ($VISUAL / $EDITOR).',
  );
}

export function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): void {
  const entries = Object.entries(host.state.appState.availableModels);
  if (entries.length === 0) {
    host.showNotice(
      'No models configured',
      'Use /provider to add a provider from a model catalog or custom registry.',
    );
    return;
  }
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models: host.state.appState.availableModels,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinkingEffort: host.state.appState.thinkingEffort,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, true);
      },
      onSessionOnlySelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persist: boolean,
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const prevModel = host.state.appState.model;
  const prevEffort = host.state.appState.thinkingEffort;
  const modelChanged = alias !== prevModel;
  const effortChanged = effort !== prevEffort;
  const runtimeChanged = modelChanged || effortChanged;
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);

  const session = host.session;
  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, effort);
    } else if (session !== undefined) {
      if (alias !== prevModel) {
        await session.setModel(alias);
      }
      if (effort !== prevEffort) {
        await session.setThinking(effort);
      }
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch model: ${msg}`);
    return;
  }

  host.setAppState({ model: alias, thinkingEffort: effort });
  if (session === undefined && runtimeChanged) {
    if (alias !== prevModel) {
      host.track('model_switch', { model: alias });
    }
    if (effort !== prevEffort) {
      host.track('thinking_toggle', {
        enabled: effort !== 'off',
        effort,
        from: prevEffort,
      });
    }
  }

  let persisted = false;
  if (persist) {
    try {
      persisted = await persistModelSelection(host, alias, effort);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Switched to ${displayName}, but failed to save default: ${msg}`);
      return;
    }
  }

  let status: string;
  if (modelChanged) {
    status = persist
      ? `Switched to ${displayName} with thinking ${effort}.`
      : `Switched to ${displayName} with thinking ${effort} for this session only.`;
  } else if (effortChanged) {
    status = persist
      ? `Thinking set to ${effort}.`
      : `Thinking set to ${effort} for this session only.`;
  } else if (persist && persisted) {
    status = `Saved ${displayName} with thinking ${effort} as default.`;
  } else {
    status = `Already using ${displayName} with thinking ${effort}.`;
  }
  host.showStatus(status, 'success');
}

async function persistModelSelection(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const patch = thinkingEffortToConfig(effort);
  if (
    config.defaultModel === alias &&
    config.thinking?.enabled === patch.enabled &&
    config.thinking?.effort === patch.effort
  ) {
    return false;
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: patch,
  });
  return true;
}

function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      onSelect: (value) => {
        host.restoreEditor();
        void applyThemeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThemeChoice(host: SlashCommandHost, theme: ThemeName): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === 'auto') host.refreshTerminalThemeTracking();
    host.showStatus(`Theme unchanged: "${theme}".`);
    return;
  }

  // Validate custom themes up front so a missing / malformed file reports an
  // error instead of silently persisting a name that resolves to the dark
  // fallback.
  if (!isBuiltInTheme(theme)) {
    const palette = await loadCustomThemeMerged(theme);
    if (palette === null) {
      host.showStatus(`Theme "${theme}" could not be loaded.`, 'error');
      return;
    }
  }

  try {
    await saveTuiConfig({
      theme,
      editorCommand: host.state.appState.editorCommand,
      notifications: host.state.appState.notifications,
      upgrade: host.state.appState.upgrade,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save theme: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  const resolved = theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.track('theme_switch', { theme });
  const detail = theme === 'auto' ? ` (tracking terminal; current: ${resolved})` : '';
  host.showStatus(`Theme set to "${theme}"${detail}.`);
}

const PERMISSION_OPTIONS = [
  {
    value: 'manual',
    label: 'Manual',
    description:
      'Ask before commands, edits, and other risky actions. Read/search tools run directly; session approval rules are respected.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Run fully non-interactively. Tool actions are approved automatically, and agent questions are skipped so it can decide on its own.',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description:
      'Automatically approve tool actions and plan transitions. The agent can still ask you explicit questions when your input is needed.',
  },
] as const;

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'yolo';
}

export function showPermissionPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Select permission mode',
      options: [...PERMISSION_OPTIONS],
      currentValue: host.state.appState.permissionMode,
      onSelect: (value) => {
        host.restoreEditor();
        if (isPermissionModeChoice(value)) {
          void applyPermissionChoice(host, value);
        }
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export function showUpdatePreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new UpdatePreferenceSelectorComponent({
      currentValue: host.state.appState.upgrade.autoInstall,
      onSelect: (value) => {
        host.restoreEditor();
        void applyUpdatePreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export async function showExperimentsPanel(host: SlashCommandHost): Promise<void> {
  let features: readonly ExperimentalFeatureState[];
  try {
    features = await host.harness.getExperimentalFeatures();
  } catch (error) {
    host.showError(`Failed to load experimental features: ${formatErrorMessage(error)}`);
    return;
  }
  mountExperimentsPanel(host, features);
}

export async function applyExperimentalFeatureChanges(
  host: SlashCommandHost,
  changes: readonly ExperimentalFeatureDraftChange[],
): Promise<void> {
  if (changes.length === 0) {
    host.showStatus(
      'No experimental feature changes to apply.',
      'textMuted',
    );
    return;
  }

  const experimental: Partial<Record<FlagId, boolean>> = {};
  for (const change of changes) {
    experimental[change.id] = change.enabled;
  }

  try {
    await host.harness.setConfig({ experimental });
    const features = await host.harness.getExperimentalFeatures();
    setExperimentalFeatures(features);
    host.refreshSlashCommandAutocomplete();
    host.restoreEditor();
    if (host.session !== undefined) {
      await host.session.reloadSession();
      await host.reloadCurrentSessionView(
        host.session,
        'Experimental features updated. Session reloaded.',
      );
    } else {
      host.showStatus('Experimental features updated.', 'success');
    }
    host.track('experimental_features_apply', { changed: changes.length });
  } catch (error) {
    host.showError(`Failed to update experimental features: ${formatErrorMessage(error)}`);
  }
}

function mountExperimentsPanel(
  host: SlashCommandHost,
  features: readonly ExperimentalFeatureState[],
): void {
  host.mountEditorReplacement(
    new ExperimentsSelectorComponent({
      features,
      onApply: (changes) => {
        void applyExperimentalFeatureChanges(host, changes);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type UpdatePreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade'
    >;
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'upgrade'>): void;
  showStatus(msg: string, color?: string): void;
  track: SlashCommandHost['track'];
};

export async function applyUpdatePreferenceChoice(
  host: UpdatePreferenceHost,
  autoInstall: boolean,
): Promise<void> {
  if (autoInstall === host.state.appState.upgrade.autoInstall) {
    host.showStatus(`Automatic updates already ${autoInstall ? 'enabled' : 'disabled'}.`);
    return;
  }

  const upgrade = { autoInstall };
  try {
    await saveTuiConfig({
      theme: host.state.appState.theme,
      editorCommand: host.state.appState.editorCommand,
      notifications: host.state.appState.notifications,
      upgrade,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save automatic update setting: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  host.setAppState({ upgrade });
  host.track('upgrade_preference_changed', { auto_install: autoInstall });
  host.showStatus(`Automatic updates ${autoInstall ? 'enabled' : 'disabled'}.`);
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(`Permission mode unchanged: ${mode}.`);
    return;
  }

  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set permission mode: ${msg}`);
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(`Permission mode: ${mode}`);
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      onSelect: (value) => {
        handleSettingsSelection(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function handleSettingsSelection(host: SlashCommandHost, value: SettingsSelection): void {
  host.restoreEditor();
  switch (value) {
    case 'model': showModelPicker(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'experiments': void showExperimentsPanel(host); return;
    case 'upgrade': showUpdatePreferencePicker(host); return;
    case 'usage': void showUsage(host); return;
    case 'coder-write': {
      const current = host.state.appState.coderWriteEnabled;
      const options = current
        ? [
            { value: 'off', label: 'Turn OFF', description: 'Disable coder write access' },
            { value: 'cancel', label: 'Cancel', description: 'Keep current setting' },
          ]
        : [
            { value: 'on', label: 'Turn ON', description: 'Enable coder write access' },
            { value: 'cancel', label: 'Cancel', description: 'Keep current setting' },
          ];
      host.mountEditorReplacement(
        new ChoicePickerComponent({
          title: `Coder Write is currently ${current ? 'ON' : 'OFF'}`,
          options,
          onSelect: (value) => {
            host.restoreEditor();
            if (value === 'on' || value === 'off') {
              const next = value === 'on';
              void applyCoderWriteChoice(host, next);
            }
          },
          onCancel: () => {
            host.restoreEditor();
          },
        }),
      );
      return;
    }
    case 'swarm-depth':
      showSwarmDepthPicker(host);
      return;
    case 'note-rules':
      showNoteRulesPicker(host);
      return;
    case 'read-only': {
      void applyReadOnlyChoice(host, !host.state.appState.toolsReadonly);
      return;
    }
    case 'workflow':
      showWorkflowPicker(host);
      return;
  }
}

// ---------------------------------------------------------------------------
// Setting command — centralized config setter
// ---------------------------------------------------------------------------

export async function handleSettingCommand(host: SlashCommandHost, args: string): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    showSettingsSelector(host);
    return;
  }

  const [section, subcommand, value] = tokens;
  switch (section) {
    case 'permission':
      if (subcommand === undefined) showPermissionPicker(host);
      else await handleSettingPermission(host, subcommand);
      return;
    case 'readonly': {
      const next = parseOnOff(subcommand, !host.state.appState.toolsReadonly);
      if (next === undefined) {
        host.showError('Usage: /setting readonly on|off');
        return;
      }
      await applyReadOnlyChoice(host, next);
      return;
    }
    case 'coder': {
      if (subcommand !== 'write') {
        host.showError('Usage: /setting coder write on|off');
        return;
      }
      const next = parseOnOff(value, !host.state.appState.coderWriteEnabled);
      if (next === undefined) {
        host.showError('Usage: /setting coder write on|off');
        return;
      }
      await applyCoderWriteChoice(host, next);
      return;
    }
    case 'depth': {
      const depth = Number(subcommand);
      if (!Number.isInteger(depth) || depth < 1) {
        host.showError('Usage: /setting depth <positive-integer>');
        return;
      }
      await applyMaxSwarmDepthChoice(host, depth);
      return;
    }
    case 'auto':
      showSettingAutoWizard(host);
      return;
    case 'model':
      await handleModelCommand(host, tokens.slice(1).join(' '));
      return;
    case 'theme':
      await handleThemeCommand(host, tokens.slice(1).join(' '));
      return;
    case 'editor':
      await handleEditorCommand(host, tokens.slice(1).join(' '));
      return;
    case 'note':
      showNoteRulesPicker(host);
      return;
    default:
      host.showError(`Unknown setting: ${section}`);
      return;
  }
}

function parseOnOff(value: string | undefined, fallback: boolean): boolean | undefined {
  if (value === undefined || value.length === 0) return fallback;
  if (value === 'on' || value === 'true' || value === 'yes') return true;
  if (value === 'off' || value === 'false' || value === 'no') return false;
  return undefined;
}

async function applyCoderWriteChoice(host: SlashCommandHost, enabled: boolean): Promise<void> {
  try {
    const settings = await host.requireSession().setNoriRuntimeSettings({
      coderWriteEnabled: enabled,
    });
    host.setAppState({
      coderWriteEnabled: settings.coderWriteEnabled,
      toolsReadonly: settings.toolsReadonly,
      maxSwarmDepth: settings.maxSwarmDepth,
    });
    host.showStatus(`Coder write: ${settings.coderWriteEnabled ? 'ON' : 'OFF'}`);
  } catch (error) {
    host.showError(`Failed to set coder write: ${formatErrorMessage(error)}`);
  }
}

async function applyReadOnlyChoice(host: SlashCommandHost, enabled: boolean): Promise<void> {
  try {
    const settings = await host.requireSession().setNoriRuntimeSettings({
      toolsReadonly: enabled,
    });
    host.setAppState({
      coderWriteEnabled: settings.coderWriteEnabled,
      toolsReadonly: settings.toolsReadonly,
      maxSwarmDepth: settings.maxSwarmDepth,
    });
    host.showStatus(`Read-only mode: ${settings.toolsReadonly ? 'ON' : 'OFF'}`);
  } catch (error) {
    host.showError(`Failed to set read-only mode: ${formatErrorMessage(error)}`);
  }
}

async function applyMaxSwarmDepthChoice(host: SlashCommandHost, depth: number): Promise<void> {
  try {
    const settings = await host.requireSession().setNoriRuntimeSettings({
      maxSwarmDepth: depth,
    });
    host.setAppState({
      coderWriteEnabled: settings.coderWriteEnabled,
      toolsReadonly: settings.toolsReadonly,
      maxSwarmDepth: settings.maxSwarmDepth,
    });
    host.showStatus(`Swarm max depth: ${String(settings.maxSwarmDepth)}`);
  } catch (error) {
    host.showError(`Failed to set swarm max depth: ${formatErrorMessage(error)}`);
  }
}

function showSettingAutoWizard(host: SlashCommandHost): void {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.mountEditorReplacement(
    new SettingAutoWizardComponent({
      appState: host.state.appState,
      onComplete: (answers) => {
        host.restoreEditor();
        void applySettingAutoWizardAnswers(host, answers);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applySettingAutoWizardAnswers(
  host: SlashCommandHost,
  answers: WizardAnswers,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  try {
    await session.setPermission(answers.permission);

    if (answers.model.length > 0 && answers.model !== '__none__') {
      await session.setModel(answers.model);
    }

    const settings = await session.setNoriRuntimeSettings({
      maxSwarmDepth: answers.swarmDepth,
      coderWriteEnabled: answers.coderWrite,
    });

    await session.setPlanMode(answers.planMode);

    const notifications = {
      ...host.state.appState.notifications,
      enabled: answers.notifications,
    };
    await saveTuiConfig({
      theme: host.state.appState.theme,
      editorCommand: host.state.appState.editorCommand,
      notifications,
      upgrade: host.state.appState.upgrade,
    });

    host.setAppState({
      permissionMode: answers.permission,
      model: answers.model === '__none__' ? host.state.appState.model : answers.model,
      planMode: answers.planMode,
      notifications,
      coderWriteEnabled: settings.coderWriteEnabled,
      toolsReadonly: settings.toolsReadonly,
      maxSwarmDepth: settings.maxSwarmDepth,
    });
    host.showStatus('Auto settings applied.', 'success');
  } catch (error) {
    host.showError(`Failed to apply auto settings: ${formatErrorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Swarm depth picker
// ---------------------------------------------------------------------------

const SWARM_DEPTH_OPTIONS = [
  { value: '1', label: '1', description: 'Allow swarm delegation without recursive nesting.' },
  { value: '2', label: '2', description: 'Allow one nested swarm level.' },
  { value: '3', label: '3', description: 'Allow two nested swarm levels.' },
] as const;

function showSwarmDepthPicker(host: SlashCommandHost): void {
  const currentDepth = String(host.state.appState.maxSwarmDepth);
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Swarm Depth',
      options: [...SWARM_DEPTH_OPTIONS],
      currentValue: currentDepth === '0' ? '1' : currentDepth,
      onSelect: (value) => {
        host.restoreEditor();
        const depth = Number(value);
        void applyMaxSwarmDepthChoice(host, depth);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Note rules picker
// ---------------------------------------------------------------------------

const NOTE_RULE_LABELS: Record<keyof NoteRuleFlags, string> = {
  requireAnalysisNote: 'Analysis Note',
  requireDecisionNote: 'Decision Note (ADR)',
  requirePatternNote: 'Pattern Note',
};

function showNoteRulesPicker(host: SlashCommandHost): void {
  const flags = loadNoteRuleFlags(process.cwd());

  const options = (Object.entries(NOTE_RULE_LABELS) as [keyof NoteRuleFlags, string][]).map(
    ([flagName, label]) => {
      const enabled = flags[flagName];
      return {
        value: flagName,
        label: `${enabled ? '✓' : '✗'} ${label}`,
        description: enabled
          ? `Required — you must write ${label.toLowerCase()}s before advancing phases.`
          : `Optional — ${label.toLowerCase()}s are not required.`,
      };
    },
  );

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Note Rules',
      hint: '↑↓ navigate · Enter toggle · Esc back',
      options,
      onSelect: (value) => {
        const flagName = value as keyof NoteRuleFlags;
        const newValue = !flags[flagName];
        setNoteRuleFlag(process.cwd(), flagName, newValue);
        // Sync to running agent's noriConfig.rules for phase-switch gate
        const sessionAny = host.session as any;
        const mainAgent = sessionAny?.getReadyAgent?.('main');
        if (mainAgent?.noriConfig?.rules) {
          const updatedFlags = loadNoteRuleFlags(process.cwd());
          Object.assign(mainAgent.noriConfig.rules, updatedFlags);
        }
        // Re-show with updated flags
        host.restoreEditor();
        showNoteRulesPicker(host);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Workflow picker
// ---------------------------------------------------------------------------

function getWorkflowConfig(host: SlashCommandHost): WorkflowConfig {
  // Read from nori.yaml first, fall back to in-memory on agent
  const fromFile = loadWorkflowConfig(process.cwd());
  const sessionAny = host.session as any;
  const mainAgent = sessionAny?.getReadyAgent?.('main');
  const fromAgent = mainAgent?.noriWorkflow as WorkflowConfig | undefined;
  // Merge: agent runtime overrides file defaults
  return { ...fromFile, ...(fromAgent ?? {}) };
}

function setWorkflowConfig(host: SlashCommandHost, patch: Partial<WorkflowConfig>): void {
  const sessionAny = host.session as any;
  const mainAgent = sessionAny?.getReadyAgent?.('main');
  
  // Persist to nori.yaml
  const current = loadWorkflowConfig(process.cwd());
  const next = { ...current, ...patch };
  saveWorkflowConfig(process.cwd(), next);
  
  // Also update runtime agent for immediate effect
  if (mainAgent) {
    if (mainAgent.noriWorkflow === undefined) {
      (mainAgent as any).noriWorkflow = { ...current, ...patch };
    } else {
      Object.assign(mainAgent.noriWorkflow, patch);
    }
  }
}

function showWorkflowPicker(host: SlashCommandHost): void {
  const config = getWorkflowConfig(host);

  const bugHuntLabel = config.bugHuntSwarmRequired ? 'ON' : 'OFF';
  const gateLabel = String(config.maxReviewGateContinuations);

  const options: ChoiceOption[] = [
    {
      value: 'bug-hunt-swarm',
      label: `Bug Hunt Swarm: ${bugHuntLabel}`,
      description: 'Automatically launch AgentSwarm for bug hunt / failure diagnosis requests.',
    },
    {
      value: 'review-thresholds',
      label: `Review Thresholds: ${config.reviewSuggestionThreshold} / ${config.reviewRequiredThreshold}`,
      description: 'Set suggestion and required thresholds for auto-review gates.',
    },
    {
      value: 'max-gate-continuations',
      label: `Max Gate Continuations: ${gateLabel}`,
      description: 'Maximum times the workflow gate can loop back before giving up.',
    },
  ];

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Workflow',
      hint: '↑↓ navigate · Enter select · Esc back',
      options,
      onSelect: (value) => {
        host.restoreEditor();
        switch (value) {
          case 'bug-hunt-swarm': {
            const next = !getWorkflowConfig(host).bugHuntSwarmRequired;
            setWorkflowConfig(host, { bugHuntSwarmRequired: next });
            host.showStatus(`Bug Hunt Swarm: ${next ? 'ON' : 'OFF'}`);
            break;
          }
          case 'review-thresholds':
            showReviewThresholdPicker(host);
            return;
          case 'max-gate-continuations':
            showGateContinuationsPicker(host);
            return;
        }
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function showReviewThresholdPicker(host: SlashCommandHost): void {
  const config = getWorkflowConfig(host);

  const options: ChoiceOption[] = [
    {
      value: 'suggestion',
      label: `Suggestion Threshold: ${config.reviewSuggestionThreshold}`,
      description: 'When difficulty score reaches this value, a review gate is suggested.',
    },
    {
      value: 'required',
      label: `Required Threshold: ${config.reviewRequiredThreshold}`,
      description: 'When difficulty score reaches this value, a review gate is required.',
    },
  ];

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Review Thresholds',
      hint: '↑↓ navigate · Enter select · Esc back',
      options,
      onSelect: (value) => {
        if (value === 'suggestion') {
          host.restoreEditor();
          showNumberPicker(host, 'Suggestion Threshold', 0, 10, config.reviewSuggestionThreshold, (v) => {
            setWorkflowConfig(host, { reviewSuggestionThreshold: v });
            host.showStatus(`Suggestion threshold: ${v}`);
          });
          return;
        }
        if (value === 'required') {
          host.restoreEditor();
          showNumberPicker(host, 'Required Threshold', 0, 10, config.reviewRequiredThreshold, (v) => {
            setWorkflowConfig(host, { reviewRequiredThreshold: v });
            host.showStatus(`Required threshold: ${v}`);
          });
          return;
        }
      },
      onCancel: () => {
        host.restoreEditor();
        showWorkflowPicker(host);
      },
    }),
  );
}

function showGateContinuationsPicker(host: SlashCommandHost): void {
  const config = getWorkflowConfig(host);

  const options: ChoiceOption[] = Array.from({ length: 5 }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1}`,
    description: i + 1 === config.maxReviewGateContinuations ? '(current)' : undefined,
  }));

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Max Gate Continuations',
      hint: '↑↓ navigate · Enter select · Esc back',
      options,
      currentValue: String(config.maxReviewGateContinuations),
      onSelect: (value) => {
        const v = Number(value);
        setWorkflowConfig(host, { maxReviewGateContinuations: v });
        host.restoreEditor();
        host.showStatus(`Max gate continuations: ${v}`);
      },
      onCancel: () => {
        host.restoreEditor();
        showWorkflowPicker(host);
      },
    }),
  );
}

function showNumberPicker(
  host: SlashCommandHost,
  title: string,
  min: number,
  max: number,
  current: number,
  onSelect: (value: number) => void,
): void {
  const options: ChoiceOption[] = Array.from({ length: max - min + 1 }, (_, i) => ({
    value: String(min + i),
    label: `${min + i}`,
    description: min + i === current ? '(current)' : undefined,
  }));

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title,
      hint: '↑↓ navigate · Enter select · Esc back',
      options,
      currentValue: String(current),
      onSelect: (value) => {
        host.restoreEditor();
        onSelect(Number(value));
      },
      onCancel: () => {
        host.restoreEditor();
        showReviewThresholdPicker(host);
      },
    }),
  );
}
