import { variantApprovedImage } from "../shared/wardrobe-model.mjs";
import { buildCheatSheetLayout, CHEAT_SHEET_EXPORT_SCALE, CHEAT_SHEET_EXPORT_WIDTH, CHEAT_SHEET_LAYOUT_VERSION, CHEAT_SHEET_MAX_HEIGHT, CHEAT_SHEET_MIN_LOGICAL_HEIGHT, CHEAT_SHEET_WIDTH, titleLayout } from "../shared/cheat-sheet-layout.mjs";

export class CheatSheetRenderError extends Error {
  constructor(message, itemId = null) {
    super(message);
    this.name = "CheatSheetRenderError";
    this.itemId = itemId;
  }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Rendering cancelled", "AbortError");
}

async function loadCutout(item, variantId, signal) {
  throwIfAborted(signal);
  const imageUrl = variantApprovedImage(item, variantId);
  if (!imageUrl) throw new CheatSheetRenderError(`${item.name || "A selected piece"} has no approved cutout. Retry it or remove it from the sheet.`, item.id);
  let response;
  try { response = await fetch(imageUrl, { cache: "no-store", signal }); }
  catch (error) { throwIfAborted(signal); throw new CheatSheetRenderError(`Could not load ${item.name || "a selected piece"}. Retry or remove it.`, item.id); }
  throwIfAborted(signal);
  if (!response.ok) throw new CheatSheetRenderError(`${item.name || "A selected piece"} could not be loaded. Retry or remove it.`, item.id);
  const bytes = await response.arrayBuffer();
  throwIfAborted(signal);
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" })); }
  catch { throw new CheatSheetRenderError(`${item.name || "A selected piece"} is not a readable image. Retry or remove it.`, item.id); }
  try {
    throwIfAborted(signal);
    const bounds = alphaBounds(bitmap, signal);
    const hash = await sha256(bytes);
    throwIfAborted(signal);
    return { bytes, hash, bounds };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new CheatSheetRenderError(`${item.name || "A selected piece"}: ${error.message} Retry it or remove it.`, item.id);
  } finally {
    bitmap.close?.();
  }
}

