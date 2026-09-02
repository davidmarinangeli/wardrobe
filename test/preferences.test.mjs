import assert from "node:assert/strict";
import test from "node:test";
import {
  DEAD_STOCK_AFTER_DAYS,
  HALF_LIFE_DAYS,
  SIGNAL_TYPES,
  decayWeight,
  derivePreferences,
  describePreferences,
} from "../scripts/preferences.mjs";
import { normalizeSignal, readPreferencesStore, recordSignal } from "../scripts/preferences-api.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();

const wardrobe = [
  { id: "navy-tee", name: "navy tee", part: "upperbody", color: "#1f2a44", tags: ["cotton"], createdAt: daysAgo(200) },
  { id: "olive-pants", name: "olive trousers", part: "lowerbody", color: "#5c6b3f", tags: ["pleated"], createdAt: daysAgo(200) },
  { id: "red-jacket", name: "red jacket", part: "wholebody_up", color: "#b3222a", tags: [], createdAt: daysAgo(200) },
  { id: "pink-shirt", name: "berry shirt", part: "upperbody", color: "#e8a0b4", tags: [], createdAt: daysAgo(200) },
  { id: "new-scarf", name: "new scarf", part: "accessories_up", color: "#333333", tags: [], createdAt: daysAgo(3) },
];

// ---------------------------------------------------------------------------
// The rule that keeps this honest
// ---------------------------------------------------------------------------

test("there is no signal type for something the user did not do", () => {
  // No impression tracking exists, so "ignored" is not measurable and inventing
  // it from an absence is how a personalization loop poisons itself.
  for (const invented of ["outfit_ignored", "ignored", "not_clicked", "skipped", "impression"]) {
    assert.equal(SIGNAL_TYPES.has(invented), false, `${invented} must not be a recordable signal`);
    assert.equal(normalizeSignal({ type: invented, itemIds: ["navy-tee"] }), null);
  }
});

