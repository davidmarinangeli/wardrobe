import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildArchiveInventory,
  prepareArchiveDirectory,
  preserveOriginal,
  pruneUnreferencedOriginals,
  readReferenceBytes,
  resolveArchiveFile,
  validateArchive,
} from "../scripts/archive-store.mjs";
import { prepareSubject } from "../scripts/draping-service.mjs";
import { catalogForDisk, catalogForHttp } from "../shared/portable-assets.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execFile = promisify(execFileCallback);

async function fixtureDirectory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("portable catalog mapping changes only declared asset fields and preserves labels", () => {
  const value = {
    image: "/api/import/library/item.png?rev=8",
    references: [{ original: "/api/archive/assets/originals/source.jpg?cache=4", sourceRefs: ["a/IMG.jpg"], label: "originals/label.png" }],
    tags: ["originals/is-a-tag"],
    inventory: { files: [{ path: "originals/is-inventory-metadata" }] },
  };
  const disk = catalogForDisk(value);
  assert.equal(disk.image, "imported/item.png");
  assert.equal(disk.references[0].original, "originals/source.jpg");
  assert.deepEqual(disk.references[0].sourceRefs, ["a/IMG.jpg"]);
  assert.equal(disk.references[0].label, "originals/label.png");
  assert.deepEqual(disk.tags, ["originals/is-a-tag"]);
  assert.equal(disk.inventory.files[0].path, "originals/is-inventory-metadata");
  assert.equal(catalogForHttp(disk).references[0].original, "/api/archive/assets/originals/source.jpg");
});

test("archive inventory includes persistent media, excludes nested control files, and detects omissions", async (t) => {
  const dataDir = path.join(await fixtureDirectory(t, "wardrobe-inventory-"), "data");
  await mkdir(path.join(dataDir, "imported", "nested"), { recursive: true });
  await mkdir(path.join(dataDir, "originals", ".cache"), { recursive: true });
  await mkdir(path.join(dataDir, "outfit-images"), { recursive: true });
  const media = Buffer.from("synthetic fixture bytes");
  const capturedSource = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#865432" } }).jpeg().toBuffer();
  const capturedSourcePath = `originals/${sha256(capturedSource)}.jpg`;
  await writeFile(path.join(dataDir, "imported", "nested", "item.png"), media);
  await writeFile(path.join(dataDir, ...capturedSourcePath.split("/")), capturedSource);
  await writeFile(path.join(dataDir, "originals", "photo.jpg"), Buffer.from("synthetic original bytes"));
  await writeFile(path.join(dataDir, "outfit-images", "look.png"), Buffer.from("synthetic outfit bytes"));
  await writeFile(path.join(dataDir, "originals", ".cache", "cached.png"), Buffer.from("excluded cache"));
  await writeFile(path.join(dataDir, "originals", "credentials-token.png"), Buffer.from("excluded control"));
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([{
    id: "fixture-item",
    image: "imported/nested/item.png",
    sourceRefs: ["a/IMG.jpg", "source-id-3", capturedSourcePath],
    references: [{ original: "originals/photo.jpg", label: "originals/descriptive-label.png" }],
    tags: ["originals/ordinary-tag"],
  }]));
  await writeFile(path.join(dataDir, "outfits.json"), JSON.stringify([{ id: "fixture-outfit", image: "/api/archive/assets/outfit-images/look.png?v=2" }]));

  const inventory = await buildArchiveInventory(dataDir);
  const paths = inventory.files.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right, "en")));
  assert.ok(paths.includes("imported/nested/item.png"));
  assert.ok(paths.includes(capturedSourcePath));
  assert.ok(paths.includes("originals/photo.jpg"));
  assert.ok(paths.includes("outfit-images/look.png"));
  assert.ok(!paths.some((entry) => /cache|credentials/.test(entry)));
  assert.equal(inventory.files.find((entry) => entry.path === "imported/nested/item.png").sha256, sha256(media));
  assert.equal((await validateArchive(dataDir, inventory)).valid, true);

  const omitted = { ...inventory, files: inventory.files.filter((entry) => entry.path !== "outfit-images/look.png") };
  const validation = await validateArchive(dataDir, omitted);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("omits file: outfit-images/look.png")));
  assert.ok(!validation.errors.some((error) => error.includes("descriptive-label") || error.includes("ordinary-tag") || error.includes("a/IMG.jpg") || error.includes("source-id-3")));

  await rm(path.join(dataDir, ...capturedSourcePath.split("/")));
  const missingCapturedOriginal = await validateArchive(dataDir, await buildArchiveInventory(dataDir));
  assert.equal(missingCapturedOriginal.valid, false);
  assert.ok(missingCapturedOriginal.errors.some((error) => error.includes(`Missing referenced media: ${capturedSourcePath}`)));
});

