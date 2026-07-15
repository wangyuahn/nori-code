import { autoUpdater, type UpdateCheckResult } from 'electron-updater';
import { showNotification } from './notifications';

autoUpdater.logger = console;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

export function registerUpdateHandlers(): void {
  autoUpdater.on('checking-for-update', () => {
    process.stdout.write('[nori-work-updater] checking for updates…\n');
  });
  autoUpdater.on('update-available', (info) => {
    process.stdout.write(`[nori-work-updater] update available: ${info.version} (${info.releaseName ?? 'n/a'})\n`);
    showNotification('Update Available', `Nori Work ${info.version} is ready to download.`);
  });
  autoUpdater.on('update-not-available', () => {
    process.stdout.write('[nori-work-updater] no update available.\n');
  });
  autoUpdater.on('download-progress', (progress) => {
    process.stdout.write(`[nori-work-updater] download progress: ${progress.percent.toFixed(1)}%\r`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    process.stdout.write(`[nori-work-updater] update downloaded: ${info.version}. It will be installed on quit.\n`);
    showNotification('Update Ready', `Nori Work ${info.version} has been downloaded.`);
  });
  autoUpdater.on('error', (error) => {
    process.stderr.write(`[nori-work-updater] error: ${error.message}\n`);
  });
}

export async function checkForUpdates(): Promise<UpdateCheckResult | null> {
  process.stdout.write('[nori-work-updater] manual check triggered.\n');
  try {
    return await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[nori-work-updater] check failed: ${message}\n`);
    showNotification('Update Check Failed', message);
    return null;
  }
}
