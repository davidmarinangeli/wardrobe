import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import test from "node:test";

import { cheatSheetsApi, cheatSheetSourceFingerprint } from "../scripts/cheat-sheets-api.mjs";
import { atomicJson } from "../scripts/import-job-api.mjs";
import { buildCheatSheetLayout } from "../shared/cheat-sheet-layout.mjs";

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
  assert.deepEqual(created.value.sheet.pieces, pieces);
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
