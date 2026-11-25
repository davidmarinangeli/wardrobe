import test from "node:test";
import assert from "node:assert/strict";
import { normalizePieceSelection, selectionChanged } from "../shared/piece-selection.mjs";
import { migrateOutfit } from "../shared/wardrobe-model.mjs";

const variant = (id) => ({ id, name: id });
const items = [
  { id: "shirt", part: "upperbody", defaultVariantId: "shirt-std", variants: [variant("shirt-std"), variant("shirt-rolled")] },
  { id: "jeans", part: "lowerbody", defaultVariantId: "jeans-std", variants: [variant("jeans-std")] },
  { id: "scarf", part: "accessories_up", variants: [variant("scarf-a"), variant("scarf-b")] },
];

test("unknown, duplicate and malformed entries are dropped", () => {
  const pieces = [
    null, "shirt", 7, {}, { itemId: 3, variantId: "x" }, { itemId: "", variantId: "x" },
    { itemId: "ghost", variantId: "ghost-std" },
    { itemId: "jeans", variantId: "jeans-std" },
    { itemId: "jeans", variantId: "other" },
  ];
  assert.deepEqual(normalizePieceSelection(pieces, items), [{ itemId: "jeans", variantId: "jeans-std" }]);
  assert.deepEqual(normalizePieceSelection(undefined, items), []);
  assert.deepEqual(normalizePieceSelection([{ itemId: "jeans", variantId: "jeans-std" }], undefined), []);
});

test("a null or unknown variant becomes the default variant, or the first without a default", () => {
  assert.deepEqual(normalizePieceSelection([
    { itemId: "shirt", variantId: null },
    { itemId: "jeans", variantId: "gone" },
    { itemId: "scarf" },
  ], items), [
    { itemId: "shirt", variantId: "shirt-std" },
    { itemId: "jeans", variantId: "jeans-std" },
    { itemId: "scarf", variantId: "scarf-a" },
  ]);
});

test("a valid variant is kept, order is kept and the input is not mutated", () => {
  const pieces = [{ itemId: "scarf", variantId: "scarf-b" }, { itemId: "shirt", variantId: "shirt-rolled" }];
  const snapshot = structuredClone(pieces);
  const result = normalizePieceSelection(pieces, items);
  assert.deepEqual(result, pieces);
  assert.notEqual(result[0], pieces[0]);
  assert.deepEqual(pieces, snapshot);
});

test("legacy itemIds go through migrateOutfit and land on default variants", () => {
  const pieces = migrateOutfit({ itemIds: ["jeans", "shirt", "ghost", "jeans"] }, items).pieces;
  assert.deepEqual(normalizePieceSelection(pieces, items), [
    { itemId: "jeans", variantId: "jeans-std" },
    { itemId: "shirt", variantId: "shirt-std" },
  ]);
});

test("selectionChanged compares itemId + variantId sets, ignoring order", () => {
  const a = { itemId: "shirt", variantId: "shirt-std" };
  const b = { itemId: "jeans", variantId: "jeans-std" };
  assert.equal(selectionChanged([], []), false);
  assert.equal(selectionChanged([a, b], [b, a]), false);
  assert.equal(selectionChanged([a, b], [{ ...a, variantId: "shirt-rolled" }, b]), true);
  assert.equal(selectionChanged([a], [a, b]), true);
  assert.equal(selectionChanged([a, b], [b]), true);
  assert.equal(selectionChanged([a, b], [a, a]), true);
});
