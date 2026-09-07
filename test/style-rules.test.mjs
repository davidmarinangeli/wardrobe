import assert from "node:assert/strict";
import test from "node:test";
import { buildMirrorCritique, classifyColor, evaluateColorHarmony, evaluateProportion } from "../scripts/style-rules.mjs";

// Real hex values pulled straight from data/library.json. HSL saturation is
// numerically unstable near white/black (it divides by a term that shrinks to
// zero at the lightness extremes), so these near-white/near-black items used
// to compute a large enough "saturation" to get misclassified as vividly
// chromatic. classifyColor must use chroma (raw channel spread) instead.

// buildMirrorCritique now takes what the judge returned alongside the perceived
// facts. These tests are about the half that matters most — whether the engine
// accepts a claim, and what it offers once it has — so the helper stands in for
// the judge and asserts the finding through, exactly as a real one would. Every
// gate downstream of it is the code under test.
const judged = (garments, ruleIds, wardrobe = [], register = "classic", photoQuality = "clear") =>
  buildMirrorCritique(
    { garments, register, photoQuality },
    {
      findings: ruleIds.map((ruleId) => ({
        ruleId,
        garmentIndices: garments.map((_, index) => index),
        confidence: "high",
        summary: `Reported ${ruleId}.`,
      })),
      works: [],
    },
    wardrobe,
  );

test("regression: near-white and near-black items classify as neutral, not chromatic", () => {
  assert.equal(classifyColor("#f2f4f7").neutral, true, "white mock neck t-shirt");
  assert.equal(classifyColor("#ece7e1").neutral, true, "white graphic t-shirt");
  assert.equal(classifyColor("#f0ede6").neutral, true, "Red and white striped t-shirt");
  assert.equal(classifyColor("#f2f3f5").neutral, true, "White Nike Air Zoom Sneakers");
  assert.equal(classifyColor("#232426").neutral, true, "Black Short-Sleeve Open Collar Shirt");
});

test("regression: muted warm tones (khaki/beige) classify as neutral across the whole lightness band", () => {
  assert.equal(classifyColor("#a89377").neutral, true, "corduroy trousers (khaki) — previously fell through the brown/tan gap at l=0.56");
  assert.equal(classifyColor("#a1957a").neutral, true, "beige pullover hoodie");
});

test("regression: a genuinely olive/green item stays chromatic, not neutral — this was the 'olive cargo is trash' bug", () => {
  const info = classifyColor("#6e715e");
  assert.equal(info.neutral, false);
  assert.equal(info.name, "olive");
});

test("a vivid, highly saturated warm color is not swept into the neutral band", () => {
  const info = classifyColor("#d68d1f"); // mustard corduroy overshirt
  assert.equal(info.neutral, false);
});

const navyShirt = { region: "upperbody", description: "open-collar shirt", color: "navy", volume: "regular", hemNotes: null };
const whiteTee = { region: "upperbody", description: "crew tee", color: "white", volume: "fitted", hemNotes: null };
const brownCargo = { region: "lowerbody", description: "wide-leg cargo pants", color: "brown", volume: "relaxed", hemNotes: null };
const brownCargoPooling = { ...brownCargo, hemNotes: "pools heavily over the shoe", hemSeverity: "severe" };

test("regression: navy top + brown bottom is not flagged as a color clash", () => {
  const { issue } = evaluateColorHarmony([navyShirt, whiteTee, brownCargo]);
  assert.equal(issue, null);
});

test("more than two non-neutral hues reads as clutter", () => {
  const red = { region: "upperbody", description: "shirt", color: "red", volume: "regular", hemNotes: null };
  const green = { region: "lowerbody", description: "trousers", color: "green", volume: "regular", hemNotes: null };
  const purple = { region: "accessory", description: "scarf", color: "purple", volume: "regular", hemNotes: null };
  const { issue } = evaluateColorHarmony([red, green, purple]);
  assert.equal(issue.id, "color-clutter");
});

