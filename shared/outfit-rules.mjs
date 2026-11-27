import { GARMENT_PART_MAP } from "./garments.mjs";

// A dress or jumpsuit already dresses both halves, so the halves it covers
// stop being available — and once a top or bottom is picked, a full garment
// no longer fits the outfit either. Blocking the combination here is kinder
// than letting someone build dress-plus-trousers and discover it in the
// rendered photo.
// Layering pieces are exempt in both directions: a jacket goes over a shirt or
// over a dress equally well, so it never blocks and is never blocked (see the
// `layer` note in shared/garments.mjs).

/** The most pieces an outfit holds. The API keeps only this many; the picker stops here. */
export const OUTFIT_MAX_PIECES = 12;

/** Coverages that unselected pieces may no longer take, given the current selection. */
export function blockedCoverages(selectedItems = []) {
  const coverages = new Set();
  for (const item of selectedItems || []) {
    const part = GARMENT_PART_MAP[item?.part];
    if (!part || part.layer) continue;
    coverages.add(part.coverage);
  }
  if (coverages.has("full")) return new Set(["upper", "lower"]);
  if (coverages.has("upper") || coverages.has("lower")) return new Set(["full"]);
  return new Set();
}

/** Whether the piece's coverage is blocked. Ignores selection; the caller excludes selected pieces. */
export function isPieceBlocked(item, blocked) {
  const part = GARMENT_PART_MAP[item?.part];
  if (!part || part.layer) return false;
  return Boolean(blocked?.has(part.coverage));
}

/**
 * Why a blocked piece can't join, for its title. Null when it isn't blocked.
 * A full-length selection blocks the halves; a picked half blocks full pieces.
 */
export function blockedReason(item, blocked) {
  if (!isPieceBlocked(item, blocked)) return null;
  return blocked.has("full") ? "a top or bottom is already picked" : "a full-length piece already covers this";
}
