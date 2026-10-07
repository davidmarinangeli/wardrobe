import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { atomicJson } from "./import-job-api.mjs";
import { normalizeItemV2, variantApprovedImage } from "../shared/wardrobe-model.mjs";
import { buildCheatSheetLayout, CHEAT_SHEET_LAYOUT_VERSION, CHEAT_SHEET_MAX_HEIGHT, CHEAT_SHEET_EXPORT_WIDTH, CHEAT_SHEET_MIN_LOGICAL_HEIGHT, normalizeCheatSheetScale } from "../shared/cheat-sheet-layout.mjs";
import { buildCheatSheetBeautifyPrompt, CHEAT_SHEET_DESCRIPTION_LIMIT, CHEAT_SHEET_PROMPT_LIMIT, DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT } from "../shared/cheat-sheet-prompt.mjs";
import { cheatSheetImageSettings, generateCheatSheetImage } from "./cheat-sheet-beautify.mjs";

const API_ROOT = "/api/cheat-sheets";
const ASSET_ROOT = `${API_ROOT}/assets`;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_BODY = 64 * 1024 * 1024;
const SHEET_ASSET_KEYS = ["originalImage", "thumbnailImage", "aiImage", "aiThumbnailImage"];

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  return value;
}

function decodePng(value, label) {
  const match = typeof value === "string" && value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error(`${label} must be a PNG image`), { status: 400 });
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > 24 * 1024 * 1024) throw Object.assign(new Error(`${label} has an invalid size`), { status: 400 });
  return bytes;
}

function hashBytes(value) { return createHash("sha256").update(value).digest("hex"); }
function hashText(value) { return createHash("sha256").update(value).digest("hex"); }

function canonicalSource(title, pieces, description) {
  return JSON.stringify({
    layoutVersion: CHEAT_SHEET_LAYOUT_VERSION,
    title,
    description,
    pieces: pieces.map(({ itemId, variantId, scale, assetHash, assetRevision, cutoutRevision }) => ({ itemId, variantId, scale: normalizeCheatSheetScale(scale), assetHash, assetRevision, cutoutRevision })),
  });
}

export function cheatSheetSourceFingerprint(title, pieces, description = "") {
  return hashText(canonicalSource(title, pieces, description));
}

