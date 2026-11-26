/**
 * Shared constants and helpers for the desktop build scripts
 * (bundle-server, install-native, fetch-node, prepare, smoke-sidecar).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");
export const TAURI_DIR = path.join(DESKTOP_DIR, "src-tauri");
export const RESOURCES_DIR = path.join(TAURI_DIR, "resources");
export const SERVER_RESOURCES_DIR = path.join(RESOURCES_DIR, "server");
export const WEB_RESOURCES_DIR = path.join(RESOURCES_DIR, "web");
export const BINARIES_DIR = path.join(TAURI_DIR, "binaries");
export const DOWNLOAD_CACHE_DIR = path.join(DESKTOP_DIR, ".cache");

/**
 * Packages that esbuild leaves out of server.cjs and that install-native
 * installs per target into resources/server/node_modules. `@img/*` are the
 * sharp platform packages, which npm pulls in as sharp's optional dependencies.
 */
export const NATIVE_PACKAGES = Object.freeze(["sharp", "onnxruntime-node", "@huggingface/transformers", "ipx"]);
export const ESBUILD_EXTERNALS = Object.freeze(["sharp", "@img/*", "onnxruntime-node", "@huggingface/transformers", "ipx"]);

/** The two supported Rust target triples and what they mean for npm and nodejs.org. */
export const TARGETS = Object.freeze({
  "aarch64-apple-darwin": Object.freeze({ os: "darwin", cpu: "arm64", nodeDist: "darwin-arm64", archive: "tar.gz", exe: "" }),
  "x86_64-pc-windows-msvc": Object.freeze({ os: "win32", cpu: "x64", nodeDist: "win-x64", archive: "zip", exe: ".exe" }),
});

export function targetInfo(triple) {
  const info = TARGETS[triple];
  if (!info) throw new Error(`Unsupported target ${JSON.stringify(triple)}. Supported: ${Object.keys(TARGETS).join(", ")}`);
  return { triple, ...info };
}

/** The target triple of the machine running the script. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  for (const [triple, info] of Object.entries(TARGETS)) {
    if (info.os === platform && info.cpu === arch) return triple;
  }
  throw new Error(`No desktop target for this host (${platform}-${arch}). Pass --target ${Object.keys(TARGETS).join(" | ")}.`);
}

/** `--target <triple>` from argv, else the host target. */
export function targetFromArgv(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--target");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--target needs a value");
    return targetInfo(value);
  }
  const inline = argv.find((arg) => arg.startsWith("--target="));
  if (inline) return targetInfo(inline.slice("--target=".length));
  return targetInfo(hostTarget());
}

/** The pinned sidecar Node version from desktop/node-version.txt (without a leading v). */
export function readNodeVersion(file = path.join(DESKTOP_DIR, "node-version.txt")) {
  const version = readFileSync(file, "utf8").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${file} must hold one version such as 24.11.1, got ${JSON.stringify(version)}`);
  return version;
}

/** The app version: the root package.json version (also what /api/health reports). */
export function readAppVersion(root = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
}

/** The sidecar binary path for a target, with the triple suffix Tauri's externalBin expects. */
export function nodeBinaryPath(triple) {
  return path.join(BINARIES_DIR, `node-${triple}${targetInfo(triple).exe}`);
}

/**
 * `{ name: version }` for the native packages, read from the root lockfile so
 * the sidecar ships exactly what `npm run dev` runs.
 */
export function nativeDependencyVersions(lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"))) {
  const out = {};
  for (const name of NATIVE_PACKAGES) {
    const version = lock?.packages?.[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`${name} is not in the root package-lock.json. Run npm install at the repo root.`);
    out[name] = version;
  }
  return out;
}

/** The package.json written to resources/server. */
export function serverPackageJson({ appVersion, dependencies }) {
  return {
    name: "wardrobe-server",
    version: appVersion,
    private: true,
    description: "Wardrobe server bundle and its native modules, shipped inside the desktop app.",
    license: "MIT",
    main: "server.cjs",
    dependencies,
  };
}

/** Parses nodejs.org SHASUMS256.txt into a Map of file name → sha256 hex. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** The nodejs.org archive for a version and target. */
export function nodeArchive(version, triple) {
  const info = targetInfo(triple);
  const base = `node-v${version}-${info.nodeDist}`;
  const file = `${base}.${info.archive}`;
  return {
    base,
    file,
    url: `https://nodejs.org/dist/v${version}/${file}`,
    shasumsUrl: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    // Path of the binary inside the archive.
    member: info.os === "win32" ? `${base}/node.exe` : `${base}/bin/node`,
  };
}

/**
 * Removes the onnxruntime-node binaries of every other platform and CPU, and
 * onnxruntime-web, which `@huggingface/transformers` only loads in browsers
 * (its Node build imports onnxruntime-node and onnxruntime-common only).
 * Returns the removed paths, relative to nodeModules.
 */
export async function pruneNativeModules(nodeModules, triple) {
  const { os, cpu } = targetInfo(triple);
  const removed = [];
  const remove = async (relative) => {
    await rm(path.join(nodeModules, relative), { recursive: true, force: true });
    removed.push(relative.split(path.sep).join("/"));
  };
  const napi = path.join("onnxruntime-node", "bin", "napi-v6");
  for (const platformDir of await listDirs(path.join(nodeModules, napi))) {
    if (platformDir !== os) { await remove(path.join(napi, platformDir)); continue; }
    for (const cpuDir of await listDirs(path.join(nodeModules, napi, platformDir))) {
      if (cpuDir !== cpu) await remove(path.join(napi, platformDir, cpuDir));
    }
  }
  if (await exists(path.join(nodeModules, "onnxruntime-web"))) await remove("onnxruntime-web");
  if (await exists(path.join(nodeModules, ".bin"))) await remove(".bin");
  return removed;
}

async function listDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

/** Total size in bytes of a file tree (symlinks are not followed). */
export async function treeSize(dir) {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await treeSize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Runs a command, inheriting stdio. Rejects on a non-zero exit. */
export function run(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which needs a shell.
    const shell = process.platform === "win32" && /^(npm|npx)$/.test(command);
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal || `exit ${code}`}) in ${cwd}`));
    });
  });
}

export function log(message) {
  process.stdout.write(`[desktop] ${message}\n`);
}

/** True when the module at `url` is the script node was started with. */
export function isMain(url) {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = fileURLToPath(url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
