import {
  applyCustomRegistryEntries,
  fetchCustomRegistry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@nori-code/oauth';
import {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  type Catalog,
  type KimiConfigPatch,
  type ThinkingEffort,
} from '@nori-code/sdk';
import { createKimiCodeUserAgent } from '#/cli/version';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '../components/dialogs/custom-registry-import';
import { ExtraEffortTogglesComponent } from '../components/dialogs/extra-effort-toggles';
import {
  ProviderExtrasListComponent,
} from '../components/dialogs/provider-extras-list';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  extraModelAliasPatch,
  extraModelIds,
  extraModelsFromConfig,
  type ExtraModelDraft,
  type ExtraThinkingMode,
} from '../utils/provider-extras';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import {
  promptApiKey,
  promptCatalogProviderSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

export async function handleProviderCommand(host: SlashCommandHost): Promise<void> {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

function buildProviderManagerOptions(host: SlashCommandHost): ProviderManagerOptions {
  const activeProviderId =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  return {
    providers: host.state.appState.availableProviders,
    activeProviderId,
    onAdd: () => {
      void handleProviderAdd(host).catch((error: unknown) => {
        host.showError(`Add provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onOpenExtras: (providerIds) => {
      void openProviderExtras(host, providerIds).catch((error: unknown) => {
        host.showError(`Extra models failed: ${formatErrorMessage(error)}`);
      });
    },
    onDeleteSource: (providerIds) => {
      void handleProviderManagerDeleteSource(host, providerIds).catch((error: unknown) => {
        host.showError(`Remove provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onClose: () => {
      host.restoreEditor();
    },
  };
}

async function handleProviderManagerDeleteSource(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  for (const providerId of providerIds) {
    try {
      await handleProviderDelete(host, providerId);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Failed to delete provider ${providerId}: ${msg}`);
    }
  }
  reopenProviderManager(host);
}

async function handleProviderDelete(host: SlashCommandHost, providerId: string): Promise<void> {
  if (providerId === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
    return;
  }

  const activeProvider =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  const config = await host.harness.removeProvider(providerId);
  if (activeProvider === providerId) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    host.setAppState({
      availableProviders: config.providers ?? {},
      availableModels: config.models ?? {},
    });
  }
}

async function handleProviderAdd(host: SlashCommandHost): Promise<void> {
  const source = await promptProviderAddSource(host);
  if (source === undefined) {
    reopenProviderManager(host);
    return;
  }

  if (source === 'known') {
    await handleCatalogProviderAdd(host);
    return;
  }
  const handled = await handleCustomRegistryAddViaDialog(host);
  if (!handled) {
    reopenProviderManager(host);
  }
}

function reopenProviderManager(host: SlashCommandHost): void {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

async function openProviderExtras(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  if (providerIds.length === 0) {
    reopenProviderManager(host);
    return;
  }
  if (providerIds.length === 1) {
    showProviderExtrasList(host, providerIds[0]!);
    return;
  }
  const providerId = await promptProviderId(host, providerIds);
  if (providerId === undefined) {
    reopenProviderManager(host);
    return;
  }
  showProviderExtrasList(host, providerId);
}

function promptProviderId(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Select provider',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: providerIds.map((id) => ({ value: id, label: id })),
      onSelect: (value) => {
        resolve(value);
      },
      onCancel: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

function showProviderExtrasList(host: SlashCommandHost, providerId: string): void {
  const drafts = extraModelsFromConfig(
    host.state.appState.availableProviders[providerId],
    host.state.appState.availableModels,
    providerId,
  );
  host.mountEditorReplacement(
    new ProviderExtrasListComponent({
      providerId,
      drafts,
      onAdd: (modelId) => {
        void persistProviderExtras(host, providerId, [
          ...drafts,
          { id: modelId, thinking: 'unsupported', supportEfforts: [], defaultEffort: '' },
        ]).then(() => {
          showProviderExtrasList(host, providerId);
        });
      },
      onEdit: (draft) => {
        void editExtraThinking(host, providerId, drafts, draft);
      },
      onDelete: (modelId) => {
        void persistProviderExtras(
          host,
          providerId,
          drafts.filter((draft) => draft.id !== modelId),
        ).then(() => {
          showProviderExtrasList(host, providerId);
        });
      },
      onClose: () => {
        reopenProviderManager(host);
      },
    }),
  );
}

async function editExtraThinking(
  host: SlashCommandHost,
  providerId: string,
  drafts: readonly ExtraModelDraft[],
  draft: ExtraModelDraft,
): Promise<void> {
  const thinking = await promptExtraThinking(host, draft.thinking);
  if (thinking === undefined) {
    showProviderExtrasList(host, providerId);
    return;
  }
  let next: ExtraModelDraft = {
    ...draft,
    thinking,
    supportEfforts: thinking === 'efforts' ? draft.supportEfforts : [],
    defaultEffort: thinking === 'efforts' ? draft.defaultEffort : '',
  };
  if (thinking === 'efforts') {
    const efforts = await promptExtraEfforts(host, next.supportEfforts);
    if (efforts === undefined) {
      showProviderExtrasList(host, providerId);
      return;
    }
    if (efforts.length === 0) {
      host.showError('Pick at least one thinking effort.');
      showProviderExtrasList(host, providerId);
      return;
    }
    const defaultEffort = await promptDefaultEffort(host, efforts, next.defaultEffort);
    if (defaultEffort === undefined) {
      showProviderExtrasList(host, providerId);
      return;
    }
    next = { ...next, supportEfforts: efforts, defaultEffort };
  }
  await persistProviderExtras(
    host,
    providerId,
    drafts.map((item) => (item.id === draft.id ? next : item)),
  );
  showProviderExtrasList(host, providerId);
}

function promptExtraThinking(
  host: SlashCommandHost,
  current: ExtraThinkingMode,
): Promise<ExtraThinkingMode | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Thinking for extra model',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      currentValue: current,
      options: [
        {
          value: 'unsupported',
          label: 'No thinking',
          description: 'Hide the effort picker for this model.',
        },
        {
          value: 'toggle',
          label: 'Thinking toggle',
          description: 'On / off only — no named effort list.',
        },
        {
          value: 'efforts',
          label: 'Thinking efforts',
          description: 'Named efforts such as low / medium / high (stealth, ox-alpha, …).',
        },
      ],
      onSelect: (value) => {
        resolve(value as ExtraThinkingMode);
      },
      onCancel: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

function promptExtraEfforts(
  host: SlashCommandHost,
  selected: readonly string[],
): Promise<readonly string[] | undefined> {
  return new Promise((resolve) => {
    const picker = new ExtraEffortTogglesComponent({
      selected,
      onSubmit: (efforts) => {
        resolve(efforts);
      },
      onCancel: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

function promptDefaultEffort(
  host: SlashCommandHost,
  efforts: readonly string[],
  current: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Default thinking effort',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      currentValue: efforts.includes(current) ? current : efforts[0],
      options: efforts.map((effort) => ({ value: effort, label: effort })),
      onSelect: (value) => {
        resolve(value);
      },
      onCancel: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function persistProviderExtras(
  host: SlashCommandHost,
  providerId: string,
  drafts: readonly ExtraModelDraft[],
): Promise<void> {
  const nextDrafts = drafts.filter((draft, index) => {
    const id = draft.id.trim();
    if (id.length === 0) return false;
    return drafts.findIndex((item) => item.id.trim() === id) === index;
  });
  const nextIds = extraModelIds(nextDrafts);
  try {
    const config = await host.harness.getConfig();
    const previous = extraModelsFromConfig(
      config.providers[providerId],
      config.models ?? {},
      providerId,
    );
    const models: NonNullable<KimiConfigPatch['models']> = {};
    for (const removed of extraModelIds(previous).filter((id) => !nextIds.includes(id))) {
      models[`${providerId}/${removed}`] = null;
    }
    for (const draft of nextDrafts) {
      const existing =
        config.models?.[`${providerId}/${draft.id}`] ?? config.models?.[draft.id];
      models[`${providerId}/${draft.id}`] = extraModelAliasPatch(
        providerId,
        draft,
        existing,
      ) as NonNullable<KimiConfigPatch['models']>[string];
    }
    const existingProvider = config.providers[providerId];
    const updated = await host.harness.setConfig({
      providers: {
        [providerId]: {
          ...existingProvider,
          customModels: nextIds,
        },
      },
      models,
    });
    host.setAppState({
      availableProviders: updated.providers ?? {},
      availableModels: updated.models ?? {},
    });
    host.showStatus(
      nextIds.length === 0
        ? `Cleared extra models on ${providerId}.`
        : `Saved ${String(nextIds.length)} extra model${nextIds.length === 1 ? '' : 's'} on ${providerId}. Auto-discover stays on.`,
    );
  } catch (error) {
    host.showError(`Failed to save extra models: ${formatErrorMessage(error)}`);
  }
}

function promptProviderAddSource(
  host: SlashCommandHost,
): Promise<'known' | 'custom' | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'known', label: 'Known third-party provider' },
        { value: 'custom', label: 'Custom registry (api.json)' },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value === 'known' || value === 'custom' ? value : undefined);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function handleCatalogProviderAdd(host: SlashCommandHost): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  const spinner = host.showLoginProgressSpinner(`Fetching catalog from ${DEFAULT_CATALOG_URL}`);
  let catalog: Catalog | undefined;
  try {
    catalog = await fetchCatalog(DEFAULT_CATALOG_URL, { signal: controller.signal, userAgent: createKimiCodeUserAgent() });
    spinner.stop({ ok: true, label: 'Catalog loaded.' });
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: 'Aborted.' });
    } else {
      const hint = error instanceof CatalogFetchError ? ` (HTTP ${error.status})` : '';
      spinner.stop({ ok: false, label: 'Failed to load catalog.' });
      host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
    }
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(`Provider "${providerId}" has no usable models in this catalog.`);
    return;
  }

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  const wire = inferWireType(entry);
  if (wire === undefined) {
    host.showError(`Provider "${providerId}" has unsupported wire type.`);
    return;
  }
  const baseUrl = catalogBaseUrl(entry, wire);

  // Persist the provider and all its models immediately after the api key is
  // entered. The model selector that follows is just a convenience to pick the
  // default model; ESC leaves the provider in place without a default selection.
  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: '', // no default yet; user picks in the model selector
    thinking: false,    // will be resolved by the model selector
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('connect', { provider: providerId, method: 'catalog' });
  host.showStatus(`Provider added: ${entry.name ?? providerId}`);

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };

  const selector = new TabbedModelSelectorComponent({
    models: mergedModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(mergedModels).find((a) => a.startsWith(`${providerId}/`)),
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: providerId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: thinkingEffortToConfig(effort),
  });
  await host.authFlow.refreshConfigAfterLogin();
  host.track('model_switch', { model: alias });
  host.showStatus(`Default model set to ${alias} with thinking ${effort}.`);
}

async function handleCustomRegistryAddViaDialog(host: SlashCommandHost): Promise<boolean> {
  const value = await promptCustomRegistryImport(host);
  if (value === undefined) return false;

  const source: CustomRegistrySource = {
    kind: 'apiJson',
    url: value.url,
    apiKey: value.apiKey,
  };

  let entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  try {
    entries = await fetchCustomRegistry(source, { userAgent: createKimiCodeUserAgent() });
  } catch (error) {
    host.showError(`Failed to import registry: ${formatErrorMessage(error)}`);
    return false;
  }

  const addedProviderIds = Object.values(entries).map((entry) => entry.id);
  try {
    const config = await host.harness.getConfig();
    applyCustomRegistryEntries(
      config as unknown as ManagedKimiConfigShape,
      entries,
      source,
    );
    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
    });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(`Failed to apply registry: ${formatErrorMessage(error)}`);
    return false;
  }

  const count = addedProviderIds.length;
  if (count === 0) {
    host.showStatus('Registry contained no providers.');
    return false;
  }
  host.showStatus(
    count === 1
      ? 'Imported 1 provider from registry.'
      : `Imported ${String(count)} providers from registry.`,
    'success',
  );

  // Offer the model selector so the user can pick a default, just like the
  // catalog (known-provider) flow.
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const firstNewAlias = Object.keys(stateModels).find((a) =>
    addedProviderIds.some((pid) => a.startsWith(`${pid}/`)),
  );
  const firstNewProvider = firstNewAlias
    ? stateModels[firstNewAlias]?.provider
    : addedProviderIds[0];
  const selector = new TabbedModelSelectorComponent({
    models: stateModels,
    currentValue: host.state.appState.model,
    selectedValue: firstNewAlias,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: firstNewProvider,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
  return true;
}

function promptCustomRegistryImport(
  host: SlashCommandHost,
): Promise<{ readonly url: string; readonly apiKey: string } | undefined> {
  return new Promise((resolve) => {
    const dialog = new CustomRegistryImportDialogComponent(
      (result: CustomRegistryImportResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog);
  });
}
