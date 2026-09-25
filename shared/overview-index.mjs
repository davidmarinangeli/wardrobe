const AREA_ORDER = ["accessories", "tops", "full", "bottoms", "footwear", "other"];
const AREA_DETAILS = {
  accessories: { id: "accessories", label: "Accessories", parts: new Set(["accessories_up"]) },
  tops: { id: "tops", label: "Tops & outerwear", parts: new Set(["upperbody", "wholebody_up", "bodysuit"]) },
  full: { id: "full", label: "Dresses & jumpsuits", parts: new Set(["dress", "jumpsuit"]) },
  bottoms: { id: "bottoms", label: "Bottoms", parts: new Set(["lowerbody", "shorts", "skirt"]) },
  footwear: { id: "footwear", label: "Shoes & socks", parts: new Set(["shoes", "socks"]) },
  other: { id: "other", label: "Other", parts: new Set() },
};

const PART_LABELS = {
  upperbody: "Top", wholebody_up: "Outerwear", bodysuit: "Bodysuit", dress: "Dress",
  jumpsuit: "Jumpsuit", lowerbody: "Bottom", shorts: "Shorts", skirt: "Skirt",
  accessories_up: "Accessory", shoes: "Shoes", socks: "Socks",
};

const SUBTYPES = {
  "t shirt": { id: "t-shirt", label: "T-shirts", aliases: ["t shirt", "tee shirt", "tee", "tshirt"] },
  shirt: { id: "shirt", label: "Shirts", aliases: ["shirt", "button down", "button up", "camicia", "camicie"] },
  polo: { id: "polo", label: "Polos", aliases: ["polo", "polo shirt", "polo shirts"] },
  knitwear: { id: "knitwear", label: "Knitwear", aliases: ["knitwear", "knit", "sweater", "jumper", "maglieria", "maglione"] },
  sweatshirt: { id: "sweatshirt", label: "Sweatshirts", aliases: ["sweatshirt", "hoodie", "felpa", "felpe"] },
  blazer: { id: "blazer", label: "Blazers", aliases: ["blazer", "blazers", "giacca elegante"] },
  coat: { id: "coat", label: "Coats", aliases: ["coat", "overcoat", "cappotto", "cappotti"] },
  jacket: { id: "jacket", label: "Jackets", aliases: ["jacket", "giacca", "giacche"] },
  trousers: { id: "trousers", label: "Trousers", aliases: ["trouser", "trousers", "pants", "pantaloni"] },
  jeans: { id: "jeans", label: "Jeans", aliases: ["jean", "jeans"] },
  shorts: { id: "shorts", label: "Shorts", aliases: ["shorts", "pantaloncini"] },
  headwear: { id: "headwear", label: "Headwear", aliases: ["hat", "cap", "beanie", "beret", "cappello", "cappelli"] },
  shoes: { id: "shoes", label: "Shoes", aliases: ["shoe", "shoes", "scarpe"] },
  socks: { id: "socks", label: "Socks", aliases: ["sock", "socks", "calze"] },
  dress: { id: "dress", label: "Dresses", aliases: ["dress", "dresses", "abito", "abiti", "vestito", "vestiti"] },
  jumpsuit: { id: "jumpsuit", label: "Jumpsuits", aliases: ["jumpsuit", "romper", "tuta"] },
  skirt: { id: "skirt", label: "Skirts", aliases: ["skirt", "skirts", "gonna", "gonne"] },
  bodysuit: { id: "bodysuit", label: "Bodysuits", aliases: ["bodysuit", "body"] },
};

