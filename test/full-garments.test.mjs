// A dress or jumpsuit dresses both halves of the body at once. Every piece of
// outfit logic in this app was written assuming those halves are filled by two
// separate garments, so this file covers the places that assumption used to
// break: the coverage rule, the suggestion pre-filter, and Mirror's proportion
// engine going silent on a wardrobe it could not describe.

import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_COVERAGE_PART_IDS,
  GARMENT_PART_MAP,
  MIRROR_REGIONS,
  PART_TO_REGION,
  REGION_TO_PART,
  describeCoverageRule,
  isFullCoverage,
  partsWithCoverage,
} from "../shared/garments.mjs";
import { buildMirrorCritique, evaluateProportion } from "../scripts/style-rules.mjs";
import { canCoverBody, coverageState } from "../scripts/suggestions-api.mjs";

// ---------------------------------------------------------------------------
// The coverage rule
// ---------------------------------------------------------------------------

test("the coverage rule is generated from the vocabulary, not typed", () => {
  const rule = describeCoverageRule();
  // Every full, upper and lower part must appear — that is what "generated"
  // buys us: adding a part cannot leave the rule behind.
  for (const coverage of ["full", "upper", "lower"]) {
    for (const part of partsWithCoverage(coverage)) {
      assert.ok(rule.includes(part.id), `${part.id} missing from the coverage rule`);
    }
  }
  assert.match(rule, /MUST cover both the upper and the lower body/);
  // The rule that replaced "1 top + 1 bottom" must not reintroduce it.
  assert.doesNotMatch(rule, /at least 1 top/i);
});

test("the rule forbids the combination that has no meaning", () => {
  assert.match(describeCoverageRule(), /a dress is not worn over trousers/i);
});

test("dress and jumpsuit are the full-coverage parts", () => {
  assert.deepEqual(FULL_COVERAGE_PART_IDS, ["dress", "jumpsuit"]);
  assert.equal(isFullCoverage("dress"), true);
  assert.equal(isFullCoverage("upperbody"), false);
  assert.equal(isFullCoverage("skirt"), false);
});

// ---------------------------------------------------------------------------
// Coverage arithmetic
// ---------------------------------------------------------------------------

const piece = (id, part) => ({ id, part, name: id, color: "#3a3a3a", tags: [] });

test("one full garment dresses a body; an upper alone does not", () => {
  assert.equal(canCoverBody([piece("d", "dress")]), true);
  assert.equal(canCoverBody([piece("j", "jumpsuit")]), true);
  assert.equal(canCoverBody([piece("t", "upperbody")]), false);
  assert.equal(canCoverBody([piece("t", "upperbody"), piece("p", "lowerbody")]), true);
  assert.equal(canCoverBody([piece("t", "upperbody"), piece("s", "skirt")]), true);
  assert.equal(canCoverBody([piece("sh", "shoes"), piece("a", "accessories_up")]), false);
});

test("coverage is read from the vocabulary, so new parts count automatically", () => {
  const state = coverageState([piece("b", "bodysuit"), piece("s", "shorts")]);
  assert.deepEqual(state, { full: false, upper: true, lower: true });
  assert.equal(GARMENT_PART_MAP.bodysuit.coverage, "upper");
  assert.equal(GARMENT_PART_MAP.shorts.coverage, "lower");
});

// ---------------------------------------------------------------------------
// Mirror: the surface that used to go silent
// ---------------------------------------------------------------------------

test("fullbody is a region Mirror can perceive and map back to a garment", () => {
  assert.ok(MIRROR_REGIONS.includes("fullbody"));
  assert.equal(REGION_TO_PART.fullbody, "dress", "the canonical full garment");
  assert.equal(PART_TO_REGION.dress, "fullbody");
  assert.equal(PART_TO_REGION.jumpsuit, "fullbody");
});

test("a dress no longer silences proportion feedback", () => {
  // Before: neither `top` nor `bottom` matched, so this returned nothing at all
  // and the user heard silence after asking to be looked at.
  const result = evaluateProportion([
    { region: "fullbody", color: "navy", volume: "oversized", description: "oversized maxi dress", hemNotes: "drags on the ground", hemSeverity: "severe" },
    { region: "footwear", color: "white", volume: "regular", description: "white sneakers" },
  ]);
  assert.ok(result.issue, "a dragging hem on a dress is a real, visible observation");
  assert.equal(result.issue.id, "pooling-hem");
});

test("an oversized dress is a silhouette, not a double-volume mistake", () => {
  // A single garment cannot fight itself. Comparing the dress to itself would
  // flag every oversized dress ever worn.
  const result = evaluateProportion([
    { region: "fullbody", color: "black", volume: "oversized", description: "oversized shirt dress" },
  ]);
  assert.equal(result.issue, null);
});

test("but a dress is still judged against a jacket layered over it", () => {
  const result = evaluateProportion([
    { region: "outerwear", color: "brown", volume: "oversized", description: "oversized coat" },
    { region: "fullbody", color: "black", volume: "oversized", description: "oversized dress" },
  ]);
  assert.ok(result.issue, "two separate voluminous pieces still erase the shape");
  assert.equal(result.issue.id, "double-volume");
});

test("Mirror critiques a dress outfit without erroring or going quiet", () => {
  const wardrobe = [
    piece("dress-1", "dress"),
    piece("dress-2", "dress"),
    piece("shoes-1", "shoes"),
    piece("jacket-1", "wholebody_up"),
  ];
  const critique = buildMirrorCritique([
    { region: "fullbody", color: "red", volume: "regular", description: "red midi dress" },
    { region: "footwear", color: "white", volume: "regular", description: "white sneakers" },
  ], wardrobe);

  assert.ok(critique.overall, "there is always something to say");
  assert.ok(["clean", "minor", "notable"].includes(critique.verdict));
  assert.ok(Array.isArray(critique.issues));
});

// ---------------------------------------------------------------------------
// The ticket's acceptance case
// ---------------------------------------------------------------------------

test("a wardrobe of only dresses, shoes and a jacket can dress someone", () => {
  const wardrobe = [
    piece("dress-1", "dress"),
    piece("dress-2", "dress"),
    piece("shoes-1", "shoes"),
    piece("jacket-1", "wholebody_up"),
  ];
  assert.equal(canCoverBody(wardrobe), true, "this wardrobe is wearable and must be treated as such");

  // The valid outfits it can build: a dress, optionally with shoes and a jacket.
  const outfit = [wardrobe[0], wardrobe[2], wardrobe[3]];
  assert.equal(canCoverBody(outfit), true);

  // And the combination that must never be produced from it does not exist,
  // because there is no lower-body garment to pair a dress with.
  assert.equal(coverageState(wardrobe).lower, false);
});
