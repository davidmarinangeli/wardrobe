#!/usr/bin/env node
/**
 * Downloads the Node version pinned in desktop/node-version.txt for one
 * target, verifies it against nodejs.org's SHASUMS256.txt and extracts the
 * binary to src-tauri/binaries/node-<triple>[.exe] (Tauri's externalBin name).
 *
 *   node scripts/fetch-node.mjs [--target aarch64-apple-darwin | x86_64-pc-windows-msvc]
 *
 * Archives are cached, verified, in desktop/.cache/node/.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BINARIES_DIR, DOWNLOAD_CACHE_DIR, formatBytes, isMain, log, nodeArchive, nodeBinaryPath, parseShasums,
  readNodeVersion, targetFromArgv,
} from "./common.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function download(url) {
  const response = await fetch(url, { headers: { "User-Agent": "wardrobe-desktop-build" } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

// bsdtar extracts both .tar.gz and .zip. On Windows use the one in System32:
// a GNU tar earlier on PATH (Git Bash) cannot read zip files and treats
// "C:" as a remote host.
function tarCommand() {
  if (process.platform === "win32") return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return "tar";
}

function extractMember(archive, member, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand(), ["-xf", archive, "-C", destination, member], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code} extracting ${member} from ${archive}`)));
  });
}

export async function fetchNode({ target, version = readNodeVersion(), cacheDir = path.join(DOWNLOAD_CACHE_DIR, "node") } = {}) {
  const archive = nodeArchive(version, target.triple);
  await mkdir(cacheDir, { recursive: true });
  const shasums = parseShasums((await download(archive.shasumsUrl)).toString("utf8"));
  const expected = shasums.get(archive.file);
  if (!expected) throw new Error(`${archive.file} is not listed in ${archive.shasumsUrl}`);

  const cached = path.join(cacheDir, archive.file);
  let bytes = null;
  try {
    const existing = await readFile(cached);
    if (sha256(existing) === expected) bytes = existing;
  } catch { /* not cached yet */ }
  if (!bytes) {
    log(`downloading ${archive.url}`);
    bytes = await download(archive.url);
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`Checksum mismatch for ${archive.file}: expected ${expected}, got ${actual}`);
    await writeFile(cached, bytes);
  }

  const scratch = await mkdtemp(path.join(cacheDir, "extract-"));
  try {
    await extractMember(cached, archive.member, scratch);
    const output = nodeBinaryPath(target.triple);
    await mkdir(BINARIES_DIR, { recursive: true });
    await copyFile(path.join(scratch, ...archive.member.split("/")), output);
    if (target.os !== "win32") await chmod(output, 0o755);
    const size = (await stat(output)).size;
    return { output, version, sha256: expected, archive: archive.file, bytes: size };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const target = targetFromArgv();
  fetchNode({ target }).then(({ output, version, archive, bytes }) => {
    log(`node v${version} for ${target.triple} (${archive}, sha256 verified) → ${output} (${formatBytes(bytes)})`);
  }, (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
