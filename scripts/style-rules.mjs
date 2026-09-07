// Deterministic styling rules engine shared by the Mirror critique (mirror-api.mjs)
// and the Outfits suggestion generator (suggestions-api.mjs), so both features judge
// color harmony and proportion the same way instead of each guessing independently.
//
// Grounded in sourced menswear style conventions rather than free-form LLM judgment:
// - Neutrals (navy, brown, black, white, grey, beige, cream, tan, taupe, charcoal,
//   khaki) combine reliably with anything and don't count toward the color budget.
//   https://www.realmenrealstyle.com/color-wheel-menswear/
//   https://www.gentlemanwithin.com/how-to-mix-and-match-clothing-colors-for-men/
// - Complementary hues (~150-210° apart) read as a bold, intentional contrast, not
//   a mistake. Analogous hues (<45° apart) read as cohesive/tonal.
//   https://westwoodhart.com/blogs/westwood-hart/mens-style-color-theory-color-wheel-outfit-coordination
// - Rule of thumb: two to three non-neutral colors max, or it reads as clutter.
//   https://westwoodhart.com/blogs/westwood-hart/mens-fashion-color-combinations-guide-pairing-colours
// - Proportion: volume on one half of the body requires restraint on the other —
//   never oversized top + oversized bottom.
//   https://manofmany.com/style/mens-style-relaxed-fit-guide
//   https://suitsupply.com/en-us/journal/how-it-should-fit.html
// - Pooling/stacking hems are a real, commonly-named fit problem, distinct from color.
//   https://suitablee.com/en/perspective/post/how-men-wear-their-trousers-and-what-it-says-about-them

import { PART_TO_REGION, REGION_SURFACE, REGION_TO_PART, REGION_TO_PARTS, accessoryKind } from "../shared/garments.mjs";
import { MATERIAL_WEATHER, MIRROR_RULE_MAP, inferMaterial, rulesForRegister } from "../shared/style-catalogue.mjs";
import { findJudgmentLanguage } from "../shared/prompt-guardrails.mjs";

// ---------------------------------------------------------------------------
// Color vocabulary
// ---------------------------------------------------------------------------

export const COLOR_TABLE = {
  // Neutrals — combine reliably with anything, don't count toward the color budget.
  black: { neutral: true, hue: null },
  white: { neutral: true, hue: null },
  grey: { neutral: true, hue: null },
  charcoal: { neutral: true, hue: null },
  navy: { neutral: true, hue: null },
  brown: { neutral: true, hue: null },
  tan: { neutral: true, hue: null },
  beige: { neutral: true, hue: null },
  cream: { neutral: true, hue: null },
  taupe: { neutral: true, hue: null },
  khaki: { neutral: true, hue: null },
  // Chromatic — placed on the 0-360° color wheel, count toward the color budget.
  red: { neutral: false, hue: 0 },
  burgundy: { neutral: false, hue: 350 },
  orange: { neutral: false, hue: 30 },
  rust: { neutral: false, hue: 20 },
  yellow: { neutral: false, hue: 55 },
  olive: { neutral: false, hue: 70 },
  green: { neutral: false, hue: 120 },
  teal: { neutral: false, hue: 175 },
  blue: { neutral: false, hue: 220 },
  "sky-blue": { neutral: false, hue: 200 },
  purple: { neutral: false, hue: 275 },
  pink: { neutral: false, hue: 330 },
};

export const COLOR_NAMES = Object.keys(COLOR_TABLE);

// Perception region vocabulary <-> wardrobe part vocabulary (shared/garments.mjs).
export { REGION_TO_PART, REGION_TO_PARTS, PART_TO_REGION };

// Most-replaceable-first: which garment to target when an issue could point at
// either of two pieces (e.g. a color clash between an accessory and a top should
// point at the accessory, not ask the user to replace their shirt).
// A full-coverage garment sits last: it IS the outfit, so asking someone to
// swap their dress is the biggest change the critique can propose.
const REGION_PRIORITY = ["accessory", "footwear", "lowerbody", "outerwear", "upperbody", "fullbody"];
const PART_LABEL = { upperbody: "top", outerwear: "jacket", lowerbody: "bottoms", accessory: "accessory", footwear: "shoes", fullbody: "dress", legwear: "socks" };

