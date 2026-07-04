import { Notification } from 'electron';

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
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      wins[0].show();
      wins[0].focus();
    }
  });

  notification.show();
}
