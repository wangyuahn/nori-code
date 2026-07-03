import type { OAuthTokenProviderResolver, BearerTokenProvider } from '../../session/provider-manager';
import type { OAuthRef } from '../../config';
import type { IEnvironmentService } from '../environment/environment';

/** Default managed OAuth provider name. */
const DEFAULT_MANAGED_PROVIDER_NAME = 'managed:nori-code';

interface ServicesAuthLoginOptions {
  readonly baseUrl?: string | undefined;
  readonly oauthHost?: string | undefined;
  readonly oauthRef?: OAuthRef | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onDeviceCode?: ((auth: any) => void) | undefined;
}

interface ServicesAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

interface ServicesAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface ServicesAuthFacade {
  login(
    providerName?: string | undefined,
    options?: ServicesAuthLoginOptions,
  ): Promise<ServicesAuthLoginResult>;
  logout(providerName?: string | undefined): Promise<ServicesAuthLogoutResult>;
  getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined>;
  readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver;
}

/** Stub implementation — managed Kimi OAuth is not available in nori-code. */
class ServicesManagedAuthFacade implements ServicesAuthFacade {
  async login(
    _providerName?: string | undefined,
    _options?: ServicesAuthLoginOptions,
  ): Promise<ServicesAuthLoginResult> {
    throw new Error('Managed OAuth login is not available in nori-code.');
  }

  async logout(
    _providerName?: string | undefined,
  ): Promise<ServicesAuthLogoutResult> {
    throw new Error('Managed OAuth logout is not available in nori-code.');
  }

  async getCachedAccessToken(
    _providerName?: string,
    _oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    return undefined;
  }

  readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver = (
    _providerName: string,
    _oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider | undefined => undefined;
}

export function createManagedAuthFacade(
  _env: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
): ServicesAuthFacade {
  return new ServicesManagedAuthFacade();
}
