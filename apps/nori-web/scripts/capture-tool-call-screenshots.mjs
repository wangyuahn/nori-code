import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = '/opt/cursor/artifacts/screenshots';
const url = 'http://127.0.0.1:5173/?mock=tool-call-detail';

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.expandable-tool-call', { timeout: 15000 });
  await page.waitForTimeout(400);

  const workProcess = page.locator('.chat-work-process');
  await workProcess.screenshot({
    path: resolve(outDir, 'tool-call-edit-browser-work-process.png'),
  });

  const editTool = page.locator('.expandable-tool-call.tool-edit');
  await editTool.screenshot({
    path: resolve(outDir, 'tool-call-edit-expanded.png'),
  });

  const browserTool = page.locator('.expandable-tool-call.tool-browser');
  await browserTool.screenshot({
    path: resolve(outDir, 'tool-call-browser-expanded.png'),
  });

  await page.screenshot({
    path: resolve(outDir, 'tool-call-edit-browser-full.png'),
    fullPage: true,
  });

  await browser.close();
  console.log('Saved screenshots to', outDir);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
