import { useEffect, useRef, useState } from 'react';
import { api, type SessionAgent, type TeamChatMessage } from '../api/client';
import { apiMessageToChat, foldConversationTurns, type ChatMessage } from '../hooks/useChatMessages';
import { useI18n } from '../i18n';
import { sessionAgentDisplayName } from '../utils/session-agent';

/**
 * 开会 / 交流 的显示面板。原先是 chat 右侧那条固定 rail，现在作为两个工具活在
 * 工具面板里：打开哪个工具就显示哪个，不再和 chat 抢版面。
 * 人类只读——这是成员之间的通道。自己这方的气泡用主题色区分。
 */

function messageTimeOf(message: ChatMessage): number {
  const parsed = Date.parse(message.createdAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 新消息进来时把滚动条钉在底部（除非用户自己往上翻了）。 */
function useStickToBottom(dependency: unknown): (node: HTMLDivElement | null) => void {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [dependency]);
  return (node: HTMLDivElement | null) => { nodeRef.current = node; };
}

/** 交流：兄弟成员群聊。 */
export function DepartmentChatPanel({ messages, selfAgentId, sessionAgents }: {
  messages: readonly TeamChatMessage[];
  selfAgentId: string;
  sessionAgents: readonly SessionAgent[];
}) {
  const { tr } = useI18n();
  const attachScroller = useStickToBottom(messages.length);
  if (messages.length === 0) {
    return <div className="department-panel"><div className="department-rail-empty">{tr('No messages yet — members align here while working.', '还没有消息——成员工作时在这里交流。')}</div></div>;
  }
  return (
    <div className="department-panel">
      <div className="department-rail-body" ref={attachScroller}>
        {messages.map(message => {
          const own = message.agent_id === selfAgentId;
          const agent = sessionAgents.find(candidate => candidate.agent_id === message.agent_id);
          const name = agent?.name?.trim() || message.name || message.agent_id;
          const mentions = message.mentions.filter(mention => mention !== 'all').map(mention =>
            sessionAgents.find(candidate => candidate.agent_id === mention)?.name?.trim() || mention);
          return (
            <div key={message.message_id} className={'department-rail-row' + (own ? ' own' : '')}>
              {!own && <div className="department-chat-avatar" aria-hidden="true"><span>{name.slice(0, 1)}</span></div>}
              <div className="department-chat-bubble">
                <div className="department-chat-meta">
                  {!own && <strong>{name}</strong>}
                  {message.mentions.includes('all') && <em>@{tr('all', '全体')}</em>}
                  {mentions.map(mention => <em key={mention}>@{mention}</em>)}
                  <time>{new Date(message.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <div className="department-chat-text">{message.message}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 开会的头部：议题、主持人、参会成员。开会不是人类开的——父节点自己召集，
 * 这里只把它召集了谁、在聊什么摊开给人看。
 */
function MeetingHeader({ topic, leadName, participants }: {
  topic: string | null;
  leadName: string | null;
  participants: readonly string[];
}) {
  const { tr } = useI18n();
  if (topic === null && leadName === null && participants.length === 0) return null;
  return <div className="meeting-header">
    <div className="meeting-header-topic">
      <span className="meeting-header-label">{tr('Topic', '议题')}</span>
      <strong>{topic ?? tr('Untitled round', '未命名的一轮')}</strong>
    </div>
    <div className="meeting-header-people">
      {leadName !== null && <span className="meeting-header-chip lead">{tr('Chair', '主持')}: {leadName}</span>}
      {participants.map(name => <span key={name} className="meeting-header-chip">{name}</span>)}
    </div>
  </div>;
}

/** 开会：Discuss 轮次的发言流。 */
export function DepartmentMeetingPanel({ sessionId, discussionAgentId, selfAgentId, sessionAgents, turnAgentId, revision }: {
  sessionId: string | null;
  discussionAgentId: string | null;
  selfAgentId: string;
  sessionAgents: readonly SessionAgent[];
  turnAgentId: string | null;
  revision: string | number;
}) {
  const { tr } = useI18n();
  const [rows, setRows] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const attachScroller = useStickToBottom(`${rows.length}:${turnAgentId ?? ''}`);
  useEffect(() => {
    if (!sessionId || discussionAgentId === null) {
      setRows([]);
      setError(null);
      return;
    }
    let disposed = false;
    const load = async () => {
      try {
        const data = await api.sessions.getMessages(sessionId, { agent_id: discussionAgentId, page_size: 100 });
        if (disposed) return;
        const mapped = (data.items ?? [])
          .map(apiMessageToChat)
          .filter((item): item is ChatMessage => item !== null)
          .sort((a, b) => messageTimeOf(a) - messageTimeOf(b));
        setRows(foldConversationTurns(mapped));
        setError(null);
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    return () => { disposed = true; };
    // 依赖里刻意只放会话、轮次节点 id 与 revision：revision 由 discussion.updated
    // 与树变更推进，所以有新发言就会重拉，而 4 秒一次的 agent 轮询不会。
  }, [sessionId, discussionAgentId, revision]);
  const turnAgent = sessionAgents.find(candidate => candidate.agent_id === turnAgentId);
  const turnAgentName = turnAgentId === null
    ? null
    : turnAgent === undefined ? turnAgentId : sessionAgentDisplayName(turnAgent);
  const nameOf = (agentId: string): string => {
    const agent = sessionAgents.find(candidate => candidate.agent_id === agentId);
    return agent === undefined ? agentId : sessionAgentDisplayName(agent);
  };
  // 轮次节点自己带着议题（summary）、主持人（父级）和参会名单。
  const round = sessionAgents.find(candidate => candidate.agent_id === discussionAgentId);
  const header = <MeetingHeader
    topic={round?.summary?.trim() || null}
    leadName={round?.parent_agent_id === undefined ? null : nameOf(round.parent_agent_id)}
    participants={(round?.discussion_participant_agent_ids ?? []).map(nameOf)}
  />;
  const empty = (note: string) => (
    <div className="department-panel">
      {header}
      <div className="department-rail-empty">{note}</div>
    </div>
  );
  if (discussionAgentId === null) {
    return empty(tr('No discussion yet. The lead convenes one when it needs its members to align.', '还没有讨论。父级需要成员对齐时会自己召集一轮。'));
  }
  if (error !== null) {
    return empty(error);
  }
  if (rows.length === 0 && turnAgentName === null) {
    return empty(tr('No statements in this round yet.', '这一轮还没有发言。'));
  }
  return (
    <div className="department-panel">
      {header}
      <div className="department-rail-body" ref={attachScroller}>
        {rows.map(row => {
          const own = row.speaker?.id === selfAgentId;
          const name = row.speaker?.name
            ?? sessionAgents.find(candidate => candidate.agent_id === row.speaker?.id)?.name?.trim()
            ?? tr('Lead', '主持');
          return (
            <div key={row.id} className={'department-rail-row' + (own ? ' own' : '')}>
              {!own && <div className="department-chat-avatar" aria-hidden="true"><span>{name.slice(0, 1)}</span></div>}
              <div className="department-chat-bubble">
                <div className="department-chat-meta">
                  {!own && <strong>{name}</strong>}
                  {row.createdAt && <time>{new Date(row.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
                </div>
                <div className="department-chat-text">{row.text}</div>
              </div>
            </div>
          );
        })}
        {turnAgentName !== null && <div className="department-rail-turn" aria-live="polite">
          {tr(`${turnAgentName} is speaking…`, `${turnAgentName} 正在发言…`)}
        </div>}
      </div>
    </div>
  );
}
