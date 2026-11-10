import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import test from "node:test";

import { buildArchiveInventory, validateArchive } from "../scripts/archive-store.mjs";
import { wardrobeImportApi, chooseChromaKey } from "../scripts/import-job-api.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const detection = {
  name: "Fixture shirt", part: "upperbody", color: "#336699", secondaryColor: null,
  tags: ["fixture"], worn: true, rotationDegrees: 0,
  boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
};

async function fixture(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "archive");
  const model = await sharp({ create: { width: 30, height: 40, channels: 3, background: "#876543" } }).png().toBuffer();
  const source = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#b09070" } }).jpeg().toBuffer();
  await writeFile(path.join(root, "model.png"), model);
  const plugin = wardrobeImportApi({ env: {
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "fixture-only-key",
    OPENAI_API_BASE_URL: "http://mock.invalid/v1",
    WARDROBE_MODEL_REFERENCE: "model.png",
    WARDROBE_DATA_DIR: dataDir,
  } });
  let middleware;
  await plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  assert.ok(middleware);
  return { root, dataDir, source, middleware };
}

async function request(middleware, url, method = "GET", value) {
  const body = value === undefined ? [] : [Buffer.from(JSON.stringify(value))];
  const req = Readable.from(body);
  req.url = url;
  req.method = method;
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = Buffer.alloc(0)) { this.body = value; },
  };
  await middleware(req, res, () => { res.statusCode = 404; res.end(); });
  const bytes = Buffer.from(res.body || "");
  return { status: res.statusCode, headers: res.headers, bytes, value: res.headers["content-type"]?.includes("application/json") ? JSON.parse(bytes.toString("utf8")) : null };
}

async function postSource(middleware, source) {
  return request(middleware, "/api/import/jobs", "POST", {
    filename: "fixture-look.jpg",
    imageDataUrl: `data:image/jpeg;base64,${source.toString("base64")}`,
  });
}

async function assertCapturedOriginal(dataDir, source) {
  const relative = `originals/${digest(source)}.jpg`;
  assert.deepEqual(await readFile(path.join(dataDir, relative)), source);
  const inventory = await buildArchiveInventory(dataDir);
  assert.ok(inventory.files.some((entry) => entry.path === relative && entry.sha256 === digest(source)));
  const validation = await validateArchive(dataDir, inventory);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
}

test("web import keeps raw upload bytes when mocked AI fails or finds zero garments", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const scenario of ["failure", "empty"]) {
    const { dataDir, source, middleware } = await fixture(t, `wardrobe-web-original-${scenario}-`);
    globalThis.fetch = async () => {
      if (scenario === "failure") throw new Error("fixture AI outage");
      return Response.json({ output_text: JSON.stringify({ items: [] }) });
    };
    const response = await postSource(middleware, source);
    if (scenario === "failure") assert.equal(response.status, 500);
    else {
      assert.equal(response.status, 202, response.bytes.toString("utf8"));
      assert.equal(response.value.noClothingDetected, true);
      assert.deepEqual(response.value.jobs, []);
    }
    await assertCapturedOriginal(dataDir, source);
  }
});

test("reject cleanup and completed web imports retain their raw source originals", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const rejected = await fixture(t, "wardrobe-web-original-reject-");
  globalThis.fetch = async () => Response.json({ output_text: JSON.stringify({ items: [detection] }) });
  const created = await postSource(rejected.middleware, rejected.source);
  assert.equal(created.status, 202, created.bytes.toString("utf8"));
  const rejectedId = created.value.jobs[0].id;
  const rejectResponse = await request(rejected.middleware, `/api/import/jobs/${rejectedId}/stages/crop/reject`, "POST", {});
  assert.equal(rejectResponse.status, 200, rejectResponse.bytes.toString("utf8"));
  assert.deepEqual(await readdir(path.join(rejected.dataDir, "jobs")), [], "rejected crop work is cleaned up");
  await assertCapturedOriginal(rejected.dataDir, rejected.source);

  const completed = await fixture(t, "wardrobe-web-original-complete-");
  const chromaKey = chooseChromaKey(detection.color);
  const chromaRgb = chromaKey.match(/[0-9a-f]{2}/gi).map((part) => Number.parseInt(part, 16));
  const generated = await sharp({ create: { width: 96, height: 96, channels: 3, background: chromaKey } })
    .composite([{ input: await sharp({ create: { width: 60, height: 72, channels: 3, background: "#eeeeee" } }).png().toBuffer(), left: 18, top: 12 }])
    .png().toBuffer();
  assert.equal(chromaRgb.length, 3);
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/responses")) return Response.json({ output_text: JSON.stringify({ items: [detection] }) });
    if (String(url).endsWith("/images/edits")) return Response.json({ data: [{ b64_json: generated.toString("base64") }] });
    throw new Error(`Unexpected mocked AI request: ${url}`);
  };
  const started = await postSource(completed.middleware, completed.source);
  assert.equal(started.status, 202, started.bytes.toString("utf8"));
  const jobId = started.value.jobs[0].id;
  const approvedCrop = await request(completed.middleware, `/api/import/jobs/${jobId}/stages/crop/approve`, "POST", {});
  assert.equal(approvedCrop.status, 200, approvedCrop.bytes.toString("utf8"));

  let reviewJob;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    reviewJob = await request(completed.middleware, `/api/import/jobs/${jobId}`);
    if (reviewJob.status !== 200) break;
    if (reviewJob.value.stages.garment.status === "review" || reviewJob.value.stages.garment.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reviewJob.status, 200, reviewJob.bytes.toString("utf8"));
  assert.equal(reviewJob.value.stages.garment.status, "review", reviewJob.value.stages.garment.error || "mocked garment generation did not reach review");
  const approvedGarment = await request(completed.middleware, `/api/import/jobs/${jobId}/stages/garment/approve`, "POST", {});
  assert.equal(approvedGarment.status, 200, approvedGarment.bytes.toString("utf8"));
  assert.equal(approvedGarment.value.status, "complete");
  await assertCapturedOriginal(completed.dataDir, completed.source);
  const library = JSON.parse(await readFile(path.join(completed.dataDir, "library.json"), "utf8"));
  assert.equal(library.length, 1);
  assert.equal(library[0].sourceOriginal, `originals/${digest(completed.source)}.jpg`);
  assert.equal(library[0].references[0].original, `originals/${digest(completed.source)}.jpg`);
});
