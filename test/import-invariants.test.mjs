import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";

import { applyPreparedManifest, createIndependentCandidates, writePreparedManifest } from "../scripts/bulk-import.mjs";
import { wardrobeImportApi } from "../scripts/import-job-api.mjs";

const execFile = promisify(execFileCallback);
const PNG = await sharp({
  create: { width: 2, height: 2, channels: 4, background: { r: 17, g: 34, b: 51, alpha: 0 } },
}).composite([{
  input: Buffer.from([17, 34, 51, 255]),
  raw: { width: 1, height: 1, channels: 4 },
}]).png().toBuffer();

function legacyUuid(bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function metadata(name = "Navy shirt") {
  return { name, part: "upperbody", color: "#112233", secondaryColor: null, tags: ["cotton"] };
}

test("bulk manifests keep identical detections as independent records with unique assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-independent-manifest-"));
  const manifestFile = path.join(root, "manifest.json");
  const generated = [
    { importId: "11111111-1111-4111-8111-111111111111", metadata: metadata(), garmentBuffer: PNG, modeledBuffer: null, sourceFiles: ["one.jpg"] },
    { importId: "22222222-2222-4222-8222-222222222222", metadata: metadata(), garmentBuffer: PNG, modeledBuffer: null, sourceFiles: ["two.jpg"] },
  ];

  const prepared = await writePreparedManifest({ generated, manifestFile });
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.items.length, 2);
  assert.notEqual(manifest.items[0].slug, manifest.items[1].slug);
  assert.notEqual(manifest.items[0].variants[0].file, manifest.items[1].variants[0].file);
  assert.deepEqual(manifest.items.map((item) => item.importId), generated.map((item) => item.importId));
  assert.equal((await readdir(prepared.itemsDir)).length, 2);

  const dataDir = path.join(root, "data");
  await applyPreparedManifest({ manifestFile, itemsDir: prepared.itemsDir, modeledDir: prepared.modeledDir, dataDir });
  const first = await readFile(path.join(dataDir, "library.json"), "utf8");
  await applyPreparedManifest({ manifestFile, itemsDir: prepared.itemsDir, modeledDir: prepared.modeledDir, dataDir });
  const second = await readFile(path.join(dataDir, "library.json"), "utf8");
  assert.equal(second, first, "reapplying an unchanged manifest is idempotent");

  const records = JSON.parse(second);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.importJobId), generated.map((item) => item.importId));
  assert.notEqual(records[0].id, records[1].id);
  assert.notEqual(records[0].image, records[1].image);
  assert.deepEqual(records.map((record) => record.variants.map((variant) => variant.name)), [["Standard"], ["Standard"]]);
});

test("bulk manifest production rejects duplicate importIds before writing assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-duplicate-import-id-"));
  const manifestFile = path.join(root, "manifest.json");
  const entry = { importId: "same-candidate", metadata: metadata(), garmentBuffer: PNG, modeledBuffer: null, sourceFiles: ["photo.jpg"] };
  await assert.rejects(
    () => writePreparedManifest({ generated: [entry, { ...entry, sourceFiles: ["other.jpg"] }], manifestFile }),
    /Duplicate importId "same-candidate"/,
  );
  await assert.rejects(() => readdir(path.join(root, "items")), { code: "ENOENT" });
});

test("deterministic importer uses importId instead of identical PNG content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-import-id-"));
  const itemsDir = path.join(root, "items");
  const dataDir = path.join(root, "data");
  const manifestFile = path.join(root, "manifest.json");
  await mkdir(itemsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "wardrobe" }));
  await writeFile(path.join(dataDir, "library.json"), "[]\n");
  await writeFile(path.join(itemsDir, "first.png"), PNG);
  await writeFile(path.join(itemsDir, "second.png"), PNG);
  await writeFile(manifestFile, JSON.stringify({
    version: 2,
    items: [
      { slug: "navy-shirt-1", importId: "11111111-1111-4111-8111-111111111111", name: "Navy shirt", part: "upperbody", color: "#112233", status: "accepted", variants: [{ id: "navy-shirt-1-standard", name: "Standard", file: "first.png" }] },
      { slug: "navy-shirt-2", importId: "22222222-2222-4222-8222-222222222222", name: "Navy shirt", part: "upperbody", color: "#112233", status: "accepted", variants: [{ id: "navy-shirt-2-standard", name: "Standard", file: "second.png" }] },
    ],
  }, null, 2));

  const script = path.resolve(".agents/skills/import-clothes/scripts/import-to-wardrobe.mjs");
  await execFile(process.execPath, [script, "--repo", root, "--items", itemsDir, "--manifest", manifestFile]);
  const first = await readFile(path.join(dataDir, "library.json"), "utf8");
  await execFile(process.execPath, [script, "--repo", root, "--items", itemsDir, "--manifest", manifestFile]);
  const second = await readFile(path.join(dataDir, "library.json"), "utf8");
  assert.equal(second, first, "retrying the same manifest must not change the records");
  const records = JSON.parse(second);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.id), [
    "import-11111111-1111-4111-8111-111111111111",
    "import-22222222-2222-4222-8222-222222222222",
  ]);
  assert.notEqual(records[0].image, records[1].image);
  assert.deepEqual(records.map((record) => record.variants.map((variant) => variant.name)), [["Standard"], ["Standard"]]);
});

