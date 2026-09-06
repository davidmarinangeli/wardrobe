/**
 * Digital draping — geometry and fabric sets.
 *
 * The drape is drawn as a single SVG path over a cut-out portrait on a neutral
 * grey ground. Both the server (when rasterising composites for the vision
 * model) and the browser (when swapping colours interactively) build the same
 * shape from this module, so what the user judges is what the AI judges.
 */

/**
 * Builds the drape outline: a wide sweep of fabric that rises beside the face
 * and scoops down across the neck, so the subject's own clothing is covered
 * but the throat and jaw stay readable.
 *
 * `neck` comes from detectNeck() — { y, left, right } as fractions of the frame.
 */
export function buildDrapePath(width, height, neck) {
  const yEdge = Math.round(height * (neck.y - 0.15));
  const yHigh = Math.round(height * (neck.y - 0.015));
  const yLow = Math.round(height * (neck.y + 0.062));

  const xLeft = width * Math.max(0.24, neck.left - 0.02);
  const xRight = width * Math.min(0.76, neck.right + 0.02);
  const innerLeft = xLeft + (width * 0.5 - xLeft) * 0.55;
  const innerRight = xRight - (xRight - width * 0.5) * 0.55;

  return [
    `M 0,${yEdge}`,
    `C ${width * 0.16},${yEdge - 8} ${xLeft - width * 0.06},${yHigh - 14} ${xLeft},${yHigh}`,
    `C ${xLeft + (innerLeft - xLeft) * 0.5},${yHigh + 6} ${innerLeft - 12},${yLow} ${innerLeft},${yLow}`,
    `L ${innerRight},${yLow}`,
    `C ${innerRight + 12},${yLow} ${xRight - (xRight - innerRight) * 0.5},${yHigh + 6} ${xRight},${yHigh}`,
    `C ${xRight + width * 0.06},${yHigh - 14} ${width * 0.84},${yEdge - 8} ${width},${yEdge}`,
    `L ${width},${height} L 0,${height} Z`,
  ].join(" ");
}

/** Neutral grey surround — constant across every drape so only the fabric varies. */
export const DRAPE_GROUND = "#8f8f8f";

/** Shared <defs> for the fabric shading, so server and browser render alike. */
export function drapeDefs(idPrefix = "d") {
  return `
    <linearGradient id="${idPrefix}-sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="26%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.30"/>
    </linearGradient>
    <linearGradient id="${idPrefix}-fold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.22"/>
      <stop offset="22%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="78%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.22"/>
    </linearGradient>
    <filter id="${idPrefix}-lift" x="-10%" y="-30%" width="120%" height="160%">
      <feDropShadow dx="0" dy="-7" stdDeviation="9" flood-color="#000000" flood-opacity="0.32"/>
    </filter>`;
}

/**
 * The drape sets a user can run.
 *
 * Every candidate carries `fabrics` — the solid gabardine colours the panel
 * steps through — and `palette`, the wider family shown as reference swatches.
 * `seasonId` is the season a candidate resolves to; temperature candidates have
 * none, because "warm" is a finding, not a season, so they carry `narrowsTo`
 * instead and hand the user on to the next test.
 */
