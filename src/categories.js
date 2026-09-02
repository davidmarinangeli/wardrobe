// Canonical garment category definitions.
// Views import BASE_GARMENT_CATEGORIES and extend as needed rather than re-declaring.
// The vocabulary itself lives in ../shared/garments.mjs (shared with the Node
// API plugins) — this file just shapes it for the views that already import it.

import { GARMENT_PARTS } from "../shared/garments.mjs";

export const BASE_GARMENT_CATEGORIES = GARMENT_PARTS.map(({ id, label, singular }) => ({ id, label, singular }));

// Wardrobe + Wishlist: "All" first, then every garment type.
export const WARDROBE_TYPES = [
  { id: "all", label: "All" },
  ...BASE_GARMENT_CATEGORIES,
];

// Inspo board: "All" first, garment types, then "Full Look" + "Unclassified" at the end.
export const INSPO_CATEGORIES = [
  { id: "all",           label: "All" },
  ...BASE_GARMENT_CATEGORIES,
  { id: "full_look",     label: "Full Look" },
  { id: "unclassified",  label: "Unclassified" },
];

// Outfit builder: no "All" or "Unclassified", no singular needed.
export const OUTFIT_CATEGORIES = BASE_GARMENT_CATEGORIES.map(({ id, label }) => ({ id, label }));

// Convenience lookup maps.
export const TYPE_MAP   = Object.fromEntries(WARDROBE_TYPES.map((t) => [t.id, t]));
export const TYPE_ORDER = Object.fromEntries(WARDROBE_TYPES.slice(1).map((t, i) => [t.id, i]));
export const CATEGORY_LABEL = Object.fromEntries(INSPO_CATEGORIES.map((c) => [c.id, c.label]));
