import test from "node:test";
import assert from "node:assert/strict";
import { buildOverviewIndex, buildOverviewSections, commonOverviewTags, filterOverviewIndex } from "../shared/overview-index.mjs";

const item = (id, name, part = "upperbody", tags = [], color = null) => ({ id, name, part, tags, color });
const find = (items, query) => filterOverviewIndex(buildOverviewIndex(items), query).map((entry) => entry.id);

test("specific garment phrases avoid collisions with shirt, short, and denim", () => {
  for (const [name, expected] of [["T-shirt", "t-shirt"], ["Polo shirt", "polo"], ["Short sleeve shirt", "shirt"], ["Camicia", "shirt"], ["Camicie", "shirt"], ["Button-down", "shirt"], ["Denim jacket", "jacket"], ["Blazer Jacket", "blazer"]]) {
    assert.equal(buildOverviewIndex([item("x", name)])[0].subtype.id, expected, name);
  }
  assert.match(buildOverviewIndex([item("x", "T-shirt shirt")])[0].subtype.id, /^part:/);
});

test("Italian and English plurals combine with color and material as AND terms", () => {
  const items = [item("a", "Camicia", "upperbody", ["lino"], "#ffffff"), item("b", "Shirt", "upperbody", ["cotton"], "#0000ff")];
  for (const query of ["camicie bianche lino", "white linen shirts", "shirt bianca lino"]) assert.deepEqual(find(items, query), ["a"], query);
  assert.deepEqual(find(items, "blue shirts"), ["b"]);
});

test("T-shirt plural search stays distinct from generic shirts", () => {
  const items = [item("t", "T-shirt"), item("s", "Shirt")];
  assert.deepEqual(find(items, "t-shirts"), ["t"]);
  assert.deepEqual(find(items, "shirts"), ["s"]);
});

test("linen evidence includes Italian camicie without mixing T-shirts or polos", () => {
  const items = [
    ...Array.from({ length: 4 }, (_, index) => item(`camicia-${index}`, "Camicia", "upperbody", ["lino"])),
    item("tee", "T-shirt", "upperbody", ["linen"]),
    item("polo", "Polo shirt", "upperbody", ["linen"]),
  ];
  const index = buildOverviewIndex(items);
  const evidence = buildOverviewSections(index)[0].evidence.find((entry) => /linen shirts/i.test(entry.label));
  assert.ok(evidence);
  assert.equal(evidence.count, 4);
  assert.deepEqual(evidence.itemIds, ["camicia-0", "camicia-1", "camicia-2", "camicia-3"]);
});

test("muted brown and khaki colors classify by value while saturated orange and yellow stay distinct", () => {
  const items = [
    item("saddle", "Trousers", "lowerbody", [], "#8b4513"),
    item("khaki", "Trousers", "lowerbody", [], "#c2b280"),
    item("orange", "Trousers", "lowerbody", [], "#ff6600"),
    item("yellow", "Trousers", "lowerbody", [], "#ffff00"),
    { ...item("secondary", "Trousers", "lowerbody", [], "#0000ff"), secondaryColor: "#8b4513" },
  ];
  assert.deepEqual(find(items, "brown").sort(), ["khaki", "saddle", "secondary"]);
  assert.deepEqual(find(items, "beige").sort(), ["khaki", "saddle", "secondary"]);
  assert.deepEqual(find(items, "orange"), ["orange"]);
  assert.deepEqual(find(items, "yellow"), ["yellow"]);
});

test("linen-look is literal text and does not declare linen material", () => {
  const items = [item("fake", "Linen-look shirt"), item("real", "Shirt", "upperbody", ["linen"])];
  assert.deepEqual(find(items, "lino"), ["real"]);
  assert.deepEqual(find(items, "linen-look"), ["fake"]);
});

test("search does not infer fabric or use qualities", () => {
  const items = [item("linen", "Shirt", "upperbody", ["linen"]), item("outdoor", "Jacket", "wholebody_up", ["outdoor"])];
  for (const query of ["fresh", "fresco", "rain", "per la pioggia", "impermeabile"]) assert.deepEqual(find(items, query), [], query);
});

test("compound bilingual terms and custom accented tags are searchable", () => {
  const items = [item("rain", "Rain jacket", "wholebody_up", ["città", "formal"]), item("x", "Jacket", "wholebody_up", ["outdoor"])];
  assert.deepEqual(find(items, "per la pioggia elegante citta"), ["rain"]);
});

test("headwear comes first and unknown categories remain in Other", () => {
  const sections = buildOverviewSections(buildOverviewIndex([item("bag", "Bag", "accessories_up"), item("hat", "Hat", "accessories_up"), item("unknown", "Strange", "unknown-category")]));
  assert.equal(sections[0].entries[0].id, "hat");
  assert.equal(sections.at(-1).id, "other");
  assert.equal(sections.at(-1).entries[0].item.part, "unknown-category");
});

test("evidence is a subtype or subtype plus one feature, with exact compound filtering", () => {
  const items = [
    ...Array.from({ length: 5 }, (_, index) => item(`s${index}`, "Shirt", "upperbody", ["linen"])),
    ...Array.from({ length: 3 }, (_, index) => item(`c${index}`, "Shirt", "upperbody", ["cotton"])),
    ...Array.from({ length: 3 }, (_, index) => item(`j${index}`, "Jacket", "wholebody_up", ["linen"])),
  ];
  const index = buildOverviewIndex(items);
  const section = buildOverviewSections(index)[0];
  assert.ok(section.evidence.some((entry) => entry.count === 8 && /shirts/i.test(entry.label)));
  const linenShirts = section.evidence.find((entry) => /linen.*shirts|shirts.*linen/i.test(entry.label));
  assert.ok(linenShirts);
  assert.deepEqual(filterOverviewIndex(index, "", linenShirts).map((entry) => entry.id).sort(), ["s0", "s1", "s2", "s3", "s4"]);
  assert.ok(section.evidence.length <= 3);
});

test("identical evidence sets keep one more descriptive candidate", () => {
  const evidence = buildOverviewSections(buildOverviewIndex(Array.from({ length: 4 }, (_, index) => item(`s${index}`, "Shirt", "upperbody", ["linen"])) ))[0].evidence;
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].label, /linen.*shirts|shirts.*linen/i);
});


test("selected tags include only the intersection, ignoring case, whitespace, and repeats", () => {
  const index = buildOverviewIndex([
    item("a", "Shirt", "upperbody", [" Linen ", "linen", "work", "summer"]),
    item("b", "Trousers", "lowerbody", ["LINEN", "summer", "formal"]),
    item("c", "Jacket", "wholebody_up", []),
  ]);
  const tags = (entries) => commonOverviewTags(entries).map(({ key }) => key);
  assert.deepEqual(tags(index.slice(0, 1)), ["linen", "summer", "work"]);
  assert.deepEqual(tags(index.slice(0, 2)), ["linen", "summer"]);
  assert.deepEqual(tags(index), []);
  assert.deepEqual(tags([]), []);
});
