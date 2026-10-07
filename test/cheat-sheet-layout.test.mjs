import assert from "node:assert/strict";
import test from "node:test";
import { balancedRowSizes, buildCheatSheetLayout, CHEAT_SHEET_ITEM_MAX_HEIGHT, CHEAT_SHEET_ITEM_MAX_WIDTH, cheatSheetCollectionPositions, normalizeCheatSheetScale, titleLayout } from "../shared/cheat-sheet-layout.mjs";

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

test("cheat sheet garment groups follow the dressing order and recognize Italian and English names", () => {
  const items = [
    { id: "shoes", name: "Sneakers", part: "shoes" },
    { id: "socks", name: "Calze di lana", part: "socks" },
    { id: "skirt", name: "Gonna plissettata", part: "skirt" },
    { id: "pants", name: "Jeans", part: "lowerbody" },
    { id: "belt", name: "Cintura in pelle", part: "accessories_up" },
    { id: "tank", name: "Canottiera", part: "upperbody" },
    { id: "shirt", name: "Camicia bianca", part: "upperbody" },
    { id: "tee", name: "T-shirt", part: "upperbody" },
    { id: "vest", name: "Gilet", part: "upperbody" },
    { id: "sweater", name: "Maglione", part: "upperbody" },
    { id: "hoodie", name: "Felpa con cappuccio", part: "upperbody" },
    { id: "blazer", name: "Blazer elegante", part: "upperbody" },
    { id: "coat", name: "Giaccone invernale", part: "wholebody_up" },
    { id: "scarf", name: "Sciarpa di lana", part: "accessories_up" },
    { id: "hat", name: "Cappello", part: "accessories_up" },
    { id: "sandals", name: "Sandali", part: "shoes" },
  ];
  const layout = buildCheatSheetLayout(items);
  assert.deepEqual(layout.groups.map((group) => group.subtypeId), [
    "headwear", "scarves", "coat", "blazer", "sweatshirt", "knitwear", "vests",
    "t-shirt", "shirt", "tank-top", "belts", "trousers", "skirt", "socks", "sandals", "shoes",
  ]);
});

test("fleece and shorts use specific groups before generic garment fallbacks", () => {
  const layout = buildCheatSheetLayout([
    { id: "shorts-part", name: "Pants", part: "shorts" },
    { id: "regular-pants", name: "Pants", part: "lowerbody" },
    { id: "short-pants", name: "Short pants", part: "lowerbody" },
    { id: "fleece-vest", name: "Fleece vest", part: "upperbody" },
    { id: "generic-layer", name: "Layer", part: "wholebody_up" },
    { id: "fleece-jacket", name: "Fleece jacket", part: "wholebody_up" },
    { id: "sweater", name: "Sweater", part: "upperbody" },
    { id: "hoodie", name: "Hoodie", part: "upperbody" },
    { id: "blazer", name: "Blazer", part: "upperbody" },
  ]);

  assert.deepEqual(layout.groups.map((group) => group.subtypeId), [
    "blazer", "fleece", "part:wholebody_up", "sweatshirt", "knitwear", "vests", "trousers", "shorts",
  ]);
  assert.deepEqual(layout.groups.find((group) => group.subtypeId === "shorts").items.map((item) => item.id), ["shorts-part", "short-pants"]);
  assert.deepEqual(layout.groups.find((group) => group.subtypeId === "vests").items.map((item) => item.id), ["fleece-vest"]);
});

