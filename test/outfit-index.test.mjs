import assert from "node:assert/strict";
import test from "node:test";
import { buildOutfitIndex, summarizeOutfits } from "../shared/outfit-index.mjs";

// Shaped like the real records in data/outfits.json — the trimming only means
// anything against outfits carrying the full model-photo state and style prose.
const fullRecord = (id, name, itemIds, modeledImage = null) => ({
  id,
  name,
  itemIds,
  modeledImage,
  modeledStatus: null,
  modeledError: null,
  modeledTier: "standard",
  createdAt: "2026-08-24T20:25:16.771Z",
  updatedAt: "2026-08-24T20:25:16.771Z",
  description: "A relaxed brick-red graphic t-shirt is effortlessly tucked into tailored black pleated trousers, balancing ease with structure.",
  tags: ["minimal", "smart casual", "casual", "modern"],
});

const outfits = [
  fullRecord("o1", "Saturday", ["tee", "jeans", "sneakers"], "/api/outfits/assets/o1-modeled.png?v=1788011439496"),
  fullRecord("o2", "Office", ["shirt", "jeans"]),
  fullRecord("o3", "Dinner", ["dress"]),
];


const summaries = summarizeOutfits(outfits);

test("groups outfits by the pieces they use", () => {
  const { byItem } = buildOutfitIndex(summaries);
  assert.deepEqual(byItem.jeans, ["o1", "o2"]);
  assert.deepEqual(byItem.tee, ["o1"]);
  assert.deepEqual(byItem.dress, ["o3"]);
});

test("a piece in no outfits is simply absent, never zero-filled", () => {
  const { byItem } = buildOutfitIndex(summaries);
  assert.equal(byItem.scarf, undefined);
  assert.equal(byItem.scarf?.length || 0, 0);
});

test("summaries carry only what the wardrobe surfaces render", () => {
  const [first, , third] = summaries;
  assert.deepEqual(Object.keys(first).sort(), ["id", "itemIds", "modeledImage", "name"]);
  assert.equal(first.name, "Saturday");
  assert.equal(summaries[1].modeledImage, null);
  // An outfit that never had a model photo still reports the field, so the
  // viewer's thumbnail fallback has something defined to branch on.
  assert.equal(third.modeledImage, null);
});

test("the summary payload is materially smaller than the raw outfit list", () => {
  // The reason this endpoint exists at all. If this ratio ever collapses, the
  // wardrobe grid should just read the full list instead.
  const raw = JSON.stringify(outfits).length;
  const slim = JSON.stringify(summaries).length;
  assert.ok(slim < raw * 0.8, `expected the summaries to be well under the raw list, got ${slim} vs ${raw}`);
});

test("a piece repeated inside one outfit counts once", () => {
  const { byItem } = buildOutfitIndex(summarizeOutfits([{ id: "o9", name: "Layered", itemIds: ["tee", "tee", "jacket"] }]));
  assert.deepEqual(byItem.tee, ["o9"]);
});

test("malformed records are skipped rather than throwing", () => {
  const cleaned = summarizeOutfits([
    null,
    { name: "no id", itemIds: ["tee"] },
    { id: "o4", name: "no items" },
    { id: "o5", name: "junk ids", itemIds: ["tee", 42, "", null] },
  ]);
  assert.deepEqual(cleaned.map((outfit) => outfit.id), ["o5"]);
  assert.deepEqual(cleaned[0].itemIds, ["tee"]);
  assert.deepEqual(buildOutfitIndex(cleaned).byItem.tee, ["o5"]);
});

test("an empty wardrobe yields an empty index, not a throw", () => {
  assert.deepEqual(summarizeOutfits(), []);
  assert.deepEqual(buildOutfitIndex(), { outfits: {}, byItem: {} });
  assert.deepEqual(buildOutfitIndex([]), { outfits: {}, byItem: {} });
});
