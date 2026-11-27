// Merging a piece picker's selection back into a cheat sheet's piece list.

/** Scale a newly added piece starts at (same as normalizeCheatSheetScale(undefined)). */
export const DEFAULT_SHEET_PIECE_SCALE = 1;

/**
 * Reconcile the editor's pieces with what the picker confirmed.
 *
 * current     [{ itemId, variantId, scale }] – the editor's pieces, in order.
 * picked      [{ itemId, variantId }]        – the picker's selection, in selection order.
 * offeredIds  Set<string> | undefined        – ids the picker could show; omitted means all.
 *
 * - Retained piece: keeps its scale and position, takes the picked variant
 *   (its own when the picked one is null/undefined).
 * - Removed piece (offered, not picked): dropped.
 * - Not offered (the picker never showed it, e.g. a retired piece): kept
 *   unchanged, in place.
 * - Added piece: appended in picked order at DEFAULT_SHEET_PIECE_SCALE.
 *
 * Duplicate itemIds in `picked` collapse, first wins. Inputs are never mutated.
 */
export function reconcileSheetPieces(current, picked, offeredIds) {
  const pickedById = new Map();
  for (const piece of picked) if (!pickedById.has(piece.itemId)) pickedById.set(piece.itemId, piece);
  const kept = current.flatMap((piece) => {
    if (offeredIds && !offeredIds.has(piece.itemId)) return [{ ...piece }];
    const choice = pickedById.get(piece.itemId);
    if (!choice) return [];
    return [{ ...piece, variantId: choice.variantId ?? piece.variantId }];
  });
  const seen = new Set(kept.map((piece) => piece.itemId));
  const added = [];
  for (const { itemId, variantId } of pickedById.values()) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    added.push({ itemId, variantId, scale: DEFAULT_SHEET_PIECE_SCALE });
  }
  return [...kept, ...added];
}