test("legacy manifests without importId keep matching old hash-identified records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-legacy-import-"));
  const itemsDir = path.join(root, "items");
  const dataDir = path.join(root, "data");
  const manifestFile = path.join(root, "manifest.json");
  await mkdir(itemsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(itemsDir, "shirt.png"), PNG);
  const uuid = legacyUuid(PNG);
  const legacyId = `import-${uuid}`;
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([{ id: legacyId, name: "Existing shirt", part: "upperbody", color: "#112233", image: "/old.png" }]));
  await writeFile(manifestFile, JSON.stringify({
    version: 2,
    items: [{ slug: "shirt", name: "Updated shirt", part: "upperbody", color: "#112233", status: "accepted", variants: [{ id: "shirt-standard", name: "Standard", file: "shirt.png" }] }],
  }));

  await applyPreparedManifest({ manifestFile, itemsDir, dataDir });
  const bulkRecords = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
  assert.equal(bulkRecords.length, 1);
  assert.equal(bulkRecords[0].id, legacyId);
  assert.equal(bulkRecords[0].name, "Updated shirt");

  const deterministicRoot = await mkdtemp(path.join(tmpdir(), "wardrobe-legacy-script-"));
  const deterministicItems = path.join(deterministicRoot, "items");
  const deterministicData = path.join(deterministicRoot, "data");
  const deterministicManifest = path.join(deterministicRoot, "manifest.json");
  await mkdir(deterministicItems, { recursive: true });
  await mkdir(deterministicData, { recursive: true });
  await writeFile(path.join(deterministicRoot, "package.json"), JSON.stringify({ name: "wardrobe" }));
  await writeFile(path.join(deterministicItems, "shirt.png"), PNG);
  await writeFile(path.join(deterministicData, "library.json"), JSON.stringify([{ id: legacyId, name: "Existing shirt", part: "upperbody", color: "#112233", image: "/old.png" }]));
  await writeFile(deterministicManifest, JSON.stringify({
    version: 2,
    items: [{ slug: "shirt", name: "Updated shirt", part: "upperbody", color: "#112233", status: "accepted", variants: [{ id: "shirt-standard", name: "Standard", file: "shirt.png" }] }],
  }));
  const script = path.resolve(".agents/skills/import-clothes/scripts/import-to-wardrobe.mjs");
  await execFile(process.execPath, [script, "--repo", deterministicRoot, "--items", deterministicItems, "--manifest", deterministicManifest]);
  const deterministicRecords = JSON.parse(await readFile(path.join(deterministicData, "library.json"), "utf8"));
  assert.equal(deterministicRecords.length, 1);
  assert.equal(deterministicRecords[0].id, legacyId);
  assert.equal(deterministicRecords[0].name, "Updated shirt");
});

test("bulk importer contains no cross-detection deduplication path", async () => {
  const candidates = createIndependentCandidates([{ crop: PNG, metadata: metadata() }, { crop: PNG, metadata: metadata() }]);
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].importId, candidates[1].importId);
  const source = await readFile(path.resolve("scripts/bulk-import.mjs"), "utf8");
  assert.doesNotMatch(source, /findDuplicateGroups|geminiFindDuplicates|openAIFindDuplicates|normalizeGroups|MAX_DEDUP_ITEMS/);
  assert.match(source, /allItems\.map\(\(item\) => limit/);
});

test("web importer still creates one job for each detection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-web-import-jobs-"));
  await writeFile(path.join(root, "model.png"), PNG);
  const plugin = wardrobeImportApi({ env: { OPENAI_API_KEY: "test-key", WARDROBE_MODEL_REFERENCE: "model.png" } });
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(next) { handler = next; } } });
  assert.ok(handler);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ output_text: JSON.stringify({ items: [
    { ...metadata("First shirt"), secondaryColor: null, worn: false, rotationDegrees: 0, boundingBox: { x: 0, y: 0, width: 500, height: 1000 } },
    { ...metadata("Second shirt"), secondaryColor: null, worn: false, rotationDegrees: 0, boundingBox: { x: 500, y: 0, width: 500, height: 1000 } },
  ] }) });
  try {
    const request = Readable.from([Buffer.from(JSON.stringify({ imageDataUrl: `data:image/png;base64,${PNG.toString("base64")}` }))]);
    request.method = "POST";
    request.url = "/api/import/jobs";
    const response = { statusCode: 200, body: "", setHeader() {}, end(value) { this.body = value; } };
    await handler(request, response, () => {});
    assert.equal(response.statusCode, 202, response.body);
    const result = JSON.parse(response.body);
    assert.equal(result.jobs.length, 2);
    assert.deepEqual(result.jobs.map((job) => job.metadata.name), ["First shirt", "Second shirt"]);
    assert.notEqual(result.jobs[0].id, result.jobs[1].id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
