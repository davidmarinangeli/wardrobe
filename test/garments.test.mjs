import assert from "node:assert/strict";
import test from "node:test";
import {
  GARMENT_DISAMBIGUATION_RULES,
  GARMENT_PARTS,
  GARMENT_PART_IDS,
  GARMENT_PART_ID_SET,
  MIRROR_REGIONS,
  PART_TO_REGION,
  REGION_TO_PART,
} from "../shared/garments.mjs";
import { haystack, proposePart, scan } from "../scripts/backfill-garment-parts.mjs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Vocabulary integrity
// ---------------------------------------------------------------------------

test("every part is complete and uniquely identified", () => {
  const seen = new Set();
  for (const part of GARMENT_PARTS) {
    assert.ok(part.id && !seen.has(part.id), `duplicate or missing id: ${part.id}`);
    seen.add(part.id);
    assert.equal(typeof part.label, "string", `${part.id} needs a label`);
    assert.equal(typeof part.singular, "string", `${part.id} needs a singular`);
    assert.ok(["upper", "lower", "full", "feet", "accessory"].includes(part.coverage), `${part.id} has an unknown coverage: ${part.coverage}`);
  }
});

// The prompt prose names part ids in English sentences, which is exactly the
// kind of copy that silently rots when the vocabulary changes. This is the
// guard that makes the shared module genuinely single-source.
test("the disambiguation rules only reference part ids that exist", () => {
  const referenced = GARMENT_DISAMBIGUATION_RULES.flatMap((rule) => [...rule.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]));
  assert.ok(referenced.length > 0, "expected the rules to name some part ids");
  for (const id of referenced) {
    assert.ok(GARMENT_PART_ID_SET.has(id), `disambiguation rules name "${id}", which is not a garment part`);
  }
});

test("a full-coverage garment exists and is distinct from upper/lower", () => {
  const full = GARMENT_PARTS.filter((part) => part.coverage === "full").map((part) => part.id);
  assert.deepEqual(full, ["dress", "jumpsuit"]);
});

// Several parts share a Mirror region (skirt and shorts are both "lowerbody").
// Region -> part must keep the canonical one, or the critique would start
// offering a skirt as the replacement for a pair of trousers.
test("region -> part keeps the canonical part when several parts share a region", () => {
  assert.equal(REGION_TO_PART.lowerbody, "lowerbody");
  assert.equal(REGION_TO_PART.upperbody, "upperbody");
  assert.equal(REGION_TO_PART.outerwear, "wholebody_up");
  assert.equal(REGION_TO_PART.footwear, "shoes");
  assert.equal(REGION_TO_PART.accessory, "accessories_up");
  assert.equal(REGION_TO_PART.fullbody, "dress");
  // Order is irrelevant (it feeds a JSON-schema enum); the set is what matters.
  assert.deepEqual([...MIRROR_REGIONS].sort(), ["accessory", "footwear", "fullbody", "lowerbody", "outerwear", "upperbody"]);
});

test("part -> region maps every sharing part, not just the canonical one", () => {
  assert.equal(PART_TO_REGION.skirt, "lowerbody");
  assert.equal(PART_TO_REGION.shorts, "lowerbody");
  assert.equal(PART_TO_REGION.bodysuit, "upperbody");
  // Both full garments share the fullbody region; `dress` stays canonical for
  // the reverse lookup. (Proportion handling for them lives in
  // test/full-garments.test.mjs.)
  assert.equal(PART_TO_REGION.dress, "fullbody");
  assert.equal(PART_TO_REGION.jumpsuit, "fullbody");
});

test("the detection enum carries the new types", () => {
  for (const id of ["dress", "skirt", "jumpsuit", "bodysuit", "shorts"]) {
    assert.ok(GARMENT_PART_IDS.includes(id), `${id} missing from the detection enum`);
  }
});

// ---------------------------------------------------------------------------
// Backfill matcher
// ---------------------------------------------------------------------------

const item = (name, tags = []) => ({ name, tags });

// These are real names and tags out of data/library.json. Every one of them
// contains a substring of a new category ("short", "dress") and every one of
// them is a menswear staple that must be left exactly where it is — this is the
// failure mode a naive keyword scan walks straight into.
test("regression: 'short sleeve' items are never refiled as shorts", () => {
  const traps = [
    item("Black Short-Sleeve Open Collar Shirt", ["short sleeve", "open collar", "button-up", "shirt"]),
    item("navy short sleeve open collar shirt", ["short sleeve", "open collar", "button-down"]),
    item("Nike Grey Short-Sleeve Oversize T-Shirt", ["t-shirt", "oversize", "crewneck", "athletic", "short-sleeve"]),
    item("red patagonia logo t-shirt", ["t-shirt", "short-sleeve", "crewneck", "casual"]),
    item("Oversized Crew Neck T-Shirt", ["crewneck", "t-shirt", "oversized", "short sleeve"]),
  ];
  for (const trap of traps) {
    assert.equal(proposePart(trap, "upperbody"), null, `${trap.name} must stay upperbody`);
  }
});

