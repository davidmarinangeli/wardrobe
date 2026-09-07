// The space of outfits the Mirror has to survive, as data.
//
// The hand-written fixtures in test/fixtures/mirror are real photos with a
// verdict someone decided by looking at them — they answer "is this right?".
// They cannot answer "is this right for everything else", because a fixture
// only ever covers a case somebody already thought of, and the failures in this
// feature's history were all cases nobody thought of: a wide-leg trouser, a
// dress, a wardrobe with only baseball caps, a maximalist outfit.
//
// So this file describes the space instead of samples of it. Garments are
// archetypes, outfits compose them, and the matrix crosses every register with
// every rule — the outfit that should trigger it, and the near-miss that should
// not. Nothing here asserts wording; test/mirror-invariants.test.mjs asserts the
// things that must be true of any critique, whatever it says.

import { MIRROR_RULES, OUTFIT_REGISTERS } from "../shared/style-catalogue.mjs";

const garment = (region, description, overrides = {}) => ({
  region,
  description,
  color: "grey",
  colorHex: "#8b8b8b",
  secondaryHex: null,
  material: "cotton",
  patterned: false,
  patternScale: null,
  volume: "regular",
  formality: 3,
  hemNotes: null,
  hemSeverity: null,
  confidence: "high",
  ...overrides,
});

