import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_LOGGED_DAYS_FOR_DECLUTTER,
  UNWORN_AFTER_DAYS,
  UNWORN_OWNERSHIP_FLOOR_DAYS,
  SIGNAL_TYPES,
  deriveDeclutter,
  deriveWearStats,
} from "../scripts/preferences.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();

// Everything is owned long enough to be questionable, so each test isolates the
// rule it is about rather than tripping the ownership floor by accident.
const wardrobe = [
  { id: "navy-tee", name: "navy tee", part: "upperbody", color: "#1f2a44", createdAt: daysAgo(400) },
  { id: "olive-pants", name: "olive trousers", part: "lowerbody", color: "#5c6b3f", createdAt: daysAgo(400) },
  { id: "red-jacket", name: "red jacket", part: "wholebody_up", color: "#b3222a", createdAt: daysAgo(400) },
  { id: "new-scarf", name: "new scarf", part: "accessories_up", color: "#333333", createdAt: daysAgo(3) },
];

const wear = (itemIds, days) => ({ type: "outfit_worn", at: daysAgo(days), itemIds });
const spreadOver = (days) => Array.from({ length: days }, (_, i) => wear(["navy-tee"], i));

test("outfit_worn is recordable and mirror_submitted still is", () => {
  assert.equal(SIGNAL_TYPES.has("outfit_worn"), true);
  assert.equal(SIGNAL_TYPES.has("mirror_submitted"), true);
});

// ---------------------------------------------------------------------------
// What a wear is
// ---------------------------------------------------------------------------

test("wearing the same combination twice in one day counts once", () => {
  const signals = [wear(["navy-tee", "olive-pants"], 5), wear(["olive-pants", "navy-tee"], 5)];
  const { byItem, loggedDays } = deriveWearStats(signals, { items: wardrobe, outfits: [] });
  assert.equal(byItem["navy-tee"].wearCount, 1, "order of itemIds must not create a second wear");
  assert.equal(loggedDays, 1);
});

test("the same pieces in a different combination are a different wear", () => {
  const signals = [wear(["navy-tee", "olive-pants"], 5), wear(["navy-tee"], 5)];
  const { byItem } = deriveWearStats(signals, { items: wardrobe, outfits: [] });
  assert.equal(byItem["navy-tee"].wearCount, 2);
});

test("a bare mirror_submitted advances progress but names no garment", () => {
  const signals = [{ type: "mirror_submitted", at: daysAgo(1) }];
  const { byItem, loggedDays } = deriveWearStats(signals, { items: wardrobe, outfits: [] });
  assert.equal(loggedDays, 1, "a mirror photo proves the user dressed that day");
  for (const item of wardrobe) {
    assert.equal(byItem[item.id].lastWornAt, null, "it cannot say WHICH garments were worn");
    assert.equal(byItem[item.id].wearCount, 0);
  }
});

test("confidence separates worn from merely styled from untouched", () => {
  const outfits = [{ id: "o1", itemIds: ["olive-pants"] }];
  const { byItem } = deriveWearStats([wear(["navy-tee"], 2)], { items: wardrobe, outfits });
  assert.equal(byItem["navy-tee"].confidence, "worn");
  assert.equal(byItem["olive-pants"].confidence, "styled");
  assert.equal(byItem["red-jacket"].confidence, "untouched");
});

