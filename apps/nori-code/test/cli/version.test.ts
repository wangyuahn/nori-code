import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildKimiDefaultHeaders,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/nori-code and reads its version', () => {
    const pkgPath = getHostPackageJsonPath();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(pkgPath.endsWith(join('apps', 'nori-code', 'package.json'))).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(pkgPath));
    expect(getVersion()).toBe(pkg.version);
  });

  it('builds default headers with the nori-code-cli user-agent', () => {
    const headers = buildKimiDefaultHeaders('1.2.3');

    expect(headers['User-Agent']).toBe('nori-code-cli/1.2.3');
  });
});