// Realistic pieces, each one a thing you could point at in a wardrobe rather
// than a bag of field values. Named so a failing scenario reads as an outfit.
export const PIECES = {
  whiteTee: garment("upperbody", "crew neck tee", { color: "white", colorHex: "#f2f4f7", formality: 2 }),
  blackTee: garment("upperbody", "pocket tee", { color: "black", colorHex: "#1c1b20", formality: 2 }),
  greyTee: garment("upperbody", "relaxed tee", { color: "grey", colorHex: "#a8abad", volume: "relaxed", formality: 2 }),
  navyShirt: garment("upperbody", "open-collar shirt", { color: "navy", colorHex: "#232a3d" }),
  linenShirt: garment("upperbody", "linen shirt", { color: "cream", colorHex: "#efe6d5", material: "linen" }),
  printShirt: garment("upperbody", "printed camp shirt", { color: "purple", colorHex: "#7b5ea7", secondaryHex: "#d4b83a", patterned: true, patternScale: "bold", volume: "relaxed", formality: 2 }),
  stripeShirt: garment("upperbody", "striped rugby shirt", { color: "teal", colorHex: "#1f8a80", secondaryHex: "#c0392b", patterned: true, patternScale: "bold", formality: 2 }),
  meshTank: garment("upperbody", "mesh tank top", { color: "green", colorHex: "#b8d94a", material: "mesh", formality: 1 }),
  redTee: garment("upperbody", "logo tee", { color: "red", colorHex: "#be2033", formality: 2 }),
  knitSweater: garment("upperbody", "ribbed sweater", { color: "charcoal", colorHex: "#3d4e3f", material: "knit", formality: 3 }),
  athleticTop: garment("upperbody", "training top", { color: "blue", colorHex: "#1f5fbf", material: "technical", volume: "fitted", formality: 1 }),
  dressShirt: garment("upperbody", "dress shirt", { color: "white", colorHex: "#f6f7f9", volume: "fitted", formality: 5 }),

  woolCoat: garment("outerwear", "wool overcoat", { color: "charcoal", colorHex: "#3a3d42", material: "wool", formality: 4 }),
  denimJacket: garment("outerwear", "denim jacket", { color: "navy", colorHex: "#263548", material: "denim", volume: "relaxed", formality: 2 }),
  camoJacket: garment("outerwear", "camo overshirt", { color: "olive", colorHex: "#6e715e", patterned: true, patternScale: "bold", volume: "relaxed", formality: 2 }),

  blackTrousers: garment("lowerbody", "pleated trousers", { color: "black", colorHex: "#1f1f21" }),
  woolTrousers: garment("lowerbody", "wool trousers", { color: "charcoal", colorHex: "#3c3f44", material: "wool", formality: 4 }),
  cordShorts: garment("lowerbody", "corduroy shorts", { color: "tan", colorHex: "#a8763f", material: "corduroy", volume: "relaxed", formality: 2 }),
  cordTrousers: garment("lowerbody", "corduroy trousers", { color: "teal", colorHex: "#2a9d8f", material: "corduroy", formality: 2 }),
  oliveTrousers: garment("lowerbody", "tailored trousers", { color: "olive", colorHex: "#555c3c", formality: 3 }),
  wideJeans: garment("lowerbody", "wide-leg jeans", { color: "sky-blue", colorHex: "#a5bed8", material: "denim", volume: "relaxed", formality: 2, hemNotes: "rests on the shoe", hemSeverity: "slight" }),
  slimTrousers: garment("lowerbody", "slim trousers", { color: "grey", colorHex: "#8b8b8b", volume: "fitted", hemNotes: "stacks over the shoe", hemSeverity: "slight" }),
  poolingWideJeans: garment("lowerbody", "wide-leg jeans", { color: "sky-blue", colorHex: "#a5bed8", material: "denim", volume: "relaxed", formality: 2, hemNotes: "bunches heavily over the shoe", hemSeverity: "severe" }),
  cargoPants: garment("lowerbody", "cargo pants", { color: "brown", colorHex: "#71502c", material: "canvas", volume: "relaxed", formality: 2 }),
  runningShorts: garment("lowerbody", "running shorts", { color: "black", colorHex: "#1d1c1e", material: "technical", formality: 1 }),

  floralDress: garment("fullbody", "floral midi dress", { color: "red", colorHex: "#b3222a", secondaryHex: "#e8d9a0", patterned: true, patternScale: "bold", volume: "relaxed" }),
  blackDress: garment("fullbody", "column dress", { color: "black", colorHex: "#1a1a1c", material: "silk", formality: 5 }),

  whiteSneakers: garment("footwear", "leather sneakers", { color: "white", colorHex: "#f2f3f5", material: "leather", formality: 2 }),
  greySneakers: garment("footwear", "mesh runners", { color: "grey", colorHex: "#9a9da0", material: "technical", formality: 2 }),
  suedeBoots: garment("footwear", "suede work boots", { color: "tan", colorHex: "#a8895e", material: "suede", formality: 2 }),
  dressShoes: garment("footwear", "oxford shoes", { color: "black", colorHex: "#1b1b1d", material: "leather", formality: 5 }),
  trailShoes: garment("footwear", "trail runners", { color: "orange", colorHex: "#e2622a", material: "technical", patterned: true, patternScale: "bold", formality: 1 }),

  blueBeanie: garment("accessory", "knit beanie", { color: "blue", colorHex: "#4a6fa5", material: "wool", formality: 2 }),
  navyCap: garment("accessory", "baseball cap", { color: "navy", colorHex: "#2a2f45", formality: 2 }),
  pinkBelt: garment("accessory", "webbing belt", { color: "pink", colorHex: "#e8547c", material: "nylon", formality: 1 }),
  tealBag: garment("accessory", "crossbody sling bag", { color: "teal", colorHex: "#2fa8a0", secondaryHex: "#e8a33d", material: "nylon", patterned: true, patternScale: "bold", formality: 1 }),

  orangeSocks: garment("legwear", "ribbed crew socks", { color: "orange", colorHex: "#e2622a", formality: 1 }),
  redSocks: garment("legwear", "ribbed socks", { color: "red", colorHex: "#b83a2e", material: "wool", formality: 2 }),
  whiteSocks: garment("legwear", "crew socks", { color: "white", colorHex: "#f8f8f8", formality: 2 }),
  redBeanie: garment("accessory", "wool beanie", { color: "red", colorHex: "#c0392b", material: "wool", formality: 2 }),
};

const outfit = (register, pieces, overrides = {}) => ({
  register,
  photoQuality: "clear",
  garments: pieces,
  ...overrides,
});

const P = PIECES;

