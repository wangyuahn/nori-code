"use strict";

const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");

const desktopRoot = resolve(__dirname, "..");
const outputDir = resolve(desktopRoot, process.argv[2] ?? "dist-app");
const expectedVersion = JSON.parse(
  readFileSync(join(desktopRoot, "package.json"), "utf8"),
).version;

function findPackagedResources(root, depth = 0) {
  if (depth > 7 || !existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (
      basename(path).toLowerCase() === "resources" &&
      existsSync(join(path, "app.asar"))
    ) {
      found.push(path);
      continue;
    }
    found.push(...findPackagedResources(path, depth + 1));
  }
  return found;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const resourceDirs = findPackagedResources(outputDir);
if (resourceDirs.length !== 1) {
  throw new Error(
    `Expected one packaged resources directory under ${outputDir}; found ${resourceDirs.length}.`,
  );
}

const resources = resourceDirs[0];
const runtimeDir = join(resources, "server-runtime");
const workerPath = join(runtimeDir, "server-worker.cjs");
const manifestPath = join(runtimeDir, "server-worker.manifest.json");
const webDistDir = join(resources, "nori-web", "dist");
const webAssetsDir = join(webDistDir, "assets");

if (existsSync(join(resources, "bin"))) {
  throw new Error(`Legacy SEA resources remain in ${join(resources, "bin")}.`);
}
for (const required of [
  workerPath,
  manifestPath,
  join(webDistDir, "index.html"),
]) {
  if (!existsSync(required))
    throw new Error(`Missing packaged runtime artifact: ${required}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || manifest.version !== expectedVersion) {
  throw new Error(
    `Server worker manifest ${String(manifest.version)} does not match ${expectedVersion}.`,
  );
}
if (manifest.sha256 !== sha256(workerPath)) {
  throw new Error("Packaged server worker hash does not match its manifest.");
}

const cssFiles = readdirSync(webAssetsDir)
  .filter((name) => /^index-.*\.css$/.test(name))
  .map((name) => join(webAssetsDir, name));
const css = cssFiles.map((path) => readFileSync(path, "utf8")).join("\n");
const whiteSecondaryDeclarations = css.match(
  /--nori-text-secondary:\s*#(?:fff|ffffff)\b/gi,
);
if ((whiteSecondaryDeclarations?.length ?? 0) < 2) {
  throw new Error(
    "Packaged dark-theme secondary text overrides are not white.",
  );
}
if (!/--nori-text-muted:\s*#c9c9c9\b/i.test(css)) {
  throw new Error(
    "Packaged dark-theme muted text does not use the expected high-contrast value.",
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version: expectedVersion,
    resources,
    workerSha256: manifest.sha256,
  })}\n`,
);