test("archive paths reject traversal and symlink parents", async (t) => {
  const root = await fixtureDirectory(t, "wardrobe-paths-");
  const dataDir = path.join(root, "data");
  await mkdir(path.join(dataDir, "imported"), { recursive: true });
  await writeFile(path.join(dataDir, "imported", "item.png"), Buffer.from("image"));
  await assert.rejects(() => resolveArchiveFile(dataDir, "imported/../../outside.png"), /Unsafe archive path/);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.png"), Buffer.from("secret"));
  await rm(path.join(dataDir, "imported"), { recursive: true });
  await (await import("node:fs/promises")).symlink(outside, path.join(dataDir, "imported"));
  await assert.rejects(() => resolveArchiveFile(dataDir, "imported/secret.png"), /symbolic link/);
});

test("external JPEG references become portable PNGs while byte-exact originals and actual MIME survive copy", async (t) => {
  const root = await fixtureDirectory(t, "wardrobe-reference-");
  const dataDir = path.join(root, "data");
  const external = path.join(root, "private-model.jpg");
  const jpeg = await sharp({ create: { width: 12, height: 18, channels: 3, background: "#694b32" } }).jpeg().toBuffer();
  await writeFile(external, jpeg);
  const setting = (name, fallback = "") => name === "WARDROBE_MODEL_REFERENCE" ? "private-model.jpg" : fallback;
  await prepareArchiveDirectory({ root, dataDir, setting });
  const configuredReference = await readReferenceBytes({ root, dataDir, setting, kind: "full" });
  assert.equal(configuredReference.mime, "image/jpeg", "configured source bytes keep their actual MIME type");

  const preserved = await preserveOriginal({ dataDir, bytes: jpeg, filename: "private-model.jpg", mime: "image/png" });
  assert.equal(preserved.extension, ".jpg");
  assert.equal(preserved.mime, "image/jpeg");
  assert.deepEqual(await readFile(path.join(dataDir, preserved.path)), jpeg);
  const canonical = await readFile(path.join(dataDir, "model-reference.png"));
  assert.equal((await sharp(canonical).metadata()).format, "png");

  const copiedRoot = await fixtureDirectory(t, "wardrobe-reference-copy-");
  const copiedDataDir = path.join(copiedRoot, "data");
  await cp(dataDir, copiedDataDir, { recursive: true });
  await rm(external, { force: true });
  const reference = await readReferenceBytes({ root: copiedRoot, dataDir: copiedDataDir, setting, kind: "full" });
  assert.equal(reference.mime, "image/png");
  assert.equal((await sharp(reference.data).metadata()).format, "png");
  const inventory = await buildArchiveInventory(copiedDataDir);
  assert.ok(inventory.files.some((entry) => entry.path === preserved.path && entry.sha256 === sha256(jpeg)));
  assert.ok(inventory.files.some((entry) => entry.path === "model-reference.png"));
});

test("canonical model references reject symlinks during runtime lookup and archive preparation", async (t) => {
  const root = await fixtureDirectory(t, "wardrobe-reference-symlink-");
  const dataDir = path.join(root, "custom-data");
  const external = path.join(root, "external.png");
  await mkdir(dataDir, { recursive: true });
  const png = await sharp({ create: { width: 10, height: 12, channels: 3, background: "#684a32" } }).png().toBuffer();
  await writeFile(external, png);
  await symlink(external, path.join(dataDir, "model-reference.png"));
  const setting = (name, fallback = "") => name === "WARDROBE_DATA_DIR" ? "custom-data" : fallback;

  await assert.rejects(readReferenceBytes({ root, dataDir, setting, kind: "full" }), /symbolic link/);
  await assert.rejects(prepareArchiveDirectory({ root, dataDir, setting }), /symbolic link/);
  await assert.rejects(buildArchiveInventory(dataDir), /symbolic link/);
});

