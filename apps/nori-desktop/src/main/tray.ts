import { Tray, Menu, nativeImage, BrowserWindow } from 'electron';

import { NORI_PRODUCT_NAME, noriRuntimeIconPath } from './brand';

function trayImage() {
  const image = nativeImage.createFromPath(noriRuntimeIconPath());
  return process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image.resize({ width: 16, height: 16 });
}

function menuTemplate() {
  return [
    { label: NORI_PRODUCT_NAME, enabled: false },
    { type: 'separator' as const },
    { label: 'Show Nori Work', click: () => { const win = BrowserWindow.getAllWindows()[0]; win?.show(); win?.focus(); } },
    { type: 'separator' as const },
    { label: 'Quit Nori Work', role: 'quit' as const },
  ];
}

export function createTray(mainWindow: BrowserWindow): Tray {
  const tray = new Tray(trayImage());
  tray.setToolTip(NORI_PRODUCT_NAME);
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
  return tray;
}
