const MATCH_THRESHOLD = 52;

export const SEASONS = {
  // --- WINTER (INVERNO) ---
  "winter-cool": {
    id: "winter-cool",
    parentSeason: "winter",
    labelEn: "Cool Winter",
    labelIt: "Inverno Cool",
    altIt: "Inverno Freddo",
    sublabelEn: "Cool Undertone Dominant • High Contrast",
    sublabelIt: "Sottotono Freddo • Alto Contrasto",
    description: "Crisp, icy and high-contrast — sapphire, royal blue, optical white, emerald, and ruby.",
    accent: "#1B3F8B",
    ambientGlow: "rgba(27, 63, 139, 0.16)",
    palette: ["#C8102E", "#00693E", "#1B3F8B", "#101010", "#C6017E", "#A9D6E5", "#FFFFFF", "#2B2B2E"],
  },
  "winter-deep": {
    id: "winter-deep",
    parentSeason: "winter",
    labelEn: "Deep Winter",
    labelIt: "Inverno Deep",
    altIt: "Inverno Profondo",
    sublabelEn: "Dark Depth Dominant • High Contrast",
    sublabelIt: "Profondità Scura • Alto Contrasto",
    description: "Rich, mysterious and saturated — midnight navy, deep burgundy, pine green, and jet black.",
    accent: "#4A0E17",
    ambientGlow: "rgba(74, 14, 23, 0.16)",
    palette: ["#4A0E17", "#0C1427", "#1A1A1A", "#38184C", "#8B1E3F", "#0B3C49", "#DDE2E5", "#2C3539"],
  },
  "winter-bright": {
    id: "winter-bright",
    parentSeason: "winter",
    labelEn: "Bright Winter",
    labelIt: "Inverno Bright",
    altIt: "Inverno Brillante",
    sublabelEn: "High Chroma Dominant • Electric Contrast",
    sublabelIt: "Luminosità Brillante • Contrasto Squillante",
    description: "Vivid, energetic and luminous — electric cobalt, hot fuchsia, sharp emerald, and icy accents.",
    accent: "#0047AB",
    ambientGlow: "rgba(0, 71, 171, 0.18)",
    palette: ["#E0115F", "#0047AB", "#00A86B", "#FFFFFF", "#111111", "#7DF9FF", "#8A2BE2", "#FF007F"],
  },
  "winter-true": {
    id: "winter-true",
    parentSeason: "winter",
    labelEn: "True Winter",
    labelIt: "Inverno Assoluto",
    altIt: "Inverno Puro",
    sublabelEn: "Pure Cold, Depth & Contrast in Balance",
    sublabelIt: "Puro Freddo, Profondità e Contrasto",
    description: "The archetypal winter harmony — pure optical white, jet black, ruby red, and royal blue.",
    accent: "#1B3F8B",
    ambientGlow: "rgba(27, 63, 139, 0.16)",
    palette: ["#C8102E", "#00693E", "#1B3F8B", "#101010", "#C6017E", "#A9D6E5", "#FFFFFF", "#2B2B2E"],
  },

  // --- SUMMER (ESTATE) ---
  "summer-cool": {
    id: "summer-cool",
    parentSeason: "summer",
    labelEn: "Cool Summer",
    labelIt: "Estate Cool",
    altIt: "Estate Fredda",
    sublabelEn: "Cool Undertone Dominant • Delicate Softness",
    sublabelIt: "Sottotono Freddo • Delicata Morbidezza",
    description: "Ethereal, crystalline and gentle — wisteria, lavender, soft slate, and delicate periwinkle.",
    accent: "#7E93AC",
    ambientGlow: "rgba(126, 147, 172, 0.18)",
    palette: ["#A9C6D8", "#B7A6D9", "#D69AA6", "#7E93AC", "#9C7E93", "#8FBFAE", "#A8547A", "#B7B4B8"],
  },
  "summer-light": {
    id: "summer-light",
    parentSeason: "summer",
    labelEn: "Light Summer",
    labelIt: "Estate Light",
    altIt: "Estate Chiara",
    sublabelEn: "Light Value Dominant • Luminous Pastels",
    sublabelIt: "Valore Chiaro • Toni Pastello Luminosi",
    description: "Airy, soft and luminous — powder blue, baby pink, chalky mint, and lavender mist.",
    accent: "#9EBACF",
    ambientGlow: "rgba(158, 186, 207, 0.18)",
    palette: ["#B8D4E3", "#E3B5C7", "#C9E4DE", "#B5B9D5", "#D8E2DC", "#F0D6DE", "#8EAF9D", "#A6A2A2"],
  },
  "summer-soft": {
    id: "summer-soft",
    parentSeason: "summer",
    labelEn: "Soft Summer",
    labelIt: "Estate Soft",
    altIt: "Estate Morbida",
    sublabelEn: "Muted Chroma Dominant • Velvety Tones",
    sublabelIt: "Intensità Attenuata • Toni Fumosi e Sofisticati",
    description: "Velvety, dusty and refined — dusty mauve, smoky grey-blue, sage, and soft plum.",
    accent: "#8B7D8B",
    ambientGlow: "rgba(139, 125, 139, 0.18)",
    palette: ["#8B7D8B", "#708090", "#BC987E", "#8F9CA6", "#B49EA7", "#5B6770", "#9E8B8B", "#D1C2BA"],
  },
  "summer-true": {
    id: "summer-true",
    parentSeason: "summer",
    labelEn: "True Summer",
    labelIt: "Estate Assoluta",
    altIt: "Estate Pura",
    sublabelEn: "Pure Cool Temperature & Soft Contrast",
    sublabelIt: "Puro Freddo & Morbido Contrasto",
    description: "Calm, cool and floral — dusty rose, French blue, heather, and seafoam.",
    accent: "#7E93AC",
    ambientGlow: "rgba(126, 147, 172, 0.18)",
    palette: ["#A9C6D8", "#B7A6D9", "#D69AA6", "#7E93AC", "#9C7E93", "#8FBFAE", "#A8547A", "#B7B4B8"],
  },

  // --- AUTUMN (AUTUNNO) ---
  "autumn-warm": {
    id: "autumn-warm",
    parentSeason: "autumn",
    labelEn: "Warm Autumn",
    labelIt: "Autunno Warm",
    altIt: "Autunno Caldo",
    sublabelEn: "Warm Undertone Dominant • Earthy Richness",
    sublabelIt: "Sottotono Caldo • Ricchezza Speziata",
    description: "Golden, spiced and grounded — terracotta, mustard, burnt orange, and warm olive.",
    accent: "#B5541A",
    ambientGlow: "rgba(181, 84, 26, 0.18)",
    palette: ["#B5541A", "#6B6B2A", "#D3A02C", "#5A3A22", "#C1602A", "#3F5B39", "#C1663D", "#A9793D"],
  },
  "autumn-deep": {
    id: "autumn-deep",
    parentSeason: "autumn",
    labelEn: "Deep Autumn",
    labelIt: "Autunno Deep",
    altIt: "Autunno Profondo",
    sublabelEn: "Dark Value Dominant • Warm Depth",
    sublabelIt: "Profondità Scura • Toni Caldi e Intensi",
    description: "Deep, opulent and earthy — dark chocolate, forest green, warm espresso, and auburn.",
    accent: "#5C2C16",
    ambientGlow: "rgba(92, 44, 22, 0.18)",
    palette: ["#5C2C16", "#2D382A", "#8B3A1C", "#3B2F2F", "#A0522D", "#4A3525", "#C46210", "#6E473B"],
  },
  "autumn-soft": {
    id: "autumn-soft",
    parentSeason: "autumn",
    labelEn: "Soft Autumn",
    labelIt: "Autunno Soft",
    altIt: "Autunno Morbido",
    sublabelEn: "Muted Chroma Dominant • Gentle Warmth",
    sublabelIt: "Intensità Attenuata • Calore Morbido e Avvolgente",
    description: "Cozy, warm and understated — oatmeal, warm taupe, sage green, and soft cinnamon.",
    accent: "#9D6B53",
    ambientGlow: "rgba(157, 107, 83, 0.18)",
    palette: ["#9D6B53", "#82786B", "#BA8759", "#6B7158", "#C49A76", "#8F6B58", "#A38F78", "#D9C3B0"],
  },
  "autumn-true": {
    id: "autumn-true",
    parentSeason: "autumn",
    labelEn: "True Autumn",
    labelIt: "Autunno Assoluto",
    altIt: "Autunno Puro",
    sublabelEn: "Pure Warmth, Depth & Earthy Harmony",
    sublabelIt: "Puro Calore, Profondità & Armonia della Terra",
    description: "The classic autumn palette — rust, ochre, moss green, and mahogany.",
    accent: "#B5541A",
    ambientGlow: "rgba(181, 84, 26, 0.18)",
    palette: ["#B5541A", "#6B6B2A", "#D3A02C", "#5A3A22", "#C1602A", "#3F5B39", "#C1663D", "#A9793D"],
  },

  // --- SPRING (PRIMAVERA) ---
  "spring-warm": {
    id: "spring-warm",
    parentSeason: "spring",
    labelEn: "Warm Spring",
    labelIt: "Primavera Warm",
    altIt: "Primavera Calda",
    sublabelEn: "Warm Undertone Dominant • Golden Clarity",
    sublabelIt: "Sottotono Caldo • Luminosità Dorata",
    description: "Sunny, vibrant and radiant — peach, marigold, coral, and leafy spring green.",
    accent: "#F5B700",
    ambientGlow: "rgba(245, 183, 0, 0.18)",
    palette: ["#FF6F59", "#F5B700", "#7AC74F", "#2FC3B2", "#FFB27A", "#C68954", "#3FBAC2", "#F2542D"],
  },
  "spring-light": {
    id: "spring-light",
    parentSeason: "spring",
    labelEn: "Light Spring",
    labelIt: "Primavera Light",
    altIt: "Primavera Chiara",
    sublabelEn: "Light Value Dominant • Luminous Warmth",
    sublabelIt: "Valore Chiaro • Calore Luminoso e Vivace",
    description: "Bright, fresh and cheerful — buttercup yellow, light coral, apricot, and aqua.",
    accent: "#FFB03A",
    ambientGlow: "rgba(255, 176, 58, 0.18)",
    palette: ["#FFAA85", "#FDE047", "#86EFAC", "#67E8F9", "#FED7AA", "#F472B6", "#A7F3D0", "#FDE68A"],
  },
  "spring-bright": {
    id: "spring-bright",
    parentSeason: "spring",
    labelEn: "Bright Spring",
    labelIt: "Primavera Bright",
    altIt: "Primavera Brillante",
    sublabelEn: "High Chroma Dominant • Striking Vibrancy",
    sublabelIt: "Intensità Brillante • Contrasto Squillante",
    description: "Vivid, energetic and luminous — watermelon pink, turquoise, electric coral, and lime.",
    accent: "#FF4040",
    ambientGlow: "rgba(255, 64, 64, 0.18)",
    palette: ["#FF4040", "#00D2D3", "#10AC84", "#FFA502", "#EE5253", "#FF9FF3", "#FEEAA7", "#54A0FF"],
  },
  "spring-true": {
    id: "spring-true",
    parentSeason: "spring",
    labelEn: "True Spring",
    labelIt: "Primavera Assoluta",
    altIt: "Primavera Pura",
    sublabelEn: "Pure Warmth, Radiance & Vitality",
    sublabelIt: "Puro Calore, Radianza e Vitalità",
    description: "The classic spring palette — golden warmth, fresh peach, coral, and vibrant jade.",
    accent: "#F5B700",
    ambientGlow: "rgba(245, 183, 0, 0.18)",
    palette: ["#FF6F59", "#F5B700", "#7AC74F", "#2FC3B2", "#FFB27A", "#C68954", "#3FBAC2", "#F2542D"],
  },
};

