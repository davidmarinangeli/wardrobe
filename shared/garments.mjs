// Canonical garment part vocabulary — the single source of truth for what a
// garment "is". Every view filter, AI detection schema/prompt, and the Mirror
// critique's region mapping derives from this array instead of re-declaring
// it. Add a part here and it should appear everywhere with no other file
// touched.
//
// coverage: which body region the part occupies (upper | lower | full | feet |
// accessory). A `full` garment covers the upper and lower body at once, so it
// satisfies both halves of an outfit on its own.
// layer: the part goes OVER whatever is underneath rather than claiming a slot
// of its own. It still covers the body region named by `coverage`, but it never
// conflicts with another garment — a jacket layers over a shirt or over a dress
// equally well, so it is never blocked and never blocks.
// mirrorRegion: the coarser region id the Mirror critique perceives garments in
// (scripts/style-rules.mjs). Several parts may share a region — the FIRST part
// listed for a region is the canonical one used for reverse lookups. null when
// a part has no Mirror-critique counterpart, as `socks` never has.
export const GARMENT_PARTS = [
  { id: "upperbody", label: "Tops", singular: "Top", coverage: "upper", mirrorRegion: "upperbody" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket", coverage: "upper", mirrorRegion: "outerwear", layer: true },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom", coverage: "lower", mirrorRegion: "lowerbody" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory", coverage: "accessory", mirrorRegion: "accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes", coverage: "feet", mirrorRegion: "footwear" },
  { id: "socks", label: "Socks", singular: "Socks", coverage: "feet", mirrorRegion: null },
];

export const GARMENT_PART_IDS = GARMENT_PARTS.map((part) => part.id);
export const GARMENT_PART_ID_SET = new Set(GARMENT_PART_IDS);
export const GARMENT_PART_MAP = Object.fromEntries(GARMENT_PARTS.map((part) => [part.id, part]));

// "Use only these category ids: upperbody, wholebody_up, ..." — generated so
// detection prompts can never drift from the schema enum above them.
export const GARMENT_PART_IDS_PROSE = GARMENT_PART_IDS.join(", ");

// Mirror perception region <-> wardrobe part vocabulary. Only parts carrying a
// mirrorRegion participate. Region -> part keeps the first part listed for that
// region, so adding another part sharing a region never steals the canonical
// target the critique offers as a replacement.
export const REGION_TO_PART = GARMENT_PARTS.reduce((map, part) => {
  if (part.mirrorRegion && !(part.mirrorRegion in map)) map[part.mirrorRegion] = part.id;
  return map;
}, {});
export const PART_TO_REGION = Object.fromEntries(
  GARMENT_PARTS.filter((part) => part.mirrorRegion).map((part) => [part.id, part.mirrorRegion]),
);
export const MIRROR_REGIONS = Object.keys(REGION_TO_PART);
