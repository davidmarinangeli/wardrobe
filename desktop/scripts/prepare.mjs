#!/usr/bin/env node
/**
 * Prepares everything `tauri build` bundles for one target:
 *
 *   1. `npm run build` at the repo root, then ../dist → src-tauri/resources/web
 *   2. bundle-server.mjs  → src-tauri/resources/server/server.cjs
 *   3. install-native.mjs → src-tauri/resources/server/node_modules
 *   4. fetch-node.mjs     → src-tauri/binaries/node-<triple>[.exe]
 *
 *   node scripts/prepare.mjs [--target <triple>] [--skip-web-build]
 *   npm run prepare:app -- [same flags]
 *
 * --skip-web-build reuses an existing ../dist (CI builds it in an earlier step).
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleServer } from "./bundle-server.mjs";
import {
  REPO_ROOT, RESOURCES_DIR, SERVER_RESOURCES_DIR, WEB_RESOURCES_DIR, exists, formatBytes, isMain, log, readAppVersion,
  readNodeVersion, run, targetFromArgv, treeSize,
} from "./common.mjs";
import { fetchNode } from "./fetch-node.mjs";
import { installNative } from "./install-native.mjs";

export async function prepare({ target, skipWebBuild = false } = {}) {
  const started = Date.now();
  const dist = path.join(REPO_ROOT, "dist");
  if (!skipWebBuild) {
    log("building the web app (npm run build at the repo root)");
    await run("npm", ["run", "build"], { cwd: REPO_ROOT });
  }
  if (!await exists(path.join(dist, "index.html"))) throw new Error(`${dist}/index.html is missing. Run npm run build at the repo root.`);
  await rm(WEB_RESOURCES_DIR, { recursive: true, force: true });
  await mkdir(RESOURCES_DIR, { recursive: true });
  await cp(dist, WEB_RESOURCES_DIR, { recursive: true });
  log(`web app → ${WEB_RESOURCES_DIR}`);

  // Placeholders a debug cargo build may have left (src-tauri/build.rs).
  await rm(path.join(SERVER_RESOURCES_DIR, "PLACEHOLDER.txt"), { force: true });
  const bundle = await bundleServer();
  log(`server bundle ${bundle.version} → ${bundle.outfile} (${formatBytes(bundle.bytes)})`);

  const native = await installNative({ target });
  log(`native modules for ${target.triple} (${formatBytes(native.bytes)}); pruned ${native.removed.join(", ") || "nothing"}`);

  const node = await fetchNode({ target });
  log(`node v${node.version} → ${node.output} (${formatBytes(node.bytes)})`);

  const sizes = {
    web: await treeSize(WEB_RESOURCES_DIR),
    server: await treeSize(SERVER_RESOURCES_DIR),
    nodeModules: native.bytes,
    node: node.bytes,
  };
  const summary = {
    target: target.triple,
    appVersion: readAppVersion(),
    nodeVersion: readNodeVersion(),
    nodeSha256: node.sha256,
    dependencies: native.dependencies,
    pruned: native.removed,
    sizes,
    preparedAt: new Date().toISOString(),
  };
  await writeFile(path.join(SERVER_RESOURCES_DIR, "prepared.json"), `${JSON.stringify(summary, null, 2)}\n`);
  log(`prepared ${target.triple} in ${Math.round((Date.now() - started) / 1000)} s: sidecar ${formatBytes(sizes.server + sizes.node)} (node ${formatBytes(sizes.node)}, node_modules ${formatBytes(sizes.nodeModules)}), web ${formatBytes(sizes.web)}`);
  return summary;
}

if (isMain(import.meta.url)) {
  const target = targetFromArgv();
  prepare({ target, skipWebBuild: process.argv.includes("--skip-web-build") }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