test("an item both styled and worn ranks as worn", () => {
  const outfits = [{ id: "o1", itemIds: ["navy-tee"] }];
  const { byItem } = deriveWearStats([wear(["navy-tee"], 2)], { items: wardrobe, outfits });
  assert.equal(byItem["navy-tee"].confidence, "worn");
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("declutter says nothing until it has been logged long enough", () => {
  const result = deriveDeclutter([wear(["navy-tee"], 1)], { items: wardrobe, outfits: [], now: NOW });
  assert.equal(result.unlocked, false);
  assert.deepEqual(result.candidates, [], "no wear-backed claim before the gate opens");
  assert.ok(result.provisional.length > 0, "the weak proxy is still offered, for a UI that labels it");
  assert.equal(result.daysNeeded, MIN_LOGGED_DAYS_FOR_DECLUTTER);
});

test("unlocking counts distinct days, not signals", () => {
  const sameDay = Array.from({ length: MIN_LOGGED_DAYS_FOR_DECLUTTER + 5 }, (_, i) =>
    ({ type: "outfit_worn", at: daysAgo(1), itemIds: [`filler-${i}`] }));
  assert.equal(deriveDeclutter(sameDay, { items: wardrobe, outfits: [], now: NOW }).unlocked, false,
    "twenty taps in one afternoon is one day of evidence");

  const spread = deriveDeclutter(spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), { items: wardrobe, outfits: [], now: NOW });
  assert.equal(spread.unlocked, true);
  assert.equal(spread.loggedDays, MIN_LOGGED_DAYS_FOR_DECLUTTER);
});

// ---------------------------------------------------------------------------
// What it flags once open
// ---------------------------------------------------------------------------

test("a piece worn recently is never a candidate", () => {
  const signals = [...spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), wear(["olive-pants"], 3)];
  const { candidates } = deriveDeclutter(signals, { items: wardrobe, outfits: [], now: NOW });
  assert.equal(candidates.some((c) => c.id === "olive-pants"), false);
});

test("a piece worn once, long ago, is flagged with the month it was last worn", () => {
  const signals = [...spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), wear(["olive-pants"], UNWORN_AFTER_DAYS + 30)];
  const { candidates } = deriveDeclutter(signals, { items: wardrobe, outfits: [], now: NOW });
  const flagged = candidates.find((c) => c.id === "olive-pants");
  assert.ok(flagged, "180+ days since the last wear is worth a second look");
  assert.match(flagged.reason, /^Not worn since \w+/);
  assert.equal(flagged.confidence, "worn");
});

test("the never-worn floor is the wardrobe's own 'fair chance' bar, not the staleness bar", () => {
  // A wardrobe imported last month would surface nothing for six months if a
  // never-worn piece had to clear UNWORN_AFTER_DAYS first.
  assert.ok(UNWORN_OWNERSHIP_FLOOR_DAYS < UNWORN_AFTER_DAYS);
  const items = [{ id: "midling", name: "midling", part: "upperbody", color: "#111111", createdAt: daysAgo(UNWORN_OWNERSHIP_FLOOR_DAYS + 5) }];
  const { candidates } = deriveDeclutter(spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), { items, outfits: [], now: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, "Never worn, never styled");
});

test("a piece bought last week is never called unworn", () => {
  const { candidates, provisional } = deriveDeclutter(spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), {
    items: wardrobe, outfits: [], now: NOW,
  });
  assert.equal(candidates.some((c) => c.id === "new-scarf"), false,
    "three days in the wardrobe is not evidence of anything");
  // It is still honestly describable as never styled, without the age claim.
  assert.equal(provisional.find((p) => p.id === "new-scarf").reason, "Never styled");
});

test("an item with no createdAt is never flagged, and never crashes", () => {
  const items = [...wardrobe, { id: "undated", name: "mystery belt", part: "accessories_up", color: "#000000" }];
  const result = deriveDeclutter(spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), { items, outfits: [], now: NOW });
  assert.equal(result.candidates.some((c) => c.id === "undated"), false,
    "unknown age is the same refusal deadStock makes");
  assert.equal(result.provisional.find((p) => p.id === "undated").reason, "Never styled");
});

test("styled-but-never-worn reads differently from never-touched", () => {
  const outfits = [{ id: "o1", itemIds: ["olive-pants"] }];
  const { candidates } = deriveDeclutter(spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), {
    items: wardrobe, outfits, now: NOW,
  });
  assert.equal(candidates.find((c) => c.id === "olive-pants").reason, "Styled, but never worn");
  assert.equal(candidates.find((c) => c.id === "red-jacket").reason, "Never worn, never styled");
});

test("the strongest case is listed first", () => {
  const { candidates } = deriveDeclutter(spreadOver(MIN_LOGGED_DAYS_FOR_DECLUTTER), {
    items: wardrobe, outfits: [], now: NOW,
  });
  const ranks = candidates.map((c) => c.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
});

test("an empty log derives empty wear facts without inventing a verdict", () => {
  const result = deriveDeclutter([], { items: wardrobe, outfits: [], now: NOW });
  assert.equal(result.unlocked, false);
  assert.equal(result.loggedDays, 0);
  assert.deepEqual(result.candidates, []);
});
