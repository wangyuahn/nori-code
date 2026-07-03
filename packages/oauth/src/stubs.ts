/**
 * Stub implementations for Kimi-specific features that were removed during
 * the OAuth cleanup. Every exported symbol here is a no-op / default-return
 * that satisfies the type-checker while preserving the runtime call-sites
 * scattered across agent-core, node-sdk, and the TUI.
 */

// ── Identity (was ./identity) ──

export interface KimiHostIdentity {
  userAgentProduct: string;
  version: string;
  userAgentSuffix?: string | undefined;
}

export function createKimiDeviceId(
  _homeDir: string,
  options?: { onFirstLaunch?: () => void },
): string {
  options?.onFirstLaunch?.();
  return requireCrypto().randomUUID();
}

export function readKimiDeviceId(_homeDir?: string): string | undefined {
  return undefined;
}

export function createKimiDefaultHeaders(_options: {
  homeDir: string;
  userAgentProduct?: string;
  version?: string;
}): Record<string, string> {
  return {};
}

export function assertKimiHostIdentity(
  identity: unknown,
): asserts identity is KimiHostIdentity {
  // no-op stub — trust the caller
}

// ── Constants (was ./constants) ──

export const KIMI_CODE_PROVIDER_NAME = 'managed:nori-code';

export const KIMI_CODE_PLATFORM = 'kimi_code_cli';

export const KIMI_CODE_FLOW_CONFIG: { oauthHost: string } = {
  oauthHost: '',
};

// ── Open Platform (was ./open-platform) ──

export interface OpenPlatformDefinition {
  id: string;
  name: string;
  consoleUrl?: string;
  baseUrl: string;
}

export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [];

export function getOpenPlatformById(
  _id: string,
): OpenPlatformDefinition | undefined {
  return undefined;
}

export function isOpenPlatformId(_id: string): boolean {
  return false;
}

export class OpenPlatformApiError extends Error {
  readonly status: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenPlatformApiError';
    this.status = status ?? 0;
  }
}

export async function applyOpenPlatformConfig(
  ..._args: unknown[]
): Promise<Record<string, unknown>> {
  return {};
}

export async function fetchOpenPlatformModels(
  _platform: OpenPlatformDefinition,
  _apiKey: string,
  _fetch?: typeof fetch,
  _signal?: AbortSignal,
): Promise<ManagedKimiCodeModelInfo[]> {
  return [];
}

export function filterModelsByPrefix(
  models: ManagedKimiCodeModelInfo[],
  _platform: OpenPlatformDefinition,
): ManagedKimiCodeModelInfo[] {
  return models;
}

export function capabilitiesForModel(_model: unknown): string[] {
  return [];
}

// ── Managed Kimi Code (was ./managed-kimi-code) ──

export interface ManagedKimiCodeModelInfo {
  id: string;
  contextLength: number;
  context_length?: number;
  displayName?: string;
  supports_reasoning?: boolean;
  supports_thinking_type?: string;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
  protocol?: string;
}

export interface ManagedKimiOAuthRef {
  storage: 'file' | 'keyring';
  key: string;
  oauthHost?: string | undefined;
}

export function resolveKimiCodeOAuthKey(options: {
  oauthHost?: string;
  baseUrl: string;
}): string {
  return `oauth/${options.baseUrl}`;
}

export function resolveKimiCodeOAuthRef(options: {
  oauthHost: string;
  baseUrl: string;
}): ManagedKimiOAuthRef {
  return {
    storage: 'file',
    key: `oauth/${options.baseUrl}`,
  };
}

export function resolveKimiTokenStorageName(options: {
  oauthKey: string;
}): string {
  return `oauth/${options.oauthKey}`;
}

// ── Kimi OAuth Toolkit (was ./toolkit) ──

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export class KimiOAuthToolkit {
  constructor(_options: { homeDir: string; identity: KimiHostIdentity }) {
    // no-op
  }

  async ensureFresh(
    _providerName: string,
    _options: { force: boolean; oauthRef: ManagedKimiOAuthRef },
  ): Promise<string> {
    throw new Error('KimiOAuthToolkit is not available — OAuth was removed.');
  }
}

// ── Managed Usage (was ./managed-usage) ──

export function kimiCodeBaseUrl(): string {
  return '';
}

export function parseKimiCodeCustomHeaders(): Record<string, string> {
  return {};
}

// ── Refresh Provider Models (was ./refreshProviderModels) ──

export interface RefreshProviderHost {
  getConfig(): Promise<unknown>;
  removeProvider(providerId: string): Promise<unknown>;
  setConfig(patch: unknown): Promise<unknown>;
  resolveOAuthToken(providerName: string, oauthRef?: ManagedKimiOAuthRef): Promise<string>;
}

export interface ProviderChange {
  providerId: string;
  providerName: string;
  added: number;
  removed: number;
}

export type RefreshProviderScope = 'all' | 'oauth';

export interface RefreshProviderOptions {
  scope?: RefreshProviderScope;
  providerId?: string;
}

export interface RefreshResult {
  changed: readonly ProviderChange[];
  unchanged: readonly string[];
  failed: readonly { provider: string; reason: string }[];
}

export async function refreshProviderModels(
  _host: RefreshProviderHost,
  _options?: RefreshProviderOptions,
): Promise<RefreshResult> {
  return { changed: [], unchanged: [], failed: [] };
}

// ── helpers ──

function requireCrypto(): {
  randomUUID(): string;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:crypto') as { randomUUID(): string };
}
