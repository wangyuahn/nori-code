import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type LspStatus } from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface LspPanelProps {
  sessionId: string | null;
  path: string;
  onReveal: (path: string, line: number, character: number) => void;
  onDiagnosticCountChange?: (count: number | undefined) => void;
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface Diagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface SymbolItem {
  name: string;
  detail?: string;
  kind?: number;
  range: LspRange;
  children?: SymbolItem[];
}

export function LspPanel({ sessionId, path, onReveal, onDiagnosticCountChange }: LspPanelProps) {
  const { tr } = useI18n();
  const [status, setStatus] = useState<LspStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => setReload(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setDiagnostics([]);
    setSymbols([]);
    setError(null);
    onDiagnosticCountChange?.(undefined);
    if (!sessionId || !path) return () => controller.abort();
    setLoading(true);
    void api.sessions.lsp.status(sessionId, path, controller.signal)
      .then(async nextStatus => {
        if (controller.signal.aborted) return;
        setStatus(nextStatus);
        if (!nextStatus.available) return;
        const [diagnosticResult, symbolResult] = await Promise.all([
          api.sessions.lsp.request(sessionId, { operation: 'diagnostics', path }, controller.signal),
          nextStatus.capabilities.includes('document_symbols')
            ? api.sessions.lsp.request(sessionId, { operation: 'document_symbols', path }, controller.signal)
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        const nextDiagnostics = asDiagnostics(diagnosticResult.result);
        setDiagnostics(nextDiagnostics);
        setSymbols(symbolResult ? asSymbols(symbolResult.result) : []);
        onDiagnosticCountChange?.(nextDiagnostics.length);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onDiagnosticCountChange, path, reload, sessionId]);

  const flatSymbols = useMemo(() => flattenSymbols(symbols), [symbols]);
  if (!sessionId || !path) return <div className="inspector-empty"><Icon name="target" size={24}/><span>{tr('Select a code file to inspect language intelligence.', '选择代码文件以查看语言智能。')}</span></div>;

  return <section className="lsp-panel">
    <header className="lsp-summary">
      <div><span className={`lsp-server-dot${status?.running ? ' running' : ''}`}/><div><strong>{status?.server_id ?? tr('Language server', '语言服务器')}</strong><span>{status ? `${status.language_id} · ${status.running ? tr('Running', '运行中') : tr('Unavailable', '不可用')}` : tr('Connecting…', '正在连接…')}</span></div></div>
      <button type="button" className="change-recalculate" onClick={refresh} disabled={loading} title={tr('Refresh LSP', '刷新 LSP')} aria-label={tr('Refresh LSP', '刷新 LSP')}>{loading ? <span className="spinner spinner-small"/> : <Icon name="refresh" size={13}/>}</button>
    </header>
    {(error || status?.reason) && <div className="lsp-notice"><Icon name="alert" size={13}/><span>{error ?? status?.reason}</span></div>}
    {status?.available && <div className="lsp-results">
      <section className="lsp-result-group">
        <header><strong>{tr('Problems', '问题')}</strong><span>{diagnostics.length}</span></header>
        {diagnostics.length === 0 ? <p className="lsp-empty-result">{tr('No diagnostics', '没有诊断问题')}</p> : diagnostics.map((diagnostic, index) => <button type="button" className={`lsp-diagnostic severity-${diagnostic.severity ?? 3}`} key={`${diagnostic.range.start.line}-${diagnostic.range.start.character}-${index}`} onClick={() => onReveal(path, diagnostic.range.start.line, diagnostic.range.start.character)}>
          <span className="lsp-diagnostic-icon">{diagnostic.severity === 1 ? '×' : diagnostic.severity === 2 ? '!' : 'i'}</span>
          <span><strong>{diagnostic.message}</strong><small>{diagnostic.source ?? 'LSP'}{diagnostic.code !== undefined ? ` ${diagnostic.code}` : ''} · {diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}</small></span>
        </button>)}
      </section>
      <section className="lsp-result-group">
        <header><strong>{tr('Symbols', '符号')}</strong><span>{flatSymbols.length}</span></header>
        {flatSymbols.length === 0 ? <p className="lsp-empty-result">{tr('No document symbols', '没有文档符号')}</p> : flatSymbols.map(({ symbol, depth }, index) => <button type="button" className="lsp-symbol" style={{ paddingLeft: `${10 + depth * 12}px` }} key={`${symbol.name}-${symbol.range.start.line}-${index}`} onClick={() => onReveal(path, symbol.range.start.line, symbol.range.start.character)}>
          <span>{symbolKind(symbol.kind)}</span><strong>{symbol.name}</strong>{symbol.detail && <small>{symbol.detail}</small>}<i>{symbol.range.start.line + 1}</i>
        </button>)}
      </section>
    </div>}
  </section>;
}

function asDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Diagnostic => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Partial<Diagnostic>;
    return typeof candidate.message === 'string' && validRange(candidate.range);
  });
}

function asSymbols(value: unknown): SymbolItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => normalizeSymbol(item));
}

function normalizeSymbol(value: unknown): SymbolItem[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate['name'] === 'string' ? candidate['name'] : undefined;
  const range = validRange(candidate['selectionRange']) ? candidate['selectionRange']
    : validRange(candidate['range']) ? candidate['range']
      : locationRange(candidate['location']);
  if (!name || !range) return [];
  const children = Array.isArray(candidate['children']) ? candidate['children'].flatMap(child => normalizeSymbol(child)) : undefined;
  return [{ name, range, kind: typeof candidate['kind'] === 'number' ? candidate['kind'] : undefined, detail: typeof candidate['detail'] === 'string' ? candidate['detail'] : undefined, children }];
}

function locationRange(value: unknown): LspRange | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const range = (value as Record<string, unknown>)['range'];
  return validRange(range) ? range : undefined;
}

function validRange(value: unknown): value is LspRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as Partial<LspRange>;
  return validPosition(range.start) && validPosition(range.end);
}

function validPosition(value: unknown): value is LspRange['start'] {
  if (!value || typeof value !== 'object') return false;
  const position = value as Record<string, unknown>;
  return typeof position['line'] === 'number' && typeof position['character'] === 'number';
}

function flattenSymbols(symbols: SymbolItem[], depth = 0): Array<{ symbol: SymbolItem; depth: number }> {
  return symbols.flatMap(symbol => [{ symbol, depth }, ...flattenSymbols(symbol.children ?? [], depth + 1)]);
}

function symbolKind(kind?: number): string {
  if ([5, 23].includes(kind ?? 0)) return 'C';
  if ([6, 12].includes(kind ?? 0)) return 'ƒ';
  if ([7, 8, 13, 14].includes(kind ?? 0)) return 'V';
  if ([10, 11].includes(kind ?? 0)) return 'E';
  return 'S';
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
