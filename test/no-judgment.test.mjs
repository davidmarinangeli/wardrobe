// The app must never imply a user's clothes are wrong, dated, or behind.
//
// Two different enforcement problems live here:
//  - Generative surfaces (suggestions, style DNA, captions) are constrained by a
//    prompt block. The test asserts the block is actually present in each prompt.
//  - Mirror builds its critique deterministically in style-rules.mjs. No prompt
//    can constrain it, so its strings are audited directly — this is the surface
//    where the user has explicitly asked to be judged and the honest answer is
//    still about proportion and color, never about era.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FORBIDDEN_JUDGMENT_PATTERNS,
  NO_JUDGMENT_PROMPT,
  NO_JUDGMENT_RULES,
  findJudgmentLanguage,
} from "../shared/prompt-guardrails.mjs";
import { buildMirrorCritique } from "../scripts/style-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => readFile(path.join(ROOT, file), "utf8");

// ---------------------------------------------------------------------------
// The detector itself
// ---------------------------------------------------------------------------

test("the detector catches the language that must never reach a user", () => {
  const offenders = [
    "Those jeans are a bit dated now.",
    "Skinny jeans are out of style.",
    "Nobody wears that these days.",
    "This silhouette is very on-trend.",
    "Time to update your wardrobe.",
    "That cut is no longer worn.",
  ];
  for (const text of offenders) {
    assert.ok(findJudgmentLanguage(text).length > 0, `should have been flagged: ${text}`);
  }
});

test("the detector leaves legitimate styling language alone", () => {
  const fine = [
    "The navy reads cleanly against the olive.",
    "Both pieces are relaxed, so the proportions fight each other.",
    "Your Autumn palette favours warm, muted tones.",
    "This works for a cold, wet commute.",
    "The trousers pool at the ankle.",
    "A seasonal palette based on your skin tone.",
  ];
  for (const text of fine) {
    assert.deepEqual(findJudgmentLanguage(text), [], `false positive on: ${text}`);
  }
});

test("the guardrail block states the constraint it is named for", () => {
  assert.ok(NO_JUDGMENT_RULES.length >= 4);
  assert.match(NO_JUDGMENT_PROMPT, /HARD CONSTRAINTS/);
  assert.match(NO_JUDGMENT_PROMPT, /dated/);
  // The block itself is allowed to name the forbidden words — it is the
  // instruction not to use them.
  assert.ok(FORBIDDEN_JUDGMENT_PATTERNS.length > 10);
});

// ---------------------------------------------------------------------------
// Every generative surface carries the block
// ---------------------------------------------------------------------------

test("each generative surface injects the shared guardrail", async () => {
  const surfaces = [
    ["scripts/suggestions-api.mjs", 2], // outfit suggestions + style DNA
    ["scripts/import-job-api.mjs", 1],  // outfit style captions
  ];
  for (const [file, expected] of surfaces) {
    const text = await source(file);
    const uses = text.split("NO_JUDGMENT_PROMPT").length - 1;
    // One import plus one use per prompt.
    assert.ok(uses >= expected + 1, `${file} should inject the guardrail into ${expected} prompt(s), found ${uses - 1}`);
  }
});

test("detection is told to classify, never appraise", async () => {
  const text = await source("scripts/import-job-api.mjs");
  assert.match(text, /descriptively, never evaluatively/);
  assert.match(text, /Skinny jeans are "skinny jeans"/);
});

// ---------------------------------------------------------------------------
// Mirror: deterministic, so audited directly
// ---------------------------------------------------------------------------

const critiqueStrings = (critique) => [
  critique.overall,
  ...(critique.works || []),
  ...(critique.issues || []).flatMap((issue) => [issue.label, issue.detail, issue.fix?.reason].filter(Boolean)),
].filter((value) => typeof value === "string");

test("Mirror never reaches for era language, whatever it is shown", () => {
  const wardrobe = [
    { id: "a", name: "navy tee", part: "upperbody", color: "#1f2a44", tags: [] },
    { id: "b", name: "olive trousers", part: "lowerbody", color: "#5c6b3f", tags: [] },
    { id: "c", name: "grey trousers", part: "lowerbody", color: "#8b8b8b", tags: ["slim"] },
  ];

  // A deliberately awkward outfit, a clean one, and the empty case — the three
  // shapes the critique can take.
  const outfits = [
    [
      { region: "upperbody", color: "#b3222a", volume: "oversized", description: "red oversized tee" },
      { region: "lowerbody", color: "#5c6b3f", volume: "oversized", description: "olive baggy trousers", hemSeverity: "severe" },
    ],
    [
      { region: "upperbody", color: "#1f2a44", volume: "regular", description: "navy tee" },
      { region: "lowerbody", color: "#3d3d3d", volume: "regular", description: "charcoal trousers" },
    ],
    [],
  ];

  for (const garments of outfits) {
    const critique = buildMirrorCritique(garments, wardrobe);
    for (const text of critiqueStrings(critique)) {
      assert.deepEqual(
        findJudgmentLanguage(text),
        [],
        `Mirror produced judgment language: ${JSON.stringify(text)}`,
      );
    }
  }
});

test("the style-rules source carries no era vocabulary in its user-facing strings", async () => {
  const text = await source("scripts/style-rules.mjs");
  // Comments cite sources with words like "conventions"; only the quoted strings
  // that can reach a user are checked.
  const strings = [...text.matchAll(/"([^"\\]{12,240})"|`([^`\\]{12,240})`/g)]
    .map((match) => match[1] || match[2])
    .filter((value) => !value.startsWith("http"));

  for (const value of strings) {
    assert.deepEqual(findJudgmentLanguage(value), [], `style-rules.mjs string would judge the user: ${JSON.stringify(value)}`);
  }
});
