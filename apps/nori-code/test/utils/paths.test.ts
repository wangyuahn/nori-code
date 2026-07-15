import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getBinDir,
  getDataDir,
  getInputHistoryFile,
  getLogDir,
  getUpdateInstallStateFile,
  getUpdateStateFile,
} from '#/utils/paths';

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env['NORI_CODE_HOME'];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('getDataDir', () => {
  it('returns ~/.nori-code when NORI_CODE_HOME is not set', () => {
    expect(getDataDir()).toBe(join(homedir(), '.nori-code'));
  });

  it('returns NORI_CODE_HOME when set', () => {
    process.env['NORI_CODE_HOME'] = '/tmp/nori-test-data';
    expect(getDataDir()).toBe('/tmp/nori-test-data');
  });

  it('returns NORI_CODE_HOME even if it is a relative path', () => {
    process.env['NORI_CODE_HOME'] = 'relative/path';
    expect(getDataDir()).toBe('relative/path');
  });
});

describe('getLogDir', () => {
  it('returns <dataDir>/logs', () => {
    expect(getLogDir()).toBe(join(homedir(), '.nori-code', 'logs'));
  });

  it('respects NORI_CODE_HOME', () => {
    process.env['NORI_CODE_HOME'] = '/z';
    expect(getLogDir()).toBe(join('/z', 'logs'));
  });
});

describe('getBinDir', () => {
  it('returns <dataDir>/bin', () => {
    expect(getBinDir()).toBe(join(homedir(), '.nori-code', 'bin'));
  });

  it('respects NORI_CODE_HOME', () => {
    process.env['NORI_CODE_HOME'] = '/custom-bin-home';
    expect(getBinDir()).toBe(join('/custom-bin-home', 'bin'));
  });
});

describe('getUpdateStateFile', () => {
  it('returns <dataDir>/updates/latest.json', () => {
    expect(getUpdateStateFile()).toBe(join(homedir(), '.nori-code', 'updates', 'latest.json'));
  });

  it('respects NORI_CODE_HOME', () => {
    process.env['NORI_CODE_HOME'] = '/updates-home';
    expect(getUpdateStateFile()).toBe(join('/updates-home', 'updates', 'latest.json'));
  });
});

describe('getUpdateInstallStateFile', () => {
  it('returns <dataDir>/updates/install.json', () => {
    expect(getUpdateInstallStateFile()).toBe(
      join(homedir(), '.nori-code', 'updates', 'install.json'),
    );
  });

  it('respects NORI_CODE_HOME', () => {
    process.env['NORI_CODE_HOME'] = '/updates-home';
    expect(getUpdateInstallStateFile()).toBe(join('/updates-home', 'updates', 'install.json'));
  });
});

describe('getInputHistoryFile', () => {
  it('returns <dataDir>/user-history/<md5(workDir)>.jsonl', () => {
    const workDir = '/home/user/project';
    const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
    expect(getInputHistoryFile(workDir)).toBe(
      join(homedir(), '.nori-code', 'user-history', `${hash}.jsonl`),
    );
  });

  it('respects NORI_CODE_HOME', () => {
    process.env['NORI_CODE_HOME'] = '/custom/data';
    const hash = createHash('md5').update('/proj', 'utf-8').digest('hex');
    expect(getInputHistoryFile('/proj')).toBe(
      join('/custom/data', 'user-history', `${hash}.jsonl`),
    );
  });
});
