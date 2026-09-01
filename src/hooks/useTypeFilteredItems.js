import { useMemo } from "react";
import { TYPE_ORDER } from "../categories.js";

/**
 * Filters a list of garments by `item.part` against `activeType` ("all" or a
 * category id), then sorts: canonical category order when showing everything,
 * otherwise stable by id. Shared by Wardrobe and Wishlist, which filtered and
 * sorted their grids identically — this was the same ~10 lines duplicated in
 * both files.
 *
 * @param {Array} items
 * @param {string} activeType - "all" or a `part` value from categories.js.
 * @param {(item: object) => boolean} [extraFilter] - Applied after the type
 *   filter (e.g. Wardrobe's "matches my colors"). Memoize this at the call
 *   site (useCallback) so it doesn't force a re-filter every render.
 */
export function useTypeFilteredItems(items, activeType, extraFilter) {
  return useMemo(() => {
    let filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    if (extraFilter) filtered = filtered.filter(extraFilter);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [items, activeType, extraFilter]);
}
