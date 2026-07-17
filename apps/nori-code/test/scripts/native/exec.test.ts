import { describe, expect, it } from 'vitest';

import { commandForExecFile } from '../../../scripts/native/exec.mjs';

describe('commandForExecFile', () => {
  it('returns command as-is on non-Windows', () => {
    const result = commandForExecFile('postject', ['kimi', 'NODE_SEA_BLOB', './blob'], 'darwin');
    expect(result).toEqual({ command: 'postject', args: ['kimi', 'NODE_SEA_BLOB', './blob'] });
  });

  it('returns command as-is on Windows for non-batch files', () => {
    const result = commandForExecFile('postject.exe', ['kimi.exe'], 'win32');
    expect(result).toEqual({ command: 'postject.exe', args: ['kimi.exe'] });
  });

  it('wraps .cmd files through cmd.exe on Windows', () => {
    const result = commandForExecFile('postject.cmd', ['kimi.exe', 'NODE_SEA_BLOB'], 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(result.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(result.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""postject.cmd" "kimi.exe" "NODE_SEA_BLOB""',
    ]);
    expect(result.options?.windowsVerbatimArguments).toBe(true);
  });

  it('wraps .bat files through cmd.exe on Windows', () => {
    const result = commandForExecFile('foo.bat', [], 'win32', { ComSpec: 'cmd.exe' });
    expect(result.command).toBe('cmd.exe');
  });

  it('escapes embedded double quotes in args', () => {
    const result = commandForExecFile('foo.cmd', ['hello "world"'], 'win32', {
      ComSpec: 'cmd.exe',
    });
    expect(result.args[3]).toBe('""foo.cmd" "hello ""world""""');
  });

  it('falls back to cmd.exe when ComSpec missing', () => {
    const result = commandForExecFile('foo.cmd', [], 'win32', {});
    expect(result.command).toBe('cmd.exe');
  });
});
