// Canonical garment category definitions.
// Views import BASE_GARMENT_CATEGORIES and extend as needed rather than re-declaring.

export const BASE_GARMENT_CATEGORIES = [
  { id: "upperbody",      label: "Tops",        singular: "Top" },
  { id: "wholebody_up",   label: "Jackets",     singular: "Jacket" },
  { id: "lowerbody",      label: "Bottoms",     singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes",          label: "Shoes",       singular: "Shoes" },
  { id: "socks",          label: "Socks",       singular: "Socks" },
];

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
