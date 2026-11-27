import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHEET_PIECE_SCALE, reconcileSheetPieces } from "../shared/cheat-sheet-pieces.mjs";

const piece = (itemId, scale = 1, variantId = `${itemId}-std`) => ({ itemId, variantId, scale });
const pick = (itemId, variantId = `${itemId}-std`) => ({ itemId, variantId });

test("a retained piece keeps its scale", () => {
  assert.deepEqual(reconcileSheetPieces([piece("a", 1.3)], [pick("a")]), [piece("a", 1.3)]);
});

test("an added piece starts at the default scale", () => {
  assert.equal(DEFAULT_SHEET_PIECE_SCALE, 1);
  assert.deepEqual(reconcileSheetPieces([], [pick("b")]), [piece("b", DEFAULT_SHEET_PIECE_SCALE)]);
  assert.deepEqual(reconcileSheetPieces([piece("a", 1.3)], [pick("a"), pick("b")]), [piece("a", 1.3), piece("b", 1)]);
});

test("a removed piece is dropped", () => {
  assert.deepEqual(reconcileSheetPieces([piece("a", 1.3), piece("b")], [pick("b")], new Set(["a", "b"])), [piece("b")]);
});

test("a retained piece takes the picked variant and keeps its scale", () => {
  assert.deepEqual(
    reconcileSheetPieces([piece("a", 1.3, "a-std")], [pick("a", "a-rolled")]),
    [piece("a", 1.3, "a-rolled")],
  );
});

test("a retained piece keeps its own variant when the picked one is null or undefined", () => {
  assert.deepEqual(reconcileSheetPieces([piece("a", 1.3, "a-rolled")], [{ itemId: "a", variantId: null }]), [piece("a", 1.3, "a-rolled")]);
  assert.deepEqual(reconcileSheetPieces([piece("a", 1.3, "a-rolled")], [{ itemId: "a" }]), [piece("a", 1.3, "a-rolled")]);
});

test("existing pieces keep their order; new ones follow selection order", () => {
  const current = [piece("a", 1.2), piece("b"), piece("c", 0.8)];
  const picked = [pick("c"), pick("d"), pick("a"), pick("e")];
  assert.deepEqual(reconcileSheetPieces(current, picked).map((entry) => entry.itemId), ["a", "c", "d", "e"]);
  assert.deepEqual(reconcileSheetPieces(current, picked), [piece("a", 1.2), piece("c", 0.8), piece("d"), piece("e")]);
});

test("a piece removed and re-added in the picker still counts as retained", () => {
  // The picker moves a re-picked piece to the end of its selection.
  const current = [piece("a", 1.3), piece("b")];
  const picked = [pick("b"), pick("c"), pick("a")];
  assert.deepEqual(reconcileSheetPieces(current, picked), [piece("a", 1.3), piece("b"), piece("c")]);
});

test("a piece the picker never offered is kept in place", () => {
  const current = [piece("a"), piece("x", 1.4, "x-gone"), piece("b")];
  assert.deepEqual(
    reconcileSheetPieces(current, [pick("b")], new Set(["a", "b"])),
    [piece("x", 1.4, "x-gone"), piece("b")],
  );
});

test("omitting offeredIds treats every current piece as offered", () => {
  assert.deepEqual(reconcileSheetPieces([piece("a"), piece("x", 1.4)], [pick("a")]), [piece("a")]);
});

test("duplicate picked itemIds collapse, first wins", () => {
  assert.deepEqual(
    reconcileSheetPieces([piece("a", 1.3)], [pick("a", "a-rolled"), pick("a", "a-std"), pick("b", "b-1"), pick("b", "b-2")]),
    [piece("a", 1.3, "a-rolled"), piece("b", 1, "b-1")],
  );
});

test("edges: an empty pick clears everything offered; an empty sheet takes the picked list", () => {
  assert.deepEqual(reconcileSheetPieces([piece("a"), piece("b")], [], new Set(["a", "b"])), []);
  assert.deepEqual(reconcileSheetPieces([], [pick("a"), pick("b")]), [piece("a"), piece("b")]);
  assert.deepEqual(reconcileSheetPieces([], []), []);
});

test("inputs are not mutated", () => {
  const current = [piece("a", 1.3), piece("b"), piece("x", 0.8)];
  const picked = [pick("b", "b-alt"), pick("c"), pick("a")];
  const offered = new Set(["a", "b", "c"]);
  const snapshot = structuredClone({ current, picked, offered });
  const result = reconcileSheetPieces(current, picked, offered);
  assert.deepEqual({ current, picked, offered }, snapshot);
  assert.notEqual(result[0], current[0]);
});
