import assert from "node:assert/strict";
import test from "node:test";
import { balancedRowSizes, buildCheatSheetLayout, titleLayout } from "../shared/cheat-sheet-layout.mjs";

const trousers = (count) => Array.from({ length: count }, (_, index) => ({
  id: `trousers-${index}`, name: "Linen trousers", part: "lowerbody", image: "/same-image.png",
}));

test("rows stay balanced for small and large selections without an outfit cap", () => {
  for (const count of [1, 3, 5, 12, 27]) {
    const sizes = balancedRowSizes(count);
    assert.equal(sizes.reduce((sum, value) => sum + value, 0), count);
    assert.ok(sizes.every((size) => size >= 1 && size <= 4));
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    const layout = buildCheatSheetLayout(trousers(count));
    assert.deepEqual(layout.rows.map((row) => row.columns), sizes);
    assert.deepEqual(layout.rows.flatMap((row) => row.itemIds), trousers(count).map((item) => item.id));
  }
  assert.deepEqual(balancedRowSizes(5), [3, 2]);
  assert.deepEqual(balancedRowSizes(0), []);
});

test("category grouping preserves distinct records, stable within-group order and garment proportions", () => {
  const items = [
    { id: "shoe", name: "Wide shoes", part: "shoes" },
    { id: "shirt-b", name: "White shirt", part: "upperbody", image: "/identical.png" },
    { id: "trouser", name: "Tall trousers", part: "lowerbody" },
    { id: "dress", name: "Long dress", part: "dress" },
    { id: "blazer", name: "Navy blazer", part: "upperbody" },
    { id: "shirt-a", name: "White shirt", part: "upperbody", image: "/identical.png" },
  ];
  const original = structuredClone(items);
  const layout = buildCheatSheetLayout(items);
  assert.deepEqual(items, original);
  assert.equal(layout.rows.flatMap((row) => row.itemIds).length, items.length);
  assert.deepEqual(layout.groups.find((group) => group.subtypeId === "shirt").items.map((item) => item.id), ["shirt-b", "shirt-a"]);
  assert.deepEqual([...new Set(layout.rows.map((row) => row.area))], ["tops", "full", "bottoms", "footwear"]);
  const height = (area) => layout.rows.find((row) => row.area === area).rowHeight;
  assert.ok(height("bottoms") > height("footwear"));
  assert.ok(height("full") > height("tops"));
});

test("long titles wrap or shrink without losing text", () => {
  const measure = (text, fontSize) => [...text].reduce((sum, character) => sum + (character === "W" ? 1 : 0.55) * fontSize, 0);
  for (const title of ["Summer", "My favourite white linen shirts and tailored trousers for warm evenings ".repeat(2).slice(0, 120).trim(), "W".repeat(120)]) {
    const result = titleLayout(title, measure, 1056);
    assert.ok(result.lines.length <= 3);
    assert.ok(result.lines.every((line) => measure(line, result.fontSize) <= 1056));
    assert.equal(result.lines.join("").replace(/\s/g, ""), title.replace(/\s/g, ""));
  }
});
