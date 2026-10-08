import { buildOverviewIndex, normalizeOverviewText } from "./overview-index.mjs";

export const CHEAT_SHEET_LAYOUT_VERSION = 5;
export const CHEAT_SHEET_WIDTH = 1200;
export const CHEAT_SHEET_EXPORT_SCALE = 2;
export const CHEAT_SHEET_EXPORT_WIDTH = CHEAT_SHEET_WIDTH * CHEAT_SHEET_EXPORT_SCALE;
export const CHEAT_SHEET_MAX_HEIGHT = 16384;
export const CHEAT_SHEET_MIN_LOGICAL_HEIGHT = 1500;
export const CHEAT_SHEET_ITEM_MAX_WIDTH = 300;
export const CHEAT_SHEET_ITEM_MAX_HEIGHT = 420;
export const CHEAT_SHEET_MIN_PIECE_SCALE = 0.5;
export const CHEAT_SHEET_MAX_PIECE_SCALE = 1.5;
export const CHEAT_SHEET_PIECE_SCALE_STEP = 0.1;

const AREA_HEIGHT = {
  accessories: 480,
  tops: 480,
  full: 660,
  bottoms: 660,
  footwear: 480,
  other: 480,
};

const CHEAT_SHEET_GROUPS = [
  { id: "headwear", label: "Headwear", order: 0, parts: ["accessories_up"], aliases: ["hat", "hats", "cap", "caps", "beanie", "beanies", "beret", "berets", "cappello", "cappelli", "cuffia", "cuffie", "headband", "headbands"] },
  { id: "scarves", label: "Scarves & neckwear", order: 1, parts: ["accessories_up"], aliases: ["scarf", "scarves", "sciarpa", "sciarpe", "scaldacollo", "scaldacolli", "neck scarf", "neck scarves", "neck warmer", "neck warmers", "muffler", "mufflers", "foulard", "foulards", "bandana", "bandanas"] },
  { id: "coat", label: "Coats & outerwear", order: 10, parts: ["wholebody_up", "upperbody"], aliases: ["coat", "coats", "overcoat", "overcoats", "parka", "parkas", "puffer", "puffers", "puffer jacket", "down jacket", "raincoat", "raincoats", "trench coat", "trench coats", "windbreaker", "windbreakers", "cappotto", "cappotti", "giaccone", "giacconi", "piumino", "piumini", "impermeabile", "impermeabili", "giacca a vento", "giacche a vento"] },
  { id: "blazer", label: "Blazers", order: 20, parts: ["upperbody", "wholebody_up"], aliases: ["blazer", "blazers", "sport coat", "sport coats", "suit jacket", "suit jackets", "giacca elegante", "giacche eleganti", "giacca da completo", "giacche da completo"] },
  { id: "jacket", label: "Jackets", order: 21, parts: ["upperbody", "wholebody_up"], aliases: ["jacket", "jackets", "bomber", "bombers", "denim jacket", "denim jackets", "leather jacket", "leather jackets", "giacca", "giacche"] },
  { id: "sweatshirt", label: "Sweatshirts", order: 30, parts: ["upperbody", "wholebody_up"], aliases: ["sweatshirt", "sweatshirts", "hoodie", "hoodies", "felpa", "felpe", "felpa con cappuccio", "felpe con cappuccio"] },
  { id: "knitwear", label: "Knitwear", order: 40, parts: ["upperbody", "wholebody_up"], aliases: ["knitwear", "knit", "sweater", "sweaters", "jumper", "jumpers", "pullover", "pullovers", "cardigan", "cardigans", "maglione", "maglioni", "maglieria"] },
  { id: "vests", label: "Vests & waistcoats", order: 50, parts: ["upperbody", "wholebody_up"], aliases: ["vest", "vests", "waistcoat", "waistcoats", "gilet", "gilets", "smanicato", "smanicati"] },
  // Kept after vests in classifier priority so "fleece vest" stays a vest.
  { id: "fleece", label: "Fleece", order: 22, parts: ["upperbody", "wholebody_up"], aliases: ["fleece", "pile", "fleece jacket", "pile jacket", "giacca in pile"] },
  { id: "t-shirt", label: "T-shirts", order: 60, parts: ["upperbody"], aliases: ["t shirt", "t shirts", "tee shirt", "tee shirts", "tshirt", "tshirts", "tee", "tees", "polo", "polo shirt", "polo shirts", "maglietta", "magliette"] },
  { id: "shirt", label: "Shirts", order: 61, parts: ["upperbody"], aliases: ["shirt", "shirts", "button down", "button downs", "button up", "button ups", "camicia", "camicie", "camice", "blouse", "blouses"] },
  { id: "tank-top", label: "Tank tops", order: 62, parts: ["upperbody"], aliases: ["tank top", "tank tops", "tank", "tanks", "singlet", "singlets", "canotta", "canotte", "canottiera", "canottiere"] },
  { id: "fullbody", label: "Dresses & jumpsuits", order: 70, parts: ["dress", "jumpsuit"], aliases: [] },
  { id: "belts", label: "Belts", order: 80, parts: ["accessories_up"], aliases: ["belt", "belts", "cintura", "cinture"] },
  { id: "shorts", label: "Shorts", order: 91, parts: ["lowerbody", "shorts"], aliases: ["shorts", "short pant", "short pants", "pantaloncino", "pantaloncini"] },
  { id: "trousers", label: "Trousers", order: 90, parts: ["lowerbody"], aliases: ["trouser", "trousers", "pant", "pants", "jean", "jeans", "pantalone", "pantaloni"] },
  { id: "skirt", label: "Skirts", order: 92, parts: ["lowerbody", "skirt"], aliases: ["skirt", "skirts", "gonna", "gonne"] },
  { id: "socks", label: "Socks", order: 100, parts: ["socks"], aliases: ["sock", "socks", "calza", "calze"] },
  { id: "sandals", label: "Sandals", order: 110, parts: ["shoes"], aliases: ["sandal", "sandals", "sandaletto", "sandali", "ciabatta", "ciabatte"] },
  { id: "shoes", label: "Shoes", order: 111, parts: ["shoes"], aliases: ["shoe", "shoes", "sneaker", "sneakers", "boot", "boots", "scarpa", "scarpe"] },
].map((group) => ({ ...group, aliases: group.aliases.map(normalizeOverviewText) }));

