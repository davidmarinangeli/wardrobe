import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import test from "node:test";

import { buildArchiveInventory, resolveArchiveFile, validateArchive } from "../scripts/archive-store.mjs";

const execFile = promisify(execFileCallback);
const detection = {
  name: "Fixture top", part: "upperbody", color: "#336699", secondaryColor: null,
  tags: ["fixture"], worn: true,
  boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-bulk-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#ececec" } }).png().toBuffer();
  const preload = path.join(root, "mock-ai.mjs");
  await writeFile(preload, `
const item = ${JSON.stringify(detection)};
const image = ${JSON.stringify(generated.toString("base64"))};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/responses")) return new Response(JSON.stringify({ output_text: JSON.stringify({ items: [item] }) }), { headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/images/edits")) return new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { "Content-Type": "application/json" } });
  throw new Error("Unexpected test network request: " + url);
};
`);
  const env = {
    PATH: process.env.PATH || "",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "fixture-only-key",
    OPENAI_API_BASE_URL: "http://mock.invalid/v1",
    WARDROBE_DATA_DIR: path.join(root, "target-data"),
    WARDROBE_MODEL_REFERENCE: path.join(root, "missing-model-reference.png"),
    WARDROBE_FACE_REFERENCE: "off",
  };
  return { root, preload, env, script: path.resolve("scripts/bulk-import.mjs") };
}

async function runBulk({ script, preload, env }, args) {
  return execFile(process.execPath, ["--import", preload, script, ...args], { env, maxBuffer: 1024 * 1024 });
}

async function snapshotFiles(root) {
  const result = new Map();
  async function walk(directory, prefix = "") {
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else result.set(relative, await readFile(absolute));
    }
  }
  await walk(root);
  return result;
}

test("bulk prepare carries sidecar originals through source deletion, apply, and retry", async (t) => {
  const env = await fixture(t);
  const inputDir = path.join(env.root, "input-photos");
  const manifestDir = path.join(env.root, "prepared");
  const manifestFile = path.join(manifestDir, "review.json");
  await mkdir(inputDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  const source = await sharp({ create: { width: 40, height: 48, channels: 3, background: "#b08050" } }).jpeg().toBuffer();
  await writeFile(path.join(inputDir, "look.jpg"), source);

  await runBulk(env, ["--input", inputDir, "--prepare", "--manifest", manifestFile, "--no-modeled"]);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].status, "accepted");
  const declared = manifest.items[0].originalSources[0];
  const sidecarFile = path.resolve(manifestDir, declared.path);
  assert.deepEqual(await readFile(sidecarFile), source);
  await rm(inputDir, { recursive: true, force: true });

  await runBulk(env, ["--apply", "--manifest", manifestFile]);
  const dataDir = env.env.WARDROBE_DATA_DIR;
  const firstLibrary = await readFile(path.join(dataDir, "library.json"));
  const imported = JSON.parse(firstLibrary.toString("utf8"));
  assert.equal(imported.length, 1);
  assert.equal(imported[0].sourceOriginals.length, 1);
  const archivedSource = imported[0].sourceOriginals[0];
  assert.deepEqual(await readFile(await resolveArchiveFile(dataDir, archivedSource)), source);
  const inventory = await buildArchiveInventory(dataDir);
  const validation = await validateArchive(dataDir, inventory);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  await runBulk(env, ["--apply", "--manifest", manifestFile]);
  assert.deepEqual(await readFile(path.join(dataDir, "library.json")), firstLibrary, "reapplying remains idempotent after the input photo is gone");
  assert.deepEqual(await readFile(await resolveArchiveFile(dataDir, archivedSource)), source);
});

test("bulk dry-run leaves every target archive file byte-for-byte untouched", async (t) => {
  const env = await fixture(t);
  const dataDir = env.env.WARDROBE_DATA_DIR;
  const inputDir = path.join(env.root, "dry-run-photos");
  await mkdir(path.join(dataDir, "imported"), { recursive: true });
  await mkdir(inputDir, { recursive: true });
  const source = await sharp({ create: { width: 40, height: 48, channels: 3, background: "#b08050" } }).jpeg().toBuffer();
  await writeFile(path.join(inputDir, "look.jpg"), source);
  await writeFile(path.join(dataDir, "library.json"), "[]\n");
  await writeFile(path.join(dataDir, "imported", "kept.png"), Buffer.from("fixture target asset"));
  const before = await snapshotFiles(dataDir);

  await runBulk(env, ["--input", inputDir, "--dry-run", "--no-modeled"]);

  const after = await snapshotFiles(dataDir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [relative, bytes] of before) assert.deepEqual(after.get(relative), bytes, `${relative} changed during dry-run`);
});
