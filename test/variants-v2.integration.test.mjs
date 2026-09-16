import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { outfitsApi } from "../scripts/outfits-api.mjs";
import { variantApi } from "../scripts/variant-api.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const IMAGE_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const OUTFIT_UPDATE_ID = "11111111-1111-4111-8111-111111111111";
const OUTFIT_USED_ID = "22222222-2222-4222-8222-222222222222";
const OUTFIT_MISSING_ID = "33333333-3333-4333-8333-333333333333";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function pluginMiddleware(plugin, root) {
  let middleware;
  await plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  assert.ok(middleware);
  return middleware;
}

async function request(baseUrl, pathname, method = "GET", value) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: value === undefined ? undefined : { "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { status: response.status, value: await response.json().catch(() => ({})) };
}

async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for API job");
}

test("variant and outfit APIs enforce v2 invariants without external AI calls", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-v2-api-"));
  const imported = path.join(root, "imported");
  await mkdir(imported, { recursive: true });
  await writeFile(path.join(root, "model.png"), PNG);
  await writeFile(path.join(imported, "standard.png"), PNG);
  await writeFile(path.join(imported, "alt.png"), PNG);

  const item = {
    id: "item-1",
    name: "Shirt",
    part: "upperbody",
    defaultVariantId: "item-1-standard",
    variants: [
      { id: "item-1-standard", name: "Standard", image: "/api/import/library/standard.png", cutout: { image: "/api/import/library/standard.png", revision: 1, status: "current" }, approvalStatus: "approved", assetRevision: 1 },
      { id: "item-1-alt", name: "Alt", image: "/api/import/library/alt.png", cutout: { image: "/api/import/library/alt.png", revision: 1, status: "current" }, approvalStatus: "approved", assetRevision: 1 },
      { id: "item-1-pending", name: "Pending", image: "/api/import/library/standard.png", cutout: { image: "/api/import/library/standard.png", revision: 1, status: "current" }, approvalStatus: "pending" },
      { id: "item-1-rejected", name: "Rejected", image: "/api/import/library/standard.png", cutout: { image: "/api/import/library/standard.png", revision: 1, status: "current" }, approvalStatus: "rejected" },
      { id: "item-1-stale", name: "Stale", image: "/api/import/library/standard.png", cutout: { image: "/api/import/library/standard.png", revision: 1, status: "stale" }, approvalStatus: "approved" },
      { id: "item-1-missing", name: "Missing", approvalStatus: "approved", cutout: null },
    ],
    references: [],
  };
  const outfits = [
    { id: OUTFIT_UPDATE_ID, name: "Variant update", pieces: [{ itemId: item.id, variantId: "item-1-alt" }], modeledImage: "/old-update.png", modeledStatus: "approved", modeledError: null, modeledTier: "standard", description: "Old update", tags: ["old"] },
    { id: OUTFIT_USED_ID, name: "Used variant", pieces: [{ itemId: item.id, variantId: "item-1-alt" }], modeledImage: "/old-used.png", modeledStatus: "error", modeledError: "old", modeledTier: "premium", description: "Old used", tags: ["old"] },
    { id: OUTFIT_MISSING_ID, name: "Missing cutout", pieces: [{ itemId: item.id, variantId: "item-1-missing" }] },
  ];
  await writeFile(path.join(root, "library.json"), JSON.stringify([item]));
  await writeFile(path.join(root, "outfits.json"), JSON.stringify(outfits));

  const aiRequests = [];
  const aiServer = http.createServer(async (request, response) => {
    const requestBody = await readRequest(request);
    aiRequests.push(request.url);
    response.setHeader("Content-Type", "application/json");
    if (request.url.endsWith("/responses")) {
      const payload = JSON.parse(requestBody.toString("utf8") || "{}");
      if (payload.text?.format?.name === "wardrobe_items") {
        response.end(JSON.stringify({
          output_text: JSON.stringify({
            items: [{
              name: "Blue rolled-sleeve shirt",
              part: "upperbody",
              color: "#334455",
              secondaryColor: null,
              tags: ["rolled sleeves", "cotton"],
              worn: false,
              rotationDegrees: 0,
              boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
            }],
          }),
        }));
        return;
      }
      response.end(JSON.stringify({ output: [{ type: "image_generation_call", result: PNG.toString("base64") }] }));
      return;
    }
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
  });
  let aiBaseUrl;
  try {
    aiBaseUrl = await listen(aiServer);
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("local HTTP listeners are unavailable in this sandbox");
      return;
    }
    throw error;
  }
  t.after(() => close(aiServer));

  const env = {
    WARDROBE_DATA_DIR: root,
    WARDROBE_MODEL_REFERENCE: "model.png",
    OPENAI_API_KEY: "test-key",
    OPENAI_API_BASE_URL: `${aiBaseUrl}/v1`,
    OPENAI_IMAGE_ROUTE: "images",
  };
  const variantMiddleware = await pluginMiddleware(variantApi({ env }), root);
  const outfitMiddleware = await pluginMiddleware(outfitsApi({ env }), root);
  const apiServer = http.createServer((request, response) => {
    const middleware = request.url.startsWith("/api/outfits") ? outfitMiddleware : variantMiddleware;
    middleware(request, response, () => { response.statusCode = 404; response.end(); });
  });
  const baseUrl = await listen(apiServer);
  t.after(() => close(apiServer));

  const failedBefore = aiRequests.length;
  for (const variantId of ["item-1-pending", "item-1-rejected", "item-1-stale", "item-1-missing"]) {
    const result = await request(baseUrl, `/api/wardrobe/items/${item.id}/variants/${variantId}/modeled`, "POST", {});
    assert.equal(result.status, 409, variantId);
  }
  const missingOutfit = await request(baseUrl, `/api/outfits/${OUTFIT_MISSING_ID}/modeled`, "POST", {});
  assert.equal(missingOutfit.status, 409);
  assert.equal(aiRequests.length, failedBefore);

  const createdVariant = await request(baseUrl, `/api/wardrobe/items/${item.id}/variants`, "POST", {
    name: "Rolled sleeves",
    description: "Wear the sleeves rolled above the elbow",
    origin: "generated",
    sourceVariantId: "item-1-standard",
    tier: "standard",
  });
  assert.equal(createdVariant.status, 202);
  assert.equal(createdVariant.value.variants.find((variant) => variant.id === createdVariant.value.createdVariantId)?.processingStatus, "processing");
  const processedVariant = await waitFor(async () => {
    const library = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"));
    const variant = library[0].variants.find((candidate) => candidate.id === createdVariant.value.createdVariantId);
    return variant?.processingStatus === "approved" ? variant : null;
  });
  assert.equal(processedVariant.name, "Rolled sleeves");
  assert.deepEqual(processedVariant.tags, ["rolled sleeves", "cotton"]);
  assert.equal(processedVariant.cutout.status, "current");
  assert.equal(processedVariant.modeledStatus, "approved");
  assert.equal(processedVariant.modeledTier, "standard");

  const imagesStart = await request(baseUrl, `/api/wardrobe/items/${item.id}/variants/item-1-standard/modeled`, "POST", {});
  assert.equal(imagesStart.status, 202);
  await waitFor(async () => {
    const library = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"));
    return library[0].variants.find((variant) => variant.id === "item-1-standard")?.modeledStatus === "approved";
  });
  assert.ok(aiRequests.some((url) => url.endsWith("/v1/images/edits")));

  env.OPENAI_IMAGE_ROUTE = "responses";
  const responsesStart = await request(baseUrl, `/api/wardrobe/items/${item.id}/variants/item-1-standard/modeled`, "POST", {});
  assert.equal(responsesStart.status, 202);
  await waitFor(async () => {
    const library = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"));
    return library[0].variants.find((variant) => variant.id === "item-1-standard")?.modeledStatus === "approved";
  });
  assert.ok(aiRequests.some((url) => url.endsWith("/v1/responses")));

  const renamed = await request(baseUrl, `/api/outfits/${OUTFIT_UPDATE_ID}`, "PATCH", { name: "Renamed" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.value.modeledImage, "/old-update.png");
  assert.equal(renamed.value.description, "Old update");
  const variantChanged = await request(baseUrl, `/api/outfits/${OUTFIT_UPDATE_ID}`, "PATCH", { pieces: [{ itemId: item.id, variantId: "item-1-standard" }] });
  assert.equal(variantChanged.status, 200);
  assert.equal(variantChanged.value.modeledImage, null);
  assert.equal(variantChanged.value.modeledStatus, null);
  assert.equal(variantChanged.value.modeledError, null);
  assert.equal(variantChanged.value.modeledTier, null);
  assert.equal(variantChanged.value.description, null);
  assert.deepEqual(variantChanged.value.tags, []);

  const legacy = await request(baseUrl, "/api/outfits", "POST", { name: "Legacy", itemIds: [item.id] });
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.value.pieces, [{ itemId: item.id, variantId: "item-1-standard" }]);
  const v2 = await request(baseUrl, "/api/outfits", "POST", { name: "Explicit", pieces: [{ itemId: item.id, variantId: "item-1-alt" }] });
  assert.equal(v2.status, 201);
  assert.deepEqual(v2.value.pieces, [{ itemId: item.id, variantId: "item-1-alt" }]);
  const makeAltDefault = await request(baseUrl, `/api/wardrobe/items/${item.id}/default-variant`, "PUT", { variantId: "item-1-alt" });
  assert.equal(makeAltDefault.status, 200);
  const legacyPatch = await request(baseUrl, `/api/outfits/${legacy.value.id}`, "PATCH", { name: "Legacy renamed", itemIds: [item.id] });
  assert.equal(legacyPatch.status, 200);
  assert.deepEqual(legacyPatch.value.pieces, [{ itemId: item.id, variantId: "item-1-alt" }]);
  const explicitPatch = await request(baseUrl, `/api/outfits/${v2.value.id}`, "PATCH", { name: "Explicit renamed" });
  assert.equal(explicitPatch.status, 200);
  assert.deepEqual(explicitPatch.value.pieces, [{ itemId: item.id, variantId: "item-1-alt" }]);

  const scopedReference = await request(baseUrl, `/api/wardrobe/items/${item.id}/references`, "POST", { id: "ref-variant", scope: "variant", variantId: "item-1-alt", imageDataUrl: IMAGE_DATA_URL });
  assert.equal(scopedReference.status, 201);
  const afterScoped = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"))[0];
  assert.equal(afterScoped.variants.find((variant) => variant.id === "item-1-alt").cutout.status, "stale");
  assert.equal(afterScoped.variants.find((variant) => variant.id === "item-1-standard").cutout.status, "current");
  const scopedRevision = scopedReference.value.revision;
  const scopedUpdate = await request(baseUrl, `/api/wardrobe/items/${item.id}/references/ref-variant`, "PATCH", { imageDataUrl: IMAGE_DATA_URL });
  assert.equal(scopedUpdate.status, 200);
  const updatedReference = scopedUpdate.value.references.find((reference) => reference.id === "ref-variant");
  assert.equal(updatedReference.revision, scopedRevision + 1);
  assert.match(path.basename(new URL(updatedReference.asset, "http://localhost").pathname), /^reference-[0-9a-f-]+\.png$/);
  assert.doesNotMatch(updatedReference.asset, /ref-variant/);

  const itemReference = await request(baseUrl, `/api/wardrobe/items/${item.id}/references`, "POST", { id: "ref-item", scope: "item", imageDataUrl: IMAGE_DATA_URL });
  assert.equal(itemReference.status, 201);
  const afterItemReference = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"))[0];
  assert.equal(afterItemReference.variants.find((variant) => variant.id === "item-1-alt").assetRevision, 4);
  assert.equal(afterItemReference.variants.find((variant) => variant.id === "item-1-standard").cutout.status, "stale");
  assert.equal((await request(baseUrl, `/api/wardrobe/items/${item.id}/references`, "POST", { id: "ref-item" })).status, 409);
  assert.equal((await request(baseUrl, `/api/wardrobe/items/${item.id}/references`, "POST", { id: "../escape" })).status, 400);
  assert.equal((await request(baseUrl, `/api/wardrobe/items/${item.id}/references/%2e%2e%2fescape`, "DELETE")).status, 400);
  assert.equal((await request(baseUrl, `/api/wardrobe/items/${item.id}/variants`, "POST", { name: "Alt" })).status, 409);
  assert.ok((await readdir(imported)).every((name) => !name.includes("escape")));

  const deleted = await request(baseUrl, `/api/wardrobe/items/${item.id}/variants/item-1-alt`, "DELETE", { replacementVariantId: "item-1-standard" });
  assert.equal(deleted.status, 200);
  const savedOutfits = JSON.parse(await readFile(path.join(root, "outfits.json"), "utf8"));
  const used = savedOutfits.find((outfit) => outfit.id === OUTFIT_USED_ID);
  assert.deepEqual(used.pieces, [{ itemId: item.id, variantId: "item-1-standard" }]);
  assert.deepEqual(used.itemIds, [item.id]);
  assert.equal(used.modeledImage, null);
  assert.equal(used.modeledStatus, null);
  assert.equal(used.modeledError, null);
  assert.equal(used.modeledTier, null);
  assert.equal(used.description, null);
  assert.deepEqual(used.tags, []);
  assert.equal(deleted.value.item.defaultVariantId, "item-1-standard");
});