const CHEAT_SHEET_GROUP_BY_ID = new Map(CHEAT_SHEET_GROUPS.map((group) => [group.id, group]));
const CHEAT_SHEET_FALLBACK_ORDER = { accessories: 120, tops: 65, full: 70, bottoms: 95, footwear: 111, other: 130 };

function hasPhrase(text, phrase) {
  return text === phrase || (` ${text} `).includes(` ${phrase} `);
}

export function normalizeCheatSheetScale(value) {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value)
    || value < CHEAT_SHEET_MIN_PIECE_SCALE || value > CHEAT_SHEET_MAX_PIECE_SCALE
    || Math.abs(value / CHEAT_SHEET_PIECE_SCALE_STEP - Math.round(value / CHEAT_SHEET_PIECE_SCALE_STEP)) > 1e-7) {
    throw new Error("Piece size must be from 50% to 150% in 10% steps");
  }
  return Math.round(value / CHEAT_SHEET_PIECE_SCALE_STEP) / 10;
}

function getPieceScale(pieceScales, itemId) {
  const value = pieceScales instanceof Map ? pieceScales.get(itemId) : pieceScales?.[itemId];
  return normalizeCheatSheetScale(value);
}

function scaledRowSizes(items, pieceScales) {
  const scales = items.map((item) => getPieceScale(pieceScales, item.id));
  if (scales.every((scale) => scale <= 1)) return balancedRowSizes(items.length);

  const sizes = [];
  let count = 0;
  let span = 0;
  let previousWidth = 0;
  for (let index = 0; index < items.length; index += 1) {
    const width = CHEAT_SHEET_ITEM_MAX_WIDTH * scales[index];
    const nextSpan = count ? span + width - 0.22 * Math.min(previousWidth, width) : width;
    if (count && (count >= 4 || nextSpan > CHEAT_SHEET_WIDTH - 144)) {
      sizes.push(count);
      count = 0;
      span = width;
    } else {
      span = nextSpan;
    }
    count += 1;
    previousWidth = width;
  }
  if (count) sizes.push(count);
  return sizes;
}

