// Ground truth for the Mirror, held as whole photos rather than as unit cases.
//
// Every previous round of fixes to this feature was verified against a
// hand-made example and shipped, and every one of them was still wrong on the
// photo that had prompted the complaint. Each fixture here is a real outfit,
// carrying the perceived facts, a judgment (including the wrong findings a
// model plausibly returns for it), and what the user must end up seeing. A
// change that improves one photo and quietly breaks another fails here.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildMirrorCritique } from "../scripts/style-rules.mjs";
import { GARMENT_PART_MAP } from "../shared/garments.mjs";
import { findJudgmentLanguage } from "../shared/prompt-guardrails.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test/fixtures/mirror");

const wardrobe = JSON.parse(await readFile(path.join(ROOT, "data/library.json"), "utf8"));
const files = (await readdir(FIXTURES)).filter((file) => file.endsWith(".json")).sort();
assert.ok(files.length >= 5, "the fixture set should cover more than a couple of outfits");

for (const file of files) {
  const fixture = JSON.parse(await readFile(path.join(FIXTURES, file), "utf8"));
  const { expect } = fixture;

  test(`fixture: ${fixture.name}`, () => {
    const critique = buildMirrorCritique(fixture.perception, fixture.judgment, wardrobe);
    const ids = critique.issues.map((issue) => issue.id);

    assert.deepEqual(ids, expect.issueIds, `issues for ${file}\n  why: ${fixture.why}`);
    assert.equal(critique.verdict, expect.verdict, `verdict for ${file}`);

    // A rejected finding must be gone, not merely reworded.
    for (const [ruleId, reason] of Object.entries(expect.rejects || {})) {
      assert.ok(!ids.includes(ruleId), `${file}: "${ruleId}" should have been dropped — ${reason}`);
    }

    assert.ok(
      critique.works.length >= (expect.minWorks || 0),
      `${file}: the critique must still say what works, even when it is also reporting a problem`,
    );

    if (expect.remedyRegion) {
      assert.equal(critique.issues[0].region, expect.remedyRegion, `${file}: the finding is pinned on the wrong garment`);
    }

    // The navy-cap failure in one assertion: a remedy may never reach into a
    // wardrobe category that has nothing to do with the garment at fault.
    if (expect.forbidRemedyPart) {
      for (const issue of critique.issues) {
        const item = issue.remedy?.itemId && wardrobe.find((candidate) => candidate.id === issue.remedy.itemId);
        if (!item) continue;
        assert.notEqual(item.part, expect.forbidRemedyPart, `${file}: offered a ${GARMENT_PART_MAP[item.part]?.singular} to fix a ${issue.region} problem`);
      }
    }

    // Whatever it says, it never says it in the register the guardrail forbids.
    const strings = [critique.overall, ...critique.works, ...critique.issues.flatMap((issue) => [issue.label, issue.summary, issue.remedy?.reason].filter(Boolean))];
    for (const value of strings) {
      assert.deepEqual(findJudgmentLanguage(value), [], `${file}: judgment language reached the user: ${JSON.stringify(value)}`);
    }
  });
}
