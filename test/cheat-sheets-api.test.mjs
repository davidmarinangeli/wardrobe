import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { cheatSheetsApi, cheatSheetSourceFingerprint } from "../scripts/cheat-sheets-api.mjs";
import { atomicJson } from "../scripts/import-job-api.mjs";
import { buildCheatSheetLayout } from "../shared/cheat-sheet-layout.mjs";
import { cheatSheetSourceFingerprint as clientSourceFingerprint } from "../src/cheat-sheet-renderer.js";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

async function pluginMiddleware(plugin, root) {
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
  const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || "");
  const type = response.headers["content-type"] || "";
  return { status: response.statusCode, response, value: type.includes("application/json") ? JSON.parse(body.toString("utf8")) : body };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function beautifyFixture(t, generateImage, extraOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-beautify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "imported"));
  const cutout = await sharp({ create: { width: 20, height: 30, channels: 4, background: "#406090" } }).png().toBuffer();
  await writeFile(path.join(root, "imported", "shirt.png"), cutout);
  const item = {
    id: "shirt", name: "Blue shirt", part: "upperbody", defaultVariantId: "standard", references: [],
    variants: [{ id: "standard", name: "Standard", approvalStatus: "approved", assetRevision: 1, cutout: { image: "/api/import/library/shirt.png", status: "current", revision: 1 } }],
  };
  await writeFile(path.join(root, "library.json"), JSON.stringify([item]));
  const pieces = [{ itemId: "shirt", variantId: "standard" }];
  const sources = [{ ...pieces[0], assetHash: sha256(cutout), assetRevision: 1, cutoutRevision: 1 }];
  const bands = await Promise.all([600, 2400].map(async (height, index) => ({
    kind: index ? "row" : "title", groupId: index ? buildCheatSheetLayout([item]).rows[0].groupId : undefined, itemIds: index ? ["shirt"] : [],
    dataUrl: `data:image/png;base64,${(await sharp({ create: { width: 2400, height, channels: 3, background: "#eeeeee" } }).png().toBuffer()).toString("base64")}`,
  })));
  const payload = { title: "Autunno in montagna", description: "Trekking nelle Dolomiti", pieces, bands, sourceFingerprint: cheatSheetSourceFingerprint("Autunno in montagna", sources, "Trekking nelle Dolomiti") };
  const middleware = await pluginMiddleware(cheatSheetsApi({ ...extraOptions, env: { WARDROBE_DATA_DIR: root, OPENAI_API_KEY: "fixture-key", AI_PROVIDER: "openai", ...extraOptions.env }, generateImage }), root);
  const created = await request(middleware, "/api/cheat-sheets", "POST", payload);
  assert.equal(created.status, 201);
  return { root, middleware, sheet: created.value.sheet, payload, sources };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail("Timed out waiting for image generation");
}

async function waitForStatus(middleware, id, status) {
  return waitFor(async () => {
    const response = await request(middleware, `/api/cheat-sheets/${id}`);
    return response.value.sheet?.beautifyStatus === status && response.value.sheet;
  });
}

