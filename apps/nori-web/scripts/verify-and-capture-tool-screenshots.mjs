import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  await page.waitForSelector('.expandable-tool-call.tool-edit', { timeout: 15000 });
  await page.waitForTimeout(500);

  const editText = await page.locator('.expandable-tool-call.tool-edit').innerText();
  const hasPlaceholder = editText.includes('[original line');
  const hasRealDiff = editText.includes('-const summary') || editText.includes('+const failed');

  await writeFile(
    resolve(outDir, 'tool-call-edit-text-snapshot.txt'),
    editText,
    'utf8',
  );

  const editTool = page.locator('.expandable-tool-call.tool-edit');
  await editTool.screenshot({
    path: resolve(outDir, 'tool-call-edit-fixed-v2.png'),
  });

  const browserTool = page.locator('.expandable-tool-call.tool-browser');
  await browserTool.screenshot({
    path: resolve(outDir, 'tool-call-browser-fixed-v2.png'),
  });

  await page.locator('.chat-work-process').screenshot({
    path: resolve(outDir, 'tool-call-work-process-fixed-v2.png'),
  });

  await browser.close();

  console.log(JSON.stringify({
    hasPlaceholder,
    hasRealDiff,
    preview: editText.slice(0, 500),
  }, null, 2));

  if (hasPlaceholder) {
    console.error('ERROR: placeholder text still visible in Edit tool panel');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
