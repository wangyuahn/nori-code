import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.argv[2] ?? 9333);
const outputDir = resolve(process.argv[3] ?? 'browser-smoke-output');
const listUrl = `http://127.0.0.1:${String(port)}/json/list`;
const fixture = await startFixtureServer();

await mkdir(outputDir, { recursive: true });
const uploadPath = resolve(outputDir, 'upload.txt');
await writeFile(uploadPath, 'Nori browser upload smoke test.\n');
const localHtmlPath = resolve(outputDir, 'local-smoke.html');
await writeFile(localHtmlPath, '<!doctype html><meta charset="utf-8"><title>Local Nori HTML</title><h1>Local HTML works</h1>');
const targets = await listTargets();
const workbenchTarget = targets.find(target => target.type === 'page' && target.url.includes('nori-web/dist/index.html'));
if (!workbenchTarget) throw new Error('Nori Work renderer target was not found.');

const workbench = await connect(workbenchTarget.webSocketDebuggerUrl);
progress('connected to workbench');
await workbench.send('Page.enable');
await workbench.send('Runtime.enable');
let opened = await openBrowserTab();
if (!opened) {
  const switched = await evaluate(workbench, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find(element => /^(Code|代码)$/.test((element.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (switched) {
    await waitFor(async () => Boolean(await evaluate(workbench, `Boolean(document.querySelector('.inspector-tabs'))`)));
    opened = await openBrowserTab();
  }
}
if (!opened) throw new Error('Browser inspector tab was not found.');
await waitFor(async () => Boolean(await evaluate(workbench, `Boolean(document.querySelector('.browser-panel'))`)));
progress('browser panel opened');

async function openBrowserTab() {
  return evaluate(workbench, `(() => {
  const tab = [...document.querySelectorAll('.inspector-tabs [role="tab"]')]
    .find(element => /Browser|浏览器/.test(element.textContent || ''));
  if (!tab) return false;
  tab.click();
  return true;
})()`);
}

let initial = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
if (!initial?.activeTabId || initial.tabs.length === 0) throw new Error('Browser did not initialize its first tab.');
const retainedTabId = initial.tabs[0].id;
for (const tab of initial.tabs.slice(1)) {
  await evaluate(workbench, `window.noriDesktop.browserCloseTab(${JSON.stringify(tab.id)})`, true);
}
await evaluate(workbench, `window.noriDesktop.browserActivateTab(${JSON.stringify(retainedTabId)})`, true);
initial = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
if (initial.tabs.length !== 1) throw new Error('Browser smoke could not reset the tab set.');
const smokeActionAvailable = await evaluate(workbench, `typeof window.noriDesktop.browserExecuteActionForSmoke === 'function'`);
if (!smokeActionAvailable) throw new Error('Browser smoke action bridge is unavailable. Start Electron with NORI_BROWSER_SMOKE=1.');
const unavailableStartedAt = Date.now();
const unavailableSnapshot = await executeAction({ action: 'snapshot' });
if (unavailableSnapshot.ok || !unavailableSnapshot.output.includes('Browser navigate action')) {
  throw new Error(`Snapshot without a page did not return an actionable error: ${unavailableSnapshot.output}`);
}
if (Date.now() - unavailableStartedAt > 1_000) {
  throw new Error('Snapshot without a page did not fail immediately.');
}
progress('empty-page snapshot failed immediately');
await evaluate(workbench, `window.noriDesktop.browserNavigate(${JSON.stringify(fixture.url)})`, true);
await waitFor(async () => {
  const state = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  return active?.url === fixture.url && !active.loading && !active.error;
}, 15_000);
progress('navigation completed');

const firstSnapshot = await executeAction({ action: 'snapshot' });
assertOk(firstSnapshot, 'snapshot');
const inputRef = snapshotRef(firstSnapshot.output, 'Smoke input');
const buttonRef = snapshotRef(firstSnapshot.output, 'Increment');
let headingRef = snapshotRef(firstSnapshot.output, 'Nori Browser Smoke');
const uploadRef = snapshotRef(firstSnapshot.output, 'Smoke upload');
const fetchRef = snapshotRef(firstSnapshot.output, 'Fetch data');
const downloadRef = snapshotRef(firstSnapshot.output, 'Download file');
const dialogRef = snapshotRef(firstSnapshot.output, 'Open confirm');
const permissionRef = snapshotRef(firstSnapshot.output, 'Request notifications');
if (!inputRef || !buttonRef || !headingRef || !uploadRef || !fetchRef || !downloadRef || !dialogRef || !permissionRef) {
  throw new Error('Snapshot did not expose stable refs for every fixture control.');
}
const secondSnapshot = await executeAction({ action: 'snapshot' });
if (snapshotRef(secondSnapshot.output, 'Smoke input') !== inputRef) throw new Error('Stable element ref changed between snapshots.');
progress('stable snapshot refs verified');

assertOk(await executeAction({ action: 'type', ref: inputRef, text: 'bridge works', clear: true }), 'type');
assertOk(await executeAction({ action: 'click', ref: buttonRef }), 'click');
await waitFor(async () => {
  const changedSnapshot = await executeAction({ action: 'snapshot' });
  return changedSnapshot.output.includes('value="bridge works"') && changedSnapshot.output.includes('Clicks: 1');
});
const stale = await executeAction({ action: 'click', ref: 'n999999' });
if (stale.ok || !stale.staleRef) throw new Error('A missing ref was not reported as stale.');
progress('input, click, and stale-ref handling verified');

assertOk(await executeAction({ action: 'upload', ref: uploadRef, paths: [uploadPath] }), 'upload');
await waitFor(async () => (await executeAction({ action: 'snapshot' })).output.includes('upload.txt'));
progress('file upload verified');

assertOk(await executeAction({ action: 'click', ref: fetchRef }), 'fetch click');
await waitFor(async () => (await executeAction({ action: 'snapshot' })).output.includes('Fetch: pong'));
const network = await executeAction({ action: 'get_network', filter: '/api/ping' });
assertOk(network, 'network list');
if (!network.output.includes('/api/ping') || !network.output.includes('200')) {
  throw new Error('Network debugging did not capture the fixture fetch response.');
}
progress('network capture and filtering verified');

assertOk(await executeAction({ action: 'click', ref: dialogRef }), 'dialog click');
let latestDialogOutput = '';
let dialogId;
try {
  dialogId = await waitForValue(async () => {
    const dialogs = await executeAction({ action: 'dialog_list' });
    latestDialogOutput = dialogs.output;
    return dialogs.output.match(/\[([^\]]+)\] confirm/)?.[1];
  });
} catch (error) {
  const consoleOutput = await executeAction({ action: 'get_console' });
  const pageOutput = await executeAction({ action: 'snapshot' });
  throw new Error(`${error instanceof Error ? error.message : String(error)} Dialogs: ${latestDialogOutput}\nConsole: ${consoleOutput.output}\nPage: ${pageOutput.output}`);
}
assertOk(await executeAction({ action: 'dialog_respond', dialogId, accept: true }), 'dialog response');
await waitFor(async () => (await executeAction({ action: 'snapshot' })).output.includes('Dialog: true'));
progress('JavaScript dialog lifecycle verified');

assertOk(await executeAction({ action: 'click', ref: permissionRef }), 'permission click');
const permissionId = await waitForValue(async () => {
  const state = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
  return state.permissions.pending.find(item => item.permission === 'notifications')?.id;
});
await evaluate(workbench, `window.noriDesktop.browserResolvePermission(${JSON.stringify(permissionId)}, 'allow_once')`, true);
await waitFor(async () => {
  const state = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
  return state.permissions.pending.length === 0;
});
progress('browser permission request and response verified');

assertOk(await executeAction({ action: 'click', ref: downloadRef }), 'download click');
await waitFor(async () => {
  const state = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
  return state.downloads.some(item => item.filename === 'nori-smoke.txt' && item.state === 'completed');
}, 15_000);
const downloads = await executeAction({ action: 'download_list' });
if (!downloads.ok || !downloads.output.includes('nori-smoke.txt')) throw new Error('Completed download was not listed.');
progress('download lifecycle verified');

const secondPage = await executeAction({ action: 'navigate', url: `${fixture.url}second` });
assertOk(secondPage, 'second-page navigation');
const crossPageStale = await executeAction({ action: 'click', ref: buttonRef });
if (crossPageStale.ok || !crossPageStale.staleRef) {
  throw new Error('A reference from the previous document was accepted after navigation.');
}
assertOk(await executeAction({ action: 'navigate', url: fixture.url }), 'fixture return navigation');
headingRef = snapshotRef((await executeAction({ action: 'snapshot' })).output, 'Nori Browser Smoke');
if (!headingRef) throw new Error('The returned fixture did not expose a fresh heading reference.');
progress('cross-navigation reference isolation verified');

assertOk(await executeAction({ action: 'navigate', url: pathToFileURL(localHtmlPath).toString() }), 'local HTML navigation');
if (!(await executeAction({ action: 'snapshot' })).output.includes('Local HTML works')) {
  throw new Error('Local HTML loaded but its content was not available to the browser snapshot.');
}
assertOk(await executeAction({ action: 'navigate', url: fixture.url }), 'fixture return after local HTML');
headingRef = snapshotRef((await executeAction({ action: 'snapshot' })).output, 'Nori Browser Smoke');
if (!headingRef) throw new Error('The fixture did not recover after local HTML navigation.');
progress('local HTML navigation verified');

assertOk(await executeAction({ action: 'scroll', deltaY: 700 }), 'scroll');
await waitFor(async () => {
  const snapshot = await executeAction({ action: 'snapshot' });
  return viewportScrollY(snapshot.output) > 0;
});
const screenshot = await executeAction({ action: 'screenshot' });
assertOk(screenshot, 'screenshot');
if (!screenshot.screenshotDataUrl?.startsWith('data:image/png;base64,')) throw new Error('Screenshot action returned no PNG data URL.');
await writeFile(resolve(outputDir, 'agent-screenshot.png'), Buffer.from(screenshot.screenshotDataUrl.split(',')[1], 'base64'));
progress('scroll and screenshot verified');

await evaluate(workbench, `window.noriDesktop.browserSetAnnotationMode(true)`, true);
assertOk(await executeAction({ action: 'click', ref: headingRef }), 'annotation click');
await waitFor(async () => {
  const state = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
  return state.tabs.find(tab => tab.id === state.activeTabId)?.annotations.length === 1;
});
const annotationState = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
const annotation = annotationState.tabs.find(tab => tab.id === annotationState.activeTabId).annotations[0];
await evaluate(workbench, `window.noriDesktop.browserUpdateAnnotation(${JSON.stringify(annotation.id)}, 'Check this heading')`, true);
const listedAnnotations = await executeAction({ action: 'annotation_list' });
if (!listedAnnotations.output.includes('Check this heading') || !listedAnnotations.output.includes('Nori Browser Smoke')) {
  throw new Error('Annotation list did not preserve element text and user note.');
}
await evaluate(workbench, `window.noriDesktop.browserClearAnnotations()`, true);
await evaluate(workbench, `window.noriDesktop.browserSetAnnotationMode(false)`, true);
progress('annotation lifecycle verified');

await evaluate(workbench, `window.noriDesktop.browserSetAutomationPaused(true)`, true);
const pausedResult = await executeAction({ action: 'snapshot' });
if (pausedResult.ok || !pausedResult.output.includes('paused')) throw new Error('Paused automation still accepted an Agent action.');
await evaluate(workbench, `window.noriDesktop.browserSetAutomationPaused(false)`, true);
assertOk(await executeAction({ action: 'snapshot' }), 'resumed snapshot');
progress('user takeover pause/resume verified');

const afterNavigate = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
const second = await evaluate(workbench, `window.noriDesktop.browserNewTab()`, true);
if (second.tabs.length !== 2) throw new Error('Creating a browser tab did not update state.');
const restored = await evaluate(workbench, `window.noriDesktop.browserCloseTab(${JSON.stringify(second.activeTabId)})`, true);
if (restored.tabs.length !== 1 || restored.activeTabId !== afterNavigate.activeTabId) {
  throw new Error('Closing the active browser tab did not restore the previous tab.');
}
progress('tab lifecycle completed');

await capture(workbench, resolve(outputDir, 'workbench.png'));
progress('workbench captured');
const pageTarget = (await listTargets()).find(target => target.type === 'page' && target.url === fixture.url);
if (!pageTarget) throw new Error('Embedded WebContentsView target was not created.');
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.send('Page.enable');
await capture(page, resolve(outputDir, 'page.png'));
progress('embedded page captured');
page.close();

const recoveryFixture = await prepareRecoveryFixture();
const failedNavigation = await executeAction({ action: 'navigate', url: recoveryFixture.url, timeoutMs: 2_000 });
if (failedNavigation.ok) throw new Error('A failed page load was reported as successful.');
await recoveryFixture.start();
assertOk(await executeAction({ action: 'retry', timeoutMs: 5_000 }), 'failed-page retry');
await recoveryFixture.close();
progress('failed-page retry verified');
const finalState = await evaluate(workbench, `window.noriDesktop.browserGetState()`, true);
workbench.close();

const result = {
  workbench: { title: workbenchTarget.title, url: workbenchTarget.url },
  page: { title: pageTarget.title, url: pageTarget.url },
  state: finalState,
};
const operationHistory = result.state.automation.history;
if (operationHistory.length < 8 || operationHistory.some(item => item.agentId !== 'browser-smoke-agent' || item.sessionId !== 'browser-smoke-session')) {
  throw new Error('Browser operation history lost Agent/session ownership.');
}
await writeFile(resolve(outputDir, 'result.json'), JSON.stringify(result, null, 2));
await fixture.close();
process.stdout.write(`${JSON.stringify(result)}\n`);

async function executeAction(request) {
  return evaluate(
    workbench,
    `window.noriDesktop.browserExecuteActionForSmoke(${JSON.stringify(request)})`,
    true,
  );
}

function assertOk(result, action) {
  if (!result?.ok) throw new Error(`${action} failed: ${result?.output ?? 'unknown error'}`);
}

function snapshotRef(snapshot, marker) {
  const line = snapshot.split('\n').find(candidate => candidate.includes(marker));
  return line?.match(/\bref=(n[a-z0-9]+-\d+)\b/i)?.[1];
}

function viewportScrollY(snapshot) {
  return Number(snapshot.match(/Viewport: \d+x\d+ at \([^,]+, ([^)]+)\)/)?.[1] ?? 0);
}

async function startFixtureServer() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Nori Browser Fixture</title>
    <style>body{font:16px system-ui;margin:32px}.controls{display:grid;grid-template-columns:repeat(2,minmax(180px,280px));gap:10px}input,button,a{box-sizing:border-box;font:inherit;padding:8px}.spacer{height:1200px}.tail{padding:20px;background:#d8f4e5}</style></head>
    <body><h1>Nori Browser Smoke</h1><div class="controls"><input aria-label="Smoke input" placeholder="Smoke input"><button id="increment">Increment</button><input id="upload" type="file" aria-label="Smoke upload"><button id="fetch">Fetch data</button><a id="download" href="/download" download="nori-smoke.txt">Download file</a><button id="dialog">Open confirm</button><button id="permission">Request notifications</button></div><p id="status">Clicks: 0</p><p id="fetch-status">Fetch: idle</p><p id="dialog-status">Dialog: idle</p><p id="permission-status">Permission: idle</p><div class="spacer"></div><p class="tail">Scroll target</p>
    <script>
      let clicks=0;
      document.querySelector('#increment').addEventListener('click',()=>{document.querySelector('#status').textContent='Clicks: '+String(++clicks)});
      document.querySelector('#fetch').addEventListener('click',async()=>{const value=await fetch('/api/ping').then(response=>response.text());document.querySelector('#fetch-status').textContent='Fetch: '+value});
      document.querySelector('#dialog').addEventListener('click',()=>{const value=confirm('Browser smoke confirm');document.querySelector('#dialog-status').textContent='Dialog: '+String(value)});
      document.querySelector('#permission').addEventListener('click',async()=>{const result=await Notification.requestPermission();document.querySelector('#permission-status').textContent='Permission: '+result});
    </script></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === '/api/ping') {
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('pong');
      return;
    }
    if (request.url === '/download') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="nori-smoke.txt"',
        'cache-control': 'no-store',
      });
      response.end('download works\n');
      return;
    }
    if (request.url === '/second') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><title>Second page</title><h1>Second page</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port.');
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function prepareRecoveryFixture() {
  const reservation = createServer();
  await listen(reservation, 0);
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Recovery fixture did not reserve a TCP port.');
  const port = address.port;
  await closeServer(reservation);
  let server;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    start: async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><title>Recovered page</title><h1>Recovered page</h1>');
      });
      await listen(server, port);
    },
    close: () => server ? closeServer(server) : Promise.resolve(),
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function listTargets() {
  const response = await fetch(listUrl);
  if (!response.ok) throw new Error(`CDP target list failed: ${String(response.status)}`);
  return response.json();
}

async function capture(client, path) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Runtime evaluation failed.');
  return result.result.value;
}

async function waitFor(predicate, timeout = 8_000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for browser state.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function waitForValue(factory, timeout = 8_000) {
  let value;
  await waitFor(async () => {
    value = await factory();
    return value !== undefined && value !== null && value !== '';
  }, timeout);
  return value;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++requestId;
      return withTimeout(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }), 15_000, `CDP ${method}`);
    },
    close() { socket.close(); },
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function progress(message) {
  process.stderr.write(`[browser-smoke] ${message}\n`);
}