test("two non-neutral hues 45-150 degrees apart is a near-miss, not intentional", () => {
  const orange = { region: "upperbody", description: "shirt", color: "orange", volume: "regular", hemNotes: null };
  const green = { region: "lowerbody", description: "trousers", color: "green", volume: "regular", hemNotes: null };
  const { issue } = evaluateColorHarmony([orange, green]);
  assert.equal(issue.id, "off-match");
});

test("complementary hues read as bold and intentional, not an issue", () => {
  const blue = { region: "upperbody", description: "shirt", color: "blue", volume: "regular", hemNotes: null };
  const orange = { region: "lowerbody", description: "trousers", color: "orange", volume: "regular", hemNotes: null };
  const { issue, note } = evaluateColorHarmony([blue, orange]);
  assert.equal(issue, null);
  assert.match(note, /bold/);
});

test("relaxed top + relaxed bottom is flagged, fix targets the top", () => {
  const relaxedTop = { region: "upperbody", description: "overshirt", color: "olive", volume: "relaxed", hemNotes: null };
  const relaxedBottom = { region: "lowerbody", description: "trousers", color: "olive", volume: "relaxed", hemNotes: null };
  const { issue } = evaluateProportion([relaxedTop, relaxedBottom]);
  assert.equal(issue.id, "double-volume");
  assert.equal(issue.region, "upperbody");
});

test("pooling hem is a fit issue independent of color", () => {
  const { issue } = evaluateProportion([navyShirt, brownCargoPooling]);
  assert.equal(issue.id, "pooling-hem");
  assert.equal(issue.region, "lowerbody");
});

test("regression: a wide-leg trouser with only slight break is not flagged — that's the silhouette working as intended", () => {
  const wideLegSlightBreak = { region: "lowerbody", description: "wide-leg trousers", color: "beige", volume: "relaxed", hemNotes: "rests lightly over the shoe", hemSeverity: "slight" };
  const { issue, note } = evaluateProportion([navyShirt, wideLegSlightBreak]);
  assert.equal(issue, null);
  assert.match(note, /expected/);
});

test("a fitted trouser pooling at all is still a real issue, even at slight severity", () => {
  const fittedButPooling = { region: "lowerbody", description: "slim trousers", color: "navy", volume: "fitted", hemNotes: "bunches slightly at the shoe", hemSeverity: "slight" };
  const { issue } = evaluateProportion([navyShirt, fittedButPooling]);
  assert.equal(issue.id, "pooling-hem");
});

test("a wide-leg trouser with severe pooling is still flagged, but never called a length mistake", () => {
  const wideLegSeverePooling = { region: "lowerbody", description: "wide-leg trousers", color: "beige", volume: "relaxed", hemNotes: "stacks heavily and covers the shoe", hemSeverity: "severe" };
  const { issue } = evaluateProportion([navyShirt, wideLegSeverePooling]);
  assert.equal(issue.id, "pooling-hem");
  assert.doesNotMatch(issue.summary, /not a style choice/);
});

test("coherence guard: two findings never land on the same garment, and neither is thrown away for wanting to", () => {
  // Both of these prefer the same piece: the near-miss colour pairing and the
  // double-volume silhouette each point first at the red overshirt. They are
  // genuinely different observations, so the second one retargets to another
  // garment it cited rather than being dropped — what must never happen is two
  // pieces of advice about the same garment, which is how a critique starts
  // contradicting itself.
  const relaxedRedJacket = { region: "outerwear", description: "overshirt", color: "red", volume: "relaxed", hemNotes: null };
  const relaxedGreenTop = { region: "upperbody", description: "tee", color: "green", volume: "regular", hemNotes: null };
  const relaxedBottom = { region: "lowerbody", description: "trousers", color: "navy", volume: "relaxed", hemNotes: null };
  const critique = judged([relaxedRedJacket, relaxedGreenTop, relaxedBottom], ["off-match", "double-volume"]);
  assert.equal(critique.issues[0].id, "double-volume", "fit evidence is more directly observable, so it claims its preferred garment first");
  assert.equal(critique.issues[0].region, "outerwear");

  // The invariant is about advice, not about observations: two findings may
  // both be ABOUT the overshirt, but only one of them may tell you to change it.
  const acted = critique.issues.filter((issue) => issue.remedy.action !== "none").map((issue) => issue.region);
  assert.equal(new Set(acted).size, acted.length, "no two remedies may act on the same garment");
});

