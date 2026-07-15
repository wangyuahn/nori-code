import { useEffect, useRef, useCallback } from 'react';

export function useTerminal(terminalId: string) {
  const termRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const initialize = useCallback(async (container: HTMLDivElement) => {
    if (typeof window === 'undefined') return;
    
    containerRef.current = container;
    
    // Dynamically import xterm
    const { Terminal } = await import('xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    
    const term = new Terminal({
      theme: { background: '#0b0b0c', foreground: '#e7e7ea', cursor: '#7c8cff' },
      cursorBlink: true,
      fontSize: 13,
    });
    
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    
    const { cols, rows } = term;
    
    // Create terminal session in main process
    const desktop = window.noriDesktop;
    if (desktop?.terminalCreate) {
      await desktop.terminalCreate({ id: terminalId, cols, rows });
    }
    
    // Send input from term to main
    term.onData((data: string) => {
      window.noriDesktop?.terminalWrite?.({ id: terminalId, data });
    });
    
    // Listen for output from main
    const cleanup = window.noriDesktop?.onTerminalOutput?.(({ id, data }) => {
      if (id === terminalId) term.write(data);
    });
    
    termRef.current = term;
    
    return () => {
      cleanup?.();
      window.noriDesktop?.terminalDestroy?.({ id: terminalId });
      term.dispose();
    };
  }, [terminalId]);
  
  return { initialize, containerRef };
}
