const REWIND_LIMIT_KEY = 'nori-rewind-limit';
export const MAX_REWIND_LIMIT = 10;

export function loadRewindLimit(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(REWIND_LIMIT_KEY) ?? '', 10);
    return clampRewindLimit(value);
  } catch {
    return MAX_REWIND_LIMIT;
  }
}

export function saveRewindLimit(value: number): number {
  const normalized = clampRewindLimit(value);
  try {
    localStorage.setItem(REWIND_LIMIT_KEY, String(normalized));
  } catch {
    // Keep the in-memory value when local storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent('nori:rewind-limit-changed', { detail: normalized }));
  return normalized;
}

function clampRewindLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_REWIND_LIMIT;
  return Math.min(MAX_REWIND_LIMIT, Math.max(1, Math.round(value)));
}
