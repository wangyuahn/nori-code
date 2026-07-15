export {
  DeviceCodeExpiredError,
  DeviceCodeTimeoutError,
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors';

export type {
  DeviceAuthorization,
  DeviceHeaders,
  OAuthFlowConfig,
  OAuthStorageBackend,
  TokenInfo,
  TokenInfoWire,
} from './types';
export { tokenFromWire, tokenToWire } from './types';

export type { TokenStorage } from './storage';
export { FileTokenStorage } from './storage';

export type { DevicePollResult, RefreshOptions } from './oauth';
export { pollDeviceToken, refreshAccessToken, requestDeviceAuthorization } from './oauth';

export type { LoginOptions, OAuthManagerOptions, OAuthRefreshOutcome } from './oauth-manager';
export { OAuthManager, defaultRefreshThreshold, newInstanceId } from './oauth-manager';

export { extractApiErrorMessage, readApiErrorMessage } from './api-error';

export {
  isOfficialKimiCodingEndpoint,
  OFFICIAL_KIMI_CODING_INPUT_CAPABILITIES,
} from './provider-capabilities';

export { isRecord } from './utils';

export {
  applyCustomRegistryEntries,
  applyCustomRegistryProvider,
  capabilitiesFromCustomEntry,
  CustomRegistryApiError,
  CUSTOM_REGISTRY_DEFAULT_CAPABILITIES,
  CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT,
  fetchCustomRegistry,
  removeCustomRegistryProvider,
} from './custom-registry';
export type {
  CustomRegistryModelEntry,
  CustomRegistryProviderEntry,
  CustomRegistryProviderType,
  CustomRegistrySource,
  FetchCustomRegistryOptions,
  ManagedKimiConfigShape,
  ManagedKimiModelAlias,
  ManagedKimiModelAliasOverrides,
} from './custom-registry';

// ── Stubs for Kimi-specific features removed during OAuth cleanup ──
// Every symbol below was originally in a dedicated module (identity, constants,
// open-platform, managed-kimi-code, toolkit, managed-usage, refreshProviderModels).
// They are now no-op / default-return stubs to keep the rest of the codebase
// type-checking without the original implementations.

export {
  assertKimiHostIdentity,
  createKimiDefaultHeaders,
  createKimiDeviceId,
  KIMI_CODE_FLOW_CONFIG,
  KIMI_CODE_PLATFORM,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  parseKimiCodeCustomHeaders,
  readKimiDeviceId,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeOAuthRef,
  resolveKimiTokenStorageName,
} from './stubs';
export type {
  BearerTokenProvider,
  KimiHostIdentity,
  ManagedKimiCodeModelInfo,
  ManagedKimiOAuthRef,
} from './stubs';

export {
  applyOpenPlatformConfig,
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  OPEN_PLATFORMS,
  OpenPlatformApiError,
} from './stubs';
export type {
  OpenPlatformDefinition,
} from './stubs';

export { refreshProviderModels } from './refresh-provider-models';
export type {
  ProviderChange,
  RefreshProviderHost,
  RefreshProviderOptions,
  RefreshProviderScope,
  RefreshResult,
} from './refresh-provider-models';