function hexToHsl(hex) {
  const clean = String(hex || "").replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  // Chroma (0-1): the raw spread between the strongest and weakest channel.
  // Stable across the whole lightness range, unlike HSL saturation below.
  const chroma = max - min;
  // HSL saturation divides by (1 - |2L-1|), which shrinks toward zero as
  // lightness approaches 0 or 1 — so tiny RGB noise in near-white/near-black
  // colors gets amplified into a large, meaningless saturation reading (a
  // near-white fabric can compute north of 20% "saturated"). Only used below
  // for hue-band decisions in the middle of the lightness range, never for
  // the neutral/chromatic call itself — chroma owns that.
  const s = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (chroma !== 0) {
    if (max === r) h = 60 * (((g - b) / chroma) % 6);
    else if (max === g) h = 60 * ((b - r) / chroma + 2);
    else h = 60 * ((r - g) / chroma + 4);
  }
  if (h < 0) h += 360;
  return { h, s, l, chroma };
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function nearestChromaticName(hue) {
  let best = null;
  let bestDist = Infinity;
  for (const [name, entry] of Object.entries(COLOR_TABLE)) {
    if (entry.neutral) continue;
    const dist = hueDistance(hue, entry.hue);
    if (dist < bestDist) { bestDist = dist; best = name; }
  }
  return best;
}

// Classifies a wardrobe item's hex color into the same vocabulary the vision
// perception step uses, applying the neutral overrides real style guides use
// (a saturated dark blue reads as "navy," a muted warm hue reads as brown/
// tan/beige) — this is the exact override that was missing from
// suggestions-api.mjs's old hue-only check, which is what let it misclassify
// navy/brown as clashing.
export function classifyColor(hex) {
  const { h, s, l, chroma } = hexToHsl(hex);
  if (chroma < 0.07) {
    const name = l < 0.15 ? "black" : l > 0.9 ? "white" : "grey";
    return { name, neutral: true, hue: null };
  }
  let name = nearestChromaticName(h);
  if ((name === "blue" || name === "sky-blue") && l <= 0.32) {
    name = "navy";
  } else if ((name === "orange" || name === "rust" || name === "yellow") && h >= 15 && h <= 60 && s <= 0.6) {
    // One continuous warm-neutral band across the orange->yellow hue range
    // (brown/tan/beige are the same underlying earth tone at different
    // lightness) instead of two disconnected pockets with an arbitrary
    // cliff between them — that gap was exactly why a plain khaki ("corduroy
    // trousers", l=0.56) fell through as raw chromatic "orange".
    name = l <= 0.4 ? "brown" : l <= 0.62 ? "tan" : "beige";
  }
  const entry = COLOR_TABLE[name];
  return { name, neutral: entry.neutral, hue: entry.hue };
}

// Looks up a color name already in our fixed vocabulary (as returned by the
// vision perception step). Unrecognized names fail safe as neutral rather than
// risking a fabricated clash against a name we don't understand — and carry no
// display name, so no sentence can repeat a word back to the user that the
// engine was never able to interpret ("Everything here (chartreuse and
// vantablack) is a neutral" was a claim about two words, not two colours).
function colorInfo(name) {
  const entry = COLOR_TABLE[name];
  return entry ? { name, ...entry } : { name: null, neutral: true, hue: null };
}

export function describeColorHarmonyRules() {
  const neutrals = COLOR_NAMES.filter((name) => COLOR_TABLE[name].neutral).join(", ");
  return `Color harmony rules, grounded in menswear style convention: treat ${neutrals} as neutrals — they pair with anything and don't count toward the color budget. Among non-neutral colors, hues within ~15° of each other read as tonal and within ~45° as analogous — both harmonious. Opposite hues (~150-210° apart) read as a bold, intentional complementary pairing, not a mistake. Two non-neutral hues roughly 45-150° apart are a near-miss that reads as an accidental mismatch rather than a deliberate one — avoid that combination. Keep at most two non-neutral colors in one outfit; a third reads as clutter.`;
}

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

function cap(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }

// Only colours the engine actually recognises are ever named. Everything below
// has to survive a garment the vision step half-read, because that garment
// reaches production the moment someone photographs themselves in bad light.
function colorNames(garments) {
  return garments.map((g) => garmentColor(g).name).filter(Boolean);
}

function namesList(garments) {
  const names = colorNames(garments);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function describe(garment) {
  const noun = garment.description || PART_LABEL[garment.region] || "piece";
  const color = garmentColor(garment).name;
  return color ? `${color} ${noun}` : noun;
}

function leastEssential(garments) {
  return garments.slice().sort((a, b) => REGION_PRIORITY.indexOf(a.region) - REGION_PRIORITY.indexOf(b.region))[0];
}

// Evaluates color harmony across every visible garment in a photo (or a
// candidate outfit combination). Returns { note, issue } — issue is null when
// nothing violates a grounded rule, in which case note explains why it works.
export function evaluateColorHarmony(garments) {
  if (!garments || !garments.length) return { note: null, issue: null };

  const colored = garments.map((g) => ({ ...g, info: garmentColor(g) }));
  const chromatic = colored.filter((g) => !g.info.neutral);

  if (chromatic.length === 0) {
    const named = namesList(colored);
    return {
      note: named
        ? `Everything here (${named}) is a neutral, so there's no clash to worry about.`
        : "Nothing here is carrying a strong color, so there's no clash to worry about.",
      issue: null,
    };
  }

  const distinct = [];
  for (const g of chromatic) {
    if (!distinct.some((d) => hueDistance(d.hue, g.info.hue) < 15)) distinct.push({ hue: g.info.hue, garment: g });
  }

  if (distinct.length === 1) {
    const note = chromatic.length === 1
      ? `${cap(chromatic[0].color)} is the only real color in the mix, grounded by neutrals elsewhere — an easy, safe combination.`
      : `${cap(namesList(chromatic))} stay in the same tonal family, which reads as cohesive rather than clashing.`;
    return { note, issue: null };
  }

  if (distinct.length === 2) {
    const [a, b] = distinct;
    const dist = hueDistance(a.hue, b.hue);
    if (dist < 45) {
      return { note: `${cap(a.garment.color)} and ${b.garment.color} sit close on the color wheel, giving the outfit a cohesive, tonal feel.`, issue: null };
    }
    if (dist >= 150) {
      return { note: `${cap(a.garment.color)} and ${b.garment.color} sit opposite on the color wheel — a bold, intentional-looking contrast rather than a mismatch.`, issue: null };
    }
    const target = leastEssential([a.garment, b.garment]);
    return {
      note: null,
      issue: {
        id: "off-match",
        region: target.region,
        label: "Near-miss color pairing",
        summary: `${cap(a.garment.color)} and ${b.garment.color} are close but not quite aligned, which can read as an accidental mismatch rather than a deliberate one.`,
      },
    };
  }

  const target = leastEssential(distinct.map((d) => d.garment));
  return {
    note: null,
    issue: {
      id: "color-clutter",
      region: target.region,
      label: "Too many competing colors",
      summary: `${cap(namesList(chromatic))} pull in ${distinct.length} different directions — outfits usually read cleanest with two accent colors plus neutrals.`,
    },
  };
}

// Evaluates silhouette/proportion: pooling hems first (concrete, visible evidence),
// then double-volume (both halves relaxed/oversized at once).
export function evaluateProportion(garments) {
  if (!garments || !garments.length) return { note: null, issue: null };

  // A dress or jumpsuit dresses both halves at once, so it stands in for
  // whichever side has no garment of its own. Without this, an outfit built
  // around a dress matches neither `top` nor `bottom` and proportion feedback
  // silently disappears — the user asks to be looked at and hears nothing.
  const full = garments.find((g) => g.region === "fullbody");
  const top = garments.find((g) => g.region === "upperbody" || g.region === "outerwear") || full;
  const bottom = garments.find((g) => g.region === "lowerbody") || full;

  if (bottom?.hemNotes) {
    // A wide-leg/relaxed/oversized trouser is DESIGNED to carry some break at
    // the shoe — that's the silhouette, not a mistake. Only flag it when the
    // stacking is more than slight, or when the cut itself isn't voluminous
    // (a fitted/regular trouser pooling at all really is wrong).
    const voluminous = bottom.volume === "relaxed" || bottom.volume === "oversized";
    // Unknown severity (e.g. an older/mocked garment payload without the
    // field) defaults to "moderate" — flag it rather than silently drop a
    // real issue just because severity wasn't reported.
    const severity = bottom.hemSeverity || "moderate";

    if (voluminous && severity === "slight") {
      return { note: `${cap(describe(bottom))} carries a bit of drape at the shoe — expected for that cut, not a mistake.`, issue: null };
    }

    return {
      note: null,
      issue: {
        id: "pooling-hem",
        region: "lowerbody",
        label: voluminous ? "Hem is heavier than the outfit needs" : "Hem needs cleaning up",
        summary: voluminous
          ? `The ${describe(bottom)} ${bottom.hemNotes} — more drape than even a wide-leg cut calls for.`
          : `The ${describe(bottom)} ${bottom.hemNotes} — that reads as a length issue rather than a style choice.`,
      },
    };
  }

  if (!top || !bottom) return { note: null, issue: null };

  // One garment covering both halves cannot fight itself: an oversized dress is
  // a silhouette, not a double-volume mistake. Only compare genuinely separate
  // pieces (a dress still gets judged against a jacket layered over it).
  if (top === bottom) return { note: null, issue: null };

  const loose = new Set(["relaxed", "oversized"]);
  if (loose.has(top.volume) && loose.has(bottom.volume)) {
    return {
      note: null,
      issue: {
        id: "double-volume",
        region: top.region,
        label: "Both halves are relaxed",
        summary: `${cap(describe(top))} and ${describe(bottom)} are both loose at once, which erases the shape — keeping one half fitted would sharpen the line.`,
      },
    };
  }

  return { note: `${cap(describe(top))} stays controlled against ${describe(bottom)}, so the proportions read balanced.`, issue: null };
}


// ---------------------------------------------------------------------------
// Verifying what the judge claimed
// ---------------------------------------------------------------------------
//
// scripts/mirror-judge.mjs returns rule ids and the garments cited as evidence.
// Nothing it says is taken on trust: every finding is re-derived here from the
// perceived facts, and one whose evidence does not hold is dropped rather than
// softened. This is the whole reason a model is allowed to judge at all — it
// contributes the choice of what is worth saying, and this file remains the
// only thing that decides what is true.

/** A garment's colour, preferring the hex read off the photo over the coarse name. */
export function garmentColor(garment) {
  if (garment.colorHex) return classifyColor(garment.colorHex);
  return colorInfo(garment.color);
}

// The hue actually measured off the photo, not the canonical hue of whichever
// of twelve buckets the colour was filed under. The buckets are right for
// asking "do these clash" — that is a question about colour families — and
// wrong for asking "is this the same colour again", where quantisation invents
// matches: a pink belt files as burgundy and orange socks as rust, landing them
// 30° apart when what the eye sees is 34° and no repeat at all.
function measuredHue(garment) {
  const info = garmentColor(garment);
  if (info.neutral) return null;
  return garment.colorHex ? hexToHsl(garment.colorHex).h : info.hue;
}

function lightness(garment) {
  return garment.colorHex ? hexToHsl(garment.colorHex).l : null;
}

const surfaceOf = (garment) => REGION_SURFACE[garment.region] ?? 2;

/** Distinct chromatic hues among a set, at the same ~15° granularity as the harmony check. */
function distinctHues(garments) {
  const hues = [];
  for (const garment of garments) {
    const info = garmentColor(garment);
    if (info.neutral) continue;
    if (!hues.some((hue) => hueDistance(hue, info.hue) < 15)) hues.push(info.hue);
  }
  return hues;
}

// A piece is "loud" when it is doing something other than sitting quietly:
// a real colour, or a pattern you notice from across the room.
function isLoud(garment) {
  return !garmentColor(garment).neutral || (garment.patterned && garment.patternScale !== "fine");
}

// Something quiet with enough presence to hold the rest down. A neutral sock is
// not an anchor; a neutral coat is.
function isAnchor(garment) {
  return garmentColor(garment).neutral && !garment.patterned && surfaceOf(garment) >= 3;
}

// Does the evidence for this rule actually hold, given these cited garments and
// the outfit they sit in? Every rule in the catalogue needs an entry — a rule
// with no way to be checked is a rule the judge could assert freely.
const EVIDENCE = {
  "color-clutter": (cited) => distinctHues(cited).length >= 3,

  "off-match": (cited) => {
    const hues = distinctHues(cited);
    if (hues.length !== 2) return false;
    const gap = hueDistance(hues[0], hues[1]);
    return gap >= 45 && gap < 150;
  },

  // Asked of the whole outfit, not just the cited pieces: an anchor anywhere
  // counts, so citing the two loudest garments cannot manufacture this.
  "no-anchor": (cited, outfit) => cited.filter(isLoud).length >= 2 && !outfit.some(isAnchor),

  // Asked of the whole outfit: a colour "echoes" when some other garment carries
  // a hue near it. Many colours with no repeats is what makes a loud outfit read
  // as accidental — and it is a different question from how many there are,
  // which is why counting hues was the wrong tool for a deliberate mix.
  "no-color-echo": (cited, outfit) => {
    if (cited.filter((garment) => !garmentColor(garment).neutral).length < 3) return false;
    const hues = outfit.map(measuredHue).filter((hue) => hue !== null);
    if (hues.length < 4) return false;
    return !hues.some((hue, index) => hues.some((other, j) => j !== index && hueDistance(hue, other) <= 30));
  },

  "weather-split": (cited) => {
    const kinds = new Set(cited.map((garment) => MATERIAL_WEATHER[garment.material]).filter(Boolean));
    return kinds.has("warm") && kinds.has("cool");
  },

  "pattern-load": (cited) => cited.filter((garment) => garment.patterned && garment.patternScale !== "fine").length >= 2,

  "no-focal-point": (cited, outfit) => {
    const loud = outfit.filter(isLoud);
    if (loud.length < 3 || cited.filter(isLoud).length < 3) return false;
    // Something genuinely dominant means there IS a focal point, however busy
    // the rest is — a loud coat over loud everything still leads.
    const top = Math.max(...loud.map(surfaceOf));
    return loud.filter((garment) => surfaceOf(garment) === top).length > 1;
  },

  "double-volume": (cited) => {
    const loose = new Set(["relaxed", "oversized"]);
    const full = cited.find((garment) => garment.region === "fullbody");
    const top = cited.find((garment) => garment.region === "upperbody" || garment.region === "outerwear") || full;
    const bottom = cited.find((garment) => garment.region === "lowerbody") || full;
    // One garment covering both halves cannot fight itself.
    if (!top || !bottom || top === bottom) return false;
    return loose.has(top.volume) && loose.has(bottom.volume);
  },

  // A wide-leg trouser is meant to break at the shoe; only stacking beyond what
  // the cut asks for, or any stacking on a cut that isn't voluminous, is real.
  "pooling-hem": (cited) => cited.some((garment) => {
    if (!garment.hemNotes) return false;
    const voluminous = garment.volume === "relaxed" || garment.volume === "oversized";
    return !voluminous || (garment.hemSeverity || "moderate") !== "slight";
  }),

  "formality-split": (cited) => {
    const levels = cited.map((garment) => garment.formality).filter((value) => Number.isFinite(value));
    return levels.length >= 2 && Math.max(...levels) - Math.min(...levels) >= 2;
  },

  "contrast-flat": (cited) => {
    const levels = cited.map(lightness).filter((value) => value !== null);
    // No hex read means no honest answer — fail closed rather than guess.
    if (levels.length < 2 || levels.length !== cited.length) return false;
    return Math.max(...levels) - Math.min(...levels) < 0.18;
  },
};

/** True when the catalogue rule's evidence is genuinely present. */
export function verifyEvidence(ruleId, cited, outfit) {
  const rule = MIRROR_RULE_MAP[ruleId];
  if (!rule || cited.length < rule.minCited) return false;
  return EVIDENCE[ruleId](cited, outfit);
}

// ---------------------------------------------------------------------------
// Which garment a finding is pinned on
// ---------------------------------------------------------------------------
//
// The old engine sorted by "most replaceable" and so blamed an accessory for
// every colour problem in every outfit — which is how a hat came to be offered
// as the remedy for a shirt. Each rule now names how its own target is found,
// and every strategy is about which garment is actually driving the problem.

const TARGET = {
  // The hue with no friends: the one sitting farthest from every other colour.
  "chromatic-outlier": (cited) => {
    const chromatic = cited.filter((garment) => !garmentColor(garment).neutral);
    if (chromatic.length < 2) return chromatic[0] || cited[0];
    const isolation = (garment) => {
      const hue = garmentColor(garment).hue;
      return Math.min(...chromatic.filter((other) => other !== garment).map((other) => hueDistance(hue, garmentColor(other).hue)));
    };
    return chromatic
      .slice()
      .sort((a, b) => isolation(b) - isolation(a) || surfaceOf(a) - surfaceOf(b))[0];
  },
  "smallest-surface": (cited) => cited.slice().sort((a, b) => surfaceOf(a) - surfaceOf(b))[0],
  // Among the pieces actually competing to lead, the plain one. A print is the
  // more interesting half of any such pair, so quieting the other one keeps
  // what makes the outfit itself and drops what is merely fighting it.
  "loud-contender": (cited) => {
    const loud = cited.filter(isLoud);
    if (!loud.length) return cited[0];
    const top = Math.max(...loud.map(surfaceOf));
    const contenders = loud.filter((garment) => surfaceOf(garment) === top);
    return contenders.slice().sort((a, b) => Number(a.patterned) - Number(b.patterned))[0];
  },
  "largest-surface": (cited) => cited.slice().sort((a, b) => surfaceOf(b) - surfaceOf(a))[0],
  // Whichever weather has fewer pieces on this body is the one out of step, and
  // within it the smallest piece is the cheapest thing to change.
  "weather-outlier": (cited) => {
    const grouped = { warm: [], cool: [] };
    for (const garment of cited) {
      const kind = MATERIAL_WEATHER[garment.material];
      if (kind) grouped[kind].push(garment);
    }
    const minority = grouped.warm.length && grouped.cool.length
      ? (grouped.warm.length <= grouped.cool.length ? grouped.warm : grouped.cool)
      : cited;
    return minority.slice().sort((a, b) => surfaceOf(a) - surfaceOf(b))[0];
  },
  "formality-outlier": (cited) => {
    const levels = cited.map((garment) => garment.formality);
    const middle = levels.slice().sort((a, b) => a - b)[Math.floor(levels.length / 2)];
    return cited.slice().sort((a, b) => Math.abs(b.formality - middle) - Math.abs(a.formality - middle) || surfaceOf(a) - surfaceOf(b))[0];
  },
  cited: (cited, ruleId) => cited.find((garment) => verifyEvidence(ruleId, [garment], cited)) || cited[0],
};

// ---------------------------------------------------------------------------
// Remedies
// ---------------------------------------------------------------------------

// You can take off a hat, a bag, a pair of socks or a jacket. You cannot be
// told to take off your trousers, so those regions never offer `remove`.
const REMOVABLE_REGIONS = new Set(["accessory", "legwear", "outerwear"]);

// Phrased without leading on the item's own name — garment names are free text
// of unpredictable grammatical number, and the name is shown directly above.
function fixReason(rule, action) {
  return rule.fixReason?.[action] || "Addresses this cleanly.";
}

// A candidate only counts if swapping it in genuinely clears the finding — the
// same evidence check, re-run on the outfit as it would actually be. An earlier
// version simulated replacing EVERY garment in the region at once, so a single
// neutral hat appeared to resolve five competing colours; it did not.
function resolvesBy(ruleId, cited, outfit, target, replacement) {
  const swap = (list) => list.map((garment) => (garment === target ? replacement : garment)).filter(Boolean);
  return !verifyEvidence(ruleId, swap(cited), swap(outfit));
}

// Free-text cue that a wardrobe item carries a print. Items have no such field,
// and it matters twice over: a printed piece is a different garment for the
// pattern rules, and offering one as "a neutral" is a contradiction the reason
// copy cannot survive.
const PATTERNED_ITEM = /\b(print|printed|pattern|patterned|graphic|striped|stripe|check|plaid|floral|camo)\b/;

function candidateAsGarment(item, target) {
  const info = classifyColor(item.color);
  const secondary = item.secondaryColor ? classifyColor(item.secondaryColor) : null;
  const haystack = `${(item.tags || []).join(" ")} ${item.name || ""}`.toLowerCase();
  return {
    region: target.region,
    description: item.name || "",
    color: info.name,
    colorHex: item.color,
    material: inferMaterial(haystack),
    secondaryHex: item.secondaryColor || null,
    patterned: PATTERNED_ITEM.test(haystack),
    patternScale: null,
    volume: VOLUME_FIT.test(haystack) ? "fitted" : VOLUME_LOOSE.test(haystack) ? "relaxed" : "regular",
    formality: target.formality,
    hemNotes: null,
    hemSeverity: null,
    confidence: "high",
    _secondaryNeutral: !secondary || secondary.neutral,
  };
}

// Cut cues read off free text. A pooling hem is about excess LENGTH bunching at
// the shoe, so length and taper cues fix it on their own and only true leg-width
// cues count against it. Double-volume is a silhouette question, so it needs a
// genuinely fitted cut.
const POOLING_FIX = /\b(cropped|ankle|tailored|slim|straight|skinny|fitted|tapered)\b/;
const POOLING_AGAINST = /\b(wide|wide-leg|baggy)\b/;
const VOLUME_FIT = /\b(slim|tailored|fitted|straight|cropped|skinny)\b/;
const VOLUME_LOOSE = /\b(wide|relaxed|oversized|baggy|wide-leg|loose)\b/;

// Roughly how much garment a piece is. Replacing a mesh tank with a pullover
// hoodie technically satisfies every rule in the catalogue and is still an
// absurd thing to say to someone in shorts — nothing in a colour-and-volume
// vocabulary can see the difference, so it is named here explicitly.
// Heaviest first: a "knit polo sweater" is a sweater, and matching "polo" first
// would have called it a shirt.
const GARMENT_WEIGHTS = [
  [/\b(jacket|coat|parka|bomber|blazer|puffer)\b/, 5],
  [/\b(sweater|knit|jumper|hoodie|sweatshirt|fleece|half-zip|pullover)\b/, 4],
  // The leading (?:^|[^-\w]) is load-bearing: \bshirt\b matches inside "t-shirt",
  // because the hyphen is a word boundary. Every tee in the wardrobe was
  // therefore weighed as a shirt, which put it two steps from a tank top and
  // penalised it out of every swap it should have won.
  [/(?:^|[^-\w])(shirt|blouse|polo|overshirt|button-down|button-up|oxford)\b/, 3],
  [/\b(t-shirt|tee|crewneck|crew neck)\b/, 2],
  [/\b(tank|vest|mesh|camisole|sleeveless)\b/, 1],
];

function garmentWeight(text) {
  const haystack = String(text || "").toLowerCase();
  for (const [pattern, weight] of GARMENT_WEIGHTS) if (pattern.test(haystack)) return weight;
  return null;
}

// A fix that solves its own finding and takes part in a different one is not a
// fix. The old engine checked this for colour alone; every rule in play is
// checked now, which is the same idea generalised — and it can be generalised
// because the catalogue made "a problem" a finite, checkable list.
//
// The test is participation, not novelty. Asking only "did this swap create a
// NEW problem" lets a fix walk into an existing one: offering a patterned
// sweater to settle the silhouette, in an outfit whose other finding is that
// its patterns are already competing. So a candidate is rejected whenever a
// rule holds after the swap AND stops holding once the candidate itself is
// taken out of the picture — that is what it means to be part of the problem.
function participatesInProblem(ruleId, outfit, target, replacement, register) {
  const after = outfit.map((garment) => (garment === target ? replacement : garment)).filter(Boolean);
  const without = after.filter((garment) => garment !== replacement);
  for (const rule of rulesForRegister(register)) {
    if (rule.id === ruleId) continue;
    if (!verifyEvidence(rule.id, after, after)) continue;
    if (!verifyEvidence(rule.id, without, without)) return true;
  }
  return false;
}

function scoreCandidate(ruleId, item, target) {
  const haystack = `${(item.tags || []).join(" ")} ${item.name || ""}`.toLowerCase();
  let score = 0;
  if (ruleId === "pooling-hem") {
    if (POOLING_FIX.test(haystack)) score += 2;
    if (POOLING_AGAINST.test(haystack)) score -= 3;
  } else if (ruleId === "double-volume") {
    if (VOLUME_FIT.test(haystack)) score += 2;
    if (VOLUME_LOOSE.test(haystack)) score -= 3;
  } else if (ruleId === "weather-split") {
    // Only a fabric we can actually name counts as a fix. An unreadable item
    // would satisfy the evidence check by default — it belongs to no weather —
    // and offering it would be claiming something we have not established.
    const material = inferMaterial(haystack);
    score += material !== "other" && !MATERIAL_WEATHER[material] ? 3 : 0;
  } else {
    const info = classifyColor(item.color);
    score += info.neutral ? 2 : -1;
    if (item.secondaryColor && !classifyColor(item.secondaryColor).neutral) score -= 1;
    // A print is not a quiet piece, whatever its base colour reads as. Without
    // this the engine would offer a graphic tee to settle a colour problem and
    // describe it as "a neutral" in the same breath.
    if (PATTERNED_ITEM.test(haystack)) score -= 2;
  }
  // A large surface carries the outfit, so introducing a new colour there is
  // riskier than the evidence check alone accounts for — that check only
  // catches a colour that actively breaks the rule, not one that is merely an
  // unnecessary new colour to bring in.
  if (surfaceOf(target) >= 3 && classifyColor(item.color).neutral) score += 1;
  // Like for like: a belt problem is not answered with a hat.
  const wanted = accessoryKind(target.description);
  if (target.region === "accessory" && wanted) {
    score += accessoryKind(`${item.name || ""} ${(item.tags || []).join(" ")}`) === wanted ? 2 : -5;
  }
  // ...and a tank is not answered with a coat.
  const wornWeight = garmentWeight(target.description);
  const itemWeight = garmentWeight(`${item.name || ""} ${(item.tags || []).join(" ")}`);
  if (wornWeight && itemWeight) score -= Math.max(0, Math.abs(wornWeight - itemWeight) - 1) * 3;
  return score;
}

// Deterministic tie-break (FNV-1a). Several neutral, fit-valid items are often
// genuinely interchangeable — that is what "neutral" means — and always
// resolving that to whichever sits first in the wardrobe means one item gets
// suggested for every outfit. Seeding on the garment being replaced keeps a
// given photo fully reproducible while letting different outfits land on
// different, equally valid picks.
function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The best owned item to swap in for `target`, or null when nothing in the
 * wardrobe both clears a confidence bar AND actually resolves the finding.
 * Returning null is a real answer: no swap beats a swap that changes nothing.
 */
export function pickWardrobeFix(ruleId, cited, outfit, target, wardrobeItems, register = "classic") {
  const parts = new Set(REGION_TO_PARTS[target.region] || [REGION_TO_PART[target.region] || target.region]);
  const candidates = (wardrobeItems || []).filter((item) => parts.has(item.part));
  const seed = `${ruleId}:${target.color || ""}:${target.description || ""}`;

  let best = null;
  let bestScore = -Infinity;
  let bestTie = -Infinity;
  for (const item of candidates) {
    const score = scoreCandidate(ruleId, item, target);
    if (score < 2) continue;
    const replacement = candidateAsGarment(item, target);
    if (!resolvesBy(ruleId, cited, outfit, target, replacement)) continue;
    if (participatesInProblem(ruleId, outfit, target, replacement, register)) continue;
    const tie = stableHash(`${seed}:${item.id}`);
    if (score > bestScore || (score === bestScore && tie > bestTie)) {
      best = item; bestScore = score; bestTie = tie;
    }
  }
  return best ? { itemId: best.id } : null;
}

/** An item to bring IN — used when the outfit is missing something rather than carrying something wrong. */
function pickWardrobeAddition(ruleId, cited, outfit, wardrobeItems) {
  const worn = new Set(outfit.map((garment) => garment.region));
  // Outerwear is the one thing you can always add over what you already have.
  const region = worn.has("outerwear") ? null : "outerwear";
  if (!region) return null;
  const parts = new Set(REGION_TO_PARTS[region] || []);
  const candidates = (wardrobeItems || []).filter((item) => parts.has(item.part) && classifyColor(item.color).neutral);
  for (const item of candidates.slice().sort((a, b) => stableHash(`${ruleId}:${b.id}`) - stableHash(`${ruleId}:${a.id}`))) {
    const added = candidateAsGarment(item, { region, description: item.name, formality: 3 });
    if (!verifyEvidence(ruleId, [...cited, added], [...outfit, added])) return { itemId: item.id };
  }
  return null;
}

/**
 * Works out what to actually offer for a verified finding.
 *
 * A finding is often about a pair, and either end of it is a legitimate place
 * to fix it: "both halves are relaxed" is answered just as well by a sharper
 * trouser as by a sharper top. Pinning it to one garment and giving up when
 * that garment has no match in the wardrobe threw away real advice — so the
 * preferred target is tried first, and the other cited garments after it.
 * `resolvesBy` still has to pass either way, so this widens what can be offered
 * without loosening what counts as a fix.
 */
export function buildRemedy(ruleId, cited, outfit, target, wardrobeItems, register = "classic", claimed = new Set()) {
  const rule = MIRROR_RULE_MAP[ruleId];
  // A garment another finding has already acted on is skipped rather than
  // ending this one: two true observations can share a cited garment without
  // being about the same piece, and dropping the second for that meant the
  // fabric problem vanished because the colour problem named the same tank top.
  // Rules that named their target for a reason don't wander — see `retarget`.
  const order = (rule.retarget === false ? [target] : [target, ...cited.filter((garment) => garment !== target)])
    .filter((garment) => !claimed.has(garment));
  if (!order.length) return { action: "none", target };
  for (const candidate of order) {
    const remedy = remedyFor(ruleId, cited, outfit, candidate, wardrobeItems, register);
    if (remedy.action !== "none") return { ...remedy, target: candidate };
  }
  return { action: "none", target: order[0] };
}

function remedyFor(ruleId, cited, outfit, target, wardrobeItems, register) {
  const rule = MIRROR_RULE_MAP[ruleId];
  for (const action of rule.actions) {
    if (action === "replace") {
      const fix = pickWardrobeFix(ruleId, cited, outfit, target, wardrobeItems, register);
      if (fix) return { action, itemId: fix.itemId, reason: fixReason(rule, action) };
    }
    if (action === "remove") {
      if (!REMOVABLE_REGIONS.has(target.region)) continue;
      if (resolvesBy(ruleId, cited, outfit, target, null)) return { action, reason: fixReason(rule, action) };
    }
    if (action === "add") {
      const addition = pickWardrobeAddition(ruleId, cited, outfit, wardrobeItems);
      if (addition) return { action, itemId: addition.itemId, reason: fixReason(rule, action) };
    }
  }
  return { action: "none" };
}

// ---------------------------------------------------------------------------
// Assembling the critique
// ---------------------------------------------------------------------------

// A finding only survives if the reading behind it is solid. Photo quality and
// the per-garment confidence both feed this, because an observation drawn from
// a garment the model could barely see is exactly the kind of confident nonsense
// this feature has to stop producing.
function findingHolds(finding, cited, photoQuality) {
  if (finding.confidence === "low") return false;
  if (photoQuality === "poor" && finding.confidence !== "high") return false;
  const shaky = cited.filter((garment) => garment.confidence === "low").length;
  return shaky * 2 <= cited.length;
}

const clean = (text) => (typeof text === "string" && text && !findJudgmentLanguage(text).length ? text : null);

// Describes, never reassures. "Solid overall, with one thing worth a look" was
// a verdict the engine had not computed — it asserted the rest of the outfit was
// fine, when all it actually knew was that one rule had fired. Saying what was
// found, and nothing more, is the only claim it can stand behind.
function overallLine(issues) {
  if (!issues.length) return "This works — nothing here is fighting itself.";
  const labels = issues.map((issue) => issue.label.toLowerCase());
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return issues.length === 1
    ? `One thing worth a look here: ${list}.`
    : `${issues.length} things worth a look here: ${list}.`;
}

/**
 * Perception -> verified judgment -> remedy, in the shape the Mirror UI renders.
 *
 * `judgment` is what scripts/mirror-judge.mjs returned. Passing an empty one is
 * valid and yields an honest, positive critique — this is the path taken when
 * the judge is unavailable, and it is deliberately not a degraded experience.
 */
export function buildMirrorCritique(perception, judgment = { findings: [], works: [] }, wardrobeItems = []) {
  const outfit = perception?.garments || [];
  const photoQuality = perception?.photoQuality || "clear";

  // Which rules can apply at all is a property of the outfit, not of what the
  // judge chose to return. Counting hues is simply the wrong question to ask of
  // a deliberately mixed outfit, so the rule is not merely deprioritised there —
  // it is unavailable, and a finding naming it is dropped on arrival. The judge
  // is never shown it either; this is the second lock on the same door.
  const inPlay = new Set(rulesForRegister(perception?.register || "classic").map((rule) => rule.id));

  // Most directly observable first, so that when two findings would land on the
  // same garment the one resting on visible evidence wins over the one resting
  // on an inference. Order of arrival decided this before, which meant the
  // stronger observation could be silently dropped for turning up second.
  const confidenceRank = { high: 2, medium: 1, low: 0 };
  const ordered = [...(judgment.findings || [])].sort((a, b) => {
    const strength = (MIRROR_RULE_MAP[b.ruleId]?.strength || 0) - (MIRROR_RULE_MAP[a.ruleId]?.strength || 0);
    return strength || (confidenceRank[b.confidence] || 0) - (confidenceRank[a.confidence] || 0);
  });

  const issues = [];
  const seenTargets = new Set();
  for (const finding of ordered) {
    // Three is the ceiling. Two was too quiet: an outfit doing several distinct
    // things at once got one of them reported and the rest silently dropped,
    // which reads as approval of everything left unsaid. Beyond three it stops
    // being help and starts being a verdict on the person.
    if (issues.length >= 3) break;
    if (!inPlay.has(finding.ruleId)) continue;
    const cited = finding.garmentIndices.map((index) => outfit[index]).filter(Boolean);
    if (!verifyEvidence(finding.ruleId, cited, outfit)) continue;
    if (!findingHolds(finding, cited, photoQuality)) continue;

    const rule = MIRROR_RULE_MAP[finding.ruleId];
    const preferred = TARGET[rule.target](cited, finding.ruleId);
    if (!preferred) continue;

    const remedy = buildRemedy(finding.ruleId, cited, outfit, preferred, wardrobeItems, perception?.register || "classic", seenTargets);
    const landedOn = remedy.target || preferred;
    // One finding per GARMENT, not per region. Deduping by region meant that in
    // an outfit carrying a hat, a belt and a bag, a second true observation
    // about a different one of them was thrown away for sharing a category.
    // Only advice claims a garment, and only advice can be blocked by a claim.
    // An observation with no move behind it competes with nothing: letting it
    // reserve a piece pushed the finding that COULD have acted on that piece
    // onto a worse one, and letting a claim silence it deleted a true thing for
    // no gain. buildRemedy has already kept acting remedies off claimed
    // garments, so this only ever decides the fate of a bare observation.
    if (remedy.action !== "none" && seenTargets.has(landedOn)) continue;
    if (remedy.action !== "none") seenTargets.add(landedOn);

    issues.push({
      id: finding.ruleId,
      region: landedOn.region,
      // Which garment in the photo this is actually about, and which ones the
      // judgment rested on. Not rendered today — the panel names the pieces in
      // prose — but it is what makes a critique checkable from the outside
      // (test/mirror-invariants.test.mjs re-derives every remedy from these)
      // and what a future UI would need to point at the garment in the image.
      targetIndex: outfit.indexOf(landedOn),
      citedIndices: cited.map((garment) => outfit.indexOf(garment)),
      label: rule.label,
      summary: clean(finding.summary) || rule.what,
      confidence: finding.confidence,
      remedy: {
        action: remedy.action,
        // Some problems are genuinely not one swap away — three patterns
        // competing is not settled by removing one. Saying that plainly beats
        // both a generic shrug and a fix that would not work.
        ...(remedy.action === "none" && rule.guidance ? { guidance: rule.guidance } : {}),
        ...(remedy.itemId ? { itemId: remedy.itemId } : {}),
        ...(remedy.action === "remove" ? { target: landedOn.description || PART_LABEL[landedOn.region] } : {}),
        ...(remedy.reason ? { reason: remedy.reason } : {}),
      },
    });
  }

  // What's working is no longer built from whatever the issue checks happened
  // to leave over — under the old shape, two issues meant zero positives, so
  // the more it had to say the colder it read. The judge names these directly,
  // and the deterministic notes only stand in when it named none.
  let works = (judgment.works || []).map((work) => clean(work.text)).filter(Boolean);
  if (!works.length) {
    works = [evaluateProportion(outfit).note, evaluateColorHarmony(outfit).note].map(clean).filter(Boolean);
  }
  if (!works.length && outfit.length) works = ["The pieces here sit together without any one of them fighting the rest."];

  return {
    overall: overallLine(issues),
    verdict: issues.length === 0 ? "clean" : issues.length === 1 ? "minor" : "notable",
    // The pieces the critique is about, in the order the issues index into.
    // The panel needs them to give a summary any typographic hierarchy — a
    // sentence about "the green mesh tank" reads as a wall of text until the
    // garment it names is the thing your eye lands on — and a future UI would
    // need them to point at the piece in the photo itself.
    garments: outfit.map((garment) => ({
      region: garment.region,
      description: garment.description || PART_LABEL[garment.region] || "piece",
      colorHex: garment.colorHex || null,
    })),
    register: perception?.register || "classic",
    photoQuality,
    works: works.slice(0, 2),
    issues,
  };
}