export const DRAPE_SETS = {
  sisterDeep: {
    id: "sisterDeep",
    title: "Deep Autumn vs Cool Winter",
    question: "Which one clears the shadows under your eyes?",
    hint: "Both are dark seasons. The one that's wrong will grey your skin and deepen the circles under your eyes.",
    candidates: [
      {
        id: "autumn-deep",
        seasonId: "autumn-deep",
        name: "Deep Autumn",
        subtitle: "Warm · Deep",
        type: "warm",
        accent: "#5C2C16",
        fabrics: ["#5C2C16", "#2D4C3A", "#7B241C"],
        fabricNames: ["Chocolate", "Warm Forest", "Brick Red"],
        palette: ["#5C2C16", "#2D4C3A", "#7B241C", "#9A3324", "#3D2314", "#8A5A2B", "#B85D19"],
      },
      {
        id: "winter-cool",
        seasonId: "winter-cool",
        name: "Cool Winter",
        subtitle: "Cool · Deep",
        type: "cool",
        accent: "#1B3F8B",
        fabrics: ["#1B3F8B", "#C8102E", "#101010"],
        fabricNames: ["Royal Blue", "Ruby Red", "True Black"],
        palette: ["#C8102E", "#00693E", "#1B3F8B", "#101010", "#C6017E", "#A9D6E5", "#FFFFFF"],
      },
    ],
  },

  sisterSoft: {
    id: "sisterSoft",
    title: "Soft Summer vs Soft Autumn",
    question: "Which one looks less dusty on you?",
    hint: "Both are muted seasons. Watch the mouth and cheeks — the wrong one flattens their natural colour.",
    candidates: [
      {
        id: "summer-soft",
        seasonId: "summer-soft",
        name: "Soft Summer",
        subtitle: "Cool · Muted",
        type: "cool",
        accent: "#8B7B8B",
        fabrics: ["#8B7B8B", "#93A8AC", "#76877D"],
        fabricNames: ["Cool Taupe", "Dusty Blue", "Cool Sage"],
        palette: ["#8B7B8B", "#93A8AC", "#C2B0B7", "#76877D", "#5B6C5D", "#A39BA8", "#D9CED6"],
      },
      {
        id: "autumn-soft",
        seasonId: "autumn-soft",
        name: "Soft Autumn",
        subtitle: "Warm · Muted",
        type: "warm",
        accent: "#8F6B4F",
        fabrics: ["#8F6B4F", "#7A7C4F", "#B58A63"],
        fabricNames: ["Warm Camel", "Soft Olive", "Muted Amber"],
        palette: ["#8F6B4F", "#7A7C4F", "#B58A63", "#4F3C2C", "#9A7E56", "#735D43", "#606B56"],
      },
    ],
  },

  temperature: {
    id: "temperature",
    title: "Warm or cool?",
    question: "Which side makes your skin look alive rather than sallow?",
    hint: "This one finding splits the twelve seasons in half. Gold against silver is the fastest way to read it.",
    candidates: [
      {
        id: "warm",
        seasonId: null,
        narrowsTo: "warm",
        name: "Warm",
        subtitle: "Gold · Terracotta · Olive",
        type: "warm",
        accent: "#D4AF37",
        fabrics: ["#D4AF37", "#A04020", "#556B2F"],
        fabricNames: ["Gold", "Terracotta", "Olive"],
        palette: ["#D4AF37", "#C85020", "#A04020", "#D4A017", "#556B2F", "#C19A6B", "#8B4513"],
      },
      {
        id: "cool",
        seasonId: null,
        narrowsTo: "cool",
        name: "Cool",
        subtitle: "Silver · Fuchsia · Emerald",
        type: "cool",
        accent: "#8E9BA6",
        fabrics: ["#C0C0C0", "#C71585", "#008055"],
        fabricNames: ["Silver", "Fuchsia", "Emerald"],
        palette: ["#C0C0C0", "#C71585", "#1E3F8A", "#008055", "#FFFFFF", "#111111", "#4B0082"],
      },
    ],
  },

  macro: {
    id: "macro",
    title: "The four seasons",
    question: "Which one lets your face come forward?",
    hint: "The right family lifts your features. The wrong one makes the fabric the loudest thing in the frame.",
    candidates: [
      {
        id: "winter",
        seasonId: "winter-true",
        name: "Winter",
        subtitle: "Cool · Deep · Bright",
        type: "cool",
        accent: "#1B3F8B",
        fabrics: ["#1B3F8B", "#C8102E", "#111111"],
        fabricNames: ["Sapphire", "Ruby", "Jet Black"],
        palette: ["#111111", "#FFFFFF", "#1B3F8B", "#00693E", "#C8102E", "#C6017E", "#2B2B2E"],
      },
      {
        id: "autumn",
        seasonId: "autumn-true",
        name: "Autumn",
        subtitle: "Warm · Deep · Muted",
        type: "warm",
        accent: "#9A3324",
        fabrics: ["#9A3324", "#2D4C3A", "#C99324"],
        fabricNames: ["Terracotta", "Forest", "Ochre"],
        palette: ["#3D2314", "#9A3324", "#2D4C3A", "#B85D19", "#8A5A2B", "#C99324", "#5C2C16"],
      },
      {
        id: "summer",
        seasonId: "summer-true",
        name: "Summer",
        subtitle: "Cool · Light · Muted",
        type: "cool",
        accent: "#7E93AC",
        fabrics: ["#7E93AC", "#D69AA6", "#8FBFAE"],
        fabricNames: ["Denim Blue", "Dusty Rose", "Sage"],
        palette: ["#D69AA6", "#A9C6D8", "#B7A6D9", "#7E93AC", "#8FBFAE", "#C0D6DF", "#B7B4B8"],
      },
      {
        id: "spring",
        seasonId: "spring-true",
        name: "Spring",
        subtitle: "Warm · Light · Bright",
        type: "warm",
        accent: "#FF6F59",
        fabrics: ["#FF6F59", "#F5B700", "#2FC3B2"],
        fabricNames: ["Coral", "Daffodil", "Turquoise"],
        palette: ["#FF6F59", "#F5B700", "#7AC74F", "#2FC3B2", "#FFFDD0", "#FF7F50", "#F2542D"],
      },
    ],
  },
};

/** Every candidate across every set, keyed by `${setId}:${candidateId}`. */
export function findCandidate(setId, candidateId) {
  return DRAPE_SETS[setId]?.candidates.find((c) => c.id === candidateId) || null;
}