test("cheat sheet API composes, revisions, downloads and deletes local sheets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-cheat-sheets-"));
  const imported = path.join(root, "imported");
  await mkdir(imported, { recursive: true });
  let cutout = await sharp({ create: { width: 24, height: 36, channels: 4, background: { r: 40, g: 90, b: 140, alpha: 1 } } }).png().toBuffer();
  await writeFile(path.join(imported, "shirt.png"), cutout);

  const item = {
    id: "sheet-shirt",
    name: "Blue shirt",
    part: "upperbody",
    defaultVariantId: "shirt-default",
    variants: [{
      id: "shirt-default",
      name: "Standard",
      image: "/api/import/library/shirt.png",
      approvalStatus: "approved",
      assetRevision: 7,
      cutout: { image: "/api/import/library/shirt.png", status: "current", revision: 3 },
    }],
    references: [],
  };
  await writeFile(path.join(root, "library.json"), JSON.stringify([item]));

  const layout = buildCheatSheetLayout([item]);
  const titleBand = await sharp({ create: { width: 2400, height: 800, channels: 3, background: "#e02020" } }).png().toBuffer();
  const rowBand = await sharp({ create: { width: 2400, height: 2200, channels: 3, background: "#2060e0" } }).png().toBuffer();
  const pieces = [{ itemId: item.id, variantId: "shirt-default" }];
  const sourcePieces = [{
    ...pieces[0],
    assetHash: sha256(cutout),
    assetRevision: 7,
    cutoutRevision: 3,
  }];
  const sourceFingerprint = cheatSheetSourceFingerprint("Weekend", sourcePieces);
  const bands = [
    { kind: "title", itemIds: [], dataUrl: `data:image/png;base64,${titleBand.toString("base64")}` },
    { kind: "row", groupId: layout.rows[0].groupId, itemIds: [item.id], dataUrl: `data:image/png;base64,${rowBand.toString("base64")}` },
  ];
  const payload = { title: "Weekend", pieces, sourceFingerprint, bands };

  let failNextMetadataWrite = false;
  const middleware = await pluginMiddleware(cheatSheetsApi({
    env: { WARDROBE_DATA_DIR: root },
    atomicJson: async (file, value) => {
      if (failNextMetadataWrite) { failNextMetadataWrite = false; throw Object.assign(new Error("Simulated atomic metadata failure"), { code: "EISDIR" }); }
      return atomicJson(file, value);
    },
  }), root);

  const created = await request(middleware, "/api/cheat-sheets", "POST", payload);
  assert.equal(created.status, 201);
  assert.equal(created.value.sheet.title, "Weekend");
  assert.deepEqual(created.value.sheet.pieces, pieces.map((piece) => ({ ...piece, scale: 1 })));
  assert.equal(created.value.sheet.revision, 1);
  assert.ok(!("aiImage" in created.value.sheet));
  const savedAssets = await readdir(path.join(root, "cheat-sheets-assets"));
  assert.equal(savedAssets.length, 2);

  const id = created.value.sheet.id;
  const detail = await request(middleware, `/api/cheat-sheets/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.value.sheet.sourceFingerprint, sourceFingerprint);
  const list = await request(middleware, "/api/cheat-sheets");
  assert.equal(list.status, 200);
  assert.equal(list.value.sheets[0].id, id);

  const stale = await request(middleware, `/api/cheat-sheets/${id}`, "PUT", { ...payload, title: "Changed", expectedRevision: 8 });
  assert.equal(stale.status, 409);
  assert.equal((await request(middleware, `/api/cheat-sheets/${id}`)).value.sheet.revision, 1);

  const concurrentUpdates = await Promise.all(["Weekend edit A", "Weekend edit B"].map((title) => request(
    middleware,
    `/api/cheat-sheets/${id}`,
    "PUT",
    { ...payload, title, sourceFingerprint: cheatSheetSourceFingerprint(title, sourcePieces), expectedRevision: 1 },
  )));
  assert.deepEqual(concurrentUpdates.map((result) => result.status).sort(), [200, 409]);
  const updated = concurrentUpdates.find((result) => result.status === 200);
  assert.equal(updated.value.sheet.revision, 2);
  assert.match(updated.value.sheet.title, /^Weekend edit [AB]$/);
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 2, "replaced PNGs are collected after publication");

  const originalUrl = updated.value.sheet.originalImage;
  const downloadName = await request(middleware, `${originalUrl}?download=1&name=weekend%20edit.png`);
  assert.equal(downloadName.status, 200);
  assert.match(downloadName.response.headers["content-disposition"], /weekend-edit\.png/i);
  const downloadedMetadata = await sharp(Buffer.from(downloadName.value)).metadata();
  assert.equal(downloadedMetadata.width, 2400);
  assert.equal(downloadedMetadata.height, 3000);
  const outputBytes = Buffer.from(downloadName.value);
  const titleEdge = await sharp(outputBytes).extract({ left: 0, top: 799, width: 1, height: 1 }).raw().toBuffer();
  const rowStart = await sharp(outputBytes).extract({ left: 0, top: 800, width: 1, height: 1 }).raw().toBuffer();
  const rowEnd = await sharp(outputBytes).extract({ left: 2399, top: 2999, width: 1, height: 1 }).raw().toBuffer();
  assert.deepEqual([...titleEdge], [224, 32, 32, 255]);
  assert.deepEqual([...rowStart], [32, 96, 224, 255]);
  assert.deepEqual([...rowEnd], [32, 96, 224, 255]);

  const currentMetadata = await readFile(path.join(root, "cheat-sheets.json"));
  const currentOriginal = Buffer.from(downloadName.value);
  failNextMetadataWrite = true;
  const failedWrite = await request(middleware, `/api/cheat-sheets/${id}`, "PUT", {
    ...payload,
    title: "Persistence failure",
    sourceFingerprint: cheatSheetSourceFingerprint("Persistence failure", sourcePieces),
    expectedRevision: 2,
  });
  assert.equal(failedWrite.status, 500);
  assert.deepEqual(await readFile(path.join(root, "cheat-sheets.json")), currentMetadata);
  assert.equal((await request(middleware, `/api/cheat-sheets/${id}`)).value.sheet.revision, 2);
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 2, "failed publication cleans its prepared assets");
  const originalAfterFailure = await request(middleware, originalUrl);
  assert.equal(originalAfterFailure.status, 200);
  assert.deepEqual(Buffer.from(originalAfterFailure.value), currentOriginal);

  const libraryFile = path.join(root, "library.json");
  const originalLibrary = await readFile(libraryFile);
  const missingCutoutLibrary = JSON.parse(originalLibrary.toString("utf8"));
  missingCutoutLibrary[0].variants[0].cutout.status = "stale";
  await writeFile(libraryFile, JSON.stringify(missingCutoutLibrary));
  const changedVariant = await request(middleware, `/api/cheat-sheets/${id}`, "PUT", {
    ...payload,
    title: updated.value.sheet.title,
    sourceFingerprint: cheatSheetSourceFingerprint(updated.value.sheet.title, sourcePieces),
    expectedRevision: 2,
  });
  assert.equal(changedVariant.status, 409, "a missing or stale source cutout prevents a new composition");
  assert.equal((await request(middleware, originalUrl)).status, 200, "the saved PNG remains available without its source cutout");
  await writeFile(libraryFile, originalLibrary);

  const beforeMutation = await readFile(path.join(imported, "shirt.png"));
  cutout = await sharp(beforeMutation).composite([{ input: Buffer.from([255, 0, 0, 255]), raw: { width: 1, height: 1, channels: 4 }, left: 0, top: 0 }]).png().toBuffer();
  await writeFile(path.join(imported, "shirt.png"), cutout);
  const changedSource = await request(middleware, "/api/cheat-sheets", "POST", payload);
  assert.equal(changedSource.status, 409, "the source bytes are fingerprinted again on the server");
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 2, "a stale render publishes no orphan files");

  await writeFile(path.join(imported, "shirt.png"), beforeMutation);
  const deleted = await request(middleware, `/api/cheat-sheets/${id}`, "DELETE");
  assert.equal(deleted.status, 200);
  assert.equal((await request(middleware, `/api/cheat-sheets/${id}`)).status, 404);
  assert.equal((await request(middleware, originalUrl)).status, 404);
  assert.deepEqual(await readdir(path.join(root, "cheat-sheets-assets")), []);

  const invalidAsset = await request(middleware, "/api/cheat-sheets/assets/../library.json");
  assert.ok([404, 400].includes(invalidAsset.status));
});

test("piece scale defaults for legacy input, round trips, validates and invalidates AI on save", async (t) => {
  const generated = await sharp({ create: { width: 24, height: 30, channels: 3, background: "#708090" } }).png().toBuffer();
  const fixture = await beautifyFixture(t, async () => generated);
  const { middleware, sheet, payload, sources } = fixture;
  assert.equal(sheet.pieces[0].scale, 1, "legacy input without scale is stored at its default");

  const baseFingerprint = cheatSheetSourceFingerprint(payload.title, sources, payload.description);
  const scaledPiece = { ...payload.pieces[0], scale: 1.5 };
  const scaledSource = { ...sources[0], scale: 1.5 };
  const scaledFingerprint = cheatSheetSourceFingerprint(payload.title, [scaledSource], payload.description);
  assert.notEqual(scaledFingerprint, baseFingerprint);
  assert.equal(
    await clientSourceFingerprint(payload.title, [scaledPiece], [scaledSource], payload.description),
    scaledFingerprint,
    "browser and server fingerprints canonicalize the same per-piece scale",
  );

  for (const invalidScale of ["1.1", 0.49, 1.51, 0.55]) {
    const invalid = await request(middleware, "/api/cheat-sheets", "POST", {
      ...payload,
      pieces: [{ ...payload.pieces[0], scale: invalidScale }],
    });
    assert.equal(invalid.status, 400, `reject invalid scale ${String(invalidScale)}`);
  }

  const created = await request(middleware, "/api/cheat-sheets", "POST", {
    ...payload,
    pieces: [scaledPiece],
    sourceFingerprint: scaledFingerprint,
  });
  assert.equal(created.status, 201);
  assert.equal(created.value.sheet.pieces[0].scale, 1.5);
  const roundTrip = await request(middleware, `/api/cheat-sheets/${created.value.sheet.id}`);
  assert.equal(roundTrip.value.sheet.pieces[0].scale, 1.5);

  const started = await request(middleware, `/api/cheat-sheets/${created.value.sheet.id}/beautify`, "POST", { expectedRevision: 1 });
  assert.equal(started.status, 202);
  const finished = await waitForStatus(middleware, created.value.sheet.id, "ready");
  const resized = { ...scaledPiece, scale: 1.2 };
  const resizedSource = { ...scaledSource, scale: 1.2 };
  const savedResize = await request(middleware, `/api/cheat-sheets/${created.value.sheet.id}`, "PUT", {
    ...payload,
    pieces: [resized],
    sourceFingerprint: cheatSheetSourceFingerprint(payload.title, [resizedSource], payload.description),
    expectedRevision: finished.revision,
  });
  assert.equal(savedResize.status, 200);
  assert.equal(savedResize.value.sheet.pieces[0].scale, 1.2);
  assert.ok(!savedResize.value.sheet.aiImage, "saving a resized sheet invalidates its AI finish");
});

test("AI finish preserves the original, includes context, supports retry and invalidates on description edits", async (t) => {
  const generated = await sharp({ create: { width: 120, height: 150, channels: 3, background: "#b07030" } }).png().toBuffer();
  const calls = [];
  let fail = false;
  let complete;
  const fixture = await beautifyFixture(t, async (input) => {
    calls.push(input);
    if (fail) throw new Error("Fixture provider failed");
    return new Promise((resolve) => { complete = () => resolve(generated); });
  });
  const { middleware, root, sheet, payload, sources } = fixture;
  const endpoint = `/api/cheat-sheets/${sheet.id}/beautify`;
  const original = (await request(middleware, sheet.originalImage)).value;
  assert.equal(sheet.description, payload.description);
  assert.equal((await request(middleware, endpoint, "POST", { expectedRevision: 1, prompt: "" })).status, 400);
  assert.equal((await request(middleware, endpoint, "POST", { expectedRevision: 9 })).status, 409);
  const started = await request(middleware, endpoint, "POST", { expectedRevision: 1, prompt: "Use autumn scenery and elegant lettering", tier: "premium" });
  assert.equal(started.status, 202);
  assert.equal(started.value.sheet.beautifyStatus, "processing");
  assert.equal(started.value.sheet.beautifyTier, "premium");
  assert.equal((await request(middleware, endpoint, "POST", { expectedRevision: 1 })).status, 409);
  await waitFor(() => complete);
  assert.match(calls[0].prompt, /Autunno in montagna/);
  assert.match(calls[0].prompt, /Trekking nelle Dolomiti/);
  assert.match(calls[0].prompt, /^Use autumn scenery and elegant lettering/);
  assert.deepEqual(calls[0].data, original);
  assert.equal(calls[0].settings.tier, "premium");
  assert.equal(calls[0].settings.quality, "high");
  complete();
  let finished = await waitForStatus(middleware, sheet.id, "ready");
  assert.equal(finished.revision, 2);
  assert.equal(finished.originalImage, sheet.originalImage);
  assert.equal(finished.beautifyPrompt, "Use autumn scenery and elegant lettering");
  assert.equal(finished.beautifyTier, "premium");
  assert.deepEqual((await request(middleware, sheet.originalImage)).value, original);
  const download = await request(middleware, `${finished.aiImage}?download=1&name=autumn-ai.png`);
  assert.equal(download.status, 200);
  assert.match(download.response.headers["content-disposition"], /autumn-ai\.png/);
  const dimensions = await sharp(download.value).metadata();
  assert.equal(dimensions.width, 120);
  assert.equal(dimensions.height, 150);
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 4);

  const previousAi = finished.aiImage;
  fail = true;
  assert.equal((await request(middleware, endpoint, "POST", { expectedRevision: 2 })).status, 202);
  const failed = await waitForStatus(middleware, sheet.id, "error");
  assert.equal(failed.beautifyTier, "standard");
  assert.equal(failed.beautifyError, "Fixture provider failed");
  assert.equal(failed.aiImage, previousAi);
  assert.equal(failed.revision, 2);
  assert.equal((await request(middleware, previousAi)).status, 200);
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 4);

  fail = false;
  complete = null;
  assert.equal((await request(middleware, endpoint, "POST", { expectedRevision: 2, prompt: "New autumn finish" })).status, 202);
  await waitFor(() => complete);
  complete();
  finished = await waitForStatus(middleware, sheet.id, "ready");
  assert.equal(finished.revision, 3);
  assert.notEqual(finished.aiImage, previousAi);
  assert.equal((await request(middleware, previousAi)).status, 404);
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 4);

  const description = "Foggy mornings and warm autumn leaves";
  const changed = await request(middleware, `/api/cheat-sheets/${sheet.id}`, "PUT", {
    ...payload, description, expectedRevision: 3, sourceFingerprint: cheatSheetSourceFingerprint(payload.title, sources, description),
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.value.sheet.description, description);
  assert.ok(!changed.value.sheet.aiImage);
  assert.equal(changed.value.sheet.beautifyPrompt, "New autumn finish");
  assert.equal((await request(middleware, finished.aiImage)).status, 404);
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 2);
});

test("AI finish keeps the provider canvas and creates a full-content, unpadded thumbnail", async (t) => {
  const swatch = (color) => sharp({ create: { width: 30, height: 30, channels: 3, background: color } }).png().toBuffer();
  const generated = await sharp({ create: { width: 1600, height: 1024, channels: 3, background: "#28445a" } })
    .composite([
      { input: await swatch("#e83224"), left: 0, top: 0 },
      { input: await swatch("#27b34b"), left: 1570, top: 0 },
      { input: await swatch("#2469df"), left: 0, top: 994 },
      { input: await swatch("#e9c62e"), left: 1570, top: 994 },
    ]).png().toBuffer();
  const { middleware, sheet } = await beautifyFixture(t, async () => generated);
  const started = await request(middleware, `/api/cheat-sheets/${sheet.id}/beautify`, "POST", { expectedRevision: 1 });
  assert.equal(started.status, 202);
  const finished = await waitForStatus(middleware, sheet.id, "ready");

  const output = (await request(middleware, finished.aiImage)).value;
  const outputMetadata = await sharp(output).metadata();
  assert.equal(outputMetadata.width, 1600, "do not resize provider output onto the source sheet's canvas");
  assert.equal(outputMetadata.height, 1024);
  const outputCorners = await Promise.all([
    [0, 0], [1599, 0], [0, 1023], [1599, 1023],
  ].map(async ([left, top]) => [...await sharp(output).extract({ left, top, width: 1, height: 1 }).raw().toBuffer()]));
  assert.deepEqual(outputCorners, [[232, 50, 36, 255], [39, 179, 75, 255], [36, 105, 223, 255], [233, 198, 46, 255]], "keep content at all four provider-image edges");

  const thumbnail = (await request(middleware, finished.aiThumbnailImage)).value;
  const thumbnailMetadata = await sharp(thumbnail).metadata();
  assert.equal(thumbnailMetadata.width, 450);
  assert.equal(thumbnailMetadata.height, 288, "fit inside without adding white padding or cropping the landscape provider image");
  const thumbnailCorners = await Promise.all([
    [1, 1], [448, 1], [1, 286], [448, 286],
  ].map(async ([left, top]) => [...await sharp(thumbnail).removeAlpha().extract({ left, top, width: 1, height: 1 }).raw().toBuffer()]));
  for (const corner of thumbnailCorners) assert.notDeepEqual(corner, [255, 255, 255], "the thumbnail keeps provider content at each edge instead of a white letterbox margin");
});

test("AI finish passes the explicit OpenRouter model choice to generation", async (t) => {
  let settings;
  const { middleware, sheet } = await beautifyFixture(t, async (input) => {
    settings = input.settings;
    throw new Error("Generation probe");
  }, { env: { AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "fixture-router-key", OPENROUTER_IMAGE_MODEL: "fixture/router-model" } });
  const started = await request(middleware, `/api/cheat-sheets/${sheet.id}/beautify`, "POST", { expectedRevision: 1, tier: "openrouter" });
  assert.equal(started.status, 202);
  assert.equal(started.value.sheet.beautifyTier, "openrouter");
  await waitForStatus(middleware, sheet.id, "error");
  assert.equal(settings.tier, "openrouter");
  assert.equal(settings.model, "fixture/router-model");
});

test("AI finish rejects Gemini Premium in TEST before changing the sheet or starting generation", async (t) => {
  let calls = 0;
  const { middleware, sheet, root } = await beautifyFixture(t, async () => {
    calls += 1;
    throw new Error("Generation probe");
  }, { env: { AI_PROVIDER: "gemini", GEMINI_API_KEY_TEST: "fixture-test-key" } });
  await writeFile(path.join(root, "ai-mode.json"), JSON.stringify({ mode: "test" }));
  const endpoint = `/api/cheat-sheets/${sheet.id}/beautify`;
  const rejected = await request(middleware, endpoint, "POST", { expectedRevision: 1, tier: "premium" });
  assert.equal(rejected.status, 400);
  assert.match(rejected.value.error, /Premium quality needs PROD mode/);
  assert.equal(calls, 0);
  assert.deepEqual((await request(middleware, `/api/cheat-sheets/${sheet.id}`)).value.sheet, sheet);
  const started = await request(middleware, endpoint, "POST", { expectedRevision: 1, tier: "standard" });
  assert.equal(started.status, 202);
  await waitForStatus(middleware, sheet.id, "error");
  assert.equal(calls, 1);
});

test("a late AI result cannot overwrite a newer sheet edit", async (t) => {
  const generated = await sharp({ create: { width: 12, height: 15, channels: 3, background: "#777" } }).png().toBuffer();
  let complete;
  let calls = 0;
  const { middleware, sheet, root, payload, sources } = await beautifyFixture(t, async () => {
    calls += 1;
    if (calls > 1) throw new Error("Generation probe");
    return new Promise((resolve) => { complete = () => resolve(generated); });
  });
  const endpoint = `/api/cheat-sheets/${sheet.id}/beautify`;
  await request(middleware, endpoint, "POST", { expectedRevision: 1 });
  await waitFor(() => complete);
  const description = "A changed theme";
  const edited = await request(middleware, `/api/cheat-sheets/${sheet.id}`, "PUT", {
    ...payload, description, expectedRevision: 1, sourceFingerprint: cheatSheetSourceFingerprint(payload.title, sources, description),
  });
  assert.equal(edited.status, 200);
  complete();
  // The next request is accepted only after the previous background task ends.
  await waitFor(async () => (await request(middleware, endpoint, "POST", { expectedRevision: 2 })).status === 202);
  const current = await waitForStatus(middleware, sheet.id, "error");
  assert.equal(current.revision, 2);
  assert.equal(current.description, description);
  assert.equal(current.originalImage, edited.value.sheet.originalImage);
  assert.ok(!current.aiImage);
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 2);
});

test("failed AI asset publication is cleaned up and interrupted jobs become retryable on restart", async (t) => {
  const generated = await sharp({ create: { width: 12, height: 15, channels: 3, background: "#777" } }).png().toBuffer();
  let failPublication = false;
  const { middleware, sheet, root } = await beautifyFixture(t, async () => generated, {
    atomicJson: async (file, value) => {
      if (failPublication && value.some((entry) => entry.beautifyStatus === "ready")) {
        failPublication = false;
        throw new Error("Fixture metadata failure");
      }
      return atomicJson(file, value);
    },
  });
  failPublication = true;
  await request(middleware, `/api/cheat-sheets/${sheet.id}/beautify`, "POST", { expectedRevision: 1 });
  const failed = await waitForStatus(middleware, sheet.id, "error");
  assert.equal(failed.originalImage, sheet.originalImage);
  await waitFor(async () => (await readdir(path.join(root, "cheat-sheets-assets"))).length === 2);
  await writeFile(path.join(root, "cheat-sheets.json"), JSON.stringify([{ ...failed, beautifyStatus: "processing" }]));
  const restarted = await pluginMiddleware(cheatSheetsApi({ env: { WARDROBE_DATA_DIR: root } }), root);
  const restored = (await request(restarted, `/api/cheat-sheets/${sheet.id}`)).value.sheet;
  assert.equal(restored.beautifyStatus, "error");
  assert.match(restored.beautifyError, /interrupted/);
  assert.equal(restored.originalImage, sheet.originalImage);
});

test("deleting a beautified sheet removes both versions and thumbnails", async (t) => {
  const generated = await sharp({ create: { width: 12, height: 15, channels: 3, background: "#777" } }).png().toBuffer();
  const { middleware, sheet, root } = await beautifyFixture(t, async () => generated);
  await request(middleware, `/api/cheat-sheets/${sheet.id}/beautify`, "POST", { expectedRevision: 1 });
  const finished = await waitForStatus(middleware, sheet.id, "ready");
  assert.equal((await readdir(path.join(root, "cheat-sheets-assets"))).length, 4);
  assert.equal((await request(middleware, `/api/cheat-sheets/${sheet.id}`, "DELETE")).status, 200);
  assert.equal((await request(middleware, finished.aiImage)).status, 404);
  assert.equal((await request(middleware, finished.originalImage)).status, 404);
  assert.deepEqual(await readdir(path.join(root, "cheat-sheets-assets")), []);
});