test("an empty log derives an empty profile and renders no prompt section", () => {
  const profile = derivePreferences([], { items: wardrobe, outfits: [], now: NOW });
  assert.equal(profile.signalCount, 0);
  assert.deepEqual(profile.favouredColors, []);
  // A cold-start user gets no section at all, not a section full of empty claims.
  assert.equal(describePreferences(profile), "");
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

test("a signal is worth half as much after one half-life", () => {
  assert.equal(Math.round(decayWeight(daysAgo(0), NOW) * 1000) / 1000, 1);
  assert.equal(Math.round(decayWeight(daysAgo(HALF_LIFE_DAYS), NOW) * 1000) / 1000, 0.5);
  assert.equal(Math.round(decayWeight(daysAgo(HALF_LIFE_DAYS * 2), NOW) * 1000) / 1000, 0.25);
});

test("recent taste outranks older taste of the same strength", () => {
  const profile = derivePreferences([
    { type: "outfit_saved", at: daysAgo(400), itemIds: ["pink-shirt"] },
    { type: "outfit_saved", at: daysAgo(1), itemIds: ["navy-tee"] },
  ], { items: wardrobe, outfits: [], now: NOW });

  const [top] = profile.favouredColors;
  assert.equal(top.name, "navy", "the recent save should lead");
  const older = profile.favouredColors.find((entry) => entry.name === "burgundy");
  assert.ok(older.weight < top.weight, "an 400-day-old save should be heavily decayed");
});

// ---------------------------------------------------------------------------
// What the profile actually learns
// ---------------------------------------------------------------------------

test("saving outfits teaches colors, pairings and garment types", () => {
  const profile = derivePreferences([
    { type: "outfit_saved", at: daysAgo(2), itemIds: ["navy-tee", "olive-pants"] },
    { type: "outfit_saved", at: daysAgo(4), itemIds: ["navy-tee", "olive-pants"] },
  ], { items: wardrobe, outfits: [], now: NOW });

  assert.equal(profile.positiveCount, 2);
  assert.deepEqual(profile.favouredColors.map((entry) => entry.name).sort(), ["navy", "olive"]);
  assert.equal(profile.favouredPairings[0].name, "navy + olive");
  assert.ok(profile.favouredParts.some((entry) => entry.name === "upperbody"));
});

test("a pass is recorded as a negative and never as a favourite", () => {
  const profile = derivePreferences([
    { type: "outfit_passed", at: daysAgo(1), itemIds: ["red-jacket", "pink-shirt"] },
  ], { items: wardrobe, outfits: [], now: NOW });

  assert.equal(profile.negativeCount, 1);
  assert.deepEqual(profile.favouredColors, []);
  assert.ok(profile.rejectedPairings.some((entry) => entry.name === "burgundy + red"));
  const prose = describePreferences(profile);
  assert.match(prose, /turned down/);
});

test("core pieces come from saved outfits, and need more than one appearance", () => {
  const outfits = [
    { itemIds: ["navy-tee", "olive-pants"] },
    { itemIds: ["navy-tee", "red-jacket"] },
    { itemIds: ["navy-tee", "olive-pants"] },
  ];
  const profile = derivePreferences([], { items: wardrobe, outfits, now: NOW });

  assert.equal(profile.coreItems[0].id, "navy-tee");
  assert.equal(profile.coreItems[0].outfitCount, 3);
  // red-jacket appears once — not yet core.
  assert.equal(profile.coreItems.some((item) => item.id === "red-jacket"), false);
});

const threeOutfits = [
  { itemIds: ["navy-tee", "olive-pants"] },
  { itemIds: ["navy-tee", "red-jacket"] },
  { itemIds: ["olive-pants", "new-scarf"] },
];

test("dead stock excludes anything too new to have been worn yet", () => {
  const profile = derivePreferences([], { items: wardrobe, outfits: threeOutfits, now: NOW });

  const deadIds = profile.deadStock.map((item) => item.id);
  assert.ok(deadIds.includes("pink-shirt"), "owned for 200 days, never worn");
  assert.equal(deadIds.includes("navy-tee"), false, "worn — not dead stock");
  assert.ok(DEAD_STOCK_AFTER_DAYS >= 30, "the grace period must be a real one");
});

// A garment added days ago is not being avoided, and a user who has never built
// an outfit is not avoiding their whole wardrobe. Both would be a negative
// invented from an absence.
test("nothing is dead stock until the user actually builds outfits", () => {
  const noOutfits = derivePreferences([], { items: wardrobe, outfits: [], now: NOW });
  assert.deepEqual(noOutfits.deadStock, [], "no outfits saved means no verdict on any garment");
  assert.equal(describePreferences(noOutfits), "");

  const oneOutfit = derivePreferences([], { items: wardrobe, outfits: [{ itemIds: ["navy-tee"] }], now: NOW });
  assert.deepEqual(oneOutfit.deadStock, [], "one outfit is not a pattern");

  const newItem = derivePreferences([], { items: wardrobe, outfits: threeOutfits, now: NOW });
  assert.equal(newItem.deadStock.some((item) => item.id === "new-scarf"), false, "added three days ago");
});

test("dead stock is framed as an opportunity, never as a criticism", () => {
  const profile = derivePreferences([], { items: wardrobe, outfits: threeOutfits, now: NOW });
  const prose = describePreferences(profile);
  assert.match(prose, /never a criticism/);
  // And it never claims to have learned from actions that did not happen.
  assert.doesNotMatch(prose, /Learned from 0/);
});

// ---------------------------------------------------------------------------
// Storage hygiene
// ---------------------------------------------------------------------------

test("signals are stamped server-side and stripped to known fields", () => {
  const signal = normalizeSignal({
    type: "outfit_liked",
    itemIds: ["navy-tee", 42, "olive-pants"],
    name: "Weekend",
    at: "1999-01-01T00:00:00.000Z",
    evil: "<script>",
  });

  assert.equal(signal.type, "outfit_liked");
  assert.deepEqual(signal.itemIds, ["navy-tee", "olive-pants"], "non-string ids dropped");
  assert.equal(signal.evil, undefined, "unknown fields are not persisted");
  assert.notEqual(signal.at, "1999-01-01T00:00:00.000Z", "the timestamp is ours, not the caller's");
});

// Found in the browser, not in a unit test: tapping ♥ on one card and ✕ on the
// next fired two appends that both read the same base state, and the last write
// silently dropped the other. It dropped the pass — the only honest negative
// this app can collect.
test("regression: signals arriving together are all kept", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-prefs-"));
  const kinds = ["outfit_liked", "outfit_passed", "outfit_saved", "inspo_added", "wishlist_added"];

  await Promise.all(kinds.map((type) => recordSignal(dir, { type, itemIds: ["navy-tee"] })));

  const store = await readPreferencesStore(dir);
  assert.equal(store.signals.length, kinds.length, "every concurrent signal must survive");
  assert.deepEqual(store.signals.map((signal) => signal.type).sort(), [...kinds].sort());
});

test("a rejected signal never disturbs the ones around it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-prefs-bad-"));
  await Promise.all([
    recordSignal(dir, { type: "outfit_liked", itemIds: ["a"] }),
    recordSignal(dir, { type: "outfit_ignored", itemIds: ["b"] }), // not a real signal
    recordSignal(dir, { type: "outfit_passed", itemIds: ["c"] }),
  ]);

  const store = await readPreferencesStore(dir);
  assert.deepEqual(store.signals.map((signal) => signal.type).sort(), ["outfit_liked", "outfit_passed"]);
});

test("unknown items in a signal never break derivation", () => {
  const profile = derivePreferences([
    { type: "outfit_saved", at: daysAgo(1), itemIds: ["deleted-item", "navy-tee"] },
  ], { items: wardrobe, outfits: [], now: NOW });
  assert.deepEqual(profile.favouredColors.map((entry) => entry.name), ["navy"]);
});