// Dynamic labels and aliases for backward compatibility with 4-season schema
Object.keys(SEASONS).forEach((key) => {
  const item = SEASONS[key];
  Object.defineProperty(item, "label", {
    get() {
      return item.labelEn || item.labelIt;
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(item, "sublabel", {
    get() {
      return item.sublabelEn || item.sublabelIt;
    },
    enumerable: true,
    configurable: true,
  });
});

// Backward-compatible 4-season aliases
SEASONS.winter = SEASONS["winter-cool"];
SEASONS.summer = SEASONS["summer-cool"];
SEASONS.autumn = SEASONS["autumn-warm"];
SEASONS.spring = SEASONS["spring-warm"];

export function getSeasonAsset(seasonId, gender = "woman") {
  const clean = seasonId?.toLowerCase?.() || "winter-cool";
  if (clean.includes("winter")) {
    return gender === "man" ? "/seasons/winter-cool_man.jpg" : "/seasons/winter-cool_woman.jpg";
  }
  if (clean.includes("autumn")) {
    return gender === "man" ? "/seasons/autumn_man.jpg" : "/seasons/autumn.jpg";
  }
  if (clean.includes("spring")) return "/seasons/spring.jpg";
  if (clean.includes("summer")) return "/seasons/summer.jpg";
  return gender === "man" ? "/seasons/winter-cool_man.jpg" : "/seasons/winter-cool_woman.jpg";
}

/**
 * The interface is English throughout; the Italian name rides along as the
 * secondary label because that's the vocabulary the printed armocromia
 * literature uses, and people bring it with them from an in-person consult.
 */
export function getSeasonDisplayNames(seasonObj) {
  if (!seasonObj) return { primary: "My colours", secondary: "" };
  return {
    primary: seasonObj.labelEn || seasonObj.labelIt,
    secondary: seasonObj.labelIt || "",
  };
}

export function hexToRgb(hex) {
  const value = (hex || "").replace("#", "");
  return {
    red: Number.parseInt(value.slice(0, 2), 16) || 0,
    green: Number.parseInt(value.slice(2, 4), 16) || 0,
    blue: Number.parseInt(value.slice(4, 6), 16) || 0,
  };
}

export function rgbToHex(red, green, blue) {
  return `#${[red, green, blue]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function colorDistance(first, second) {
  return Math.sqrt(
    (first.red - second.red) ** 2 +
      (first.green - second.green) ** 2 +
      (first.blue - second.blue) ** 2
  );
}

export function itemMatchesPalette(item, profile) {
  if (!profile?.palette?.length) return false;
  const colors = [item.color, item.secondaryColor].filter(Boolean);
  return colors.some((hex) =>
    profile.palette.some((paletteHex) => colorDistance(hexToRgb(hex), hexToRgb(paletteHex)) <= MATCH_THRESHOLD)
  );
}
