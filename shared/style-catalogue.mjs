// The closed set of things the Mirror is allowed to say is wrong.
//
// Why a catalogue at all. Two earlier versions of this feature both failed, in
// opposite directions. A free-form vision model asked to "critique this outfit"
// invented problems that weren't there (it called navy-with-brown a clash) and
// proposed swaps that contradicted each other. Replacing it with a hand-written
// rules engine fixed the inventing and introduced a worse problem: with only a
// hue count and a volume check, every photo produced the same two sentences,
// and because the engine always emitted a count it manufactured confident
// nonsense rather than saying nothing.
//
// So: the model still does the judging — it is far better than a regex at
// telling a deliberate look from an accident — but it may only judge in this
// vocabulary. It picks a rule id from this list, names the garments it is
// citing as evidence, and scripts/style-rules.mjs then re-checks that evidence
// against the perceived facts before a word of it reaches the user. A finding
// whose evidence doesn't hold is dropped, not softened.
//
// `registers` is the other half of the design. The same fact means opposite
// things in different outfits: five colours is clutter in a minimal outfit and
// is the entire point of a maximalist one. A rule that doesn't name the current
// register is never even offered to the judge, so it cannot be applied where it
// doesn't belong.

// What things are made of. Perceived per garment, because a whole axis of real
// styling — whether the fabrics belong to the same weather — was invisible while
// the vocabulary was colour and cut alone.
export const MIRROR_MATERIALS = [
  "cotton", "denim", "corduroy", "wool", "knit", "fleece", "leather", "suede",
  "technical", "mesh", "linen", "silk", "canvas", "nylon", "other",
];

// Which weather a fabric belongs to. "any" is the honest answer for most of
// them — cotton and denim are worn all year — so only the fabrics that really
// do belong to one end of the thermometer are marked.
export const MATERIAL_WEATHER = {
  mesh: "warm", linen: "warm", silk: "warm",
  corduroy: "cool", wool: "cool", fleece: "cool", suede: "cool",
};

// Wardrobe items carry no material field — only a name and free-text tags — so
// a candidate offered as a fix has to have its fabric read the same way. An
// unmatched item stays "other", which the weather rule treats as making no
// claim either way: better to offer no fix than to assert one we cannot ground.
const MATERIAL_HINTS = [
  ["corduroy", /\bcord(uroy)?\b/], ["denim", /\b(denim|jean|jeans)\b/], ["fleece", /\bfleece\b/],
  ["suede", /\bsuede\b/], ["leather", /\bleather\b/], ["wool", /\b(wool|merino|cashmere|tweed)\b/],
  ["mesh", /\bmesh\b/], ["linen", /\blinen\b/], ["silk", /\bsilk\b/],
  ["technical", /\b(technical|gore-?tex|softshell|windbreaker)\b/], ["nylon", /\b(nylon|polyester|puffer)\b/],
  ["canvas", /\bcanvas\b/], ["knit", /\b(knit|knitted|ribbed|sweater|jumper)\b/], // Shape words earn their place here: a t-shirt or a polo is cotton jersey in
  // practice, and without them most of a real wardrobe reads as unknown fabric
  // and can never be offered as an all-weather answer.
  ["cotton", /\b(cotton|jersey|poplin|oxford|t-?shirt|tee|polo|crew ?neck|crewneck|chino)\b/],
];

/** Best-effort material from an item's name and tags. "other" when unreadable. */
export function inferMaterial(text) {
  const haystack = String(text || "").toLowerCase();
  return MATERIAL_HINTS.find(([, pattern]) => pattern.test(haystack))?.[0] || "other";
}

// How the outfit as a whole reads. Perceived once per photo, and it gates
// which rules are in play.
export const OUTFIT_REGISTERS = ["minimal", "classic", "sporty", "workwear", "eclectic", "formal"];

// `strength` is how directly observable a rule is, and it decides which finding
// survives when two would land on the same garment. A stacked hem is a thing you
// can point at in the photo; "nothing leads" is an inference about the whole
// look. When they collide, the one you can point at wins.

// What a finding is allowed to ask for.
//   replace — swap the cited garment for a specific item in the wardrobe
//   remove  — simply take it off; costs nothing and is usually the honest
//             answer to "too much going on", which the old engine could not say
//   add     — bring in a piece that isn't currently worn
//   none    — an observation with no single move behind it
export const FINDING_ACTIONS = ["replace", "remove", "add", "none"];