// Each entry names the rule it is built around and whether that rule should
// survive. `fires: false` entries are the ones that matter most — a styling
// engine's real failure mode is reporting a problem that isn't there.
export const SCENARIOS = [
  // --- colour -------------------------------------------------------------
  { name: "three loud colors in a plain outfit", rule: "color-clutter", fires: true,
    perception: outfit("classic", [P.redTee, P.cordTrousers, P.blueBeanie, P.whiteSneakers]) },
  { name: "all-neutral outfit", rule: "color-clutter", fires: false,
    perception: outfit("classic", [P.navyShirt, P.whiteTee, P.blackTrousers, P.whiteSneakers]) },
  { name: "navy shirt with brown cargos", rule: "off-match", fires: false,
    perception: outfit("classic", [P.navyShirt, P.whiteTee, P.cargoPants]) },
  // Red against teal would be ~175 degrees apart, which reads as a deliberate
  // complementary pairing rather than a mistake — the near-miss band is the
  // middle of the wheel, not the far side of it.
  { name: "red top against olive trousers", rule: "off-match", fires: true,
    perception: outfit("classic", [P.redTee, P.oliveTrousers, P.whiteSneakers]) },
  { name: "red top against teal trousers", rule: "off-match", fires: false,
    perception: outfit("classic", [P.redTee, P.cordTrousers, P.whiteSneakers]) },
  { name: "six colors, none repeating", rule: "no-color-echo", fires: true,
    perception: outfit("eclectic", [P.blueBeanie, P.printShirt, P.meshTank, P.pinkBelt, P.tealBag, P.cordShorts, P.orangeSocks, P.suedeBoots]) },
  { name: "loud but every color repeats", rule: "no-color-echo", fires: false,
    perception: outfit("eclectic", [P.redBeanie, P.stripeShirt, P.cordTrousers, P.redSocks, P.suedeBoots]) },
  // White sneakers would break the flatness on their own, which is the point of
  // the rule — it is about the whole outfit sitting in one narrow band, not
  // about being grey.
  { name: "everything at the same lightness", rule: "contrast-flat", fires: true,
    perception: outfit("minimal", [P.greyTee, P.slimTrousers, P.greySneakers]) },
  { name: "mid greys broken by a white shoe", rule: "contrast-flat", fires: false,
    perception: outfit("minimal", [P.greyTee, P.slimTrousers, P.whiteSneakers]) },

  // --- pattern and hierarchy ---------------------------------------------
  { name: "two bold patterns at once", rule: "pattern-load", fires: true,
    perception: outfit("classic", [P.printShirt, P.blackTrousers, P.trailShoes]) },
  { name: "one print against plain pieces", rule: "pattern-load", fires: false,
    perception: outfit("classic", [P.printShirt, P.blackTrousers, P.whiteSneakers]) },
  { name: "nothing quiet in a loud outfit", rule: "no-anchor", fires: true,
    perception: outfit("eclectic", [P.stripeShirt, P.cordTrousers, P.pinkBelt, P.trailShoes]) },
  { name: "loud pieces over a plain neutral base", rule: "no-anchor", fires: false,
    perception: outfit("eclectic", [P.printShirt, P.blackTrousers, P.tealBag, P.whiteSneakers]) },
  { name: "several pieces competing to lead", rule: "no-focal-point", fires: true,
    perception: outfit("eclectic", [P.printShirt, P.meshTank, P.tealBag, P.cordShorts, P.orangeSocks]) },

  // --- fabric -------------------------------------------------------------
  { name: "linen under wool", rule: "weather-split", fires: true,
    perception: outfit("classic", [P.woolCoat, P.linenShirt, P.woolTrousers, P.dressShoes]) },
  { name: "wool, corduroy and suede together", rule: "weather-split", fires: false,
    perception: outfit("classic", [P.redBeanie, P.knitSweater, P.cordTrousers, P.suedeBoots]) },
  { name: "mesh with corduroy and suede", rule: "weather-split", fires: true,
    perception: outfit("eclectic", [P.meshTank, P.cordShorts, P.suedeBoots]) },

  // --- cut ----------------------------------------------------------------
  { name: "relaxed top over relaxed bottom", rule: "double-volume", fires: true,
    perception: outfit("classic", [P.greyTee, P.wideJeans, P.whiteSneakers]) },
  { name: "fitted top over relaxed bottom", rule: "double-volume", fires: false,
    perception: outfit("classic", [P.dressShirt, P.wideJeans, P.whiteSneakers]) },
  { name: "wide-leg with a slight break", rule: "pooling-hem", fires: false,
    perception: outfit("classic", [P.navyShirt, P.wideJeans, P.whiteSneakers]) },
  { name: "wide-leg bunching heavily", rule: "pooling-hem", fires: true,
    perception: outfit("classic", [P.navyShirt, P.poolingWideJeans, P.whiteSneakers]) },
  { name: "slim trousers stacking at the shoe", rule: "pooling-hem", fires: true,
    perception: outfit("classic", [P.whiteTee, P.slimTrousers, P.whiteSneakers]) },

  // --- register -----------------------------------------------------------
  { name: "dress shoes with running shorts", rule: "formality-split", fires: true,
    perception: outfit("classic", [P.dressShirt, P.runningShorts, P.dressShoes]) },
  { name: "everything pitched the same", rule: "formality-split", fires: false,
    perception: outfit("classic", [P.navyShirt, P.blackTrousers, P.whiteSneakers]) },

  // --- shapes the engine has historically fallen silent on ----------------
  { name: "a dress on its own", rule: null, fires: null, perception: outfit("classic", [P.floralDress, P.whiteSneakers]) },
  { name: "a dress under a jacket", rule: null, fires: null, perception: outfit("eclectic", [P.floralDress, P.denimJacket, P.suedeBoots]) },
  { name: "black tie", rule: null, fires: null, perception: outfit("formal", [P.blackDress, P.dressShoes]) },
  { name: "gym kit", rule: null, fires: null, perception: outfit("sporty", [P.athleticTop, P.runningShorts, P.trailShoes, P.whiteSocks]) },
  { name: "workwear layers", rule: null, fires: null, perception: outfit("workwear", [P.camoJacket, P.blackTee, P.cargoPants, P.suedeBoots]) },
];

