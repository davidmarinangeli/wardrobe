// "What do I actually wear this with?" — answered for the whole wardrobe grid
// without pulling (or waiting on) the full outfit list.
//
// Split in two on purpose. The server trims each outfit to the four fields the
// wardrobe surfaces render; the client does the group-by. The ticket proposed
// shipping the grouping itself ({ itemId: outfitIds }), but measured against a
// real 26-outfit wardrobe that shape is only ~2% smaller than the raw list —
// every item id appears twice, once in the lineup and once as a key — while the
// summaries alone are ~44% smaller and the grouping is one pass on arrival.

// Server side: outfit records carry model photo state, style prose, tags and
// timestamps that no cross-reference needs. Drop them.
export function summarizeOutfits(outfits = []) {
  const summaries = [];
  for (const outfit of outfits) {
    if (!outfit?.id || !Array.isArray(outfit.itemIds)) continue;
    summaries.push({
      id: outfit.id,
      name: outfit.name || "",
      modeledImage: outfit.modeledImage || null,
      itemIds: outfit.itemIds.filter((id) => typeof id === "string" && id),
    });
  }
  return summaries;
}

// Client side: piece id -> the outfits using it, plus the summaries by id so a
// count can become thumbnails without a second lookup table.
export function buildOutfitIndex(summaries = []) {
  const outfits = {};
  const byItem = {};

  for (const outfit of summaries) {
    if (!outfit?.id || !Array.isArray(outfit.itemIds)) continue;
    outfits[outfit.id] = outfit;
    // A piece listed twice in the same outfit is still one outfit — otherwise a
    // duplicated id in the lineup would inflate the count on that card.
    for (const itemId of new Set(outfit.itemIds)) {
      if (typeof itemId !== "string" || !itemId) continue;
      (byItem[itemId] ||= []).push(outfit.id);
    }
  }

  return { outfits, byItem };
}
