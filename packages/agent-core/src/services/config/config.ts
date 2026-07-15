import { createDecorator } from '../../di';
import type { ConfigResponse, PatchConfigRequest } from '@nori-code/protocol';

export interface IConfigService {
  readonly _serviceBrand: undefined;

  get(): Promise<ConfigResponse>;
  set(patch: PatchConfigRequest): Promise<ConfigResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IConfigService = createDecorator<IConfigService>('configService');