const FEATURE_GROUPS = [
  { kind: "color", value: "white", label: "white", aliases: ["white", "bianco", "bianca", "bianchi", "bianche"] },
  { kind: "color", value: "black", label: "black", aliases: ["black", "nero", "nera", "neri", "nere"] },
  { kind: "color", value: "blue", label: "blue", aliases: ["blue", "blu", "azzurro", "azzurra", "azzurri", "azzurre", "navy", "celeste"] },
  { kind: "color", value: "red", label: "red", aliases: ["red", "rosso", "rossa", "rossi", "rosse", "bordeaux"] },
  { kind: "color", value: "green", label: "green", aliases: ["green", "verde", "verdi", "olive", "oliva"] },
  { kind: "color", value: "brown", label: "brown", aliases: ["brown", "marrone", "marroni", "tan", "beige", "khaki", "kaki"] },
  { kind: "color", value: "gray", label: "gray", aliases: ["gray", "grey", "grigio", "grigia", "grigi", "grigie", "charcoal", "stone"] },
  { kind: "color", value: "pink", label: "pink", aliases: ["pink", "rosa", "fuchsia", "fucsia"] },
  { kind: "color", value: "purple", label: "purple", aliases: ["purple", "viola", "violet", "lilac", "lilla"] },
  { kind: "color", value: "yellow", label: "yellow", aliases: ["yellow", "giallo", "gialla", "gialli", "gialle", "mustard"] },
  { kind: "color", value: "orange", label: "orange", aliases: ["orange", "arancione", "arancioni"] },
  { kind: "color", value: "multicolor", label: "multicolor", aliases: ["multicolor", "multicolore", "multicolori"] },
  { kind: "material", value: "linen", label: "linen", aliases: ["linen", "lino"] },
  { kind: "material", value: "cotton", label: "cotton", aliases: ["cotton", "cotone"] },
  { kind: "material", value: "wool", label: "wool", aliases: ["wool", "lana", "woolen", "woollen"] },
  { kind: "material", value: "silk", label: "silk", aliases: ["silk", "seta"] },
  { kind: "material", value: "leather", label: "leather", aliases: ["leather", "pelle", "suede", "scamosciato"] },
  { kind: "material", value: "denim", label: "denim", aliases: ["denim", "jeans fabric"] },
  { kind: "material", value: "fleece", label: "fleece", aliases: ["fleece", "pile"] },
  { kind: "pattern", value: "striped", label: "striped", aliases: ["striped", "stripe", "stripes", "a righe", "rigato", "righe"] },
  { kind: "pattern", value: "floral", label: "floral", aliases: ["floral", "flower print", "floreale", "a fiori"] },
  { kind: "pattern", value: "checked", label: "checked", aliases: ["checked", "checkered", "plaid", "a quadri", "quadrettato"] },
  { kind: "pattern", value: "graphic", label: "graphic", aliases: ["graphic", "print", "printed", "stampa", "stampato"] },
  { kind: "use", value: "formal", label: "formal", aliases: ["formal", "elegant", "elegante", "eleganti", "dressy", "cerimonia"] },
  { kind: "use", value: "rain", label: "rain", aliases: ["rain", "rainwear", "for the rain", "per la pioggia", "impermeabile", "waterproof", "water resistant"] },
  { kind: "use", value: "casual", label: "casual", aliases: ["casual", "everyday", "quotidiano", "quotidiana", "informal"] },
  { kind: "use", value: "sport", label: "sport", aliases: ["sport", "sportswear", "activewear", "sportivo", "sportiva", "training"] },
];

const COLOR_GROUPS = FEATURE_GROUPS.filter((group) => group.kind === "color");
const SINGULAR_WORDS = new Map(Object.entries({
  shirts: "shirt", dresses: "dress", jackets: "jacket", coats: "coat", blazers: "blazer",
  sweaters: "sweater", hoodies: "hoodie", sweatshirts: "sweatshirt", trousers: "trouser",
  pants: "pant", shoes: "shoe", socks: "sock", hats: "hat", caps: "cap", skirts: "skirt",
  tshirts: "tshirt", "t-shirts": "t shirt", "t-shirt": "t shirt", "polo-shirts": "polo shirt",
  camicie: "camicia", bianchi: "bianco", bianche: "bianco", bianca: "bianco",
  neri: "nero", nere: "nero", nera: "nero", rossi: "rosso", rosse: "rosso", rossa: "rosso",
  azzurri: "azzurro", azzurre: "azzurro", azzurra: "azzurro", gialli: "giallo", gialle: "giallo", gialla: "giallo",
}));
const ALL_ALIASES = [...Object.values(SUBTYPES).flatMap((subtype) => subtype.aliases.map((alias) => ({ text: alias, kind: "subtype", value: subtype.id }))), ...FEATURE_GROUPS.flatMap((group) => group.aliases.map((alias) => ({ text: alias, kind: group.kind, value: group.value })))];
const ALIAS_LOOKUP = new Map(ALL_ALIASES.map((entry) => [normalizeOverviewText(entry.text), entry]));
const ALIASES_BY_GROUP = new Map();
for (const entry of ALL_ALIASES) {
  const key = `${entry.kind}:${entry.value}`;
  ALIASES_BY_GROUP.set(key, [...(ALIASES_BY_GROUP.get(key) || []), normalizeOverviewText(entry.text)]);
}

