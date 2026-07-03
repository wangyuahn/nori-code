import { type OAuthRef, type KimiConfig } from '@moonshot-ai/agent-core';
import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

export interface KimiAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
  readonly contact?: string;
  readonly info?: Record<string, unknown>;
}

export interface KimiAuthCreateFeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface KimiAuthCompleteFeedbackUploadPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface KimiAuthCompleteFeedbackUploadInput {
  readonly uploadId: number;
  readonly parts: readonly KimiAuthCompleteFeedbackUploadPart[];
}

export interface KimiAuthFeedbackUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export interface KimiAuthCreateFeedbackUploadUrlOk {
  readonly kind: 'ok';
  readonly uploadId: number;
  readonly parts: readonly KimiAuthFeedbackUploadPart[];
}

export type KimiAuthCreateFeedbackUploadUrlResult =
  | KimiAuthCreateFeedbackUploadUrlOk
  | { readonly kind: 'error'; readonly message: string };

export type KimiAuthLoginOptions = {
  readonly baseUrl?: string;
  readonly oauthHost?: string;
  readonly oauthRef?: OAuthRef;
  readonly signal?: AbortSignal;
  readonly onDeviceCode?: (auth: any) => void;
};

export interface KimiAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

export interface KimiAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface KimiAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: { readonly userAgentProduct?: string; readonly version?: string; readonly userAgentSuffix?: string } | undefined;
  readonly onConfigUpdated?: ((config: KimiConfig) => void) | undefined;
  readonly onRefresh?: ((outcome: any) => void) | undefined;
}

/**
 * Pure API-key based auth facade. Replaces the former OAuth-backed
 * implementation with a simple in-memory API key store.
 */
export class KimiAuthFacade {
  private apiKey: string | undefined;

  constructor(private readonly options: KimiAuthFacadeOptions) {}

  /** Set the API key to use for all requests. */
  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /** Get the currently configured API key. */
  getApiKey(): string | undefined {
    return this.apiKey;
  }

  async status(): Promise<readonly { providerName: string; hasToken: boolean }[]> {
    return [];
  }

  async login(
    providerName: string | undefined,
    options: KimiAuthLoginOptions = {},
  ): Promise<KimiAuthLoginResult> {
    throw new Error('OAuth login is not supported. Use setApiKey() to configure an API key.');
  }

  async logout(providerName?: string | undefined): Promise<KimiAuthLogoutResult> {
    return { providerName: providerName ?? 'api-key', ok: true };
  }

  async getManagedUsage(): Promise<{ used: number; limit: number }> {
    throw new Error('Managed usage is not available with API key auth.');
  }

  async submitFeedback(
    input: KimiAuthSubmitFeedbackInput,
    providerName?: string | undefined,
  ): Promise<any> {
    throw new Error('Feedback submission is not available with API key auth.');
  }

  async createFeedbackUploadUrl(
    input: KimiAuthCreateFeedbackUploadUrlInput,
    providerName?: string | undefined,
  ): Promise<KimiAuthCreateFeedbackUploadUrlResult> {
    return { kind: 'error', message: 'Feedback upload is not available with API key auth.' };
  }

  async completeFeedbackUpload(
    input: KimiAuthCompleteFeedbackUploadInput,
    providerName?: string | undefined,
  ): Promise<any> {
    throw new Error('Feedback upload completion is not available with API key auth.');
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    return this.apiKey;
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    const apiKey = this.apiKey;
    return {
      getAccessToken: async (options?: { readonly force?: boolean }): Promise<string> => {
        if (apiKey === undefined || apiKey.length === 0) {
          throw new Error(
            `No API key configured for provider "${providerName}". Call setApiKey() to configure one.`,
          );
        }
        return apiKey;
      },
    };
  };
}