test("no grounded issues found: positive, honest critique with no swaps", () => {
  const critique = judged([navyShirt, whiteTee, brownCargo], []);
  assert.equal(critique.verdict, "clean");
  assert.equal(critique.issues.length, 0);
  assert.ok(critique.works.length > 0);
});

test("regression via full pipeline: the exact bug-report outfit no longer flags navy+brown, and the pooling hem gets a single, non-contradictory fix", () => {
  const wardrobe = [
    { id: "black-trousers", name: "Black Pleated Trousers", part: "lowerbody", color: "#1c1c1c", tags: ["slim", "tailored", "pleated"] },
    { id: "wide-trousers", name: "Wide Chino", part: "lowerbody", color: "#2b2b2b", tags: ["wide-leg", "relaxed"] },
  ];
  const critique = judged([navyShirt, whiteTee, brownCargoPooling], ["off-match", "pooling-hem"], wardrobe);
  assert.equal(critique.issues.length, 1, "navy and brown are both neutrals — there is no colour finding to make");
  assert.equal(critique.issues[0].id, "pooling-hem");
  assert.equal(critique.issues[0].remedy.itemId, "black-trousers");
});

test("regression: the wardrobe fix accounts for the specific outfit's colors, not just fit keywords", () => {
  // Real wardrobe data: both trousers are tagged "tailored", but one is olive
  // (chromatic) and one is brown (neutral). Paired with a red top, olive creates
  // a fresh off-match issue (hue distance ~70°) while brown stays safe — so the
  // fix should never blindly pick the same "most tailored" item regardless of
  // what it's being paired with.
  const redTop = { region: "upperbody", description: "shirt", color: "red", volume: "regular", hemNotes: null };
  const poolingNavyBottom = { region: "lowerbody", description: "trousers", color: "navy", volume: "relaxed", hemNotes: "pools moderately over the shoe", hemSeverity: "moderate" };
  const wardrobe = [
    { id: "olive-tailored", name: "olive green tailored trousers", part: "lowerbody", color: "#555c3c", tags: ["olive", "trousers", "pleated", "tailored"] },
    { id: "brown-tailored", name: "long dark brown loose fit pleated trousers", part: "lowerbody", color: "#3a2b22", tags: ["trousers", "long", "pleated", "tailored", "brown", "loose fit"] },
  ];
  const critique = judged([redTop, poolingNavyBottom], ["pooling-hem"], wardrobe);
  assert.equal(critique.issues[0].remedy.itemId, "brown-tailored");

  // With a neutral top, both candidates are equally color-safe on fit grounds
  // alone — real wardrobes hit this a lot (most tops here are black/navy/grey).
  // The tie should resolve to the neutral candidate (the grounded safe default),
  // not silently fall back to wardrobe list order every single time.
  const navyTop = { region: "upperbody", description: "shirt", color: "navy", volume: "regular", hemNotes: null };
  const secondCritique = judged([navyTop, poolingNavyBottom], ["pooling-hem"], wardrobe);
  assert.equal(secondCritique.issues[0].remedy.itemId, "brown-tailored");
});

test("a fix is only ever suggested when a wardrobe item clears the confidence bar", () => {
  const relaxedTop = { region: "upperbody", description: "overshirt", color: "olive", volume: "relaxed", hemNotes: null };
  const relaxedBottom = { region: "lowerbody", description: "trousers", color: "olive", volume: "relaxed", hemNotes: null };
  const noHelpfulWardrobe = [{ id: "another-relaxed-top", name: "Boxy Overshirt", part: "upperbody", color: "#556b2f", tags: ["relaxed", "boxy"] }];
  const critique = judged([relaxedTop, relaxedBottom], ["double-volume"], noHelpfulWardrobe);
  assert.equal(critique.issues.length, 1);
  assert.equal(critique.issues[0].remedy.action, "none", "no swap beats a swap that changes nothing");
});
