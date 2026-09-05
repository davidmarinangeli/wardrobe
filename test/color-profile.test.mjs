import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEASONS,
  getSeasonAsset,
  getSeasonDisplayNames,
  itemMatchesPalette,
} from "../shared/color-seasons.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("12 canonical Armocromia sub-seasons and 4 legacy seasons exist", () => {
  const canonical12 = [
    "winter-cool", "winter-deep", "winter-bright", "winter-true",
    "summer-cool", "summer-light", "summer-soft", "summer-true",
    "autumn-warm", "autumn-deep", "autumn-soft", "autumn-true",
    "spring-warm", "spring-light", "spring-bright", "spring-true",
  ];
  for (const id of canonical12) {
    assert.ok(SEASONS[id], `Missing canonical season: ${id}`);
    assert.equal(SEASONS[id].id, id);
    assert.ok(Array.isArray(SEASONS[id].palette) && SEASONS[id].palette.length === 8);
    assert.ok(SEASONS[id].accent, `Missing accent color on: ${id}`);
    assert.ok(SEASONS[id].labelEn, `Missing labelEn on: ${id}`);
    assert.ok(SEASONS[id].labelIt, `Missing labelIt on: ${id}`);
  }

  // 4 legacy keys for backward compatibility
  const legacy4 = ["winter", "summer", "autumn", "spring"];
  for (const leg of legacy4) {
    assert.ok(SEASONS[leg], `Missing legacy season alias: ${leg}`);
    assert.ok(SEASONS[leg].palette.length === 8);
    assert.ok(SEASONS[leg].accent);
    assert.ok(SEASONS[leg].label);
  }
});

test("getSeasonAsset resolves gender-adapted and fallback assets", () => {
  assert.equal(getSeasonAsset("winter-cool", "man"), "/seasons/winter-cool_man.jpg");
  assert.equal(getSeasonAsset("winter-cool", "woman"), "/seasons/winter-cool_woman.jpg");
  assert.equal(getSeasonAsset("winter", "man"), "/seasons/winter-cool_man.jpg");
  assert.equal(getSeasonAsset("autumn-deep", "man"), "/seasons/autumn_man.jpg");
  assert.equal(getSeasonAsset("autumn-deep", "woman"), "/seasons/autumn.jpg");
  assert.equal(getSeasonAsset("spring-warm", "woman"), "/seasons/spring.jpg");
  assert.equal(getSeasonAsset("summer-cool", "woman"), "/seasons/summer.jpg");
});

test("getSeasonDisplayNames provides bilingual names", () => {
  const coolWinter = SEASONS["winter-cool"];
  const names = getSeasonDisplayNames(coolWinter);
  assert.ok(names.primary);
  assert.ok(names.secondary);
  assert.ok(names.primary === "Cool Winter" || names.primary === "Inverno Cool");
});

test("itemMatchesPalette matches garments within Euclidean threshold", () => {
  const profile = {
    season: "winter-cool",
    palette: ["#1B3F8B", "#00693E", "#FFFFFF", "#101010"],
  };

  // Exact match (optical white)
  assert.equal(itemMatchesPalette({ color: "#FFFFFF" }, profile), true);

  // Close match (deep royal blue #1A3E8A vs #1B3F8B)
  assert.equal(itemMatchesPalette({ color: "#1A3E8A" }, profile), true);

  // Distant color (warm peach #FFB27A)
  assert.equal(itemMatchesPalette({ color: "#FFB27A" }, profile), false);

  // Secondary color matching
  assert.equal(itemMatchesPalette({ color: "#FFB27A", secondaryColor: "#1B3F8B" }, profile), true);
});

test("color-profile-api enforces no-judgment guardrail", async () => {
  const apiCode = await readFile(path.join(ROOT, "scripts/color-profile-api.mjs"), "utf8");
  assert.ok(apiCode.includes("NO-JUDGMENT GUARDRAIL"));
  assert.ok(apiCode.includes("Do not evaluate or comment on attractiveness"));
});

