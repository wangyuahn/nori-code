export type ChatSlashCommandName = 'compact' | 'goal' | 'swarm';

export interface ChatSlashCommand {
  name: ChatSlashCommandName;
  description: string;
  descriptionZh: string;
  argumentHint?: string;
}

export interface ParsedChatSlashCommand {
  command: ChatSlashCommand;
  args: string;
}

export type ChatSlashCommandResolution =
  | { kind: 'command'; value: ParsedChatSlashCommand }
  | { kind: 'error'; message: string; messageZh: string }
  | { kind: 'none' };

export const CHAT_SLASH_COMMANDS: readonly ChatSlashCommand[] = [
  {
    name: 'compact',
    description: 'Compact the conversation context',
    descriptionZh: '压缩当前对话上下文',
    argumentHint: '[instruction]',
  },
  {
    name: 'goal',
    description: 'Start an autonomous goal',
    descriptionZh: '启动自主目标',
    argumentHint: '<objective>',
  },
  {
    name: 'swarm',
    description: 'Start a coordinated Swarm task',
    descriptionZh: '启动 Swarm 协作任务',
    argumentHint: '<task>',
  },
];

export function chatSlashCommandSuggestions(input: string): readonly ChatSlashCommand[] {
  const match = input.match(/^\/([^\s/]*)/);
  if (!match) return [];
  const prefix = (match[1] ?? '').toLowerCase();
  return CHAT_SLASH_COMMANDS.filter(command => command.name.startsWith(prefix));
}

export function resolveChatSlashCommand(input: string): ChatSlashCommandResolution {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { kind: 'none' };

  const match = trimmed.match(/^\/([^\s/]+)(?:\s+(.*))?$/s);
  if (!match) return { kind: 'none' };
  const name = (match[1] ?? '').toLowerCase();
  const command = CHAT_SLASH_COMMANDS.find(candidate => candidate.name === name);
  if (!command) return { kind: 'none' };

  const args = (match[2] ?? '').trim();
  if ((command.name === 'goal' || command.name === 'swarm') && args.length === 0) {
    return {
      kind: 'error',
      message: `Usage: /${command.name} ${command.argumentHint}`,
      messageZh: `用法：/${command.name} ${command.argumentHint}`,
    };
  }

  return { kind: 'command', value: { command, args } };
}
