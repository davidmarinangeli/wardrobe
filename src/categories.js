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

// Inspo board: the pins you imported ("Sources") sit left of a divider; every
// pill right of it — "All" plus each garment type — is the pieces detected out
// of them.
//
// There is deliberately no "Full Look" pill any more. `full_look` is what
// wishlist-api.mjs stamps on a pin whose detection found more than two distinct
// garment parts — a detection outcome, not something the user chose — so paste a
// photo of one sweater and it could land under a pill claiming it was a full
// look. A pin is a source regardless of how much of an outfit it happens to show.
export const INSPO_CATEGORIES = [
  { id: "sources", label: "Sources" },
  { id: "all",     label: "All", dividerBefore: true },
  ...BASE_GARMENT_CATEGORIES,
];

// Outfit builder: no "All" or "Unclassified", no singular needed.
export const OUTFIT_CATEGORIES = BASE_GARMENT_CATEGORIES.map(({ id, label }) => ({ id, label }));

// Pins already on disk keep "full_look" / "unclassified" as their stored
// category even though neither is a pill now, and PinCard/PinViewer still have
// to print a human label for one. Kept out of INSPO_CATEGORIES so they label
// without filtering.
const LEGACY_PIN_CATEGORIES = [
  { id: "full_look",    label: "Full look" },
  { id: "unclassified", label: "Unclassified" },
];

// Convenience lookup maps.
export const TYPE_MAP   = Object.fromEntries(WARDROBE_TYPES.map((t) => [t.id, t]));
export const TYPE_ORDER = Object.fromEntries(WARDROBE_TYPES.slice(1).map((t, i) => [t.id, i]));
export const CATEGORY_LABEL = Object.fromEntries(
  [...INSPO_CATEGORIES, ...LEGACY_PIN_CATEGORIES].map((c) => [c.id, c.label]),
);