test("drape portrait resolves the canonical reference from a copied custom archive", async (t) => {
  const root = await fixtureDirectory(t, "wardrobe-drape-copy-");
  const dataDir = path.join(root, "custom-archive");
  const publicDrapesDir = path.join(root, "public", "drapes");
  await mkdir(dataDir, { recursive: true });
  const reference = await sharp({ create: { width: 24, height: 32, channels: 3, background: "#ad866b" } }).png().toBuffer();
  await writeFile(path.join(dataDir, "model-reference.png"), reference);
  const setting = (name, fallback = "") => name === "WARDROBE_DATA_DIR" ? "custom-archive" : name === "WARDROBE_MODEL_REFERENCE" ? "missing-on-this-install.png" : fallback;
  const subject = await prepareSubject(root, publicDrapesDir, { dataDir, setting });
  assert.equal(subject.isFaceReference, false);
  assert.equal(subject.url, "/drapes/subject.webp");
  assert.equal((await sharp(path.join(publicDrapesDir, "subject.webp")).metadata()).format, "webp");
});

test("agent source capture walks nested folders and distinguishes repeated basenames", async (t) => {
  const root = await fixtureDirectory(t, "wardrobe-agent-capture-");
  const inputDir = path.join(root, "photos");
  await mkdir(path.join(inputDir, "a"), { recursive: true });
  await mkdir(path.join(inputDir, "b"), { recursive: true });
  const first = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  const second = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#654321" } }).jpeg().toBuffer();
  await writeFile(path.join(inputDir, "a", "IMG.jpg"), first);
  await writeFile(path.join(inputDir, "b", "IMG.jpg"), second);
  const outputFile = path.join(root, "review", "sources.json");
  const script = path.resolve("scripts/capture-import-sources.mjs");
  const { stdout } = await execFile(process.execPath, [script, "--repo", root, "--input", inputDir, "--output", outputFile], {
    env: { PATH: process.env.PATH || "", WARDROBE_DATA_DIR: "data" },
  });
  const captured = JSON.parse(stdout);
  assert.equal(captured.count, 2);
  assert.deepEqual(captured.sources.map((source) => source.sourceRef), ["a/IMG.jpg", "b/IMG.jpg"]);
  for (const source of captured.sources) {
    const bytes = await readFile(path.join(root, "data", source.path));
    assert.equal(bytes.length, source.size);
    assert.equal(sha256(bytes), source.sha256);
    assert.equal(source.mime, "image/jpeg");
  }
  assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")).sources, captured.sources);
});

test("deleting a garment prunes only the originals nothing else still cites", async (t) => {
  const dataDir = await fixtureDirectory(t, "wardrobe-prune-originals-");
  const png = (r) => sharp({ create: { width: 2, height: 2, channels: 3, background: { r, g: 0, b: 0 } } }).png().toBuffer();
  const shared = await preserveOriginal({ dataDir, bytes: await png(10), filename: "shared.png" });
  const own = await preserveOriginal({ dataDir, bytes: await png(20), filename: "own.png" });
  const pending = await preserveOriginal({ dataDir, bytes: await png(30), filename: "pending.png" });
  const fresh = await preserveOriginal({ dataDir, bytes: await png(40), filename: "fresh.png" });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  for (const original of [shared, own, pending]) await utimes(path.join(dataDir, original.path), old, old);

  const removed = { id: "import-a", sourceOriginal: own.path, sourceOriginals: [shared.path, pending.path, fresh.path], references: [{ original: `/api/archive/assets/${shared.path}` }] };
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([{ id: "import-b", variants: [{ sourceRefs: [shared.path] }] }]));
  await mkdir(path.join(dataDir, "jobs", "job-1"), { recursive: true });
  await writeFile(path.join(dataDir, "jobs", "job-1", "job.json"), JSON.stringify({ internal: { sourceOriginal: pending.path } }));

  assert.deepEqual(await pruneUnreferencedOriginals(dataDir, removed), [own.path]);
  await assert.rejects(access(path.join(dataDir, own.path)));
  for (const kept of [shared, pending, fresh]) await access(path.join(dataDir, kept.path));
});
