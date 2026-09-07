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
// (scripts/style-rules.mjs). Several parts may share a region — REGION_TO_PARTS
// keeps ALL of them, so a replacement offered for a lower-body problem can be a
// skirt or a pair of shorts and not only a trouser. null when a part has no
// Mirror-critique counterpart.
// surface: roughly how much of the visible outfit the part occupies, 1-5. The
// critique weights colour and pattern by this, so a sock never outweighs a
// coat, and it decides which garment a whole-outfit problem is pinned on.
export const GARMENT_PARTS = [
  { id: "upperbody", label: "Tops", singular: "Top", coverage: "upper", mirrorRegion: "upperbody", surface: 4 },
  { id: "bodysuit", label: "Bodysuits", singular: "Bodysuit", coverage: "upper", mirrorRegion: "upperbody", surface: 4 },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket", coverage: "upper", mirrorRegion: "outerwear", layer: true, surface: 4 },
  { id: "dress", label: "Dresses", singular: "Dress", coverage: "full", mirrorRegion: "fullbody", surface: 5 },
  { id: "jumpsuit", label: "Jumpsuits", singular: "Jumpsuit", coverage: "full", mirrorRegion: "fullbody", surface: 5 },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom", coverage: "lower", mirrorRegion: "lowerbody", surface: 4 },
  { id: "skirt", label: "Skirts", singular: "Skirt", coverage: "lower", mirrorRegion: "lowerbody", surface: 4 },
  { id: "shorts", label: "Shorts", singular: "Shorts", coverage: "lower", mirrorRegion: "lowerbody", surface: 3 },
  { id: "accessories_up", label: "Accessories", singular: "Accessory", coverage: "accessory", mirrorRegion: "accessory", surface: 1 },
  { id: "shoes", label: "Shoes", singular: "Shoes", coverage: "feet", mirrorRegion: "footwear", surface: 2 },
  { id: "socks", label: "Socks", singular: "Socks", coverage: "feet", mirrorRegion: "legwear", surface: 1 },
];

export const GARMENT_PART_IDS = GARMENT_PARTS.map((part) => part.id);
export const GARMENT_PART_ID_SET = new Set(GARMENT_PART_IDS);
export const GARMENT_PART_MAP = Object.fromEntries(GARMENT_PARTS.map((part) => [part.id, part]));

export const partsWithCoverage = (coverage) => GARMENT_PARTS.filter((part) => part.coverage === coverage);

export const FULL_COVERAGE_PART_IDS = partsWithCoverage("full").map((part) => part.id);
export const FULL_COVERAGE_PART_SET = new Set(FULL_COVERAGE_PART_IDS);

/** True when one garment dresses both halves of the body on its own. */
export const isFullCoverage = (partId) => FULL_COVERAGE_PART_SET.has(partId);

/**
 * The rule every outfit has to satisfy, generated from the vocabulary rather
 * than typed out. The old wording ("at least 1 top and 1 bottom") made a dress
 * outfit structurally impossible to express no matter what categories existed —
 * this states the thing that is actually required, which is coverage.
 */
export function describeCoverageRule() {
  const ids = (coverage) => partsWithCoverage(coverage).map((part) => part.id).join(", ");
  return `Each outfit MUST cover both the upper and the lower body. Satisfy that in one of two ways: a single full-coverage garment (${ids("full")}) worn on its own, OR one upper-body garment (${ids("upper")}) together with one lower-body garment (${ids("lower")}). This is mandatory. Never combine a full-coverage garment with a separate lower-body garment — a dress is not worn over trousers.`;
}

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
// mirrorRegion participate.
//
// REGION_TO_PARTS keeps EVERY part in a region, and it is what the critique
// searches when it offers a replacement. The old single-part map silently threw
// the rest away: `lowerbody` resolved to trousers alone, so someone wearing
// shorts could only ever be offered a trouser, and their own shorts and skirts
// were unreachable. REGION_TO_PART is kept as the canonical//first part for the
// places that need one name rather than a set.
export const REGION_TO_PARTS = GARMENT_PARTS.reduce((map, part) => {
  if (!part.mirrorRegion) return map;
  (map[part.mirrorRegion] ??= []).push(part.id);
  return map;
}, {});
export const REGION_TO_PART = Object.fromEntries(
  Object.entries(REGION_TO_PARTS).map(([region, parts]) => [region, parts[0]]),
);
export const PART_TO_REGION = Object.fromEntries(
  GARMENT_PARTS.filter((part) => part.mirrorRegion).map((part) => [part.id, part.mirrorRegion]),
);
export const MIRROR_REGIONS = Object.keys(REGION_TO_PARTS);

// How much of the visible outfit a region occupies. A whole-outfit problem gets
// pinned on what is actually driving it rather than on whatever is cheapest to
// change — the old priority list blamed `accessory` first for every colour
// problem, which is how a hat came to be offered as the cure for a shirt.
export const REGION_SURFACE = Object.fromEntries(
  Object.entries(REGION_TO_PARTS).map(([region, parts]) => [
    region,
    Math.max(...parts.map((id) => GARMENT_PART_MAP[id].surface)),
  ]),
);

// Accessories are one wardrobe part but many different objects. Without a
// sub-type the critique will answer a belt problem with a hat, because both are
// `accessories_up` and nothing distinguishes them. Free text is all we have to
// go on (item names and tags, and the vision model's short description), so
// these match on the words people actually use.
export const ACCESSORY_KINDS = [
  { id: "headwear", label: "hat", pattern: /\b(hat|cap|beanie|bucket|visor|headband|bandana)\b/ },
  { id: "belt", label: "belt", pattern: /\bbelt\b/ },
  { id: "bag", label: "bag", pattern: /\b(bag|backpack|tote|sling|crossbody|fanny|bumbag|purse|satchel)\b/ },
  { id: "scarf", label: "scarf", pattern: /\b(scarf|shawl|neckerchief|tie|bowtie)\b/ },
  { id: "eyewear", label: "eyewear", pattern: /\b(glasses|sunglasses|shades|eyewear|spectacles)\b/ },
  { id: "jewellery", label: "jewellery", pattern: /\b(necklace|chain|bracelet|ring|earring|watch|pendant)\b/ },
  { id: "gloves", label: "gloves", pattern: /\bglove/ },
];

/**
 * Best-effort accessory sub-type from free text. Returns null when nothing
 * matches, which the caller must treat as "could be anything" — never as a
 * licence to swap it for an unrelated object.
 */
export function accessoryKind(text) {
  const haystack = String(text || "").toLowerCase();
  return ACCESSORY_KINDS.find((kind) => kind.pattern.test(haystack))?.id || null;
}
