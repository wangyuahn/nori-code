import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Windows installer speed contract', () => {
  it('does not delete the whole install tree before copying files', () => {
    const script = readFileSync(join(desktopRoot, 'build/installer.nsh'), 'utf8');
    expect(script).toContain('RMDir /r "$INSTDIR\\resources\\nori-web"');
    expect(script).not.toContain('RMDir /r "$INSTDIR"');
    expect(script.match(/RMDir/g)).toEqual(['RMDir']);
  });

  it('stores the Windows payload and keeps normal compression on other systems', () => {
    const config = readFileSync(join(desktopRoot, 'electron-builder.config.cjs'), 'utf8');
    expect(config).toContain("compression: process.platform === 'win32' ? 'store' : 'normal'");
  });
});
