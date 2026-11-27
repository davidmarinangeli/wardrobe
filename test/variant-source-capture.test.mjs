import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import test from "node:test";

import { variantApi } from "../scripts/variant-api.mjs";

async function pluginMiddleware(plugin, root) {
  let middleware;
  await plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  return middleware;
}

async function request(middleware, url, method, value) {
  const req = Readable.from([Buffer.from(JSON.stringify(value))]);
  req.url = url;
  req.method = method;
  const response = { statusCode: 200, setHeader() {}, end(body = "") { this.body = body; } };
  await middleware(req, response, () => { response.statusCode = 404; response.end(); });
  return { status: response.statusCode, value: JSON.parse(response.body || "{}") };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("photo variant and reference append preserve original JPEGs before follow-on work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-variant-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const importedDir = path.join(root, "imported");
  await mkdir(importedDir, { recursive: true });
  const model = await sharp({ create: { width: 12, height: 18, channels: 3, background: "#8a6a55" } }).png().toBuffer();
  const cutout = await sharp({ create: { width: 12, height: 18, channels: 4, background: { r: 23, g: 45, b: 67, alpha: 1 } } }).png().toBuffer();
  await writeFile(path.join(root, "model.png"), model);
  await writeFile(path.join(importedDir, "shirt.png"), cutout);
  await writeFile(path.join(root, "library.json"), JSON.stringify([{
    id: "capture-shirt",
    name: "Blue shirt",
    part: "upperbody",
    color: "#172d43",
    tags: [],
    defaultVariantId: "capture-shirt-standard",
    variants: [{
      id: "capture-shirt-standard",
      name: "Standard",
      image: "/api/import/library/shirt.png",
      approvalStatus: "approved",
      assetRevision: 1,
      cutout: { image: "/api/import/library/shirt.png", status: "current", revision: 1 },
    }],
    references: [],
  }]));
  const middleware = await pluginMiddleware(variantApi({ env: {
    WARDROBE_DATA_DIR: ".",
    WARDROBE_MODEL_REFERENCE: "model.png",
    OPENAI_API_KEY: "mock-key",
    AI_PROVIDER: "openai",
  } }), root);

  const originalFetch = globalThis.fetch;
  const variantJpeg = await sharp({ create: { width: 18, height: 20, channels: 3, background: "#456789" } }).jpeg().toBuffer();
  const variantDigest = digest(variantJpeg);
  let aiSawSource = false;
  let signalAi;
  const aiCalled = new Promise((resolve) => { signalAi = resolve; });
  globalThis.fetch = async () => {
    assert.deepEqual(await readFile(path.join(root, "originals", `${variantDigest}.jpg`)), variantJpeg);
    aiSawSource = true;
    signalAi(true);
    throw new Error("mock stops after verifying source durability");
  };
  try {
    const variantResponse = await request(middleware, "/api/wardrobe/items/capture-shirt/variants", "POST", {
      id: "photo-variant",
      name: "Summer photo",
      imageDataUrl: `data:image/jpeg;base64,${variantJpeg.toString("base64")}`,
      filename: "a/IMG.jpg",
    });
    assert.equal(variantResponse.status, 202, JSON.stringify(variantResponse.value));
    assert.ok((await Promise.race([aiCalled, new Promise((resolve) => setTimeout(() => resolve(false), 1000))])));
    assert.equal(aiSawSource, true);

    const referenceJpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#6a4b32" } }).jpeg().toBuffer();
    const referenceResponse = await request(middleware, "/api/wardrobe/items/capture-shirt/references", "POST", {
      id: "side-reference",
      imageDataUrl: `data:image/jpeg;base64,${referenceJpeg.toString("base64")}`,
      filename: "b/IMG.jpg",
    });
    assert.equal(referenceResponse.status, 201, JSON.stringify(referenceResponse.value));
    const originalPath = referenceResponse.value.original.replace("/api/archive/assets/", "");
    assert.match(originalPath, /^originals\/[a-f0-9]{64}\.jpg$/);
    assert.deepEqual(await readFile(path.join(root, originalPath)), referenceJpeg);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
