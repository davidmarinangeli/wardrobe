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
  { id: "bodysuit", label: "Bodysuits", singular: "Bodysuit", coverage: "upper", mirrorRegion: "upperbody" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket", coverage: "upper", mirrorRegion: "outerwear", layer: true },
  { id: "dress", label: "Dresses", singular: "Dress", coverage: "full", mirrorRegion: "fullbody" },
  { id: "jumpsuit", label: "Jumpsuits", singular: "Jumpsuit", coverage: "full", mirrorRegion: "fullbody" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom", coverage: "lower", mirrorRegion: "lowerbody" },
  { id: "skirt", label: "Skirts", singular: "Skirt", coverage: "lower", mirrorRegion: "lowerbody" },
  { id: "shorts", label: "Shorts", singular: "Shorts", coverage: "lower", mirrorRegion: "lowerbody" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory", coverage: "accessory", mirrorRegion: "accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes", coverage: "feet", mirrorRegion: "footwear" },
  { id: "socks", label: "Socks", singular: "Socks", coverage: "feet", mirrorRegion: null },
];

export const GARMENT_PART_IDS = GARMENT_PARTS.map((part) => part.id);
export const GARMENT_PART_ID_SET = new Set(GARMENT_PART_IDS);
export const GARMENT_PART_MAP = Object.fromEntries(GARMENT_PARTS.map((part) => [part.id, part]));

// "Use only these category ids: upperbody, bodysuit, ..." — generated so
// detection prompts can never drift from the schema enum above them.
export const GARMENT_PART_IDS_PROSE = GARMENT_PART_IDS.join(", ");

// The confusions a vision model actually gets wrong, each with one definite
// resolution. It needs no taste here, only a rule it can apply the same way
// every time. Shared by every detection surface (import review and the Inspo
// "detect items" pass run through the same analyze call).
// Every part id named below must exist in GARMENT_PARTS — test/garments.test.mjs
// enforces that, so this prose cannot drift out of the vocabulary.
export const GARMENT_DISAMBIGUATION_RULES = [
  "A shirt-like garment worn with nothing on the lower body and ending below mid-thigh is a `dress`; if it ends at or above mid-thigh, or trousers are visible underneath it, it is an `upperbody`.",
  "One garment joining top and bottom with no separate waistband is a `jumpsuit` (this covers rompers and playsuits); a matching top and bottom that are two separate pieces — a co-ord set — are two records, one `upperbody` and one `lowerbody`.",
  "A top that continues past the hips and fastens at the crotch is a `bodysuit`; if the hem is tucked in or otherwise not visible, default to `upperbody`.",
  "A skort reads as a skirt: classify it `skirt`.",
  "Bottoms whose hem sits above the knee are `shorts`; at or below the knee they are `lowerbody`.",
];

export const GARMENT_DISAMBIGUATION_PROSE = GARMENT_DISAMBIGUATION_RULES.map((rule) => `- ${rule}`).join("\n");

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
