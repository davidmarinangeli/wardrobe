// The app must never make someone feel their clothes are wrong.
//
// Feedback is always about what works together, within what you own. Never
// about what is in, dated, no longer done, or what they should be wearing
// instead. This is not a tone preference: a styling model left unconstrained
// editorialises by default — it has read a great deal of fashion writing, and
// most of that writing is about what is currently correct. That is the
// difference between a tool someone opens every morning and one they open
// twice.
//
// Injected into every generative surface (outfit suggestions, style DNA, outfit
// style captions, garment detection). Mirror builds its critique
// deterministically in scripts/style-rules.mjs rather than from a prompt, so it
// is held to the same rule by test/no-judgment.test.mjs instead.

export const NO_JUDGMENT_RULES = [
  "Never imply the wardrobe, or anything in it, is dated, out of style, or no longer done. Do not reference eras, seasons, trends, or what is currently worn.",
  "Never suggest replacing something the user owns with a more current version of it.",
  "Judge only what is in front of you: proportion, color harmony, occasion fit, weather fit, and whether these specific pieces work together.",
  "Every recommendation must come from the wardrobe as it is. Their clothes are the given; your job is to combine them well.",
];

export const NO_JUDGMENT_PROMPT = [
  "HARD CONSTRAINTS — these override every other instruction:",
  ...NO_JUDGMENT_RULES.map((rule) => `- ${rule}`),
].join("\n");

// Era and trend vocabulary that must never reach the user. Each entry is a
// word-boundary regex so ordinary words that merely contain them ("nowadays"
// inside a longer word, "season" in "seasonal palette") are matched precisely
// rather than by substring.
//
// Deliberately NOT forbidden: "seasonal" as used by the color-analysis feature
// ("Autumn palette") is about skin tone, not about what year it is — the
// distinction is why these are anchored patterns and not a substring blocklist.
export const FORBIDDEN_JUDGMENT_PATTERNS = [
  /\bdated\b/i,
  /\boutdated\b/i,
  /\bout of style\b/i,
  /\bout of fashion\b/i,
  /\bno longer (in|worn|done|fashionable|stylish)\b/i,
  /\bthese days\b/i,
  /\bnowadays\b/i,
  /\bthis season\b/i,
  /\blast season\b/i,
  /\bthis year\b/i,
  /\bon[- ]trend\b/i,
  /\btrendy\b/i,
  /\bin style\b/i,
  /\bin fashion\b/i,
  /\bcurrently fashionable\b/i,
  /\bstill wearing\b/i,
  /\bpassé\b/i,
  /\bold[- ]fashioned\b/i,
  /\bunfashionable\b/i,
  /\bmodernise\b/i, /\bmodernize\b/i,
  /\bupdate your\b/i,
  /\brefresh your wardrobe\b/i,
];

/**
 * Returns every forbidden phrase found in a string, for tests and for spot
 * checks on model output.
 * @returns {string[]} the offending matches, empty when the text is clean
 */
export function findJudgmentLanguage(text) {
  if (typeof text !== "string" || !text) return [];
  return FORBIDDEN_JUDGMENT_PATTERNS
    .map((pattern) => text.match(pattern)?.[0])
    .filter(Boolean);
}
