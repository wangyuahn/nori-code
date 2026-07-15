import { useEffect, useRef } from 'react';
import { useTerminal } from '../hooks/useTerminal';

interface TerminalPanelProps {
  terminalId?: string;
}

export function TerminalPanel({ terminalId = 'default' }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { initialize } = useTerminal(terminalId);

  useEffect(() => {
    if (!containerRef.current) return;
    
    let cleanup: (() => void) | undefined;
    
    initialize(containerRef.current).then((fn) => {
      cleanup = fn;
    });
    
    return () => {
      cleanup?.();
    };
  }, [initialize]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#0b0b0c',
        overflow: 'hidden',
      }}
    />
  );
}
