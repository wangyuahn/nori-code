import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'chat'
  | 'dashboard'
  | 'swarm'
  | 'vault'
  | 'settings'
  | 'sessions'
  | 'files'
  | 'panel-left'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'refresh'
  | 'plus'
  | 'send'
  | 'stop'
  | 'pause'
  | 'play'
  | 'sparkles'
  | 'moon'
  | 'sun'
  | 'check'
  | 'alert'
  | 'archive'
  | 'trash'
  | 'list'
  | 'graph'
  | 'image'
  | 'close'
  | 'git-branch'
  | 'diff'
  | 'upload'
  | 'target'
  | 'paperclip';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const paths: Record<IconName, ReactNode> = {
    chat: <><path d="M7 8h10M7 12h6"/><path d="M5 19l-1 3 4-2h10a4 4 0 0 0 4-4V7a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v9a4 4 0 0 0 3 3Z"/></>,
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="4" rx="2"/><rect x="14" y="11" width="7" height="10" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/></>,
    swarm: <><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="17" r="2.5"/><circle cx="19" cy="17" r="2.5"/><path d="M10.8 7.2 6.3 14.8M13.2 7.2l4.5 7.6M7.5 17h9"/></>,
    vault: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 4v5M16 4v5M9 14h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.2.38.6.75 1 .9.35.13.7.18 1.1.1h.1v4h-.09a1.7 1.7 0 0 0-1.1.4c-.4.3-.75.65-1 1Z"/></>,
    sessions: <><path d="M8 6h13v12H8z"/><path d="M3 10V4a1 1 0 0 1 1-1h13M3 14v6a1 1 0 0 0 1 1h13"/></>,
    files: <><path d="M4 4h6l2 3h8v13H4z"/></>,
    'chevron-right': <path d="m9 18 6-6-6-6"/>,
    'chevron-left': <path d="m15 18-6-6 6-6"/>,
    'chevron-down': <path d="m6 9 6 6 6-6"/>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></>,
    'panel-left': <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    send: <><path d="M12 19V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/></>,
    stop: <rect x="7" y="7" width="10" height="10" rx="2"/>,
    pause: <path d="M8 5v14M16 5v14"/>,
    play: <path d="m8 5 11 7-11 7Z"/>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z"/><path d="m19 14 .7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7Z"/><path d="m5 13 .7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7Z"/></>,
    moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.7 2.4 18a2 2 0 0 0 1.75 3h15.7a2 2 0 0 0 1.75-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></>,
    archive: <><path d="M4 7h16v13H4z"/><path d="M3 3h18v4H3zM9 11h6"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></>,
    graph: <><circle cx="12" cy="5" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><circle cx="12" cy="13" r="2"/><path d="m12 7v4M10.3 14.1 6.7 17M13.7 14.1l3.6 2.9"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    'git-branch': <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 12h4a6 6 0 0 0 6-4"/></>,
    diff: <><path d="M7 3v18M17 3v18M4 7h6M14 17h6"/><path d="m17 4 3 3-3 3M17 14l3 3-3 3"/></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>,
    paperclip: <path d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8"/>,
  };

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

