export type ThemeMode = 'dark' | 'light';

const THEME_KEY = 'nori-theme-color';
const THEME_MODE_KEY = 'nori-theme';
const UI_SCALE_KEY = 'nori-ui-scale';
export const DEFAULT_ACCENT = '#9BE8B0';
const LEGACY_ACCENTS = new Set(['#00bcd4', '#6dd6c7']);

export type UiScale = 'compact' | 'default' | 'large';

export function isHexColor(color: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(color);
}

export function loadThemeColor(): string {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved && !LEGACY_ACCENTS.has(saved.toLowerCase()) ? saved : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function loadThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_MODE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  } catch {
    // Use dark mode when browser storage and media queries are unavailable.
  }
  return 'dark';
}

export function loadUiScale(): UiScale {
  try {
    const saved = localStorage.getItem(UI_SCALE_KEY);
    if (saved === 'compact' || saved === 'default' || saved === 'large') return saved;
  } catch {
    // Use the default scale when browser storage is unavailable.
  }
  return 'default';
}

export function applyUiScale(scale: UiScale, persist = true): void {
  if (persist) {
    try { localStorage.setItem(UI_SCALE_KEY, scale); } catch { /* no-op */ }
  }
  document.documentElement.dataset.uiScale = scale;
}

export function applyThemeColor(color: string, persist = true): void {
  if (!isHexColor(color)) return;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, color); } catch { /* no-op */ }
  }
  document.documentElement.style.setProperty('--nori-cyan', color);
  document.documentElement.style.setProperty('--nori-border-active', color);
  document.documentElement.style.setProperty(
    '--nori-cyan-dim',
    color + (document.documentElement.dataset.theme === 'light' ? '19' : '26'),
  );
}

export function applyThemeMode(mode: ThemeMode, persist = true): void {
  if (persist) {
    try { localStorage.setItem(THEME_MODE_KEY, mode); } catch { /* no-op */ }
  }
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  applyThemeColor(loadThemeColor(), false);
}

export function initializeTheme(): void {
  applyThemeMode(loadThemeMode(), false);
  applyThemeColor(loadThemeColor(), false);
  applyUiScale(loadUiScale(), false);
}
