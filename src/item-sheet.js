// The decisions behind the item sheet, kept out of React so the behaviour the
// redesign depends on can be tested directly — which quality a generate button
// starts on, what counts as an unsaved change, and what the ⋯ menu offers.

// A draft for an item with no colour yet starts on this, so it must also be what
// the item is compared against — otherwise opening such an item would count as
// an edit before anything was touched.
export const DEFAULT_ITEM_COLOR = "#9a9286";

export const MODEL_TIER_STORAGE_KEY = "wardrobe:modeled-tier";

/**
 * The quality a generate button starts on: the one used last, as long as the
 * current provider still offers it and it is allowed in this mode. Otherwise
 * Standard, the cheap default, rather than whatever happens to be listed first.
 */
export function resolveModelTier(stored, tiers, premiumAllowed = true) {
  const allowed = (tiers || []).filter((tier) => tier.id !== "premium" || premiumAllowed);
  if (allowed.some((tier) => tier.id === stored)) return stored;
  return allowed.find((tier) => tier.id === "standard")?.id || allowed[0]?.id || "standard";
}

/**
 * The fields a draft has changed, in the order the sheet shows them. The save
 * bar counts these, so two colours edited are one change to "Colors", matching
 * the one row they were edited in.
 */
export function changedDraftFields(draft, item) {
  const tags = (list) => (list || []).map((tag) => tag.trim()).filter(Boolean);
  const color = (value) => value?.toLowerCase() || null;
  const changes = [];
  if ((draft.name || "").trim() !== (item.name || "").trim()) changes.push("name");
  if (draft.part !== item.part) changes.push("category");
  if (
    color(draft.color) !== color(item.color || DEFAULT_ITEM_COLOR)
    || color(draft.secondaryColor) !== color(item.secondaryColor)
  ) changes.push("colors");
  if (JSON.stringify(tags(draft.tags)) !== JSON.stringify(tags(item.tags))) changes.push("tags");
  return changes;
}

export function unsavedLabel(count) {
  return `${count} unsaved ${count === 1 ? "change" : "changes"}`;
}

/**
 * What the ⋯ menu offers. Rare and destructive actions live here rather than on
 * the sheet, grouped by what they act on: the way of wearing it on screen, then
 * the item. The variant group is only labelled when there is more than one
 * variant — with one, its name ("Standard") would label nothing useful.
 */
export function itemMenuActions({ variants = [], selectedVariantId = null, defaultVariantId = null, canRegenerate = false, canDeleteItem = true } = {}) {
  const selected = variants.find((variant) => variant.id === selectedVariantId) || null;
  const several = variants.length > 1;
  const variantActions = [];
  if (canRegenerate) variantActions.push("regenerate");
  if (several && selected && selected.id !== defaultVariantId) variantActions.push("cover");
  if (several && selected) variantActions.push("delete-variant");
  return {
    variantLabel: several && variantActions.length ? selected?.name || null : null,
    variantActions,
    itemActions: canDeleteItem ? ["delete-item"] : [],
  };
}

function formatAddedDate(createdAt, now, locale) {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** The line under the title: what it is, how much it is used, how long it has been here. */
export function itemMetaLine({ typeLabel, outfitCount = 0, createdAt, now = new Date(), locale } = {}) {
  const added = formatAddedDate(createdAt, now, locale);
  return [
    typeLabel,
    outfitCount ? `In ${outfitCount} ${outfitCount === 1 ? "outfit" : "outfits"}` : "",
    added ? `Added ${added}` : "",
  ].filter(Boolean).join(" · ");
}
