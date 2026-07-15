import { BrowserWindow, Notification } from 'electron';

/**
 * Show a native OS notification. Falls back gracefully if not supported.
 */
export function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title,
    body,
    icon: undefined, // Uses app icon
  });

  notification.on('click', () => {
    // Focus the main window on click
    const wins = BrowserWindow.getAllWindows();
    const mainWin = wins[0];
    if (mainWin) {
      mainWin.show();
      mainWin.focus();
    }
  });

  notification.show();
}