test("drape sets cover temperature, the four seasons, and both sister limbos", async () => {
  const { DRAPE_SETS } = await import("../shared/draping.mjs");

  for (const id of ["temperature", "macro", "sisterDeep", "sisterSoft"]) {
    assert.ok(DRAPE_SETS[id], `Missing drape set: ${id}`);
    assert.ok(DRAPE_SETS[id].question, `Drape set ${id} has no question`);
    assert.ok(Array.isArray(DRAPE_SETS[id].candidates) && DRAPE_SETS[id].candidates.length >= 2);
  }

  // A candidate is only useful if it can be worn: solid fabrics to drape with,
  // and a palette to fall back on for reference swatches.
  for (const [setId, set] of Object.entries(DRAPE_SETS)) {
    for (const candidate of set.candidates) {
      assert.ok(candidate.fabrics.length >= 1, `${setId}/${candidate.id} has no fabrics`);
      assert.equal(
        candidate.fabrics.length,
        candidate.fabricNames.length,
        `${setId}/${candidate.id} fabric names don't match fabrics`
      );
      assert.ok(candidate.palette.length >= 4, `${setId}/${candidate.id} palette too small`);
      assert.ok(/^#[0-9a-fA-F]{6}$/.test(candidate.accent), `${setId}/${candidate.id} bad accent`);
    }
    // Every candidate in a set must offer the same number of fabrics, because
    // the stepper swaps both sides at once.
    const counts = new Set(set.candidates.map((c) => c.fabrics.length));
    assert.equal(counts.size, 1, `${setId} candidates disagree on fabric count`);
  }

  assert.deepEqual(
    DRAPE_SETS.sisterDeep.candidates.map((c) => c.seasonId),
    ["autumn-deep", "winter-cool"]
  );
  assert.deepEqual(
    DRAPE_SETS.sisterSoft.candidates.map((c) => c.seasonId),
    ["summer-soft", "autumn-soft"]
  );
});

test("a candidate either resolves to a real season or narrows the temperature", async () => {
  const { DRAPE_SETS } = await import("../shared/draping.mjs");

  for (const [setId, set] of Object.entries(DRAPE_SETS)) {
    for (const candidate of set.candidates) {
      if (candidate.seasonId) {
        assert.ok(
          SEASONS[candidate.seasonId],
          `${setId}/${candidate.id} points at an unknown season: ${candidate.seasonId}`
        );
      } else {
        // No season means it must at least tell the user something actionable.
        assert.ok(
          ["warm", "cool"].includes(candidate.narrowsTo),
          `${setId}/${candidate.id} resolves to nothing at all`
        );
      }
    }
  }
});

test("the drape outline clears the neck and reaches the bottom of the frame", async () => {
  const { buildDrapePath } = await import("../shared/draping.mjs");
  const width = 760;
  const height = 950;
  const path = buildDrapePath(width, height, { y: 0.78, left: 0.33, right: 0.72 });

  assert.match(path, /^M 0,/, "Drape must start at the left edge");
  assert.match(path, /Z$/, "Drape must be a closed shape");
  assert.ok(path.includes(`L ${width},${height}`), "Drape must reach the bottom-right corner");

  // Nothing in the outline may sit above the jaw, or the drape would cover the
  // face it's meant to be judged against.
  const ys = [...path.matchAll(/[ ,](\d+(?:\.\d+)?)(?=[ ,]|$)/g)]
    .map((match) => Number(match[1]))
    .filter((value, index) => index % 2 === 1);
  assert.ok(Math.min(...ys) > height * 0.55, "Drape rides too high up the face");
});

test("onboarding photo guide assets exist on disk", async () => {
  const { stat } = await import("node:fs/promises");

  const expectedOnboarding = [
    "public/onboarding/fullbody_do.jpg",
    "public/onboarding/fullbody_dont.jpg",
    "public/onboarding/face_do.jpg",
    "public/onboarding/face_dont.jpg",
  ];
  for (const relPath of expectedOnboarding) {
    const s = await stat(path.join(ROOT, relPath));
    assert.ok(s.size > 10000, `Onboarding asset ${relPath} is unexpectedly small or missing`);
  }
});