export function normalizeOverviewText(value) {
  const normalized = String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[’'`]/g, " ")
    .replace(/[-‐‑‒–—_/]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/g, " ");
  return normalized.split(" ").map((token) => SINGULAR_WORDS.get(token) || token).join(" ");
}

function hasPhrase(text, phrase) {
  if (!text || !phrase) return false;
  return (` ${text} `).includes(` ${phrase} `);
}

function allText(item) {
  return normalizeOverviewText([
    item.name,
    item.part,
    PART_LABELS[item.part],
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].filter(Boolean).join(" "))
    // A product description such as "linen-look" names an appearance, not a
    // declared material. Keep it searchable as free text without indexing linen.
    .replace(/\blinen\s+look\b/g, "linenlook");
}

function colorFamily(value) {
  const hex = typeof value === "string" && value.match(/^#?([0-9a-f]{6})$/i)?.[1];
  if (!hex) return null;
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
  const light = (max + min) / 2;
  if (light > 0.91 && delta < 0.11) return "white";
  if (light < 0.17) return "black";
  if (delta < 0.12) return "gray";
  const hue = max === red ? ((green - blue) / delta + (green < blue ? 6 : 0)) * 60
    : max === green ? ((blue - red) / delta + 2) * 60
      : ((red - green) / delta + 4) * 60;
  // Brown, tan, beige, and khaki occupy the orange-yellow hue range. Their
  // lower brightness or muted chroma separates them from saturated orange
  // and yellow garments.
  if (hue >= 15 && hue < 55 && (light < 0.44 || (delta < 0.3 && light < 0.82))) return "brown";
  if (hue < 15 || hue >= 345) return light < 0.35 ? "brown" : "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 165) return "green";
  if (hue < 255) return "blue";
  if (hue < 300) return "purple";
  if (hue < 345) return "pink";
  return "red";
}

function candidates(text, group) {
  return group.aliases.some((alias) => hasPhrase(text, normalizeOverviewText(alias)));
}

function classifySubtype(item, text) {
  const ids = [];
  const match = (id) => Object.values(SUBTYPES).find((subtype) => subtype.id === id);
  for (const subtype of Object.values(SUBTYPES)) {
    if (subtype.aliases.some((alias) => hasPhrase(text, normalizeOverviewText(alias)))) ids.push(subtype.id);
  }
  const withoutSpecificShirtPhrases = text.replace(/\b(?:t|polo|tee)\s+shirt\b/g, " ");
  const hasStandaloneShirt = hasPhrase(withoutSpecificShirtPhrases, "shirt");
  const hasShirtAlias = hasStandaloneShirt || SUBTYPES.shirt.aliases
    .filter((alias) => !["shirt", "t shirt", "tee shirt", "polo shirt", "polo shirts"].includes(normalizeOverviewText(alias)))
    .some((alias) => hasPhrase(withoutSpecificShirtPhrases, normalizeOverviewText(alias)));
  const unique = [...new Set(ids)];
  const specificMatches = unique.filter((id) => id !== "shirt" || hasShirtAlias);
  if (specificMatches.length === 1) return { id: specificMatches[0], label: match(specificMatches[0]).label, specific: true };
  if (specificMatches.length > 1) {
    // Jeans are a kind of trousers and shorts can also be stored as lowerbody;
    // the narrower declared subtype wins. Unrelated specific labels conflict.
    if (specificMatches.includes("jeans") && specificMatches.every((id) => id === "jeans" || id === "trousers")) {
      return { id: "jeans", label: SUBTYPES.jeans.label, specific: true };
    }
    if (specificMatches.includes("shorts") && specificMatches.every((id) => id === "shorts" || id === "trousers")) {
      return { id: "shorts", label: SUBTYPES.shorts.label, specific: true };
    }
    if (specificMatches.includes("blazer") && specificMatches.every((id) => id === "blazer" || id === "jacket")) {
      return { id: "blazer", label: SUBTYPES.blazer.label, specific: true };
    }
  }
  const partSubtype = ({
    upperbody: "Top", wholebody_up: "Outerwear", bodysuit: "Bodysuits", dress: "Dresses",
    jumpsuit: "Jumpsuits", lowerbody: "Bottoms", shorts: "Shorts", skirt: "Skirts",
    accessories_up: "Accessories", shoes: "Shoes", socks: "Socks",
  })[item.part];
  return { id: `part:${item.part}`, label: partSubtype || "Other", specific: false };
}

function getArea(item) {
  return AREA_ORDER.slice(0, -1).find((id) => AREA_DETAILS[id].parts.has(item.part)) || "other";
}

function buildFeatures(item, text, subtype) {
  const features = [];
  if (subtype.specific) features.push({ kind: "subtype", value: subtype.id, label: subtype.label.toLocaleLowerCase("en") });

  const colorValues = new Set([colorFamily(item.color), colorFamily(item.secondaryColor)].filter(Boolean));
  for (const group of COLOR_GROUPS) if (candidates(text, group)) colorValues.add(group.value);
  for (const value of colorValues) features.push({ kind: "color", value, label: COLOR_GROUPS.find((group) => group.value === value)?.label || value });

  for (const group of FEATURE_GROUPS.filter((entry) => entry.kind !== "color")) {
    if (candidates(text, group)) features.push({ kind: group.kind, value: group.value, label: group.label });
  }
  return features;
}

function parseQuery(query) {
  const normalized = normalizeOverviewText(query);
  if (!normalized) return [];
  const tokens = normalized.split(" ");
  const groups = [];
  for (let index = 0; index < tokens.length;) {
    if (tokens[index] === "linen" && tokens[index + 1] === "look") {
      groups.push({ alternatives: ["linenlook"] });
      index += 2;
      continue;
    }
    let found = null;
    for (let end = tokens.length; end > index; end -= 1) {
      const alias = tokens.slice(index, end).join(" ");
      const mapped = ALIAS_LOOKUP.get(alias);
      if (mapped) { found = { mapped, end }; break; }
    }
    if (found) {
      const key = `${found.mapped.kind}:${found.mapped.value}`;
      groups.push({
        alternatives: ALIASES_BY_GROUP.get(key) || [tokens.slice(index, found.end).join(" ")],
        standaloneSubtype: found.mapped.kind === "subtype" && found.mapped.value === "shirt",
      });
      index = found.end;
    } else {
      const token = tokens[index];
      groups.push({ alternatives: [token] });
      index += 1;
    }
  }
  return groups;
}

function matchesQuery(entry, queryGroups) {
  return queryGroups.every(({ alternatives, standaloneSubtype }) => {
    const text = standaloneSubtype ? entry.typeSearchText : entry.searchText;
    return alternatives.some((term) => hasPhrase(text, term));
  });
}

function matchesFacet(entry, facet) {
  if (!facet) return true;
  if (facet.area && entry.area !== facet.area) return false;
  if (facet.subtype && entry.subtype.id !== facet.subtype) return false;
  return !facet.featureKind || entry.features.some((feature) => feature.kind === facet.featureKind && feature.value === facet.featureValue);
}

/** Build an immutable, local-only index over item records. Variants are never expanded. */
export function buildOverviewIndex(items = []) {
  return items.map((item) => {
    const searchText = allText(item);
    const subtype = classifySubtype(item, searchText);
    const features = buildFeatures(item, searchText, subtype);
    const subtypeAliases = subtype.specific
      ? Object.values(SUBTYPES).find((candidate) => candidate.id === subtype.id)?.aliases || []
      : [];
    const featureAliases = features.flatMap((feature) => feature.kind === "subtype"
      ? subtypeAliases
      : ALIASES_BY_GROUP.get(`${feature.kind}:${feature.value}`) || [feature.label]);
    return {
      id: item.id,
      item,
      area: getArea(item),
      subtype,
      features,
      searchText: normalizeOverviewText(`${searchText} ${subtypeAliases.join(" ")} ${featureAliases.join(" ")}`),
      typeSearchText: normalizeOverviewText(`${searchText} ${subtypeAliases.join(" ")} ${featureAliases.join(" ")}`)
        .replace(/\b(?:t|tee|polo)\s+shirt\b/g, " ").replace(/\s+/g, " ").trim(),
    };
  });
}

export function filterOverviewIndex(index, query = "", facet = null) {
  const queryGroups = parseQuery(query);
  return index.filter((entry) => matchesQuery(entry, queryGroups) && matchesFacet(entry, facet));
}

function compareEntries(first, second) {
  if (first.area === "accessories" && (first.subtype.id === "headwear") !== (second.subtype.id === "headwear")) {
    return first.subtype.id === "headwear" ? -1 : 1;
  }
  const firstSubtype = normalizeOverviewText(first.subtype.label);
  const secondSubtype = normalizeOverviewText(second.subtype.label);
  return firstSubtype.localeCompare(secondSubtype, "en")
    || normalizeOverviewText(first.item.name).localeCompare(normalizeOverviewText(second.item.name), "en")
    || String(first.id).localeCompare(String(second.id), "en");
}

export function buildOverviewSections(index, query = "", facet = null) {
  const filtered = filterOverviewIndex(index, query, facet);
  return AREA_ORDER.map((areaId) => {
    const entries = filtered.filter((entry) => entry.area === areaId).sort(compareEntries);
    if (!entries.length) return null;
    const candidatesBySet = new Map();
    const buckets = new Map();
    for (const entry of entries) {
      if (!entry.subtype.specific) continue;
      const subtypeLabel = entry.subtype.label.toLocaleLowerCase("en");
      const subtypeBucketKey = `subtype:${entry.subtype.id}`;
      const subtypeBucket = buckets.get(subtypeBucketKey) || { subtype: entry.subtype.id, subtypeLabel, label: subtypeLabel, ids: new Set() };
      subtypeBucket.ids.add(entry.id);
      buckets.set(subtypeBucketKey, subtypeBucket);
      for (const feature of entry.features.filter((candidate) => candidate.kind !== "subtype")) {
        const key = `${entry.subtype.id}:${feature.kind}:${feature.value}`;
        const current = buckets.get(key) || { subtype: entry.subtype.id, subtypeLabel, featureKind: feature.kind, featureValue: feature.value, featureLabel: feature.label, label: `${feature.label} ${subtypeLabel}`, ids: new Set() };
        current.ids.add(entry.id);
        buckets.set(key, current);
      }
    }
    for (const candidate of buckets.values()) {
      if (candidate.ids.size < 3) continue;
      const ids = [...candidate.ids].sort();
      const setKey = ids.join("\u0000");
      const descriptionRank = candidate.featureKind ? 2 : 1;
      const current = candidatesBySet.get(setKey);
      if (!current || descriptionRank > current.descriptionRank) candidatesBySet.set(setKey, { ...candidate, ids, descriptionRank });
    }
    const evidence = [...candidatesBySet.values()]
      .sort((first, second) => second.ids.length - first.ids.length || first.label.localeCompare(second.label, "en"))
      .slice(0, 3)
      .map(({ descriptionRank: _rank, ...candidate }) => ({
        area: areaId,
        subtype: candidate.subtype,
        featureKind: candidate.featureKind || null,
        featureValue: candidate.featureValue || null,
        label: candidate.label,
        count: candidate.ids.length,
        itemIds: candidate.ids,
      }));
    return { ...AREA_DETAILS[areaId], entries, count: entries.length, evidence };
  }).filter(Boolean);
}

export function overviewItemMatchesEvidence(indexEntry, evidence) {
  return matchesFacet(indexEntry, evidence);
}

export function overviewSuggestions(items = []) {
  const counts = new Map();
  for (const item of items) {
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      if (typeof tag !== "string" || !tag.trim()) continue;
      const key = tag.trim().toLocaleLowerCase("en");
      const previous = counts.get(key);
      counts.set(key, previous ? { ...previous, count: previous.count + 1 } : { tag: tag.trim(), count: 1 });
    }
  }
  return [...counts.values()].sort((first, second) => second.count - first.count || first.tag.localeCompare(second.tag, "en"));
}

export function commonOverviewTags(indexedItems) {
  const counts = new Map();
  for (const entry of indexedItems) {
    const seen = new Set();
    for (const tag of Array.isArray(entry.item.tags) ? entry.item.tags : []) {
      const key = typeof tag === "string" ? tag.trim().toLocaleLowerCase("en") : "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const current = counts.get(key);
      counts.set(key, current ? { ...current, count: current.count + 1 } : { tag: tag.trim(), key, count: 1 });
    }
  }
  return [...counts.values()]
    .filter(({ count }) => count === indexedItems.length)
    .sort((first, second) => first.tag.localeCompare(second.tag, "en"));
}
