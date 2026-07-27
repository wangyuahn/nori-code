'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const desktopRoot = resolve(__dirname, '..');
const workerPath = resolve(desktopRoot, 'out', 'server-worker.cjs');
const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'));
const workerBytes = readFileSync(workerPath);
const manifest = {
  schemaVersion: 1,
  version: packageJson.version,
  sha256: createHash('sha256').update(workerBytes).digest('hex'),
};

writeFileSync(
  resolve(desktopRoot, 'out', 'server-worker.manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
