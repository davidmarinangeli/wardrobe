import { buildOverviewIndex } from "./overview-index.mjs";

export const CHEAT_SHEET_LAYOUT_VERSION = 2;
export const CHEAT_SHEET_WIDTH = 1200;
export const CHEAT_SHEET_EXPORT_SCALE = 2;
export const CHEAT_SHEET_EXPORT_WIDTH = CHEAT_SHEET_WIDTH * CHEAT_SHEET_EXPORT_SCALE;
export const CHEAT_SHEET_MAX_HEIGHT = 16384;
export const CHEAT_SHEET_MIN_LOGICAL_HEIGHT = 1500;

const AREA_ORDER = ["accessories", "tops", "full", "bottoms", "footwear", "other"];
const AREA_RANK = new Map(AREA_ORDER.map((id, index) => [id, index]));
const AREA_HEIGHT = {
  accessories: 320,
  tops: 480,
  full: 660,
  bottoms: 660,
  footwear: 320,
  other: 440,
};

export function balancedRowSizes(count, maxPerRow = 4) {
  if (!Number.isInteger(count) || count < 0) throw new Error("Piece count must be a non-negative integer");
  if (!count) return [];
  const rowCount = Math.ceil(count / maxPerRow);
  const small = Math.floor(count / rowCount);
  const largerRows = count % rowCount;
  return Array.from({ length: rowCount }, (_, index) => small + (index < largerRows ? 1 : 0));
}

/** Shared category grouping and row geometry for the live renderer and server checks. */
export function buildCheatSheetLayout(items, titleLines = 1) {
  const index = buildOverviewIndex(items || []);
  const grouped = new Map();
  for (const entry of index) {
    const subtype = entry.subtype;
    const key = `${entry.area}:${subtype.id}`;
    let group = grouped.get(key);
    if (!group) {
      group = { id: key, area: entry.area, subtypeId: subtype.id, label: subtype.label, items: [] };
      grouped.set(key, group);
    }
    group.items.push(entry.item);
  }
  const groups = [...grouped.values()].sort((a, b) =>
    (AREA_RANK.get(a.area) ?? 999) - (AREA_RANK.get(b.area) ?? 999)
    || a.label.localeCompare(b.label, "en")
    || a.id.localeCompare(b.id, "en"));

  const rows = [];
  for (const group of groups) {
    const sizes = balancedRowSizes(group.items.length);
    let offset = 0;
    for (let rowIndex = 0; rowIndex < sizes.length; rowIndex += 1) {
      const count = sizes[rowIndex];
      rows.push({
        id: `${group.id}:${rowIndex}`,
        groupId: group.id,
        groupLabel: group.label,
        area: group.area,
        itemIds: group.items.slice(offset, offset + count).map((item) => item.id),
        rowHeight: AREA_HEIGHT[group.area] || AREA_HEIGHT.other,
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
