export interface FocusableWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  focus(): void;
}

/** Restore focus only when an automated browser action took it from another surface. */
export function restoreBrowserAutomationFocus(
  previous: FocusableWebContents | null,
  current: FocusableWebContents | null,
  browserPage: FocusableWebContents,
): void {
  if (previous === null || previous.id === browserPage.id || previous.isDestroyed()) return;
  if (current?.id !== browserPage.id) return;
  previous.focus();
}