export function cheatSheetsApi(options = {}) {
  let root;
  let dataDir;
  let sheetsFile;
  let libraryAssetDir;
  let assetDir;
  let mutationQueue = Promise.resolve();
  const running = new Map();
  const writeJson = options.atomicJson || atomicJson;
  const generateImage = options.generateImage || generateCheatSheetImage;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;

  const serialize = (operation) => {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.catch(() => {});
    return next;
  };

  async function loadSheets() {
    try {
      const value = JSON.parse(await readFile(sheetsFile, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function saveSheets(sheets) { await writeJson(sheetsFile, sheets); }

  async function loadLibrary() {
    try {
      const value = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
      return (Array.isArray(value) ? value : []).map((item) => normalizeItemV2(item)).filter(Boolean);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function normalizePieces(input) {
    if (!Array.isArray(input) || input.length < 1) throw Object.assign(new Error("Select at least one piece"), { status: 400 });
    const pieces = input.map((piece) => {
      if (!piece || typeof piece !== "object") throw Object.assign(new Error("Each selected piece must include an item and variant"), { status: 400 });
      let scale;
      try { scale = normalizeCheatSheetScale(piece.scale); }
      catch (error) { throw Object.assign(error, { status: 400 }); }
      return { itemId: safeId(piece.itemId, "Item"), variantId: safeId(piece.variantId, "Variant"), scale };
    });
    if (new Set(pieces.map((piece) => piece.itemId)).size !== pieces.length) {
      throw Object.assign(new Error("A cheat sheet can include each wardrobe item once"), { status: 400 });
    }
    return pieces;
  }

  async function resolvePieceSources(pieces, library) {
    const byId = new Map(library.map((item) => [item.id, item]));
    const resolved = [];
    for (const piece of pieces) {
      const item = byId.get(piece.itemId);
      if (!item) throw Object.assign(new Error(`Wardrobe item ${piece.itemId} no longer exists`), { status: 409 });
      const variant = item.variants.find((candidate) => candidate.id === piece.variantId);
      if (!variant) throw Object.assign(new Error(`Variant ${piece.variantId} no longer exists. Remove or replace it.`), { status: 409 });
      const image = variantApprovedImage(item, piece.variantId);
      if (!image) throw Object.assign(new Error(`${item.name} has no approved cutout for this variant`), { status: 409 });
      const filename = path.basename(new URL(image, "http://localhost").pathname);
      let bytes;
      try { bytes = await readFile(path.join(libraryAssetDir, filename)); }
      catch (error) {
        if (error.code === "ENOENT") throw Object.assign(new Error(`${item.name} has a missing cutout. Retry it or remove it.`), { status: 409 });
        throw error;
      }
      resolved.push({ ...piece, item, assetHash: hashBytes(bytes), assetRevision: variant.assetRevision || 1, cutoutRevision: variant.cutout?.revision || 1, bytes });
    }
    return resolved;
  }

  async function validateAndCompose(input, existing = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Expected a JSON object"), { status: 400 });
    const allowed = ["title", "description", "pieces", "expectedRevision", "sourceFingerprint", "bands"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw Object.assign(new Error("Request contains unsupported fields"), { status: 400 });
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
    if (!title) throw Object.assign(new Error("Add a title to the cheat sheet"), { status: 400 });
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > CHEAT_SHEET_DESCRIPTION_LIMIT)) {
      throw Object.assign(new Error(`Description must contain at most ${CHEAT_SHEET_DESCRIPTION_LIMIT} characters`), { status: 400 });
    }
    const description = (input.description || "").trim();
    const pieces = normalizePieces(input.pieces);
    if (existing && (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== existing.revision)) {
      throw Object.assign(new Error("This cheat sheet changed elsewhere. Reload it before saving."), { status: 409 });
    }
    if (!Array.isArray(input.bands) || input.bands.length < 2 || input.bands.length > pieces.length + 1) {
      throw Object.assign(new Error("The rendered sheet is incomplete. Retry the preview."), { status: 400 });
    }
    const rawBands = input.bands.map((band, index) => {
      if (!band || typeof band !== "object" || !["title", "row"].includes(band.kind)) throw Object.assign(new Error(`Rendered band ${index + 1} is invalid`), { status: 400 });
      if (index === 0 && band.kind !== "title") throw Object.assign(new Error("The first rendered band must contain the title"), { status: 400 });
      if (index > 0 && band.kind !== "row") throw Object.assign(new Error("Only one title band is allowed"), { status: 400 });
      const itemIds = band.kind === "title" ? [] : band.itemIds;
      if (!Array.isArray(itemIds) || (band.kind === "row" && (!itemIds.length || itemIds.length > 4))) throw Object.assign(new Error(`Rendered band ${index + 1} has an invalid piece group`), { status: 400 });
      if (itemIds.some((id) => typeof id !== "string" || !pieces.some((piece) => piece.itemId === id))) throw Object.assign(new Error(`Rendered band ${index + 1} includes an unselected piece`), { status: 400 });
      const groupId = band.kind === "row" ? band.groupId : null;
      if (band.kind === "row" && (typeof groupId !== "string" || !groupId)) throw Object.assign(new Error(`Rendered band ${index + 1} is missing its category`), { status: 400 });
      return { kind: band.kind, groupId, itemIds, bytes: decodePng(band.dataUrl, `Rendered band ${index + 1}`) };
    });
    const renderedIds = rawBands.flatMap((band) => band.itemIds);
    if (renderedIds.length !== pieces.length || new Set(renderedIds).size !== pieces.length || pieces.some((piece) => !renderedIds.includes(piece.itemId))) {
      throw Object.assign(new Error("Every selected piece must appear in the rendered sheet"), { status: 400 });
    }

    const library = await loadLibrary();
    const resolved = await resolvePieceSources(pieces, library);
    const sourceFingerprint = cheatSheetSourceFingerprint(title, resolved, description);
    if (input.sourceFingerprint !== sourceFingerprint) throw Object.assign(new Error("Wardrobe cutouts changed while the preview was rendering. Retry the preview before saving."), { status: 409 });
    const pieceScales = new Map(resolved.map((piece) => [piece.itemId, piece.scale]));
    const expectedRows = buildCheatSheetLayout(resolved.map((piece) => piece.item), 1, pieceScales).rows;
    if (rawBands.length !== expectedRows.length + 1 || expectedRows.some((row, index) => {
      const band = rawBands[index + 1];
      return band.kind !== "row" || band.groupId !== row.groupId || JSON.stringify(band.itemIds) !== JSON.stringify(row.itemIds);
    })) throw Object.assign(new Error("Rendered piece order does not match the selected wardrobe items"), { status: 400 });

    let height = 0;
    const metadata = [];
    for (const band of rawBands) {
      const details = await sharp(band.bytes).metadata();
      if (details.format !== "png" || details.width !== CHEAT_SHEET_EXPORT_WIDTH || !details.height || details.height < 1) {
        throw Object.assign(new Error("A rendered band has invalid PNG dimensions"), { status: 400 });
      }
      height += details.height;
      if (height > CHEAT_SHEET_MAX_HEIGHT) throw Object.assign(new Error("This sheet is too tall to export (maximum 2400 × 16384 px). Remove some pieces and try again."), { status: 413 });
      metadata.push({ ...band, height: details.height });
    }
    if (height < CHEAT_SHEET_MIN_LOGICAL_HEIGHT * 2) throw Object.assign(new Error("The rendered sheet is shorter than the minimum size. Retry the preview."), { status: 400 });

    let top = 0;
    const composites = metadata.map((band) => {
      const composite = { input: band.bytes, left: 0, top };
      top += band.height;
      return composite;
    });
    const original = await sharp({ create: { width: CHEAT_SHEET_EXPORT_WIDTH, height: top, channels: 3, background: "#ffffff" } })
      .composite(composites).png().toBuffer();
    const thumbnail = await sharp(original).resize(450, 600, { fit: "contain", background: "#ffffff" }).png().toBuffer();

    // Check source pixels again after Sharp finished. A variant can change
    // while its submitted bands are being assembled; never publish a mixed revision.
    const after = await resolvePieceSources(pieces, await loadLibrary());
    if (cheatSheetSourceFingerprint(title, after, description) !== sourceFingerprint) {
      throw Object.assign(new Error("Wardrobe cutouts changed while the sheet was being saved. Retry the preview."), { status: 409 });
    }
    return { title, description, pieces, sourceFingerprint, original, thumbnail };
  }

  async function writeAsset(bytes, prefix) {
    await mkdir(assetDir, { recursive: true });
    const filename = `${prefix}-${randomUUID()}.png`;
    const target = path.join(assetDir, filename);
    const temp = `${target}.tmp`;
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, target);
    return `${ASSET_ROOT}/${filename}`;
  }

  async function removeAsset(url) {
    if (typeof url !== "string") return;
    const filename = path.basename(new URL(url, "http://localhost").pathname);
    await rm(path.join(assetDir, filename), { force: true }).catch(() => {});
  }

  async function publishRendered(rendered, existing = null) {
    const written = [];
    try {
      const originalImage = await writeAsset(rendered.original, "original"); written.push(originalImage);
      const thumbnailImage = await writeAsset(rendered.thumbnail, "thumb"); written.push(thumbnailImage);
      const now = new Date().toISOString();
      const sheet = {
        id: existing?.id || randomUUID(),
        title: rendered.title,
        description: rendered.description,
        pieces: rendered.pieces,
        revision: (existing?.revision || 0) + 1,
        layoutVersion: CHEAT_SHEET_LAYOUT_VERSION,
        sourceFingerprint: rendered.sourceFingerprint,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        originalImage,
        thumbnailImage,
        ...(existing?.beautifyPrompt ? { beautifyPrompt: existing.beautifyPrompt } : {}),
      };
      const sheets = await loadSheets();
      if (existing && !sheets.some((entry) => entry.id === existing.id)) throw Object.assign(new Error("Cheat sheet was deleted before it could be saved"), { status: 404 });
      const latestSources = await resolvePieceSources(rendered.pieces, await loadLibrary());
      if (cheatSheetSourceFingerprint(rendered.title, latestSources, rendered.description) !== rendered.sourceFingerprint) {
        throw Object.assign(new Error("Wardrobe cutouts changed while the sheet was being saved. Retry the preview."), { status: 409 });
      }
      await saveSheets(existing ? sheets.map((entry) => entry.id === existing.id ? sheet : entry) : [sheet, ...sheets]);
      for (const key of SHEET_ASSET_KEYS) if (existing?.[key] && existing[key] !== sheet[key]) await removeAsset(existing[key]);
      return sheet;
    } catch (error) {
      await Promise.all(written.map(removeAsset));
      throw error;
    }
  }

  async function beautifySheet(source, settings) {
    const written = [];
    const isCurrent = (sheet) => sheet?.revision === source.revision
      && sheet.beautifyJobId === source.beautifyJobId && sheet.originalImage === source.originalImage;
    try {
      const data = await readFile(path.join(assetDir, path.basename(source.originalImage)));
      const { width, height } = await sharp(data).metadata();
      const prompt = buildCheatSheetBeautifyPrompt({ ...source, prompt: source.beautifyPrompt, width, height });
      const generated = await generateImage({ data, prompt, width, height, settings });
      const ai = await sharp(generated).rotate().png().toBuffer();
      const thumbnail = await sharp(ai).resize(450, 600, { fit: "inside" }).png().toBuffer();
      await serialize(async () => {
        const sheets = await loadSheets();
        const current = sheets.find((sheet) => sheet.id === source.id);
        // An edit or deletion made during generation supersedes this result.
        if (!isCurrent(current)) return;
        const aiImage = await writeAsset(ai, "beautified"); written.push(aiImage);
        const aiThumbnailImage = await writeAsset(thumbnail, "beautified-thumb"); written.push(aiThumbnailImage);
        const now = new Date().toISOString();
        const sheet = { ...current, aiImage, aiThumbnailImage, beautifyStatus: "ready", beautifyError: null, beautifiedAt: now, updatedAt: now, revision: current.revision + 1 };
        await saveSheets(sheets.map((entry) => entry.id === sheet.id ? sheet : entry));
        written.length = 0;
        await Promise.all([current.aiImage, current.aiThumbnailImage].map(removeAsset));
      });
    } catch (error) {
      await serialize(async () => {
        const sheets = await loadSheets();
        const current = sheets.find((sheet) => sheet.id === source.id);
        if (!isCurrent(current)) return;
        await saveSheets(sheets.map((sheet) => sheet.id === source.id
          ? { ...sheet, beautifyStatus: "error", beautifyError: error.message || "Could not beautify this sheet. Try again." }
          : sheet));
      });
    } finally {
      await Promise.all(written.map(removeAsset));
    }
  }

  async function startBeautifying(id, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["expectedRevision", "prompt", "tier"].includes(key))) {
      throw Object.assign(new Error("Invalid beautification request"), { status: 400 });
    }
    const prompt = input.prompt === undefined ? DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT : input.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > CHEAT_SHEET_PROMPT_LIMIT) {
      throw Object.assign(new Error(`Add a prompt of at most ${CHEAT_SHEET_PROMPT_LIMIT} characters`), { status: 400 });
    }
    const settings = await cheatSheetImageSettings(setting, dataDir, input.tier);
    const sheet = await serialize(async () => {
      const sheets = await loadSheets();
      const current = sheets.find((entry) => entry.id === id);
      if (!current) throw Object.assign(new Error("Cheat sheet not found"), { status: 404 });
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision) {
        throw Object.assign(new Error("This cheat sheet changed elsewhere. Reload it before generating."), { status: 409 });
      }
      if (running.has(id)) throw Object.assign(new Error("This cheat sheet is already being beautified."), { status: 409 });
      const sheet = { ...current, beautifyPrompt: prompt.trim(), beautifyTier: settings.tier, beautifyStatus: "processing", beautifyError: null, beautifyJobId: randomUUID() };
      await saveSheets(sheets.map((entry) => entry.id === id ? sheet : entry));
      const task = beautifySheet(sheet, settings).catch((error) => {
        console.error("Could not persist cheat sheet beautification status:", error.message);
      }).finally(() => running.delete(id));
      running.set(id, task);
      return sheet;
    });
    return sheet;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(API_ROOT)) return next();
    try {
      if (url.pathname === API_ROOT && req.method === "GET") {
        const sheets = await loadSheets();
        return json(res, 200, { sheets: [...sheets].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
      }
      if (url.pathname === API_ROOT && req.method === "POST") {
        const rendered = await validateAndCompose(await readBody(req));
        const sheet = await serialize(() => publishRendered(rendered));
        return json(res, 201, { sheet });
      }
      const assetMatch = url.pathname.match(/^\/api\/cheat-sheets\/assets\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const filename = path.basename(assetMatch[1]);
        const bytes = await readFile(path.join(assetDir, filename));
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        if (url.searchParams.get("download") === "1") {
          const requestedName = url.searchParams.get("name") || filename;
          const safeName = requestedName.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100) || filename;
          res.setHeader("Content-Disposition", `attachment; filename="${safeName.endsWith(".png") ? safeName : `${safeName}.png`}"`);
        }
        return res.end(bytes);
      }
      const beautifyMatch = url.pathname.match(/^\/api\/cheat-sheets\/([^/]+)\/beautify$/);
      if (beautifyMatch) {
        if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
        const id = safeId(decodeURIComponent(beautifyMatch[1]), "Cheat sheet");
        return json(res, 202, { sheet: await startBeautifying(id, await readBody(req)) });
      }
      const match = url.pathname.match(/^\/api\/cheat-sheets\/([^/]+)$/);
      if (!match) return json(res, 404, { error: "Not found" });
      const id = safeId(decodeURIComponent(match[1]), "Cheat sheet");

      if (req.method === "GET") {
        const sheet = (await loadSheets()).find((entry) => entry.id === id);
        return sheet ? json(res, 200, { sheet }) : json(res, 404, { error: "Cheat sheet not found" });
      }
      if (req.method === "PUT") {
        const input = await readBody(req);
        const existing = (await loadSheets()).find((entry) => entry.id === id);
        if (!existing) return json(res, 404, { error: "Cheat sheet not found" });
        const rendered = await validateAndCompose(input, existing);
        const sheet = await serialize(async () => {
          const latest = (await loadSheets()).find((entry) => entry.id === id);
          if (!latest) throw Object.assign(new Error("Cheat sheet was deleted before it could be saved"), { status: 404 });
          if (latest.revision !== existing.revision) throw Object.assign(new Error("This cheat sheet changed elsewhere. Reload it before saving."), { status: 409 });
          return publishRendered(rendered, latest);
        });
        return json(res, 200, { sheet });
      }
      if (req.method === "DELETE") {
        const removed = await serialize(async () => {
          const sheets = await loadSheets();
          const sheet = sheets.find((entry) => entry.id === id);
          if (!sheet) return null;
          await saveSheets(sheets.filter((entry) => entry.id !== id));
          return sheet;
        });
        if (!removed) return json(res, 404, { error: "Cheat sheet not found" });
        await Promise.all(SHEET_ASSET_KEYS.map((key) => removed[key]).map(removeAsset));
        return json(res, 200, { deleted: true });
      }
      return json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      const status = error.status || (error.code === "ENOENT" ? 404 : 500);
      return json(res, status, { error: status >= 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-cheat-sheets-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      sheetsFile = path.join(dataDir, "cheat-sheets.json");
      libraryAssetDir = path.join(dataDir, "imported");
      assetDir = path.join(dataDir, "cheat-sheets-assets");
      await mkdir(dataDir, { recursive: true });
      await mkdir(assetDir, { recursive: true });
      const sheets = await loadSheets();
      if (sheets.some((sheet) => sheet.beautifyStatus === "processing")) {
        await saveSheets(sheets.map((sheet) => sheet.beautifyStatus === "processing"
          ? { ...sheet, beautifyStatus: "error", beautifyError: "Generation was interrupted when the server restarted. Try again." }
          : sheet));
      }
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
