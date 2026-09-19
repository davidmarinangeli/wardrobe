import assert from "node:assert/strict";
import test from "node:test";
import { isPeekGesture, PEEK_SLOP } from "../src/gallery-variants.js";
import { initialVariantForPiece } from "../shared/wardrobe-model.mjs";

// The gallery card is a button, so the browser sends a click after every swipe.
// These two tests are the difference between a peek and a tap on a phone.
test("a drag past the slop is a peek, so the click that follows it is not a tap", () => {
  assert.equal(isPeekGesture(100, 100 + PEEK_SLOP + 1), true);
  assert.equal(isPeekGesture(100, 100 - PEEK_SLOP - 1), true, "either direction counts");
  assert.equal(isPeekGesture(100, 260), true);
});

test("a tap with a shaky finger stays a tap, and still opens the item", () => {
  assert.equal(isPeekGesture(100, 100), false);
  assert.equal(isPeekGesture(100, 100 + PEEK_SLOP), false, "the slop itself is still a tap");
  assert.equal(isPeekGesture(100, 96), false);
});

// Regression guard. Shipped code deliberately started multi-variant pieces on
// null, which made selecting a piece an unsaveable state and cost a second tap
// on a control the record already had the answer for.
test("a piece added to an outfit starts on its default variant, however many it has", () => {
  const multi = {
    id: "shirt",
    defaultVariantId: "shirt-rolled",
    variants: [{ id: "shirt-standard" }, { id: "shirt-rolled" }, { id: "shirt-tucked" }],
  };
  assert.equal(initialVariantForPiece(multi), "shirt-rolled");

  const single = { id: "sock", defaultVariantId: "sock-standard", variants: [{ id: "sock-standard" }] };
  assert.equal(initialVariantForPiece(single), "sock-standard");
});

test("a piece with no default falls back to its first variant rather than to nothing", () => {
  assert.equal(initialVariantForPiece({ id: "x", variants: [{ id: "x-a" }, { id: "x-b" }] }), "x-a");
});

test("a record with no variants at all yields null instead of throwing", () => {
  assert.equal(initialVariantForPiece({ id: "x", variants: [] }), null);
  assert.equal(initialVariantForPiece(undefined), null);
});
