import { useSearchParams } from 'react-router-dom';

export interface TabSpec {
  id: string;
  label: string;
  count?: number | null;
}

interface TabBarProps {
  tabs: TabSpec[];
  defaultTab: string;
}

export function TabBar({ tabs, defaultTab }: TabBarProps) {
  const [search, setSearch] = useSearchParams();
  const active = search.get('tab') ?? defaultTab;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface-1">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => {
              const next = new URLSearchParams(search);
              next.set('tab', t.id);
              setSearch(next, { replace: true });
            }}
            className={[
              'relative flex items-center gap-2 px-4 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors',
              on
                ? 'text-fg-0'
                : 'text-fg-2 hover:text-fg-1',
            ].join(' ')}
          >
            {t.label}
            {t.count !== null && t.count !== undefined ? (
              <span className="font-mono text-[10px] text-fg-3 tabular">
                {t.count}
              </span>
            ) : null}
            {on ? (
              <span className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-[var(--color-cat-conversation)]" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function useActiveTab(defaultTab: string): string {
  const [search] = useSearchParams();
  return search.get('tab') ?? defaultTab;
}