test("a declared coat stays in outerwear when fleece is a lining or tag", () => {
  const layout = buildCheatSheetLayout([
    { id: "fleece-lined", name: "Fleece-lined coat", part: "wholebody_up" },
    { id: "parka", name: "Parka", part: "wholebody_up", tags: ["fleece"] },
    { id: "fleece-jacket", name: "Fleece jacket", part: "wholebody_up" },
    { id: "pile-jacket", name: "Giacca in pile", part: "wholebody_up" },
  ]);

  assert.deepEqual(layout.groups.map((group) => group.subtypeId), ["coat", "fleece"]);
  assert.deepEqual(layout.groups.find((group) => group.subtypeId === "coat").items.map((item) => item.id), ["fleece-lined", "parka"]);
  assert.deepEqual(layout.groups.find((group) => group.subtypeId === "fleece").items.map((item) => item.id), ["fleece-jacket", "pile-jacket"]);
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

test("equivalent garments overlap gently and fit without distortion or clipping", () => {
  for (const count of [1, 2, 3, 4]) {
    for (const bounds of [
      Array.from({ length: count }, () => ({ width: 800, height: 600 })),
      Array.from({ length: count }, (_, index) => ({ width: 150 + index * 80, height: 1000 })),
      Array.from({ length: count }, (_, index) => index % 2 ? { width: 1200, height: 200 } : { width: 150, height: 1000 }),
    ]) {
      const row = { rowHeight: 480, topPadding: 64 };
      const positions = cheatSheetCollectionPositions(row, bounds);
      positions.forEach((position, index) => {
        assert.ok(position.left >= 72 && position.left + position.width <= 1128);
        assert.ok(position.top >= row.topPadding && position.top + position.height <= row.topPadding + row.rowHeight);
        assert.ok(Math.abs(position.width / position.height - bounds[index].width / bounds[index].height) < 1e-9);
        if (index) {
          const previous = positions[index - 1];
          const overlap = previous.left + previous.width - position.left;
          assert.ok(overlap > 0, "adjacent equivalent garments overlap");
          assert.ok(overlap / Math.min(previous.width, position.width) <= 0.221, "most of each garment stays visible");
        }
      });
      assert.ok(Math.abs(positions[0].left - (1200 - positions.at(-1).left - positions.at(-1).width)) < 1e-9);
    }
  }
});

test("a garment keeps the same standard dimensions alone or in a group of three", () => {
  const row = { rowHeight: 660, topPadding: 64 };
  const trousersBounds = { left: 8, top: 4, width: 1200, height: 1600 };
  const alone = cheatSheetCollectionPositions(row, [trousersBounds])[0];
  const inGroup = cheatSheetCollectionPositions(row, [trousersBounds, trousersBounds, trousersBounds])[0];

  assert.equal(alone.width, inGroup.width);
  assert.equal(alone.height, inGroup.height);
  assert.ok(alone.width <= CHEAT_SHEET_ITEM_MAX_WIDTH);
  assert.ok(alone.height <= CHEAT_SHEET_ITEM_MAX_HEIGHT);
  assert.ok(Math.abs(alone.width / alone.height - trousersBounds.width / trousersBounds.height) < 1e-9);
});

test("piece size accepts only 50–150 percent in 10 percent increments", () => {
  assert.equal(normalizeCheatSheetScale(undefined), 1, "legacy pieces default to 100 percent");
  for (const value of [0.5, 0.6, 1, 1.4, 1.5]) assert.equal(normalizeCheatSheetScale(value), value);
  for (const value of [null, "1.1", 0.49, 1.51, 0.55, NaN]) assert.throws(() => normalizeCheatSheetScale(value));
});

test("scaled pieces grow within the sheet and wrap rows when four maximum-size pieces would overflow", () => {
  const bounds = { width: 1200, height: 600 };
  const regular = cheatSheetCollectionPositions({ rowHeight: 480, topPadding: 0 }, [bounds])[0];
  const reduced = cheatSheetCollectionPositions({ rowHeight: 480, topPadding: 0 }, [{ ...bounds, scale: 0.5 }])[0];
  const enlarged = cheatSheetCollectionPositions({ rowHeight: 480, topPadding: 0 }, [{ ...bounds, scale: 1.5 }])[0];
  assert.ok(reduced.width < regular.width && enlarged.width > regular.width);

  const items = Array.from({ length: 4 }, (_, index) => ({ id: `tee-${index}`, name: "T-shirt", part: "upperbody" }));
  const layout = buildCheatSheetLayout(items, 1, new Map(items.map((item) => [item.id, 1.5])));
  assert.deepEqual(layout.rows.map((row) => row.columns), [2, 2]);
  assert.ok(layout.rows.every((row) => row.rowHeight >= 640));
  for (const row of layout.rows) {
    const positions = cheatSheetCollectionPositions(row, row.itemIds.map(() => ({ ...bounds, scale: 1.5 })));
    for (const position of positions) {
      assert.ok(position.left >= 72 && position.left + position.width <= 1128);
      assert.ok(position.top >= row.topPadding && position.top + position.height <= row.topPadding + row.rowHeight);
      assert.ok(Math.abs(position.width / position.height - bounds.width / bounds.height) < 1e-9);
    }
  }

  const mixed = cheatSheetCollectionPositions({ rowHeight: 660, topPadding: 0 }, [
    { ...bounds, scale: 0.5 },
    { ...bounds, scale: 1.5 },
  ]);
  assert.ok(Math.abs(mixed[1].width / mixed[0].width - 3) < 1e-9, "group fitting preserves the requested relative scales");
  assert.ok(mixed.every((position) => position.left >= 72 && position.left + position.width <= 1128));
});