function alphaBounds(bitmap, signal) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  try {
    context.drawImage(bitmap, 0, 0);
    let pixels;
    try { pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; }
    catch { throw new Error("Could not inspect the transparent edge of this cutout."); }
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      if (y % 64 === 0) throwIfAborted(signal);
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < left || bottom < top) throw new Error("This cutout is fully transparent.");
    const width = right - left + 1;
    const height = bottom - top + 1;
    const safety = Math.max(2, Math.ceil(Math.max(width, height) * 0.018));
    left = Math.max(0, left - safety);
    top = Math.max(0, top - safety);
    right = Math.min(canvas.width - 1, right + safety);
    bottom = Math.min(canvas.height - 1, bottom + safety);
    return { left, top, width: right - left + 1, height: bottom - top + 1 };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function makeBandCanvas(logicalHeight) {
  const canvas = document.createElement("canvas");
  const height = Math.ceil(logicalHeight * CHEAT_SHEET_EXPORT_SCALE);
  if (height > CHEAT_SHEET_MAX_HEIGHT) {
    throw new Error("This sheet is too tall to render. Remove some pieces and try again.");
  }
  canvas.width = CHEAT_SHEET_EXPORT_WIDTH;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

function encodeBand(canvas, properties) {
  const dataUrl = canvas.toDataURL("image/png");
  const height = canvas.height;
  canvas.width = 0;
  canvas.height = 0;
  return { ...properties, height, dataUrl };
}

function drawTitleBand(title, titleMetrics, layout, titleHeight) {
  const band = makeBandCanvas(titleHeight);
  band.context.fillStyle = "#25231f";
  band.context.textAlign = "center";
  band.context.textBaseline = "alphabetic";
  band.context.font = `600 ${titleMetrics.fontSize * CHEAT_SHEET_EXPORT_SCALE}px "Instrument Sans Variable", sans-serif`;
  titleMetrics.lines.forEach((line, index) => {
    const y = (layout.titleTopPadding + titleMetrics.lineHeight * index + titleMetrics.fontSize * 0.9) * CHEAT_SHEET_EXPORT_SCALE;
    band.context.fillText(line, band.canvas.width / 2, y);
  });
  return encodeBand(band.canvas, { kind: "title", itemIds: [] });
}

async function drawRowBand(row, cutouts, bottomPadding, cacheKey, signal) {
  const finalPadding = bottomPadding || 0;
  const band = makeBandCanvas(row.topPadding + row.rowHeight + finalPadding);
  const count = row.itemIds.length;
  const gap = count > 1 ? 34 : 0;
  const cellWidth = (CHEAT_SHEET_WIDTH - 144 - gap * (count - 1)) / count;
  try {
    for (let index = 0; index < count; index += 1) {
      throwIfAborted(signal);
      const itemId = row.itemIds[index];
      const source = cutouts.get(itemId);
      const bitmap = await createImageBitmap(new Blob([source.bytes], { type: "image/png" }));
      try {
        throwIfAborted(signal);
        const maxWidth = Math.max(1, cellWidth - 22);
        const maxHeight = row.rowHeight * 0.94;
        const scale = Math.min(maxWidth / source.bounds.width, maxHeight / source.bounds.height);
        const width = source.bounds.width * scale;
        const height = source.bounds.height * scale;
        const left = 72 + index * (cellWidth + gap) + (cellWidth - width) / 2;
        const top = row.topPadding + (row.rowHeight - height) / 2;
        band.context.drawImage(
          bitmap,
          source.bounds.left, source.bounds.top, source.bounds.width, source.bounds.height,
          left * CHEAT_SHEET_EXPORT_SCALE,
          top * CHEAT_SHEET_EXPORT_SCALE,
          width * CHEAT_SHEET_EXPORT_SCALE,
          height * CHEAT_SHEET_EXPORT_SCALE,
        );
      } finally {
        bitmap.close?.();
      }
    }
    throwIfAborted(signal);
    return encodeBand(band.canvas, { kind: "row", groupId: row.groupId, itemIds: row.itemIds, cacheKey });
  } finally {
    if (band.canvas.width) {
      band.canvas.width = 0;
      band.canvas.height = 0;
    }
  }
}

export async function renderCheatSheet({ title, items, selectedPieces, cache = null, signal }) {
  throwIfAborted(signal);
  if (!String(title || "").trim()) throw new Error("Add a title to preview the sheet.");
  await document.fonts?.load?.('600 52px "Instrument Sans Variable"');
  throwIfAborted(signal);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const selected = selectedPieces.map((piece) => {
    const item = itemsById.get(piece.itemId);
    if (!item) throw new CheatSheetRenderError("A selected piece is no longer in the wardrobe. Remove it to continue.", piece.itemId);
    return { ...piece, item };
  });
  const titleMeasureCanvas = document.createElement("canvas");
  const titleMeasureContext = titleMeasureCanvas.getContext("2d");
  const measure = (text, fontSize) => {
    titleMeasureContext.font = `600 ${fontSize}px "Instrument Sans Variable", sans-serif`;
    return titleMeasureContext.measureText(text).width;
  };
  const titleMetrics = titleLayout(title, measure, CHEAT_SHEET_WIDTH - 144);
  titleMeasureCanvas.width = 0;
  titleMeasureCanvas.height = 0;

  const layout = buildCheatSheetLayout(selected.map(({ item }) => item), titleMetrics.lines.length);
  const titleHeight = layout.titleTopPadding + titleMetrics.lines.length * titleMetrics.lineHeight + layout.titleBottomPadding;
  const rowContentHeight = layout.rows.reduce((total, row) => total + row.topPadding + row.rowHeight, 0);
  const bottomPadding = Math.max(0, CHEAT_SHEET_MIN_LOGICAL_HEIGHT - titleHeight - rowContentHeight);
  const plannedHeight = titleHeight + rowContentHeight + bottomPadding;
  if (plannedHeight * CHEAT_SHEET_EXPORT_SCALE > CHEAT_SHEET_MAX_HEIGHT) {
    throw new Error("This sheet is too tall to export (maximum 2400 × 16384 px). Remove some pieces and try again.");
  }

  const cutouts = new Map();
  const source = [];
  for (const entry of selected) {
    const asset = await loadCutout(entry.item, entry.variantId, signal);
    const variant = entry.item.variants?.find((candidate) => candidate.id === entry.variantId);
    cutouts.set(entry.itemId, asset);
    source.push({ itemId: entry.itemId, variantId: entry.variantId, assetHash: asset.hash, assetRevision: variant?.assetRevision || 1, cutoutRevision: variant?.cutout?.revision || 1 });
  }
  const assetHashes = Object.fromEntries(source.map((piece) => [piece.itemId, piece.assetHash]));

  const previous = cache instanceof Map ? cache : new Map();
  const nextCache = new Map();
  const bands = [];
  const titleKey = JSON.stringify([CHEAT_SHEET_LAYOUT_VERSION, "title", title, titleMetrics.fontSize, titleMetrics.lines]);
  throwIfAborted(signal);
  const priorTitle = previous.get(titleKey);
  const titleBand = priorTitle || drawTitleBand(title, titleMetrics, layout, titleHeight);
  bands.push(titleBand);
  nextCache.set(titleKey, titleBand);

  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
    throwIfAborted(signal);
    const row = layout.rows[rowIndex];
    const tailPadding = rowIndex === layout.rows.length - 1 ? bottomPadding : 0;
    const cacheKey = JSON.stringify([
      CHEAT_SHEET_LAYOUT_VERSION,
      row.groupId,
      row.topPadding,
      row.rowHeight,
      tailPadding,
      row.itemIds.map((itemId) => {
        const picked = selected.find((entry) => entry.itemId === itemId);
        return [itemId, picked.variantId, cutouts.get(itemId).hash];
      }),
    ]);
    const band = previous.get(cacheKey) || await drawRowBand(row, cutouts, tailPadding, cacheKey, signal);
    bands.push(band);
    nextCache.set(cacheKey, band);
  }

  if (!layout.rows.length && bottomPadding) {
    // A brand-new empty sheet still has a stable, useful paper preview. It
    // cannot be saved until it contains a garment, so this is title space only.
    const emptyKey = JSON.stringify([CHEAT_SHEET_LAYOUT_VERSION, "empty-tail", bottomPadding]);
    const prior = previous.get(emptyKey);
    const tail = prior || encodeBand(makeBandCanvas(bottomPadding).canvas, { kind: "row", groupId: "empty", itemIds: [], cacheKey: emptyKey });
    bands.push(tail);
    nextCache.set(emptyKey, tail);
  }

  throwIfAborted(signal);
  if (cache instanceof Map) {
    cache.clear();
    for (const [key, band] of nextCache) cache.set(key, band);
  }
  const height = bands.reduce((total, band) => total + band.height, 0);
  if (height > CHEAT_SHEET_MAX_HEIGHT) throw new Error("This sheet is too tall to export (maximum 2400 × 16384 px). Remove some pieces and try again.");
  return { bands, assetHashes, source, layout, width: CHEAT_SHEET_EXPORT_WIDTH, height, bodyHeight: height - bands[0].height };
}

export async function cheatSheetSourceFingerprint(title, selectedPieces, source) {
  const canonical = JSON.stringify({
    layoutVersion: CHEAT_SHEET_LAYOUT_VERSION,
    title: String(title || "").trim(),
    pieces: selectedPieces.map((piece, index) => ({
      itemId: piece.itemId,
      variantId: piece.variantId,
      assetHash: source[index]?.assetHash || "",
      assetRevision: source[index]?.assetRevision || 1,
      cutoutRevision: source[index]?.cutoutRevision || 1,
    })),
  });
  return sha256(new TextEncoder().encode(canonical));
}
