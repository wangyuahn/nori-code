import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { api, getWebSocketProtocols, type TerminalSession } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface TerminalPanelProps {
  sessionId: string | null;
}

export function TerminalPanel({ sessionId }: TerminalPanelProps) {
  const { tr } = useI18n();
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const createTerminal = useCallback(async () => {
    if (!sessionId || creatingRef.current) return;
    creatingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const terminal = await api.sessions.terminals.create(sessionId, { cols: 100, rows: 28 });
      setTerminals(previous => [...previous.filter(item => item.id !== terminal.id), terminal]);
      setActiveId(terminal.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      creatingRef.current = false;
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setTerminals([]);
    setActiveId(null);
    setError(null);
    if (!sessionId) return;
    setLoading(true);
    void api.sessions.terminals.list(sessionId)
      .then(result => {
        if (cancelled) return;
        setTerminals(result.items);
        const preferred = result.items.find(item => item.status === 'running') ?? result.items[0];
        if (preferred) setActiveId(preferred.id);
        else void createTerminal();
      })
      .catch(cause => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [createTerminal, sessionId]);

  const closeTerminal = useCallback(async (terminalId: string) => {
    if (!sessionId) return;
    try {
      await api.sessions.terminals.close(sessionId, terminalId);
      setTerminals(previous => previous.map(item => item.id === terminalId
        ? { ...item, status: 'exited', exited_at: new Date().toISOString() }
        : item));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [sessionId]);

  const updateTerminal = useCallback((terminalId: string, patch: Partial<TerminalSession>) => {
    setTerminals(previous => previous.map(item => item.id === terminalId ? { ...item, ...patch } : item));
  }, []);

  const active = terminals.find(item => item.id === activeId) ?? null;
  if (!sessionId) return <div className="inspector-empty"><Icon name="terminal" size={24}/><span>{tr('Open a project conversation to use the terminal.', '打开项目会话后即可使用终端。')}</span></div>;

  return <section className="terminal-panel">
    <header className="terminal-tabs">
      <div className="terminal-tab-list">
        {terminals.map((terminal, index) => <button
          type="button"
          key={terminal.id}
          className={`terminal-tab${terminal.id === activeId ? ' active' : ''}`}
          onClick={() => setActiveId(terminal.id)}
          title={`${terminal.shell} - ${terminal.cwd}`}
        ><span className={`terminal-status ${terminal.status}`}/><span>{terminalLabel(terminal, index)}</span>{terminal.status === 'running' && <i onClick={event => { event.stopPropagation(); void closeTerminal(terminal.id); }} role="button" aria-label={tr('Close terminal', '关闭终端')}><Icon name="close" size={11}/></i>}</button>)}
      </div>
      <button type="button" className="terminal-new" onClick={() => void createTerminal()} disabled={loading} title={tr('New terminal', '新建终端')} aria-label={tr('New terminal', '新建终端')}>
        {loading ? <span className="spinner spinner-small"/> : <Icon name="plus" size={14}/>} 
      </button>
    </header>
    {error && <div className="terminal-error" role="status"><Icon name="alert" size={13}/><span>{error}</span></div>}
    {active ? <TerminalSurface key={active.id} sessionId={sessionId} terminal={active} onExit={updateTerminal}/>
      : <div className="inspector-empty"><span className="spinner"/><span>{tr('Starting terminal…', '正在启动终端…')}</span></div>}
  </section>;
}

function TerminalSurface({ sessionId, terminal, onExit }: { sessionId: string; terminal: TerminalSession; onExit: (terminalId: string, patch: Partial<TerminalSession>) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let attached = false;
    let attachRequestId: string | null = null;
    let autoFocusPending = terminal.status !== 'exited';
    let exited = terminal.status === 'exited';
    let lastSentSize = '';
    let lastSeq = 0;
    let controlSequence = 0;
    const focusOwnerAtOpen = document.activeElement;
    const xterm = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'var(--nori-font-mono)',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(host);

    const nextControlId = (kind: string) => `terminal-${kind}-${++controlSequence}`;
    const send = (type: string, payload: Record<string, unknown>): string | null => {
      if (socket?.readyState !== WebSocket.OPEN) return null;
      const id = nextControlId(type);
      socket.send(JSON.stringify({ type, id, payload }));
      return id;
    };
    const fit = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitAddon.fit();
        if (attached && xterm.cols > 0 && xterm.rows > 0) {
          const size = `${xterm.cols}x${xterm.rows}`;
          if (size === lastSentSize) return;
          lastSentSize = size;
          send('terminal_resize', { session_id: sessionId, terminal_id: terminal.id, cols: xterm.cols, rows: xterm.rows });
        }
      } catch {
        // xterm can be between layout passes while a split pane is being dragged.
      }
    };
    const connect = async () => {
      try {
        const [url, protocols] = await Promise.all([api.getWsUrl(), getWebSocketProtocols()]);
        if (disposed) return;
        const ws = new WebSocket(url, protocols);
        socket = ws;
        ws.onopen = () => {
          reconnectAttempt = 0;
          attached = false;
          lastSentSize = '';
          attachRequestId = send('terminal_attach', { session_id: sessionId, terminal_id: terminal.id, since_seq: lastSeq });
        };
        ws.onmessage = event => {
          let frame: TerminalWsFrame;
          try { frame = JSON.parse(String(event.data)) as TerminalWsFrame; } catch { return; }
          if (frame.type === 'ack') {
            if (!isSuccessfulTerminalAttachAck(frame, attachRequestId)) return;
            attachRequestId = null;
            attached = true;
            fit();
            if (autoFocusPending) {
              autoFocusPending = false;
              if (shouldAutoFocusTerminal(host, focusOwnerAtOpen)) xterm.focus();
            }
            return;
          }
          if (frame.session_id !== sessionId || frame.terminal_id !== terminal.id) return;
          if (frame.type === 'terminal_output') {
            lastSeq = Math.max(lastSeq, frame.seq ?? 0);
            if (frame.payload?.data) xterm.write(frame.payload.data);
          } else if (frame.type === 'terminal_exit') {
            exited = true;
            onExit(terminal.id, { status: 'exited', exit_code: frame.payload?.exit_code ?? null, exited_at: frame.timestamp });
            xterm.write(`\r\n\x1b[90m[process exited${frame.payload?.exit_code === undefined ? '' : ` with code ${frame.payload.exit_code ?? 'unknown'}`} ]\x1b[0m\r\n`);
          }
        };
        ws.onclose = () => {
          attached = false;
          attachRequestId = null;
          if (disposed || exited) return;
          reconnectTimer = setTimeout(() => void connect(), Math.min(500 * 2 ** reconnectAttempt++, 5000));
        };
      } catch {
        if (!disposed) reconnectTimer = setTimeout(() => void connect(), Math.min(500 * 2 ** reconnectAttempt++, 5000));
      }
    };

    const input = xterm.onData(data => send('terminal_input', { session_id: sessionId, terminal_id: terminal.id, data }));
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(fit));
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => { xterm.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    void connect();
    requestAnimationFrame(fit);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'terminal_detach', id: nextControlId('detach'), payload: { session_id: sessionId, terminal_id: terminal.id } }));
      }
      socket?.close();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      input.dispose();
      xterm.dispose();
    };
  }, [onExit, sessionId, terminal.id]);

  return <div className="terminal-surface" ref={hostRef}/>;
}

interface TerminalWsFrame {
  type?: string;
  id?: string;
  code?: number;
  seq?: number;
  session_id?: string;
  terminal_id?: string;
  timestamp?: string;
  payload?: { data?: string; exit_code?: number | null };
}

export function isSuccessfulTerminalAttachAck(frame: TerminalWsFrame, attachRequestId: string | null): boolean {
  return attachRequestId !== null
    && frame.type === 'ack'
    && frame.id === attachRequestId
    && frame.code === 0;
}

export function shouldAutoFocusTerminal(host: HTMLElement, focusOwnerAtOpen: Element | null): boolean {
  const active = document.activeElement;
  return active === focusOwnerAtOpen || active === document.body || (active !== null && host.contains(active));
}

function terminalTheme() {
  const light = document.documentElement.dataset['theme'] === 'light';
  return light
    ? { background: '#ffffff', foreground: '#202124', cursor: '#168f9f', selectionBackground: '#b8e8ed' }
    : { background: '#0f1115', foreground: '#d8dce5', cursor: '#55c5d3', selectionBackground: '#28464d' };
}

function terminalLabel(terminal: TerminalSession, index: number): string {
  const shell = terminal.shell.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.exe$/i, '') || 'shell';
  return `${shell} ${index + 1}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
