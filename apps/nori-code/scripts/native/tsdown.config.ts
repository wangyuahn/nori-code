import { resolve } from 'node:path';

import baseConfig from '../../tsdown.native.config.ts';

export default {
  ...baseConfig,
  cwd: resolve(import.meta.dirname, '../..'),
  alias: {
    ...baseConfig.alias,
    'node-pty': resolve(import.meta.dirname, 'node-pty-loader.ts'),
  },
};
