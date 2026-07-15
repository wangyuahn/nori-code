import { describe, expect, it } from 'vitest';

import { CHAT_SLASH_COMMANDS, chatSlashCommandSuggestions, resolveChatSlashCommand } from '../src/utils/chat-slash-commands';

describe('chat slash commands', () => {
  it('only exposes Web actions that are not duplicated by existing controls', () => {
    expect(CHAT_SLASH_COMMANDS.map(command => command.name)).toEqual(['compact', 'goal', 'swarm']);
    expect(CHAT_SLASH_COMMANDS.map(command => command.name)).not.toContain('plan');
  });

  it('filters command suggestions by the command prefix', () => {
    expect(chatSlashCommandSuggestions('/').map(command => command.name)).toEqual(['compact', 'goal', 'swarm']);
    expect(chatSlashCommandSuggestions('/go').map(command => command.name)).toEqual(['goal']);
    expect(chatSlashCommandSuggestions('explain /goal')).toEqual([]);
  });

  it('parses supported commands and validates their arguments', () => {
    expect(resolveChatSlashCommand('/goal ship the release')).toEqual({
      kind: 'command',
      value: {
        command: CHAT_SLASH_COMMANDS[1],
        args: 'ship the release',
      },
    });
    expect(resolveChatSlashCommand('/swarm')).toMatchObject({ kind: 'error' });
    expect(resolveChatSlashCommand('/compact preserve recent tool results')).toEqual({
      kind: 'command',
      value: {
        command: expect.objectContaining({ name: 'compact' }),
        args: 'preserve recent tool results',
      },
    });
    expect(resolveChatSlashCommand('/plan')).toEqual({ kind: 'none' });
  });
});
