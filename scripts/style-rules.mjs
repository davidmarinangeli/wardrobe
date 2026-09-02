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

import { REGION_TO_PART, PART_TO_REGION } from "../shared/garments.mjs";

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
export { REGION_TO_PART, PART_TO_REGION };

// Most-replaceable-first: which garment to target when an issue could point at
// either of two pieces (e.g. a color clash between an accessory and a top should
// point at the accessory, not ask the user to replace their shirt).
// A full-coverage garment sits last: it IS the outfit, so asking someone to
// swap their dress is the biggest change the critique can propose.
const REGION_PRIORITY = ["accessory", "footwear", "lowerbody", "outerwear", "upperbody", "fullbody"];
const PART_LABEL = { upperbody: "top", outerwear: "jacket", lowerbody: "bottoms", accessory: "accessory", footwear: "shoes", fullbody: "dress" };

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
// risking a fabricated clash against a name we don't understand.
function colorInfo(name) {
  const entry = COLOR_TABLE[name];
  return entry ? { name, ...entry } : { name, neutral: true, hue: null };
}

export function describeColorHarmonyRules() {
  const neutrals = COLOR_NAMES.filter((name) => COLOR_TABLE[name].neutral).join(", ");
  return `Color harmony rules, grounded in menswear style convention: treat ${neutrals} as neutrals — they pair with anything and don't count toward the color budget. Among non-neutral colors, hues within ~15° of each other read as tonal and within ~45° as analogous — both harmonious. Opposite hues (~150-210° apart) read as a bold, intentional complementary pairing, not a mistake. Two non-neutral hues roughly 45-150° apart are a near-miss that reads as an accidental mismatch rather than a deliberate one — avoid that combination. Keep at most two non-neutral colors in one outfit; a third reads as clutter.`;
}

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

function cap(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }

