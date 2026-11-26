#!/usr/bin/env node
/**
 * Smoke test of the packaged sidecar, run after prepare.mjs on the host target.
 *
 *   node scripts/smoke-sidecar.mjs [--port 0] [--keep]
 *
 * 1. Loads the native modules with the packaged Node from resources/server
 *    (sharp, onnxruntime-node, @huggingface/transformers, ipx).
 * 2. Starts binaries/node-<triple> resources/server/server.cjs exactly like the
 *    shell does (managed mode, temporary data and cache directories, piped
 *    stdin, NODE_OPTIONS cleared, a working directory outside the repo).
 * 3. Waits for READY, then checks /api/health (ok, managed, paths, version)
 *    and that / serves the web app.
 * 4. Closes stdin and expects a clean exit (code 0) within 15 s.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SERVER_RESOURCES_DIR, WEB_RESOURCES_DIR, exists, isMain, log, nodeBinaryPath, readAppVersion, targetFromArgv,
} from "./common.mjs";

const READY_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;

function sidecarEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|WARDROBE_DATA_DIR|WARDROBE_CACHE_DIR|WARDROBE_ALLOWED_HOSTS)$/i.test(key)) delete env[key];
  }
  return env;
}

function runCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const NATIVE_CHECK = `
const sharp = require("sharp");
const ort = require("onnxruntime-node");
(async () => {
  const transformers = await import("@huggingface/transformers");
  const ipx = await import("ipx");
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } }).png().toBuffer();
  const meta = await sharp(png).metadata();
  if (meta.width !== 4) throw new Error("sharp round trip failed");
  if (typeof ort.InferenceSession?.create !== "function") throw new Error("onnxruntime-node has no InferenceSession");
  if (!ort.listSupportedBackends?.().some((b) => b.name === "cpu")) throw new Error("onnxruntime-node has no cpu backend: " + JSON.stringify(ort.listSupportedBackends?.()));
  if (typeof transformers.pipeline !== "function" || !transformers.env) throw new Error("@huggingface/transformers did not load");
  if (typeof ipx.createIPX !== "function") throw new Error("ipx did not load");
  process.stdout.write(JSON.stringify({ sharp: sharp.versions.sharp, vips: sharp.versions.vips, ort: ort.env?.versions?.node ?? "loaded", backends: ort.listSupportedBackends().map((b) => b.name) }) + "\\n");
})().catch((error) => { process.stderr.write(String(error?.stack || error) + "\\n"); process.exit(1); });
`;

async function checkNativeModules(node) {
  const result = await runCapture(node, ["-e", NATIVE_CHECK], { cwd: SERVER_RESOURCES_DIR, env: sidecarEnv() });
  if (result.code !== 0) throw new Error(`native module check failed (exit ${result.code}):\n${result.stderr}${result.stdout}`);
  log(`native modules load with the packaged node: ${result.stdout.trim()}`);
}

export async function smoke({ target, port = 0, keep = false } = {}) {
  const node = nodeBinaryPath(target.triple);
  const serverScript = path.join(SERVER_RESOURCES_DIR, "server.cjs");
  for (const required of [node, serverScript, path.join(SERVER_RESOURCES_DIR, "node_modules"), path.join(WEB_RESOURCES_DIR, "index.html")]) {
    if (!await exists(required)) throw new Error(`${required} is missing. Run node scripts/prepare.mjs first.`);
  }
  const version = (await runCapture(node, ["--version"], { env: sidecarEnv() })).stdout.trim();
  log(`packaged node ${version} at ${node}`);

  const work = await mkdtemp(path.join(os.tmpdir(), "wardrobe-smoke-"));
  const dataDir = path.join(work, "data");
  const cacheDir = path.join(work, "cache");
  try {
    await checkNativeModules(node);
    const args = [
      serverScript,
      "--port", String(port),
      "--host", "127.0.0.1",
      "--root", SERVER_RESOURCES_DIR,
      "--dist", WEB_RESOURCES_DIR,
      "--data-dir", dataDir,
      "--cache-dir", cacheDir,
      "--watch-stdin", "on",
    ];
    const child = spawn(node, args, { cwd: work, env: sidecarEnv({ WARDROBE_MANAGED_CONFIG: "1" }), stdio: ["pipe", "pipe", "pipe"] });
    const lines = [];
    let url = null;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no READY line within ${READY_TIMEOUT_MS / 1000} s`)), READY_TIMEOUT_MS);
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          lines.push(`out: ${line}`);
          const match = /^wardrobe-server listening on (http:\/\/\S+)$/.exec(line);
          if (match) url = match[1];
          if (line === "READY") { clearTimeout(timer); resolve(); }
        }
      });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code} before READY`)); });
    });
    child.stderr.on("data", (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line) lines.push(`err: ${line}`); });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    try {
      await ready;
      if (!url) throw new Error("no listening line before READY");
      const health = await (await fetch(`${url}/api/health`)).json();
      log(`health: ${JSON.stringify(health)}`);
      const expectedVersion = readAppVersion();
      const failures = [];
      if (health.ok !== true) failures.push("ok is not true");
      if (health.managed !== true) failures.push("managed is not true");
      if (path.resolve(health.dataDir) !== path.resolve(dataDir)) failures.push(`dataDir ${health.dataDir} != ${dataDir}`);
      if (path.resolve(health.cacheDir) !== path.resolve(cacheDir)) failures.push(`cacheDir ${health.cacheDir} != ${cacheDir}`);
      if (health.version !== expectedVersion) failures.push(`version ${health.version} != ${expectedVersion}`);
      const index = await fetch(`${url}/`);
      const html = await index.text();
      if (index.status !== 200 || !html.includes("<div id=\"root\"")) failures.push(`/ answered ${index.status} without the app root`);
      const expectedHtml = await readFile(path.join(WEB_RESOURCES_DIR, "index.html"), "utf8");
      if (html !== expectedHtml) failures.push("/ does not serve resources/web/index.html");
      const providers = await (await fetch(`${url}/api/setup/providers`)).json();
      if (providers.managed !== true) failures.push("/api/setup/providers is not managed");
      if (failures.length) throw new Error(`health checks failed: ${failures.join("; ")}`);
    } catch (error) {
      child.kill();
      throw new Error(`${error.message}\n--- sidecar output ---\n${lines.join("\n")}`);
    }
    child.stdin.end();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), EXIT_TIMEOUT_MS).unref());
    const exit = await Promise.race([exited, timeout]);
    if (!exit) { child.kill(); throw new Error(`server did not exit within ${EXIT_TIMEOUT_MS / 1000} s after stdin closed`); }
    if (exit.code !== 0) throw new Error(`server exited with ${exit.code ?? exit.signal} after stdin closed\n${lines.join("\n")}`);
    log(`sidecar stopped cleanly after stdin closed (exit 0). Smoke test passed for ${target.triple}.`);
    return { health: true };
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else log(`kept ${work}`);
  }
}

if (isMain(import.meta.url)) {
  const index = process.argv.indexOf("--port");
  const port = index > 0 ? Number(process.argv[index + 1]) : 0;
  smoke({ target: targetFromArgv(), port, keep: process.argv.includes("--keep") }).catch((error) => {
    process.stderr.write(`smoke test failed: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