// `retarget` says whether either end of a finding is a fair place to fix it.
// "Both halves are relaxed" is answered as well by a sharper trouser as by a
// sharper top, so if one is already spoken for the other will do. But for a
// rule whose whole content is WHICH piece — the one that should stop competing,
// the trouser that is actually pooling — moving the fix to a different garment
// inverts the advice. Those rules would rather say nothing and explain why.

export const MIRROR_RULES = [
  {
    id: "color-clutter",
    label: "Too many competing colors",
    what: "Three or more different non-neutral colors are competing across pieces that take up real space in the outfit.",
    registers: ["minimal", "classic", "sporty", "workwear", "formal"],
    strength: 2,
    actions: ["remove", "replace"],
    minCited: 3,
    // The outlier hue, and among equals the piece taking the least space —
    // easiest to drop, and the one carrying the least of the outfit's identity.
    target: "chromatic-outlier",
    fixReason: {
      replace: "A neutral, so it won't add another competing color.",
      remove: "Taking this off drops one of the competing colors without changing anything else.",
    },
    guidance: "Dropping one of these colors, or repeating one of them on a second piece, is what settles it.",
  },
  {
    id: "off-match",
    label: "Near-miss color pairing",
    what: "Two non-neutral colors sit far enough apart to look unrelated but close enough to look like they were meant to match — the gap reads as an accident rather than a choice.",
    registers: ["minimal", "classic", "sporty", "workwear", "formal"],
    strength: 1,
    actions: ["replace", "remove"],
    minCited: 2,
    target: "smallest-surface",
    fixReason: {
      replace: "A neutral, so it sidesteps the near-miss pairing entirely.",
      remove: "Without it the remaining colors don't have to agree with anything.",
    },
    guidance: "Either commit to the contrast or take one of the two colors out — the near-miss is the part that reads as accidental.",
  },
  {
    id: "no-anchor",
    label: "Nothing anchoring it",
    what: "The outfit carries a lot of color or pattern and has no quiet piece — a neutral, or something dark and plain — holding it down. This is the question to ask of a deliberately loud outfit, instead of counting its colors.",
    registers: ["eclectic", "sporty"],
    strength: 1,
    actions: ["add", "replace"],
    minCited: 2,
    target: "largest-surface",
    fixReason: {
      add: "Something quiet to hold the louder pieces down.",
      replace: "Turns one of the loud pieces into the calm one the rest can sit against.",
    },
    guidance: "One quiet piece with some size to it — a plain neutral layer — is what the loud pieces need to sit against.",
  },
  {
    id: "pattern-load",
    label: "Patterns competing",
    what: "Two or more patterned pieces at a similar scale are asking for attention at once, so neither wins.",
    registers: null,
    strength: 2,
    actions: ["remove", "replace"],
    minCited: 2,
    target: "smallest-surface",
    fixReason: {
      replace: "Plain, so the patterned piece staying on gets to lead.",
      remove: "Leaves one pattern doing the talking instead of two.",
    },
    guidance: "Pick one of these to lead and let the others go plain — no single swap settles it while three are competing.",
  },
  {
    id: "no-focal-point",
    label: "Nothing leads",
    what: "Every piece is pitched at the same volume, so the eye has nowhere to land first. Distinct from having too many colors — a loud outfit can work perfectly well as long as one thing is clearly leading.",
    registers: ["eclectic", "sporty", "workwear"],
    strength: 1,
    retarget: false,
    actions: ["replace", "remove", "none"],
    minCited: 3,
    // The stylist's move here is to quiet the plainer of the two contenders and
    // let the more interesting piece lead — not to strip the outfit back.
    target: "loud-contender",
    fixReason: {
      replace: "Quiet enough to let the louder piece lead instead of competing with it.",
      remove: "One fewer thing competing gives the rest somewhere to lead from.",
    },
    guidance: "Decide which piece is the one you want noticed first, and let everything else sit behind it.",
  },
  {
    id: "no-color-echo",
    label: "Colors don't echo",
    what: "Four or more different non-neutral colors, and not one of them turns up twice. A loud outfit reads as chosen when its colors repeat across pieces and as accidental when every piece brings a new one — so this, not a headcount, is the colour question to ask of a deliberately mixed outfit.",
    registers: ["eclectic", "sporty", "workwear"],
    strength: 2,
    actions: ["remove", "replace"],
    minCited: 3,
    target: "chromatic-outlier",
    fixReason: {
      replace: "Picks up a color already in the outfit instead of introducing another one.",
      remove: "One fewer unrepeated color for the rest to account for.",
    },
    guidance: "Repeating one of these colors somewhere else — a second piece in the same family — would tie them together.",
  },
  {
    id: "weather-split",
    label: "Fabrics from different weather",
    what: "Hot-weather fabrics (mesh, linen, silk) are being worn with cold-weather ones (corduroy, wool, fleece, suede). The pieces can each be right and still read as belonging to two different days.",
    registers: null,
    strength: 2,
    actions: ["remove", "replace"],
    minCited: 2,
    target: "weather-outlier",
    fixReason: {
      replace: "Made of something that belongs to the same weather as the rest.",
      remove: "Leaves the fabrics agreeing on one kind of day.",
    },
    guidance: "The fabrics are pulling toward different weather — worth knowing even if you keep it.",
  },
  {
    id: "double-volume",
    label: "Both halves are relaxed",
    what: "The top and the bottom are both relaxed or oversized at once, so the silhouette has no line through it.",
    registers: null,
    strength: 3,
    actions: ["replace"],
    minCited: 2,
    target: "smallest-surface",
    fixReason: {
      replace: "Keeps a fitted line here, balancing out the relaxed piece staying on.",
    },
    guidance: "Keeping one half fitted is the move, whether or not you own the piece that does it.",
  },
  {
    id: "pooling-hem",
    label: "Hem needs cleaning up",
    what: "The hem stacks or pools at the shoe by more than the cut of the garment calls for. A wide-leg or relaxed trouser is designed to carry some break — that is the silhouette, not a mistake — so this only applies when the stacking is heavier than the cut asks for, or the cut is a fitted one.",
    registers: null,
    strength: 3,
    retarget: false,
    actions: ["replace"],
    minCited: 1,
    target: "cited",
    fixReason: {
      replace: "A cleaner break instead of pooling at the shoe.",
    },
    guidance: "A shorter break at the shoe is what this needs — nothing owned does it without changing something else.",
  },
  {
    id: "formality-split",
    label: "Pieces pulling in different directions",
    what: "The pieces sit at very different levels of formality and the distance reads as accidental rather than deliberate.",
    registers: ["minimal", "classic", "workwear", "formal"],
    strength: 2,
    retarget: false,
    actions: ["replace", "remove"],
    minCited: 2,
    target: "formality-outlier",
    fixReason: {
      replace: "Sits closer to the level the rest of the outfit is pitched at.",
      remove: "Without it the rest of the outfit agrees on a level.",
    },
    guidance: "Bringing this piece closer to the level the rest sits at is the move, whether or not you own the piece that does it.",
  },
  {
    id: "contrast-flat",
    label: "Not much separation",
    what: "Every piece sits at roughly the same lightness, so the outfit reads as one block and the individual pieces stop being legible.",
    registers: ["minimal", "classic", "formal"],
    strength: 2,
    actions: ["replace", "add"],
    minCited: 2,
    target: "largest-surface",
    fixReason: {
      replace: "Opens up the gap in lightness so the pieces read separately.",
      add: "Breaks up the single block of tone.",
    },
    guidance: "Something markedly lighter or darker than the rest would let the pieces read separately.",
  },
];

export const MIRROR_RULE_MAP = Object.fromEntries(MIRROR_RULES.map((rule) => [rule.id, rule]));
export const MIRROR_RULE_IDS = MIRROR_RULES.map((rule) => rule.id);

/** The rules in play for an outfit that reads as `register`. */
export function rulesForRegister(register) {
  return MIRROR_RULES.filter((rule) => !rule.registers || rule.registers.includes(register));
}

/**
 * The catalogue as prose for the judge prompt, narrowed to the register at
 * hand so a rule that doesn't apply is never even visible to the model.
 */
export function describeRuleCatalogue(register) {
  return rulesForRegister(register)
    .map((rule) => `- "${rule.id}" — ${rule.what} (cite at least ${rule.minCited} garment${rule.minCited === 1 ? "" : "s"})`)
    .join("\n");
}