// Inputs that are not outfits at all. Every one of these has a plausible route
// into production — a cropped photo, a model that failed to read a colour, a
// wardrobe someone has only just started filling — and each one used to be a
// way to make the critique throw, fall silent, or say something untrue.
export const DEGENERATE = [
  { name: "no garments at all", perception: outfit("classic", []) },
  { name: "a single garment", perception: outfit("classic", [P.whiteTee]) },
  { name: "ten garments", perception: outfit("eclectic", Object.values(P).slice(0, 10)) },
  { name: "every garment read at low confidence", perception: outfit("classic", [
    { ...P.printShirt, confidence: "low" }, { ...P.wideJeans, confidence: "low" }, { ...P.trailShoes, confidence: "low" }]) },
  { name: "a photo the model could barely read", perception: outfit("classic", [P.printShirt, P.wideJeans], { photoQuality: "poor" }) },
  { name: "no hex was read off the photo", perception: outfit("classic", [
    { ...P.printShirt, colorHex: null }, { ...P.wideJeans, colorHex: null }]) },
  { name: "an unknown material", perception: outfit("classic", [
    { ...P.whiteTee, material: "unobtanium" }, { ...P.cordTrousers, material: null }]) },
  { name: "a color name outside the vocabulary", perception: outfit("classic", [
    { ...P.whiteTee, color: "chartreuse", colorHex: null }, { ...P.blackTrousers, color: "vantablack", colorHex: null }]) },
  { name: "fields the perception step never filled in", perception: outfit("classic", [
    { region: "upperbody", description: "shirt" }, { region: "lowerbody", description: "trousers" }]) },
  { name: "a register nobody defined", perception: outfit("interpretive-dance", [P.whiteTee, P.blackTrousers]) },
  { name: "nothing but accessories", perception: outfit("eclectic", [P.blueBeanie, P.pinkBelt, P.tealBag, P.orangeSocks]) },
];

// Wardrobes the fix search has to cope with. The one that broke this feature in
// production was a real wardrobe whose entire accessory category was four
// baseball caps, so "a wardrobe that cannot help" is a first-class case.
export const WARDROBES = {
  empty: [],
  onlyCaps: [
    { id: "cap-1", name: "Navy Polo Baseball Cap", part: "accessories_up", color: "#2a2f45", tags: ["cap"] },
    { id: "cap-2", name: "Black Embroidered Cap", part: "accessories_up", color: "#1e1f21", tags: ["cap"] },
  ],
  oneShirt: [{ id: "shirt-1", name: "white oxford shirt", part: "upperbody", color: "#f4f5f7", tags: ["slim", "cotton"] }],
};

/** Every scenario crossed with every register, for the rules that aren't register-gated. */
export function registerSweep() {
  const base = SCENARIOS.filter((scenario) => scenario.rule && MIRROR_RULES.find((rule) => rule.id === scenario.rule)?.registers === null);
  return base.flatMap((scenario) =>
    OUTFIT_REGISTERS.map((register) => ({
      ...scenario,
      name: `${scenario.name} — read as ${register}`,
      perception: { ...scenario.perception, register },
    })),
  );
}
