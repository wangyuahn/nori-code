import { BrowserWindow } from 'electron';

import { NORI_PRODUCT_NAME, noriRuntimeIconPath } from './brand';

export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 400,
    height: 300,
    transparent: false,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    backgroundColor: '#111111',
    icon: noriRuntimeIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void splash.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html><html><head><style>
        html,body{height:100%;margin:0;background:#111;color:#f3f3f3;display:flex;align-items:center;justify-content:center;flex-direction:column;font:14px/1.5 Inter,system-ui,sans-serif;user-select:none}
        .mark{width:72px;height:72px;border-radius:20px;background:#1d1d1d;border:1px solid #353535;display:grid;place-items:center;font-size:42px;font-weight:760;letter-spacing:-4px;color:#f5f5f5;box-shadow:0 18px 50px #0008;position:relative}
        .mark:after{content:'';position:absolute;width:8px;height:8px;border-radius:99px;background:#9be8b0;right:10px;top:10px}
        .name{margin-top:18px;font-size:15px;font-weight:600}.sub{margin-top:4px;color:#888;font-size:12px}
        .spinner{margin-top:24px;width:20px;height:20px;border-radius:50%;border:2px solid #303030;border-top-color:#aaa;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
      </style></head><body><div class="mark">N</div><div class="name">${NORI_PRODUCT_NAME}</div><div class="sub">Starting your workspace</div><div class="spinner"></div></body></html>
    `)}`,
  );
  return splash;
}
