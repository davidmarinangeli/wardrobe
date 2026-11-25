import { initialVariantForPiece } from "./wardrobe-model.mjs";

// What a piece picker shows and counts, given a stored selection. Legacy
// `itemIds`-only outfits go through migrateOutfit(outfit, items).pieces first;
// this only cleans an already-shaped list against the items on hand.

/**
 * Normalise [{ itemId, variantId }] against `items`: drops malformed, unknown
 * and duplicate entries (first wins) and replaces a missing or unknown variant
 * with the piece's starting variant. Keeps order; never mutates the input.
 */
export function normalizePieceSelection(pieces, items) {
  const itemsById = new Map((Array.isArray(items) ? items : []).map((item) => [item?.id, item]));
  const seen = new Set();
  const result = [];
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece || typeof piece !== "object" || typeof piece.itemId !== "string" || !piece.itemId) continue;
    const item = itemsById.get(piece.itemId);
    if (!item || seen.has(piece.itemId)) continue;
    seen.add(piece.itemId);
    const known = typeof piece.variantId === "string" && item.variants?.some((variant) => variant?.id === piece.variantId);
    result.push({ itemId: piece.itemId, variantId: known ? piece.variantId : initialVariantForPiece(item) });
  }
  return result;
}

const pieceKey = (piece) => `${piece.itemId}\u0000${piece.variantId}`;

/** Whether two selections differ as sets of itemId + variantId. Order is ignored. */
export function selectionChanged(before = [], after = []) {
  const first = new Set(before.map(pieceKey));
  const second = new Set(after.map(pieceKey));
  return first.size !== second.size || [...second].some((key) => !first.has(key));
}
