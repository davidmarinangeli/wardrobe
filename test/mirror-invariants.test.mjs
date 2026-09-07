// What must be true of any Mirror critique, whatever it happens to say.
//
// The fixtures check specific outfits against a verdict a person agreed with.
// This checks the properties instead — the things that have to hold for every
// outfit, every register and every wardrobe, including ones nobody wrote down.
//
// The judge here is deliberately hostile: for each outfit it asserts EVERY rule
// in the catalogue, at high confidence, citing every garment. That is a model
// behaving as badly as the schema permits, and it is the exact failure this
// architecture exists to contain — the first version of this feature took a
// model at its word and told someone a navy baseball cap would fix a shirt.
// Nothing it claims may reach the user unless the perceived facts bear it out.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildMirrorCritique, verifyEvidence } from "../scripts/style-rules.mjs";
import { FINDING_ACTIONS, MIRROR_RULE_IDS, MIRROR_RULE_MAP, rulesForRegister } from "../shared/style-catalogue.mjs";
import { REGION_TO_PARTS } from "../shared/garments.mjs";
import { findJudgmentLanguage } from "../shared/prompt-guardrails.mjs";
import { DEGENERATE, SCENARIOS, WARDROBES, registerSweep } from "./scenarios.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realWardrobe = JSON.parse(await readFile(path.join(ROOT, "data/library.json"), "utf8"));

/** A judge that claims everything, at maximum confidence, about every garment. */
const hostileJudgment = (perception) => ({
  findings: MIRROR_RULE_IDS.map((ruleId) => ({
    ruleId,
    garmentIndices: perception.garments.map((_, index) => index),
    confidence: "high",
    // Deliberately says nothing specific: the summary must not name the rule,
    // or the leak check below would be failing on this file's own test data.
    summary: "This is what I claim about the outfit.",
  })),
  works: [],
});