function cheatSheetGroupForEntry(entry) {
  const part = entry.item.part;
  const tags = Array.isArray(entry.item.tags) ? entry.item.tags : [];
  const text = normalizeOverviewText([entry.item.name, part, ...tags].filter(Boolean).join(" "));
  if (part === "shorts") return CHEAT_SHEET_GROUP_BY_ID.get("shorts");
  if (part === "skirt") return CHEAT_SHEET_GROUP_BY_ID.get("skirt");
  if (part === "socks") return CHEAT_SHEET_GROUP_BY_ID.get("socks");
  const vestGroup = CHEAT_SHEET_GROUP_BY_ID.get("vests");
  const fleeceGroup = CHEAT_SHEET_GROUP_BY_ID.get("fleece");
  const coatGroup = CHEAT_SHEET_GROUP_BY_ID.get("coat");
  const hasVest = vestGroup.parts.includes(part) && vestGroup.aliases.some((alias) => hasPhrase(text, alias));
  const hasCoat = coatGroup.parts.includes(part) && coatGroup.aliases.some((alias) => hasPhrase(text, alias));
  const hasFleece = fleeceGroup.parts.includes(part) && fleeceGroup.aliases.some((alias) => hasPhrase(text, alias));
  if (hasVest) return vestGroup;
  if (hasCoat) return coatGroup;
  if (hasFleece) return fleeceGroup;
  const explicitGroup = CHEAT_SHEET_GROUPS.find((group) =>
    group.parts.includes(part) && group.aliases.some((alias) => hasPhrase(text, alias)));
  if (explicitGroup) return explicitGroup;

  if (entry.area === "full") return CHEAT_SHEET_GROUP_BY_ID.get("fullbody");
  const subtypeGroup = CHEAT_SHEET_GROUP_BY_ID.get(entry.subtype.id);
  if (subtypeGroup) return subtypeGroup;
  if (part === "wholebody_up") {
    return { id: entry.subtype.id, label: entry.subtype.label, order: 25 };
  }
  return {
    id: entry.subtype.id,
    label: entry.subtype.label,
    order: CHEAT_SHEET_FALLBACK_ORDER[entry.area] ?? CHEAT_SHEET_FALLBACK_ORDER.other,
  };
}

export function balancedRowSizes(count, maxPerRow = 4) {
  if (!Number.isInteger(count) || count < 0) throw new Error("Piece count must be a non-negative integer");
  if (!count) return [];
  const rowCount = Math.ceil(count / maxPerRow);
  const small = Math.floor(count / rowCount);
  const largerRows = count % rowCount;
  return Array.from({ length: rowCount }, (_, index) => small + (index < largerRows ? 1 : 0));
}

/** Fit alpha-trimmed cutouts into a centered, lightly staggered collection. */
export function cheatSheetCollectionPositions(row, bounds) {
  if (!bounds.length) return [];
  const count = bounds.length;
  const overlap = 0.22;
  const stagger = count > 1 ? 10 : 0;
  const positions = bounds.map((bound, index) => {
    const maxWidth = CHEAT_SHEET_ITEM_MAX_WIDTH;
    const maxHeight = CHEAT_SHEET_ITEM_MAX_HEIGHT;
    const scale = Math.min(maxWidth / bound.width, maxHeight / bound.height) * normalizeCheatSheetScale(bound.scale);
    return { width: bound.width * scale, height: bound.height * scale, index };
  });
  const span = positions.reduce((width, position, index) => width + position.width
    - (index ? overlap * Math.min(positions[index - 1].width, position.width) : 0), 0);
  const tallest = Math.max(...positions.map((position) => position.height));
  const availableWidth = CHEAT_SHEET_WIDTH - 144;
  const availableHeight = Math.max(1, row.rowHeight - stagger * (count - 1));
  const fitScale = Math.min(1, availableWidth / span, availableHeight / tallest);
  positions.forEach((position) => {
    position.width *= fitScale;
    position.height *= fitScale;
  });
  let cursor = 0;
  positions.forEach((position, index) => {
    if (index) cursor -= Math.min(positions[index - 1].width, position.width) * overlap;
    position.left = cursor;
    position.top = row.topPadding + (row.rowHeight - position.height - stagger * (count - 1)) / 2 + index * stagger;
    cursor += position.width;
  });
  const left = (CHEAT_SHEET_WIDTH - cursor) / 2;
  return positions.map((position) => ({ ...position, left: position.left + left }));
}

