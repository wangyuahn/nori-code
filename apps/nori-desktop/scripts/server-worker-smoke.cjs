'use strict';

const { randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { app, utilityProcess } = require('electron');

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 7_000;
const SERVER_WORKER_CONFIG_ENV = 'NORI_DESKTOP_SERVER_WORKER_CONFIG';

const desktopRoot = resolve(__dirname, '..');
const workerPath = process.env.NORI_SERVER_WORKER_SMOKE_WORKER_PATH
  ?? join(desktopRoot, 'out', 'server-worker.cjs');
const webAssetsDir = process.env.NORI_SERVER_WORKER_SMOKE_WEB_ASSETS_DIR
  ?? resolve(desktopRoot, '..', 'nori-web', 'dist');
const modulesDir = process.env.NORI_SERVER_WORKER_SMOKE_MODULES_DIR
  ?? resolve(desktopRoot, '..', '..', 'packages', 'agent-core', 'node_modules');
const version = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !pidAlive(pid);
}

function waitForWorkerReady(worker, launchId, deadline) {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      callback();
    };
    const onMessage = (message) => {
      if (message?.launchId !== launchId) return;
      if (message.type === 'ready') {
        finish(() => resolveReady(message));
      } else if (message.type === 'fatal') {
        finish(() => reject(new Error(`${message.code}: ${message.message}`)));
      }
    };
    const onExit = (code) => {
      finish(() => reject(new Error(`Server worker exited with code ${String(code)} before ready.`)));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Server worker did not become ready within 30 seconds.')));
    }, Math.max(0, deadline - Date.now()));
    worker.on('message', onMessage);
    worker.on('exit', onExit);
  });
}

function waitForStoppedAndExit(worker, launchId) {
  return new Promise((resolveStopped, reject) => {
    let sawStopped = false;
    let sawExit = false;
    let exitCode;
    const finish = () => {
      if (!sawStopped || !sawExit) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      if (exitCode === 0) resolveStopped();
      else reject(new Error(`Server worker exited with code ${String(exitCode)} during shutdown.`));
    };
    const onMessage = (message) => {
      if (message?.type === 'stopped' && message.launchId === launchId) {
        sawStopped = true;
        finish();
      }
    };
    const onExit = (code) => {
      sawExit = true;
      exitCode = code;
      finish();
    };
    const timer = setTimeout(() => {
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      reject(new Error('Server worker did not stop within 7 seconds.'));
    }, SHUTDOWN_TIMEOUT_MS);
    worker.on('message', onMessage);
    worker.on('exit', onExit);
  });
}

async function run() {
  if (!existsSync(workerPath)) throw new Error(`Missing worker bundle: ${workerPath}`);
  if (!existsSync(webAssetsDir)) throw new Error(`Missing web assets: ${webAssetsDir}`);
  if (!existsSync(modulesDir)) throw new Error(`Missing worker modules: ${modulesDir}`);

  const homeDir = mkdtempSync(join(tmpdir(), 'nori-server-worker-smoke-'));
  const launchId = randomUUID();
  const startedAt = new Date().toISOString();
  const lockPath = join(homeDir, 'server', 'lock');
  const logPath = join(homeDir, 'server', 'server.log');
  const config = {
    launchId,
    startedAt,
    version,
    homeDir,
    lockPath,
    host: '127.0.0.1',
    port: 0,
    webAssetsDir,
    logPath,
    parentPid: process.pid,
  };
  let worker;
  let workerStopped = false;

  try {
    const launchStarted = Date.now();
    worker = utilityProcess.fork(workerPath, [], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        NORI_CODE_HOME: homeDir,
        NORI_CODE_NODE_EXECUTABLE: process.execPath,
        NORI_CODE_NODE_RUN_AS_NODE: '1',
        NORI_CODE_BUNDLED_NODE_MODULES: modulesDir,
        [SERVER_WORKER_CONFIG_ENV]: JSON.stringify(config),
      },
      stdio: 'pipe',
      serviceName: 'Nori Server Smoke',
    });
    worker.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    worker.stderr?.on('data', (chunk) => process.stderr.write(chunk));

    const ready = await waitForWorkerReady(
      worker,
      launchId,
      Date.parse(startedAt) + STARTUP_TIMEOUT_MS,
    );
    const startupMs = Date.now() - launchStarted;
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (
      lock.schema_version !== 2
      || lock.state !== 'ready'
      || lock.launch_id !== launchId
      || lock.pid !== ready.pid
      || lock.port <= 0
    ) {
      throw new Error(`Invalid ready lock: ${JSON.stringify(lock)}`);
    }

    const response = await fetch(`${ready.origin}/api/v1/healthz`);
    const body = await response.json();
    if (!response.ok || body?.code !== 0 || body?.data?.app !== 'nori-code') {
      throw new Error(`Unexpected health response: ${response.status} ${JSON.stringify(body)}`);
    }

    const workerPid = ready.pid;
    const stopped = waitForStoppedAndExit(worker, launchId);
    worker.postMessage({ type: 'shutdown' });
    await stopped;
    workerStopped = true;
    if (existsSync(lockPath)) throw new Error('Server lock remained after worker shutdown.');
    if (!(await waitForPidExit(workerPid, 2_000))) {
      throw new Error(`Server worker pid ${String(workerPid)} remained alive.`);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      startupMs,
      origin: ready.origin,
      pid: workerPid,
      lockRemoved: true,
    })}\n`);
  } finally {
    if (!workerStopped) worker?.kill();
    rmSync(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
}

void app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    app.exit(1);
  }
});
