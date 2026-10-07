import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import test from "node:test";

import { colorProfileApi } from "../scripts/color-profile-api.mjs";
import { cheatSheetsApi } from "../scripts/cheat-sheets-api.mjs";
import { outfitsApi } from "../scripts/outfits-api.mjs";
import { variantApi } from "../scripts/variant-api.mjs";
import { wardrobeImportApi } from "../scripts/import-job-api.mjs";
import { preserveOriginal, readReferenceBytes, resolveArchiveFile } from "../scripts/archive-store.mjs";
import { DRAPE_SETS } from "../shared/draping.mjs";

async function fixtureRoot(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function middlewareFor(plugin, root) {
  let middleware;
  await plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  assert.ok(middleware);
  return middleware;
}

async function request(middleware, url, method = "GET", value) {
  const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
  req.url = url;
  req.method = method;
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, content) { this.headers[name.toLowerCase()] = content; },
    end(body = Buffer.alloc(0)) { this.body = body; },
  };
  await middleware(req, response, () => { response.statusCode = 404; response.end(); });
  const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || "");
  return {
    status: response.statusCode,
    headers: response.headers,
    bytes,
    value: response.headers["content-type"]?.includes("application/json") ? JSON.parse(bytes.toString("utf8")) : bytes,
  };
}

function mockResponse(value) {
  return { ok: true, status: 200, async json() { return value; } };
}

async function solidPixel(image) {
  const { data } = await sharp(image).resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data];
}

