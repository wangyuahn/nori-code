export const PROJECT_FILE_REFERENCE_EVENT = 'nori:reference-project-file';

export function referenceProjectFile(path: string): void {
  const normalized = path.replaceAll('\\', '/').trim();
  if (!normalized) return;
  window.dispatchEvent(new CustomEvent(PROJECT_FILE_REFERENCE_EVENT, { detail: { path: normalized } }));
}

export function projectFileMention(path: string): string {
  const normalized = path.replaceAll('\\', '/').trim();
  return /\s/.test(normalized) ? `@"${normalized.replaceAll('"', '\\"')}"` : `@${normalized}`;
}
