/**
 * 标题栏团队胶囊：成员头像叠层 + 人数，点开看当前对话的团队。
 * 数据由 App 已有的轮询提供，这里不再自己拉取，切会话时随之更新。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { Session, SessionAgent } from '../api/client';
import { useI18n } from '../i18n';
import { parentSessionIdOf } from '../utils/session-mount';
import { sessionAgentDisplayName } from '../utils/session-agent';
import { Icon } from './Icon';

const MAX_AVATARS = 3;

export function SessionTeamBar({
  session,
  members,
  activeAgentId,
  onSelectAgent,
  onOpenTeam,
}: {
  session: Session | null;
  members: readonly SessionAgent[];
  activeAgentId: string;
  onSelectAgent: (agent: SessionAgent | null) => void;
  onOpenTeam: () => void;
}) {
  const { tr } = useI18n();
  const [open, setOpenState] = useState(false);
  const triggerRef = useRef<HTMLDetailsElement>(null);
  const team = members.filter(member => member.kind !== 'discussion' && member.archived !== true);
  const working = team.filter(member => member.status === 'running').length;
  // <details> 完全受控，所以状态之外还要同步 DOM 的 open 属性。
  const setOpen = (next: boolean) => {
    if (triggerRef.current !== null) triggerRef.current.open = next;
    setOpenState(next);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      // 菜单用 portal 挂到 body，因此它和触发器都算「里面」。
      const target = event.target as HTMLElement | null;
      if (target?.closest('.session-team-bar, .session-team-menu') === null) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // 切对话后旧会话的下拉不该继续浮在新会话上。
  useEffect(() => { setOpen(false); }, [session?.id]);

  const triggerLabel = tr('Team', '团队');
  const membersLabel = team.length === 0
    ? tr('No members yet', '还没有成员')
    : tr(`${team.length} members`, `${team.length} 位成员`);

  return (
    <details
      ref={triggerRef}
      className={`session-agent-tree session-team-bar${open ? ' open' : ''}`}
      open={open}
    >
      <summary
        title={tr('Show this conversation\'s team', '查看当前对话的团队')}
        onClick={event => {
          // 完全受控：summary 的原生切换和我们的状态会打架，所以接管点击。
          event.preventDefault();
          setOpen(!open);
        }}
      >
        <span className="session-team-avatars" aria-hidden="true">
          {team.slice(0, MAX_AVATARS).map(member => (
            <span className="session-team-avatar" key={member.agent_id}>
              {sessionAgentDisplayName(member).slice(0, 1).toUpperCase()}
            </span>
          ))}
          {team.length === 0 && <Icon name="graph" size={14} />}
        </span>
        <span className="session-agent-tree-trigger-label">{triggerLabel}</span>
        <span className="session-agent-tree-trigger-context">{team.length}</span>
        {working > 0 && <i aria-label={tr('Members working', '有成员正在工作')} />}
        <Icon name="chevron-down" size={13} />
      </summary>
      {open && createPortal(
        <div
          className="session-agent-tree-menu session-team-menu"
          role="menu"
          aria-label={triggerLabel}
          style={{
            top: (triggerRef.current?.getBoundingClientRect().bottom ?? 56) + 6,
            right: Math.max(12, window.innerWidth - (triggerRef.current?.getBoundingClientRect().right ?? window.innerWidth)),
          }}
        >
          <div className="session-agent-tree-menu-header">
            <div className="session-agent-tree-menu-title">
              <span className="session-agent-tree-menu-icon"><Icon name="graph" size={15} /></span>
              <span>
                <strong>{session?.title || tr('No session', '无会话')}</strong>
                <small>{membersLabel}</small>
              </span>
            </div>
            <button type="button" className="session-team-open" onClick={() => { setOpen(false); onOpenTeam(); }}>
              {tr('Open team', '打开团队')}
            </button>
          </div>
          {team.length === 0
            ? <p className="session-team-empty">{tr('Hire a member from the chat to build this conversation\'s team.', '在对话里招募成员，组成这个对话的团队。')}</p>
            : (
              <ul className="session-team-list">
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    className={`session-team-member${activeAgentId === 'main' ? ' current' : ''}`}
                    onClick={() => { setOpen(false); onSelectAgent(null); }}
                  >
                    <span className="session-team-avatar main">{(session?.title || 'M').slice(0, 1).toUpperCase()}</span>
                    <span className="session-team-member-copy">
                      <strong>{tr('Main conversation', '主对话')}</strong>
                      <small>{tr('You are talking to the lead agent', '你正在和主智能体对话')}</small>
                    </span>
                  </button>
                </li>
                {team.map(member => (
                  <li key={member.agent_id}>
                    <button
                      type="button"
                      role="menuitem"
                      className={`session-team-member${activeAgentId === member.agent_id ? ' current' : ''}`}
                      onClick={() => { setOpen(false); onSelectAgent(member); }}
                    >
                      <span className="session-team-avatar">{sessionAgentDisplayName(member).slice(0, 1).toUpperCase()}</span>
                      <span className="session-team-member-copy">
                        <strong>{sessionAgentDisplayName(member)}</strong>
                        <small>{member.role || member.mandate || member.status}</small>
                      </span>
                      <span className={`status-dot${member.status === 'running' ? ' active' : ' idle'}`} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>,
        document.body,
      )}
    </details>
  );
}

/** 顶栏胶囊只关心「当前对话这一支」，成员可能挂在父会话下（自己是成员时）。 */
export function teamBarRootId(session: Session | null): string | null {
  if (session === null) return null;
  return parentSessionIdOf(session) ?? session.id;
}
