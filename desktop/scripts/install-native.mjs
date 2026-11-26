#!/usr/bin/env node
/**
 * Installs the server's native packages for one target into
 * src-tauri/resources/server/node_modules, then removes what that target
 * never loads (other platforms' onnxruntime binaries, onnxruntime-web).
 *
 *   node scripts/install-native.mjs [--target aarch64-apple-darwin | x86_64-pc-windows-msvc]
 *
 * Install scripts are skipped (--ignore-scripts): sharp and onnxruntime-node
 * ship prebuilt binaries, and their scripts would act on the host platform,
 * not on the target, when cross-preparing.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SERVER_RESOURCES_DIR, formatBytes, isMain, log, nativeDependencyVersions, pruneNativeModules,
  readAppVersion, run, serverPackageJson, targetFromArgv, treeSize,
} from "./common.mjs";

export async function installNative({ target, dir = SERVER_RESOURCES_DIR } = {}) {
  await mkdir(dir, { recursive: true });
  const pkg = serverPackageJson({ appVersion: readAppVersion(), dependencies: nativeDependencyVersions() });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  // A clean install every time: a previous run may have been for another target.
  await rm(path.join(dir, "node_modules"), { recursive: true, force: true });
  await rm(path.join(dir, "package-lock.json"), { force: true });
  await run("npm", [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--package-lock=false",
    "--install-links=false",
    `--os=${target.os}`,
    `--cpu=${target.cpu}`,
  ], { cwd: dir, env: { ...process.env, npm_config_workspaces: "false" } });
  const nodeModules = path.join(dir, "node_modules");
  const removed = await pruneNativeModules(nodeModules, target.triple);
  const bytes = await treeSize(nodeModules);
  return { dir, nodeModules, removed, bytes, dependencies: pkg.dependencies };
}

if (isMain(import.meta.url)) {
  const target = targetFromArgv();
  installNative({ target }).then(({ nodeModules, removed, bytes }) => {
    log(`native modules for ${target.triple} → ${nodeModules} (${formatBytes(bytes)}); pruned ${removed.join(", ") || "nothing"}`);
  }, (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
