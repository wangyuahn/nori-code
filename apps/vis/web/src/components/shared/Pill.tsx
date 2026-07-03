import type { ReactNode } from 'react';

export type PillTone =
  | 'conversation'
  | 'config'
  | 'lifecycle'
  | 'subagent'
  | 'approval'
  | 'ephemeral'
  | 'meta'
  | 'tools'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'compaction'
  | 'turn'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral';

const TONE_VAR: Record<PillTone, string> = {
  conversation: '--color-cat-conversation',
  config: '--color-cat-config',
  lifecycle: '--color-cat-lifecycle',
  subagent: '--color-cat-subagent',
  approval: '--color-cat-approval',
  ephemeral: '--color-cat-ephemeral',
  meta: '--color-cat-meta',
  tools: '--color-cat-tools',
  user: '--color-user',
  assistant: '--color-assistant',
  tool: '--color-tool',
  compaction: '--color-compaction',
  turn: '--color-turn',
  info: '--color-sev-info',
  success: '--color-sev-success',
  warning: '--color-sev-warning',
  error: '--color-sev-error',
  neutral: '--color-fg-2',
};

interface PillProps {
  tone?: PillTone;
  variant?: 'solid' | 'soft' | 'outline';
  children: ReactNode;
  title?: string;
  className?: string;
}

export function Pill({
  tone = 'neutral',
  variant = 'soft',
  children,
  title,
  className = '',
}: PillProps) {
  const color = `var(${TONE_VAR[tone]})`;
  const style =
    variant === 'solid'
      ? { backgroundColor: color, color: 'var(--color-on-accent)' }
      : variant === 'outline'
        ? { border: `1px solid ${color}`, color }
        : {
            backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
            color,
          };
  return (
    <span
      className={`pill ${className}`}
      style={style}
      title={title}
    >
      {children}
    </span>
  );
}