/** Shared category grouping and row geometry for the live renderer and server checks. */
export function buildCheatSheetLayout(items, titleLines = 1, pieceScales = null) {
  const index = buildOverviewIndex(items || []);
  const grouped = new Map();
  for (const entry of index) {
    const subtype = cheatSheetGroupForEntry(entry);
    const key = `${entry.area}:${subtype.id}`;
    let group = grouped.get(key);
    if (!group) {
      group = { id: key, area: entry.area, subtypeId: subtype.id, label: subtype.label, sortOrder: subtype.order, items: [] };
      grouped.set(key, group);
    }
    group.items.push(entry.item);
  }
  const groups = [...grouped.values()].sort((a, b) =>
    a.sortOrder - b.sortOrder
    || a.label.localeCompare(b.label, "en")
    || a.id.localeCompare(b.id, "en"));

  const rows = [];
  for (const group of groups) {
    const sizes = scaledRowSizes(group.items, pieceScales);
    let offset = 0;
    for (let rowIndex = 0; rowIndex < sizes.length; rowIndex += 1) {
      const count = sizes[rowIndex];
      const rowItems = group.items.slice(offset, offset + count);
      const largestScale = Math.max(...rowItems.map((item) => getPieceScale(pieceScales, item.id)));
      const requiredHeight = Math.ceil(CHEAT_SHEET_ITEM_MAX_HEIGHT * largestScale + (count > 1 ? (count - 1) * 10 : 0));
      rows.push({
        id: `${group.id}:${rowIndex}`,
        groupId: group.id,
        groupLabel: group.label,
        area: group.area,
        itemIds: rowItems.map((item) => item.id),
        rowHeight: Math.max(AREA_HEIGHT[group.area] || AREA_HEIGHT.other, requiredHeight),
        // The title fascia already carries the 56px gap after the heading.
        topPadding: rowIndex === 0 ? (rows.length ? 64 : 0) : 28,
        columns: count,
      });
      offset += count;
    }
  }

  const titleHeight = 92 + Math.max(1, Math.min(3, Number(titleLines) || 1)) * 52 * 1.12 + 56;
  const contentHeight = titleHeight + rows.reduce((height, row) => height + row.topPadding + row.rowHeight, 0);
  return {
    version: CHEAT_SHEET_LAYOUT_VERSION,
    width: CHEAT_SHEET_WIDTH,
    exportWidth: CHEAT_SHEET_EXPORT_WIDTH,
    maxExportHeight: CHEAT_SHEET_MAX_HEIGHT,
    titleLines: Math.max(1, Math.min(3, Number(titleLines) || 1)),
    titleFontSize: 52,
    titleTopPadding: 92,
    titleBottomPadding: 56,
    titleLineHeight: 1.12,
    margin: 72,
    itemGap: 24,
    minLogicalHeight: CHEAT_SHEET_MIN_LOGICAL_HEIGHT,
    bottomPadding: Math.max(0, CHEAT_SHEET_MIN_LOGICAL_HEIGHT - contentHeight),
    groups,
    rows,
    estimatedLogicalHeight: Math.max(CHEAT_SHEET_MIN_LOGICAL_HEIGHT, contentHeight),
  };
}

/** Wrap without ellipses; long unbroken words are split only when needed. */
export function wrapCheatSheetTitle(title, measureText, maxWidth, maxLines = 3) {
  const words = String(title || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let line = "";
  const pushWord = (word) => {
    let rest = word;
    while (rest && measureText(rest) > maxWidth) {
      let cut = 1;
      while (cut < rest.length && measureText(rest.slice(0, cut + 1)) <= maxWidth) cut += 1;
      if (cut >= rest.length) break;
      if (line) { lines.push(line); line = ""; }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return rest;
  };
  for (const rawWord of words) {
    const word = pushWord(rawWord);
    const candidate = line ? `${line} ${word}` : word;
    if (line && measureText(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function titleLayout(title, measureText, maxWidth, initialSize = 52) {
  for (let fontSize = initialSize; fontSize >= 8; fontSize -= 2) {
    const lines = wrapCheatSheetTitle(title, (text) => measureText(text, fontSize), maxWidth, 3);
    if (lines.length <= 3 && lines.every((line) => measureText(line, fontSize) <= maxWidth)) {
      return { lines, fontSize, lineHeight: fontSize * 1.12 };
    }
  }
  const fontSize = 8;
  const lines = wrapCheatSheetTitle(title, (text) => measureText(text, fontSize), maxWidth, 3);
  return { lines, fontSize, lineHeight: fontSize * 1.12 };
}
