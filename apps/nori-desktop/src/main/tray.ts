import { Tray, Menu, nativeImage, BrowserWindow, type NativeImage } from 'electron';

let tray: Tray | null = null;

export interface TrayState {
  phase: string;
  swarmActive: boolean;
}

/**
 * Create a system tray icon with a context menu showing Nori status.
 */
export function createTray(mainWindow: BrowserWindow): Tray {
  // Use a simple 16x16 icon built from raw pixels (cyan N)
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Nori Code Desktop');

  const updateMenu = (state?: TrayState) => {
    const phase = state?.phase ?? 'idle';
    const swarmLabel = state?.swarmActive ? ' (Swarm active)' : '';

    const contextMenu = Menu.buildFromTemplate([
      { label: `Nori Code Desktop${swarmLabel}`, enabled: false },
      { label: `Phase: ${phase}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Show Window',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          const { app } = require('electron');
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(contextMenu);
  };

  updateMenu();

  tray.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  return tray;
}

export function updateTray(state: TrayState): void {
  if (!tray) return;
  const phase = state.phase;
  const swarmLabel = state.swarmActive ? ' (Swarm active)' : '';

  const contextMenu = Menu.buildFromTemplate([
    { label: `Nori Code Desktop${swarmLabel}`, enabled: false },
    { label: `Phase: ${phase}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => {
        const wins = BrowserWindow.getAllWindows();
        const firstWin = wins[0];
        if (firstWin) {
          firstWin.show();
          firstWin.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        const { app } = require('electron');
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTrayIcon(): NativeImage {
  // 16x16 cyan "N" icon as raw RGBA pixels
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const cyan = { r: 0x00, g: 0xBC, b: 0xD4, a: 0xFF };
  const dark = { r: 0x0B, g: 0x0B, b: 0x0C, a: 0xFF };

  // Simple N letter pattern
  const nPattern = [
    '##  ##  ##  ##',
    '### ##  ##  ##',
    '#### #  ##  ##',
    '## ##   ##  ##',
    '##  ##  ##  ##',
    '##  ### ##  ##',
    '##  #### #  ##',
    '##  ## ##  ###',
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      // Center the 8-pixel-high N in the 16-pixel icon
      const patternY = y - 4;
      const inPattern = patternY >= 0 && patternY < nPattern.length;
      const row = inPattern ? nPattern[patternY] : undefined;
      const patternX = row !== undefined && x < row.length ? row[x] : ' ';
      const isLetter = patternX === '#';
      const color = isLetter ? cyan : dark;
      buffer[offset] = color.r;
      buffer[offset + 1] = color.g;
      buffer[offset + 2] = color.b;
      buffer[offset + 3] = color.a;
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}