// Vocabulary that exists for the engine's own bookkeeping. A user seeing any of
// it means an internal id or a field name has leaked into the panel.
const INTERNAL_LEAKS = [
  /\bupperbody\b/i, /\blowerbody\b/i, /\bfullbody\b/i, /\bouterwear\b/i, /\blegwear\b/i,
  /\bformality \d/i, /\bpattern ?scale\b/i, /\bhem ?severity\b/i, /\bcolorHex\b/i,
  // A half-read garment used to interpolate straight into the copy
  // ("Undefined shirt stays controlled against undefined trousers"), and an
  // empty parenthetical is the same failure one step quieter.
  /\bundefined\b/i, /\bnull\b/i, /\bNaN\b/, /\(\s*(and\s*)?\)/, /\(\s+/,
  ...MIRROR_RULE_IDS.map((id) => new RegExp(`\\b${id}\\b`)),
];

function userFacingStrings(critique) {
  return [
    critique.overall,
    ...critique.works,
    ...critique.issues.flatMap((issue) => [issue.label, issue.summary, issue.remedy?.reason, issue.remedy?.guidance, issue.remedy?.target]),
  ].filter((value) => typeof value === "string" && value);
}

/**
 * Every property that must hold, checked against one critique. Returns nothing
 * and throws on the first violation, naming the case — a failure here should
 * read as "this outfit, this wardrobe, this claim".
 */
function assertInvariants(critique, perception, wardrobe, label) {
  const outfit = perception.garments || [];
  const inPlay = new Set(rulesForRegister(perception.register).map((rule) => rule.id));

  assert.ok(critique.issues.length <= 3, `${label}: more than three findings reached the user`);
  assert.ok(["clean", "minor", "notable"].includes(critique.verdict), `${label}: unknown verdict`);
  assert.equal(critique.verdict === "clean", critique.issues.length === 0, `${label}: verdict disagrees with the findings`);

  // Something positive is always said. Under the old shape, `works` was built
  // from whatever the issue checks left over, so an outfit with two problems
  // got zero positives — the more it had to criticise, the colder it read.
  if (outfit.length) assert.ok(critique.works.length >= 1, `${label}: nothing was said about what works`);
  assert.ok(critique.works.length <= 2, `${label}: too many positives to read`);

  const acted = new Set();
  for (const issue of critique.issues) {
    const rule = MIRROR_RULE_MAP[issue.id];
    assert.ok(rule, `${label}: reported a rule that is not in the catalogue (${issue.id})`);
    assert.ok(inPlay.has(issue.id), `${label}: "${issue.id}" is not a question you ask of a ${perception.register} outfit`);

    // The claim still has to hold against the facts, re-derived from scratch.
    const cited = issue.citedIndices.map((index) => outfit[index]);
    assert.ok(cited.every(Boolean), `${label}: "${issue.id}" cites a garment that isn't in the outfit`);
    assert.ok(verifyEvidence(issue.id, cited, outfit), `${label}: "${issue.id}" survived without its evidence holding`);

    const target = outfit[issue.targetIndex];
    assert.ok(target, `${label}: "${issue.id}" is pinned to no garment`);
    assert.equal(target.region, issue.region, `${label}: "${issue.id}" reports a region its garment does not have`);

    const { remedy } = issue;
    assert.ok(FINDING_ACTIONS.includes(remedy.action), `${label}: unknown remedy action ${remedy.action}`);
    assert.ok(rule.actions.includes(remedy.action) || remedy.action === "none", `${label}: "${issue.id}" offered an action it does not allow`);

    if (remedy.action === "none") {
      // Never a bare dead end: either the rule says what would help, or the
      // panel falls back to admitting the wardrobe has no answer.
      assert.ok(!remedy.itemId, `${label}: an abstaining remedy still named an item`);
    } else {
      assert.ok(!acted.has(issue.targetIndex), `${label}: two remedies act on the same garment`);
      acted.add(issue.targetIndex);
      assert.ok(remedy.reason, `${label}: "${issue.id}" proposed a change with no reason`);
    }

    if (remedy.itemId) {
      const item = wardrobe.find((candidate) => candidate.id === remedy.itemId);
      assert.ok(item, `${label}: offered an item that is not in the wardrobe`);
      const parts = remedy.action === "add" ? Object.values(REGION_TO_PARTS).flat() : REGION_TO_PARTS[issue.region];
      assert.ok(parts.includes(item.part), `${label}: offered a ${item.part} to change a ${issue.region} garment`);
    }
  }

  for (const value of userFacingStrings(critique)) {
    assert.deepEqual(findJudgmentLanguage(value), [], `${label}: judgment language reached the user — ${JSON.stringify(value)}`);
    for (const pattern of INTERNAL_LEAKS) {
      assert.doesNotMatch(value, pattern, `${label}: internal vocabulary reached the user — ${JSON.stringify(value)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const wardrobes = Object.entries({ ...WARDROBES, real: realWardrobe });

test("no claim survives without its evidence, across every scenario and wardrobe", () => {
  for (const scenario of [...SCENARIOS, ...registerSweep()]) {
    for (const [wardrobeName, wardrobe] of wardrobes) {
      const label = `${scenario.name} / ${wardrobeName} wardrobe`;
      const critique = buildMirrorCritique(scenario.perception, hostileJudgment(scenario.perception), wardrobe);
      assertInvariants(critique, scenario.perception, wardrobe, label);
    }
  }
});

test("each scenario's rule holds exactly when the outfit warrants it", () => {
  // Asked of the evidence directly rather than of the finished critique. A rule
  // can be true and still not be shown — outranked, or past the three-finding
  // ceiling — and conflating "not displayed" with "not true" would make this
  // test pass for the wrong reason the first time either of those changed.
  for (const scenario of SCENARIOS) {
    if (scenario.fires === null) continue;
    const outfit = scenario.perception.garments;
    assert.equal(
      verifyEvidence(scenario.rule, outfit, outfit),
      scenario.fires,
      scenario.fires
        ? `"${scenario.rule}" should hold for "${scenario.name}" and does not`
        : `"${scenario.rule}" should NOT hold for "${scenario.name}" — reporting a problem that isn't there is the worse failure`,
    );
  }
});

test("a rule that holds is actually reachable — it reaches the user when nothing outranks it", () => {
  // The companion to the check above: evidence holding is worth nothing if the
  // finding can never make it through ranking and remedy assembly.
  for (const scenario of SCENARIOS) {
    if (!scenario.fires) continue;
    const { perception } = scenario;
    const alone = {
      findings: [{
        ruleId: scenario.rule,
        garmentIndices: perception.garments.map((_, index) => index),
        confidence: "high",
        summary: "This is what I claim about the outfit.",
      }],
      works: [],
    };
    const critique = buildMirrorCritique(perception, alone, realWardrobe);
    assert.deepEqual(
      critique.issues.map((issue) => issue.id),
      [scenario.rule],
      `"${scenario.rule}" holds for "${scenario.name}" but never reaches the user`,
    );
  }
});

test("degenerate and half-read inputs produce a critique rather than an exception", () => {
  for (const shape of DEGENERATE) {
    for (const [wardrobeName, wardrobe] of wardrobes) {
      const label = `${shape.name} / ${wardrobeName} wardrobe`;
      let critique;
      assert.doesNotThrow(() => { critique = buildMirrorCritique(shape.perception, hostileJudgment(shape.perception), wardrobe); }, `${label}: threw`);
      assert.ok(critique.overall, `${label}: produced no overall line`);
      assertInvariants(critique, shape.perception, wardrobe, label);
    }
  }
});

test("an absent judgment is a warm, honest critique rather than a degraded one", () => {
  // This is the path taken when the judge call fails, so it must not look like
  // an error to the person who asked how they look.
  for (const scenario of SCENARIOS) {
    const critique = buildMirrorCritique(scenario.perception, { findings: [], works: [] }, realWardrobe);
    assert.equal(critique.verdict, "clean", `${scenario.name}: no judgment should mean nothing to report`);
    assert.ok(critique.works.length >= 1, `${scenario.name}: fell silent instead of saying something true`);
    assertInvariants(critique, scenario.perception, realWardrobe, scenario.name);
  }
});

test("the same photo always produces the same critique", () => {
  // The fix search breaks ties on a hash rather than on wardrobe order, so this
  // is the thing that keeps that from becoming "a different answer each time".
  for (const scenario of SCENARIOS) {
    const once = buildMirrorCritique(scenario.perception, hostileJudgment(scenario.perception), realWardrobe);
    const twice = buildMirrorCritique(scenario.perception, hostileJudgment(scenario.perception), realWardrobe);
    assert.deepEqual(twice, once, `${scenario.name}: two runs of the same photo disagreed`);
  }
});

test("every rule in the catalogue is exercised by at least one scenario", () => {
  // Adding a rule without a scenario for it is how a rule ends up shipping
  // untested, which is how this feature got where it was.
  const covered = new Set(SCENARIOS.map((scenario) => scenario.rule).filter(Boolean));
  const missing = MIRROR_RULE_IDS.filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], `rules with no scenario: ${missing.join(", ")}`);
});

test("every rule states what would help when it cannot offer a swap", () => {
  for (const rule of Object.values(MIRROR_RULE_MAP)) {
    assert.ok(rule.guidance, `"${rule.id}" has no guidance, so abstaining would read as a shrug`);
    assert.deepEqual(findJudgmentLanguage(rule.guidance), [], `"${rule.id}" guidance would judge the user`);
  }
});
