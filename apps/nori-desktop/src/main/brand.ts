import { join } from 'node:path';

import { app } from 'electron';

export const NORI_PRODUCT_NAME = 'Nori Work';
export const NORI_APP_ID = 'com.nori.work';
export const NORI_PROTOCOL = 'nori-work';
export const NORI_USER_DATA_DIR = 'Nori Work';

/** Apply product identity before Chromium creates profiles/windows. */
export function configureNoriApplicationIdentity(): void {
  app.setName(NORI_PRODUCT_NAME);
  app.setPath('userData', join(app.getPath('appData'), NORI_USER_DATA_DIR));
  if (process.platform === 'win32') {
    app.setAppUserModelId(NORI_APP_ID);
  }
}

/** Runtime icon used by BrowserWindow; packaged builds stage it in resources. */
export function noriRuntimeIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');
}
