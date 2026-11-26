import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { outfitsApi } from "../scripts/outfits-api.mjs";
import { OUTFIT_MAX_PIECES } from "../shared/outfit-rules.mjs";

const OUTDATED_ID = "44444444-4444-4444-8444-444444444444";
const RETIRED_ID = "55555555-5555-4555-8555-555555555555";
const DELETED_ITEM = "item-deleted";

const item = (id, extra = {}) => ({
  id,
  name: `Piece ${id}`,
  part: "upperbody",
  defaultVariantId: `${id}-standard`,
  variants: [{ id: `${id}-standard`, name: "Standard", image: "/api/import/library/standard.png", approvalStatus: "approved" }],
  ...extra,
});
const piece = (id) => ({ itemId: id, variantId: `${id}-standard` });

async function startApi(t) {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-outfits-api-"));
  const items = Array.from({ length: OUTFIT_MAX_PIECES + 1 }, (_, index) => item(`item-${index}`));
  await writeFile(path.join(root, "library.json"), JSON.stringify([...items, item("item-retired", { status: "retired" })]));
  await writeFile(path.join(root, "outfits.json"), JSON.stringify([
    { id: OUTDATED_ID, name: "Outdated", pieces: [piece("item-0"), piece(DELETED_ITEM)], modeledImage: "/old.png", description: "Old look", tags: ["old"] },
    { id: RETIRED_ID, name: "Retired", pieces: [piece("item-1"), piece("item-retired")] },
  ]));
  const plugin = outfitsApi({ env: { WARDROBE_DATA_DIR: root } });
  await plugin.configResolved({ root });
  let middleware;
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  const server = http.createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname, method = "GET", value) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: value === undefined ? undefined : { "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  const stored = async (id) => JSON.parse(await readFile(path.join(root, "outfits.json"), "utf8")).find((outfit) => outfit.id === id);
  return { request, stored };
}

test("a new outfit keeps at most OUTFIT_MAX_PIECES pieces", async (t) => {
  const { request } = await startApi(t);
  const pieces = Array.from({ length: OUTFIT_MAX_PIECES + 1 }, (_, index) => piece(`item-${index}`));
  const created = await request("/api/outfits", "POST", { name: "Everything", pieces });
  assert.equal(created.status, 201);
  assert.equal(created.value.pieces.length, OUTFIT_MAX_PIECES);
  assert.deepEqual(created.value.pieces, pieces.slice(0, OUTFIT_MAX_PIECES));
});

test("a name-only PATCH renames without touching the lineup, photo or style notes", async (t) => {
  const { request, stored } = await startApi(t);
  const renamed = await request(`/api/outfits/${OUTDATED_ID}`, "PATCH", { name: "  Renamed  " });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.value.name, "Renamed");
  const saved = await stored(OUTDATED_ID);
  assert.equal(saved.name, "Renamed");
  assert.deepEqual(saved.pieces, [piece("item-0"), piece(DELETED_ITEM)]);
  assert.equal(saved.modeledImage, "/old.png");
  assert.equal(saved.description, "Old look");
  assert.deepEqual(saved.tags, ["old"]);
  assert.ok(saved.updatedAt);

  const blank = await request(`/api/outfits/${OUTDATED_ID}`, "PATCH", { name: "   " });
  assert.equal(blank.status, 400);
  assert.equal((await stored(OUTDATED_ID)).name, "Renamed");
});

test("a lineup PATCH still drops the photo when the pieces change", async (t) => {
  const { request } = await startApi(t);
  const saved = await request(`/api/outfits/${OUTDATED_ID}`, "PATCH", { name: "Outdated", pieces: [piece("item-0")] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.pieces, [piece("item-0")]);
  assert.equal(saved.value.modeledImage, null);
  assert.equal(saved.value.description, null);
  assert.deepEqual(saved.value.tags, []);
});

test("a model photo is refused while the outfit lists a retired or deleted piece", async (t) => {
  const { request, stored } = await startApi(t);
  for (const id of [OUTDATED_ID, RETIRED_ID]) {
    const result = await request(`/api/outfits/${id}/modeled`, "POST", {});
    assert.equal(result.status, 409, id);
    assert.match(result.value.error, /no longer in your wardrobe/);
    assert.equal((await stored(id)).modeledStatus ?? null, null, id);
  }
});