function namesList(garments) {
  const names = garments.map((g) => g.color);
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function describe(garment) {
  return `${garment.color} ${garment.description || PART_LABEL[garment.region] || "piece"}`;
}

function leastEssential(garments) {
  return garments.slice().sort((a, b) => REGION_PRIORITY.indexOf(a.region) - REGION_PRIORITY.indexOf(b.region))[0];
}

// Evaluates color harmony across every visible garment in a photo (or a
// candidate outfit combination). Returns { note, issue } — issue is null when
// nothing violates a grounded rule, in which case note explains why it works.
export function evaluateColorHarmony(garments) {
  if (!garments || !garments.length) return { note: null, issue: null };

  const colored = garments.map((g) => ({ ...g, info: colorInfo(g.color) }));
  const chromatic = colored.filter((g) => !g.info.neutral);

  if (chromatic.length === 0) {
    return { note: `Everything here (${namesList(colored)}) is a neutral, so there's no clash to worry about.`, issue: null };
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

function evaluateOutfit(garments) {
  const color = evaluateColorHarmony(garments);
  const proportion = evaluateProportion(garments);

  // At most one issue per region: proportion/fit evidence is more directly
  // visible than a hue-distance heuristic, so it wins a same-region collision.
  let issues = [proportion.issue, color.issue].filter(Boolean);
  if (issues.length === 2 && issues[0].region === issues[1].region) issues = [issues[0]];

  const works = [proportion.note, color.note].filter(Boolean);
  return { issues, works };
}

// A pooling hem is about excess LENGTH bunching at the shoe, not overall
// silhouette volume — a trouser that's relaxed through the thigh but cropped or
// tapered at the ankle genuinely fixes it, so length/taper cues count on their
// own here and only real leg-width cues count against it. Double-volume is a
// silhouette question instead, so it needs true fitted/tailored cut.
const POOLING_FIX = /\b(cropped|ankle|tailored|slim|straight|skinny|fitted|tapered)\b/;
const POOLING_AGAINST = /\b(wide|wide-leg|baggy)\b/;
const VOLUME_FIX = /\b(slim|tailored|fitted|straight|cropped|skinny)\b/;
const VOLUME_AGAINST = /\b(wide|relaxed|oversized|baggy|wide-leg|loose)\b/;

function scoreCandidate(issue, item, garments) {
  const haystack = `${(item.tags || []).join(" ")} ${item.name || ""}`.toLowerCase();
  let score = 0;

  if (issue.id === "pooling-hem") {
    if (POOLING_FIX.test(haystack)) score += 2;
    if (POOLING_AGAINST.test(haystack)) score -= 3;
  } else if (issue.id === "double-volume") {
    if (VOLUME_FIX.test(haystack)) score += 2;
    if (VOLUME_AGAINST.test(haystack)) score -= 3;
  }

  if (issue.id === "color-clutter" || issue.id === "off-match") {
    const info = classifyColor(item.color);
    score += info.neutral ? 2 : -1;
    if (item.secondaryColor && !classifyColor(item.secondaryColor).neutral) score -= 1;
  }

  // A fix has to actually work with the rest of THIS outfit's colors, not just
  // solve its own dimension in isolation — otherwise the single "safest" item
  // in the wardrobe wins for every outfit regardless of what it's paired with.
  const candidateInfo = classifyColor(item.color);
  if (garments && garments.length) {
    const hypothetical = garments.map((g) => (g.region === issue.region ? { ...g, color: candidateInfo.name } : g));
    score += evaluateColorHarmony(hypothetical).issue ? -4 : 1;
  }

  // For a fit-only issue, a neutral candidate is preferred over a chromatic
  // one even when both are otherwise fit-valid — these regions (lower/upper
  // body, outerwear) carry a lot of visual weight, so introducing a new
  // chromatic color there is inherently riskier than the harmony check above
  // alone accounts for (that check only catches a color that actively
  // clashes, not one that's merely an unnecessary new color to introduce).
  if (issue.id === "pooling-hem" || issue.id === "double-volume") {
    score += candidateInfo.neutral ? 1 : 0;
  }

  return score;
}

// Phrased without leading on the item's own name (garment names are free text of
// unpredictable grammatical number — "trousers", singular jacket names, etc. — and
// the name is already shown right above this text in the UI).
function buildFixReason(issue) {
  switch (issue.id) {
    case "pooling-hem": return "A cleaner break instead of pooling at the shoe.";
    case "double-volume": return "Keeps a fitted line here, balancing out the relaxed piece staying on.";
    case "color-clutter": return "A neutral, so it won't add another competing color.";
    case "off-match": return "A neutral, so it sidesteps the near-miss pairing entirely.";
    default: return "Addresses this issue cleanly.";
  }
}

// Deterministic string hash (FNV-1a) — used only to break ties between wardrobe
// candidates that already score identically. Multiple neutral, fit-safe items
// are often genuinely interchangeable (that's what "neutral" means), and always
// resolving that tie to whichever happens to sit first in the wardrobe list
// means the same single item gets suggested for every outfit regardless of
// context. Seeding the tie-break on the specific garment being replaced keeps
// the result fully reproducible for a given photo while letting different
// outfits land on different, equally-valid picks.
function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Picks the single best wardrobe item to resolve an issue, or null if nothing
// in the wardrobe clears a real confidence bar — never forces a weak swap.
// `garments` is the rest of the outfit currently being critiqued, so a
// candidate is only chosen if it actually works with those specific colors.
export function pickWardrobeFix(issue, wardrobeItems, garments) {
  const part = REGION_TO_PART[issue.region] || issue.region;
  const candidates = (wardrobeItems || []).filter((item) => item.part === part);
  if (!candidates.length) return null;

  const replaced = (garments || []).find((g) => g.region === issue.region);
  const seed = `${issue.id}:${replaced?.color || ""}:${replaced?.description || ""}`;

  let best = null;
  let bestScore = -Infinity;
  let bestTie = -Infinity;
  for (const item of candidates) {
    const score = scoreCandidate(issue, item, garments);
    const tie = stableHash(`${seed}:${item.id}`);
    if (score > bestScore || (score === bestScore && tie > bestTie)) {
      best = item; bestScore = score; bestTie = tie;
    }
  }

  if (!best || bestScore < 2) return null;
  return { itemId: best.id, reason: buildFixReason(issue) };
}

// Orchestrates perception -> judgment -> wardrobe matching into the shape the
// Mirror UI renders. Every fix is nested under the one issue it resolves, so
// two fixes can never again read as competing alternatives for the same problem.
export function buildMirrorCritique(garments, wardrobeItems) {
  const { issues, works } = evaluateOutfit(garments || []);
  const richIssues = issues.map((issue) => ({ ...issue, fix: pickWardrobeFix(issue, wardrobeItems || [], garments) }));

  const verdict = richIssues.length === 0 ? "clean" : richIssues.length === 1 ? "minor" : "notable";
  const overall = richIssues.length === 0
    ? "This works — nothing here fights itself."
    : richIssues.length === 1
      ? `Solid overall, with one thing worth adjusting: ${richIssues[0].label.toLowerCase()}.`
      : `A couple of things work against each other here: ${richIssues.map((issue) => issue.label.toLowerCase()).join(" and ")}.`;

  return {
    overall,
    verdict,
    works: works.length ? works : (richIssues.length === 0 ? ["Proportions and color both hold together here."] : []),
    issues: richIssues,
  };
}
