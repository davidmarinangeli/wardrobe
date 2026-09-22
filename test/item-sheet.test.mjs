import assert from "node:assert/strict";
import test from "node:test";
import { changedDraftFields, DEFAULT_ITEM_COLOR, itemMenuActions, itemMetaLine, resolveModelTier, unsavedLabel } from "../src/item-sheet.js";

const TIERS = [{ id: "standard" }, { id: "premium" }];

test("the generate button starts on the quality used last", () => {
  assert.equal(resolveModelTier("premium", TIERS, true), "premium");
  assert.equal(resolveModelTier("standard", TIERS, true), "standard");
});

test("a remembered Premium falls back to Standard where Premium is not allowed", () => {
  assert.equal(resolveModelTier("premium", TIERS, false), "standard");
});

test("a quality the current provider does not offer falls back to Standard, not to whatever is listed first", () => {
  assert.equal(resolveModelTier("openrouter", TIERS, true), "standard");
  assert.equal(resolveModelTier(null, [{ id: "premium" }, { id: "standard" }], true), "standard");
  assert.equal(resolveModelTier(null, [], true), "standard");
});

const ITEM = { name: "Full-Zip Fleece Jacket", part: "upperbody", color: "#808385", secondaryColor: "#535557", tags: ["fleece", "full-zip"] };
const draftOf = (item, overrides = {}) => ({
  name: item.name || "",
  part: item.part,
  color: item.color || DEFAULT_ITEM_COLOR,
  secondaryColor: item.secondaryColor || null,
  tags: [...(item.tags || [])],
  ...overrides,
});

test("an untouched draft has no changes", () => {
  assert.deepEqual(changedDraftFields(draftOf(ITEM), ITEM), []);
});

test("whitespace and letter case alone are not changes", () => {
  assert.deepEqual(changedDraftFields(draftOf(ITEM, { name: "  Full-Zip Fleece Jacket ", color: "#808385".toUpperCase() }), ITEM), []);
});

test("each edited property counts once, in the order the sheet shows it", () => {
  const draft = draftOf(ITEM, { part: "wholebody_up", tags: ["fleece"], name: "Fleece" });
  assert.deepEqual(changedDraftFields(draft, ITEM), ["name", "category", "tags"]);
});

test("both colours edited are one change, because they are edited in one row", () => {
  assert.deepEqual(changedDraftFields(draftOf(ITEM, { color: "#000000", secondaryColor: null }), ITEM), ["colors"]);
});

// Regression guard: a draft for an item with no colour starts on the default,
// and comparing it against the bare null counted opening the sheet as an edit.
test("an item with no colour is not dirty the moment it is opened", () => {
  const colourless = { ...ITEM, color: null };
  assert.deepEqual(changedDraftFields(draftOf(colourless), colourless), []);
});

test("the save bar counts in words", () => {
  assert.equal(unsavedLabel(1), "1 unsaved change");
  assert.equal(unsavedLabel(3), "3 unsaved changes");
});

const VARIANTS = [{ id: "s", name: "Standard" }, { id: "r", name: "Sleeves rolled" }];

test("one way to wear it and no model photo leaves only deleting the item", () => {
  assert.deepEqual(itemMenuActions({ variants: [VARIANTS[0]], selectedVariantId: "s", defaultVariantId: "s" }), {
    variantLabel: null,
    variantActions: [],
    itemActions: ["delete-item"],
  });
});

test("with a single variant the menu does not label a group with its name", () => {
  const menu = itemMenuActions({ variants: [VARIANTS[0]], selectedVariantId: "s", defaultVariantId: "s", canRegenerate: true });
  assert.deepEqual(menu.variantActions, ["regenerate"]);
  assert.equal(menu.variantLabel, null);
});

test("a variant that is not the cover can become it, or be deleted, under its own name", () => {
  const menu = itemMenuActions({ variants: VARIANTS, selectedVariantId: "r", defaultVariantId: "s", canRegenerate: true });
  assert.deepEqual(menu.variantActions, ["regenerate", "cover", "delete-variant"]);
  assert.equal(menu.variantLabel, "Sleeves rolled");
});

test("the cover is not offered as a cover again", () => {
  assert.deepEqual(itemMenuActions({ variants: VARIANTS, selectedVariantId: "s", defaultVariantId: "s" }).variantActions, ["delete-variant"]);
});

test("no delete handler, no delete entry", () => {
  assert.deepEqual(itemMenuActions({ variants: [], canDeleteItem: false }).itemActions, []);
});

const NOW = new Date("2026-09-18T12:00:00Z");

test("the line under the title says what it is, how much it is worn into outfits, and when it arrived", () => {
  assert.equal(
    itemMetaLine({ typeLabel: "Top", outfitCount: 3, createdAt: "2026-08-24T12:00:00Z", now: NOW, locale: "en-GB" }),
    "Top · In 3 outfits · Added 24 Aug",
  );
  assert.equal(itemMetaLine({ typeLabel: "Top", outfitCount: 1, createdAt: "2026-08-24T12:00:00Z", now: NOW, locale: "en-GB" }), "Top · In 1 outfit · Added 24 Aug");
});

test("no outfits and no date simply drop out of the line", () => {
  assert.equal(itemMetaLine({ typeLabel: "Jacket", outfitCount: 0, createdAt: null, now: NOW, locale: "en-GB" }), "Jacket");
  assert.equal(itemMetaLine({ typeLabel: "Jacket", createdAt: "not a date", now: NOW, locale: "en-GB" }), "Jacket");
});

test("an item from another year carries the year", () => {
  assert.equal(itemMetaLine({ typeLabel: "Top", createdAt: "2025-03-02T12:00:00Z", now: NOW, locale: "en-GB" }), "Top · Added 2 Mar 2025");
});
