import assert from "node:assert/strict";
import test from "node:test";
import { buildModeledPrompt } from "../scripts/import-job-api.mjs";

test("single garment, no face reference: image roles and non-extension clause", () => {
  const prompt = buildModeledPrompt([{ name: "Crew Neck T-Shirt", tags: ["oversized", "crew neck"] }], { hasFaceReference: false });
  assert.match(prompt, /Image 1 is the exact person/);
  // "crew neck" is already in the name, so only the tag that adds something survives.
  assert.match(prompt, /Image 2 is the exact Crew Neck T-Shirt \(oversized\)/);
  assert.match(prompt, /Do not resize a garment or restyle it toward a more generic fit/);
  assert.match(prompt, /oversized/);
  assert.doesNotMatch(prompt, /close-up reference of that same person's face/);
});

test("single garment with face reference shifts garment to Image 3 and anchors identity to Image 2", () => {
  const prompt = buildModeledPrompt([{ name: "Ankle Trousers", tags: ["cropped", "ankle-length"] }], { hasFaceReference: true });
  assert.match(prompt, /Image 2 is a close-up reference of that same person's face/);
  assert.match(prompt, /Image 3 is the exact Ankle Trousers \(cropped, ankle-length\)/);
  assert.match(prompt, /identity anchored by Image 2/);
  assert.match(prompt, /cropped, ankle-length/);
});

test("multi-garment outfit lists every garment image and references the full range", () => {
  const prompt = buildModeledPrompt(
    [
      { name: "Linen Shirt", tags: ["short sleeve"] },
      { name: "Wide Leg Trousers", tags: ["cropped"] },
    ],
    { hasFaceReference: true },
  );
  assert.match(prompt, /Image 3 is the exact Linen Shirt \(short sleeve\)/);
  assert.match(prompt, /Image 4 is the exact Wide Leg Trousers \(cropped\)/);
  assert.match(prompt, /all 2 garments from Images 3 through 4, worn together as one complete outfit/);
  assert.match(prompt, /every featured piece/);
});

test("garment with no name/tags falls back to a generic descriptor without throwing", () => {
  const prompt = buildModeledPrompt([{}], { hasFaceReference: false });
  assert.match(prompt, /Image 2 is the exact garment to depict/);
});

test("identity-preservation clause names ethnicity and skin tone", () => {
  const prompt = buildModeledPrompt([{ name: "Tee" }], { hasFaceReference: true });
  assert.match(prompt, /identity, face, hair, age, ethnicity, skin tone, and body proportions exactly/);
  assert.match(prompt, /skin tone, ethnicity, hairline/);
});

test("short-sleeve t-shirt gets an explicit above-the-elbow rule even when tagged oversized", () => {
  const prompt = buildModeledPrompt([{ name: "Oversized Crew Neck T-Shirt", tags: ["oversized", "crew neck"] }], { hasFaceReference: false });
  assert.match(prompt, /even an oversized one — ends above the elbow, never at or past it/);
});

test("raglan tee (no explicit sleeve-length tag) still triggers the short-sleeve rule", () => {
  const prompt = buildModeledPrompt([{ name: "raglan t-shirt", tags: ["raglan", "t-shirt", "two-tone", "casual", "oversize"] }], { hasFaceReference: true });
  assert.match(prompt, /even an oversized one — ends above the elbow/);
});

test("a 3/4-sleeve or long-sleeve garment does not get the short-sleeve rule", () => {
  const threeQuarter = buildModeledPrompt([{ name: "3/4 Sleeve Baseball Tee", tags: ["raglan"] }], { hasFaceReference: false });
  assert.doesNotMatch(threeQuarter, /ends above the elbow/);
  const longSleeve = buildModeledPrompt([{ name: "Long Sleeve Henley" }], { hasFaceReference: false });
  assert.doesNotMatch(longSleeve, /ends above the elbow/);
});

test("a non-shirt garment (trousers) does not get the short-sleeve rule", () => {
  const prompt = buildModeledPrompt([{ name: "Ankle Trousers", tags: ["cropped"] }], { hasFaceReference: false });
  assert.doesNotMatch(prompt, /ends above the elbow/);
});

test("socks with full-length trousers get a no-rolling/no-cuffing rule", () => {
  const prompt = buildModeledPrompt(
    [
      { name: "Straight Leg Trousers", tags: [] },
      { name: "Ribbed Socks", tags: [], part: "socks" },
    ],
    { hasFaceReference: false },
  );
  assert.match(prompt, /Do not cuff, roll up, or shorten the trousers/);
});

test("socks with ankle-length trousers skip the no-rolling rule", () => {
  const prompt = buildModeledPrompt(
    [
      { name: "Ankle Trousers", tags: ["cropped"] },
      { name: "Ribbed Socks", tags: [], part: "socks" },
    ],
    { hasFaceReference: false },
  );
  assert.doesNotMatch(prompt, /Do not cuff, roll up, or shorten the trousers/);
});

test("socks with shorts skip the no-rolling rule", () => {
  const prompt = buildModeledPrompt(
    [
      { name: "Chino Shorts", tags: [] },
      { name: "Ribbed Socks", tags: [], part: "socks" },
    ],
    { hasFaceReference: false },
  );
  assert.doesNotMatch(prompt, /Do not cuff, roll up, or shorten the trousers/);
});

test("socks alone (no bottoms in the outfit) do not trigger the trouser rule", () => {
  const prompt = buildModeledPrompt([{ name: "Ribbed Socks", tags: [], part: "socks" }], { hasFaceReference: false });
  assert.doesNotMatch(prompt, /Do not cuff, roll up, or shorten the trousers/);
});

test("fidelity is owed to the garment, not to the pose it holds in its photo", () => {
  const prompt = buildModeledPrompt([{ name: "Wide Leg Cargo Pants", tags: ["wide-leg", "cargo", "casual"] }], { hasFaceReference: false });
  assert.match(prompt, /photographed unworn/);
  assert.match(prompt, /derive its shape from how that garment would hang/);
  assert.match(prompt, /Reproduce the garment, not its resting pose/);
  // The old wording demanded a pixel-faithful copy and then forbade loosening or tightening, which
  // together instructed the model to paint a flat-lay's outline onto a body.
  assert.doesNotMatch(prompt, /pixel-faithful/);
  assert.doesNotMatch(prompt, /tighten, loosen/);
  // Both fit words are already in the name — including across the hyphen/space difference — so
  // only the tag that adds something is kept.
  assert.match(prompt, /Wide Leg Cargo Pants \(casual\)/);
});

test("a cap is worn on the head rather than turned to face the camera", () => {
  const prompt = buildModeledPrompt([{ name: "Baseball Cap", tags: ["embroidered"] }], { hasFaceReference: false });
  assert.match(prompt, /a cap sits properly on the head/);
  assert.doesNotMatch(prompt, /clearly visible and unobstructed/);
});