test("regression: a dress shirt is not a dress", () => {
  assert.equal(proposePart(item("Light blue dress shirt slim", ["long sleeve", "slim", "button-down", "dress shirt", "formal"]), "upperbody"), null);
  assert.equal(proposePart(item("black dress trousers", ["dress pants", "formal"]), "lowerbody"), null);
  assert.equal(proposePart(item("dressy loafers", ["dressy"]), "lowerbody"), null);
});

test("genuine new types are proposed, with the evidence that triggered them", () => {
  assert.deepEqual(proposePart(item("floral midi dress", ["dress", "floral"]), "upperbody"), { part: "dress", matched: "dress" });
  assert.deepEqual(proposePart(item("black sundress", []), "upperbody"), { part: "dress", matched: "sundress" });
  assert.deepEqual(proposePart(item("pleated tennis skirt", ["skirt"]), "lowerbody"), { part: "skirt", matched: "skirt" });
  assert.deepEqual(proposePart(item("denim skort", []), "lowerbody"), { part: "skirt", matched: "skort" });
  assert.deepEqual(proposePart(item("linen jumpsuit", []), "upperbody"), { part: "jumpsuit", matched: "jumpsuit" });
  assert.deepEqual(proposePart(item("striped romper", []), "upperbody"), { part: "jumpsuit", matched: "romper" });
  assert.deepEqual(proposePart(item("ribbed bodysuit", []), "upperbody"), { part: "bodysuit", matched: "bodysuit" });
  assert.deepEqual(proposePart(item("khaki cargo shorts", ["shorts"]), "lowerbody"), { part: "shorts", matched: "shorts" });
});

test("only upperbody and lowerbody records are ever candidates", () => {
  // A jacket, shoe or accessory was never a victim of the missing categories,
  // so it is left alone even if its name happens to match.
  assert.equal(proposePart(item("dress shoes", []), "shoes"), null);
  assert.equal(proposePart(item("skirt-length overcoat", []), "wholebody_up"), null);
  assert.equal(proposePart(item("jumpsuit-print scarf", []), "accessories_up"), null);
});

test("a record already filed correctly is not re-proposed", () => {
  assert.equal(proposePart(item("cargo shorts", ["shorts"]), "shorts"), null);
});

test("records with nothing to go on are left alone", () => {
  assert.equal(proposePart({ name: "", tags: [] }, "upperbody"), null);
  assert.equal(proposePart({}, "upperbody"), null);
  assert.equal(haystack({ name: "A Dress", tags: ["Midi"] }), "a dress midi");
});

// End-to-end over real files: proves the scan reads each source, reads the
// right field per source (`part` for the wardrobe, `category` for inspo), and
// reports rather than rewriting.
test("scan finds candidates across all three data files without touching them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-backfill-"));
  const library = [
    { id: "a", name: "Black Short-Sleeve Open Collar Shirt", part: "upperbody", tags: ["short sleeve"] },
    { id: "b", name: "floral wrap dress", part: "upperbody", tags: ["dress"] },
    { id: "c", name: "corduroy trousers", part: "lowerbody", tags: ["trousers"] },
  ];
  await writeFile(path.join(dir, "library.json"), JSON.stringify(library));
  await writeFile(path.join(dir, "wishlist.json"), JSON.stringify([{ id: "w", name: "pleated skirt", part: "lowerbody", tags: [] }]));
  await writeFile(path.join(dir, "inspo.json"), JSON.stringify([{ id: "i", name: "linen jumpsuit", category: "upperbody" }]));

  const results = await scan(dir);
  const byLabel = Object.fromEntries(results.map((result) => [result.label, result]));

  assert.equal(byLabel.wardrobe.scanned, 3);
  assert.deepEqual(byLabel.wardrobe.candidates.map((c) => [c.id, c.from, c.to]), [["b", "upperbody", "dress"]]);
  assert.deepEqual(byLabel.wishlist.candidates.map((c) => [c.id, c.to]), [["w", "skirt"]]);
  // inspo keeps its category on a different field — the scan must follow it.
  assert.deepEqual(byLabel.inspo.candidates.map((c) => [c.id, c.field, c.to]), [["i", "category", "jumpsuit"]]);

  // The source files are untouched: scanning only reports.
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "library.json"), "utf8")), library);
});

test("a missing data file is skipped, not fatal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-backfill-empty-"));
  const results = await scan(dir);
  assert.ok(results.every((result) => result.missing));
});