test("nested imported and original assets resolve through bounded HTTP routes", async (t) => {
  const root = await fixtureRoot(t, "wardrobe-nested-http-");
  const dataDir = path.join(root, "workspace");
  const nested = path.join(dataDir, "imported", "nested", "item.png");
  const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#2468ac" } }).png().toBuffer();
  await mkdir(path.dirname(nested), { recursive: true });
  await writeFile(nested, png);
  const jpeg = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#ac6824" } }).jpeg().toBuffer();
  const original = await preserveOriginal({ dataDir, bytes: jpeg, filename: "nested-source.jpg" });
  const middleware = await middlewareFor(wardrobeImportApi({ env: { WARDROBE_DATA_DIR: "workspace" } }), root);

  const imported = await request(middleware, "/api/import/library/nested/item.png");
  assert.equal(imported.status, 200);
  assert.equal(imported.headers["content-type"], "image/png");
  assert.deepEqual(imported.bytes, png);
  assert.equal(await resolveArchiveFile(dataDir, "/api/import/library/nested/item.png"), nested);
  const raw = await request(middleware, `/api/archive/assets/${original.path}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers["content-type"], "image/jpeg");
  assert.deepEqual(raw.bytes, jpeg);
  assert.ok([400, 404].includes((await request(middleware, "/api/archive/assets/imported/../../outside.png")).status));
});

test("unset face reference resolves the canonical custom archive image; explicit off disables it", async (t) => {
  const root = await fixtureRoot(t, "wardrobe-face-reference-");
  const dataDir = path.join(root, "custom-data");
  await mkdir(dataDir, { recursive: true });
  const face = await sharp({ create: { width: 16, height: 20, channels: 3, background: "#d08040" } }).png().toBuffer();
  await writeFile(path.join(dataDir, "model-reference-face.png"), face);
  const unset = (name, fallback = "") => name === "WARDROBE_DATA_DIR" ? "custom-data" : fallback;
  const found = await readReferenceBytes({ root, dataDir, setting: unset, kind: "face" });
  assert.equal(found?.mime, "image/png");
  assert.deepEqual(found?.data, face);
  const disabled = (name, fallback = "") => name === "WARDROBE_FACE_REFERENCE" ? "off" : unset(name, fallback);
  assert.equal(await readReferenceBytes({ root, dataDir, setting: disabled, kind: "face" }), null);
});

test("drape analysis renders from a custom archive and reaches the mocked AI endpoint", async (t) => {
  const root = await fixtureRoot(t, "wardrobe-drape-api-");
  const dataDir = path.join(root, "custom-data");
  await mkdir(dataDir, { recursive: true });
  const model = await sharp({ create: { width: 72, height: 96, channels: 3, background: "#b08060" } }).png().toBuffer();
  await writeFile(path.join(dataDir, "model-reference.png"), model);
  const env = {
    WARDROBE_DATA_DIR: "custom-data",
    WARDROBE_MODEL_REFERENCE: "missing-model.png",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "fixture-key",
    OPENAI_API_BASE_URL: "http://mock.invalid/v1",
  };
  const middleware = await middlewareFor(colorProfileApi({ env }), root);
  const winner = DRAPE_SETS.sisterDeep.candidates[0].id;
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return mockResponse({ output_text: JSON.stringify({ verdict: winner, explanation: "Fixture result" }) });
  };
  t.after(() => { globalThis.fetch = oldFetch; });

  const result = await request(middleware, "/api/color-profile/drapes/analyze", "POST", { setId: "sisterDeep", fabricIndex: 0 });
  assert.equal(result.status, 200, result.value?.error);
  assert.equal(result.value.winnerId, winner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://mock.invalid/v1/responses");
  assert.equal(calls[0].body.input[0].content.filter((part) => part.type === "input_image").length, DRAPE_SETS.sisterDeep.candidates.length);
});

test("cheat sheet media endpoint serves nested archived assets", async (t) => {
  const root = await fixtureRoot(t, "wardrobe-cheat-sheet-nested-route-");
  const dataDir = path.join(root, "data");
  const nested = path.join(dataDir, "cheat-sheets-assets", "nested", "thumbnail.png");
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#8c6034" } }).png().toBuffer();
  await mkdir(path.dirname(nested), { recursive: true });
  await writeFile(nested, png);
  const middleware = await middlewareFor(cheatSheetsApi({ env: { WARDROBE_DATA_DIR: "data" } }), root);
  const response = await request(middleware, "/api/cheat-sheets/assets/nested/thumbnail.png");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.deepEqual(response.bytes, png);
});

test("outfit generation reads nested garment paths and forwards their actual image content", async (t) => {
  const root = await fixtureRoot(t, "wardrobe-outfit-nested-generation-");
  const dataDir = path.join(root, "data");
  const nestedDir = path.join(dataDir, "imported", "nested");
  await mkdir(nestedDir, { recursive: true });
  const model = await sharp({ create: { width: 18, height: 24, channels: 3, background: "#2040d0" } }).png().toBuffer();
  const garment = await sharp({ create: { width: 18, height: 24, channels: 3, background: "#d02020" } }).png().toBuffer();
  const generated = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#80a060" } }).png().toBuffer();
  await writeFile(path.join(dataDir, "model-reference.png"), model);
  await writeFile(path.join(nestedDir, "shirt.png"), garment);
  const item = {
    id: "nested-shirt", name: "Nested shirt", part: "upperbody", defaultVariantId: "nested-shirt-standard",
    variants: [{ id: "nested-shirt-standard", name: "Standard", approvalStatus: "approved", cutout: { image: "/api/import/library/nested/shirt.png", status: "current", revision: 1 } }],
    references: [],
  };
  const outfitId = "77777777-7777-4777-8777-777777777777";
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([item]));
  await writeFile(path.join(dataDir, "outfits.json"), JSON.stringify([{ id: outfitId, name: "Nested look", pieces: [{ itemId: item.id, variantId: "nested-shirt-standard" }], itemIds: [item.id] }]));
  const nestedPreview = path.join(dataDir, "outfits-assets", "nested", "preview.png");
  await mkdir(path.dirname(nestedPreview), { recursive: true });
  await writeFile(nestedPreview, garment);
  const env = { WARDROBE_DATA_DIR: "data", WARDROBE_MODEL_REFERENCE: "data/model-reference.png", OPENAI_API_KEY: "fixture-key", OPENAI_API_BASE_URL: "http://mock.invalid/v1", OPENAI_IMAGE_ROUTE: "responses" };
  const middleware = await middlewareFor(outfitsApi({ env }), root);
  const nestedPreviewResponse = await request(middleware, "/api/outfits/assets/nested/preview.png");
  assert.equal(nestedPreviewResponse.status, 200);
  assert.equal(nestedPreviewResponse.headers["content-type"], "image/png");
  assert.deepEqual(nestedPreviewResponse.bytes, garment);
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (body.tools?.some((tool) => tool.type === "image_generation")) {
      return mockResponse({ output: [{ type: "image_generation_call", result: generated.toString("base64") }] });
    }
    return mockResponse({ output_text: JSON.stringify({ description: "Fixture outfit", tags: ["fixture"] }) });
  };
  t.after(() => { globalThis.fetch = oldFetch; });

  const started = await request(middleware, `/api/outfits/${outfitId}/modeled`, "POST", { tier: "standard" });
  assert.equal(started.status, 202);
  let saved;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    saved = JSON.parse(await readFile(path.join(dataDir, "outfits.json"), "utf8"))[0];
    if (saved.modeledImage && saved.modeledStatus === null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(saved.modeledImage, saved.modeledError);
  const imageRequest = calls.find((call) => call.body.tools?.some((tool) => tool.type === "image_generation"));
  assert.ok(imageRequest, "mock image generation was called");
  const imageUrls = imageRequest.body.input[0].content.filter((part) => part.type === "input_image").map((part) => part.image_url);
  assert.equal(imageUrls.length, 2, "model and nested garment both reach the generator");
  assert.deepEqual(await solidPixel(Buffer.from(imageUrls[0].split(",")[1], "base64")), [32, 64, 208]);
  assert.deepEqual(await solidPixel(Buffer.from(imageUrls[1].split(",")[1], "base64")), [208, 32, 32]);
});

test("variant generation resolves a nested cutout and distinctive reference from originals", async (t) => {
  const root = await fixtureRoot(t, "wardrobe-variant-nested-generation-");
  const dataDir = path.join(root, "data");
  const importedDir = path.join(dataDir, "imported", "wardrobe", "shirts");
  await mkdir(importedDir, { recursive: true });
  const model = await sharp({ create: { width: 18, height: 24, channels: 3, background: "#2040d0" } }).png().toBuffer();
  const reference = await sharp({ create: { width: 18, height: 24, channels: 3, background: "#d0b020" } }).jpeg().toBuffer();
  const garment = await sharp({ create: { width: 18, height: 24, channels: 3, background: "#20a040" } }).png().toBuffer();
  const generated = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#80a060" } }).png().toBuffer();
  await writeFile(path.join(dataDir, "model-reference.png"), model);
  await writeFile(path.join(importedDir, "cutout.png"), garment);
  const original = await preserveOriginal({ dataDir, bytes: reference, filename: "detail.jpg" });
  const item = {
    id: "shirt", name: "Green shirt", part: "upperbody", defaultVariantId: "shirt-standard",
    variants: [{ id: "shirt-standard", name: "Standard", approvalStatus: "approved", assetRevision: 1, cutout: { image: "/api/import/library/wardrobe/shirts/cutout.png", status: "current", revision: 1 } }],
    references: [{ id: "shirt-detail", scope: "item", distinctive: true, original: original.path, revision: 1 }],
  };
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([item]));
  const env = {
    WARDROBE_DATA_DIR: "data", WARDROBE_MODEL_REFERENCE: "data/model-reference.png",
    AI_PROVIDER: "gemini", GEMINI_API_KEY_PROD: "fixture-key", GEMINI_IMAGE_MODEL: "fixture-image",
  };
  const middleware = await middlewareFor(variantApi({ env }), root);
  const oldFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return mockResponse({ output_image: { data: generated.toString("base64") } });
  };
  t.after(() => { globalThis.fetch = oldFetch; });

  const started = await request(middleware, "/api/wardrobe/items/shirt/variants/shirt-standard/modeled", "POST", { tier: "standard" });
  assert.equal(started.status, 202);
  let saved;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    saved = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"))[0];
    if (saved.variants[0].modeledStatus === "approved") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(saved.variants[0].modeledStatus, "approved", saved.variants[0].modeledError);
  const imageParts = requestBody.input.filter((part) => part.type === "image");
  assert.equal(imageParts.length, 3, "model, external-original reference and nested garment reach the generator");
  const pixels = await Promise.all(imageParts.map((part) => solidPixel(Buffer.from(part.data, "base64"))));
  assert.deepEqual(pixels[0], [32, 64, 208]);
  assert.ok(Math.abs(pixels[1][0] - 208) <= 2 && Math.abs(pixels[1][1] - 176) <= 2 && Math.abs(pixels[1][2] - 32) <= 2, "the JPEG original is loaded from originals/ and reaches the model");
  assert.deepEqual(pixels[2], [32, 160, 64]);
});
