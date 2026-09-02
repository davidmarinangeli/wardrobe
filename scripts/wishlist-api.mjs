import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  atomicJson,
  buildGarmentPrompt,
  chooseChromaKey,
  cropDetectedItem,
  detectBorderColor,
  geminiAnalyze,
  geminiEdit,
  normalizeImage,
  normalizeMetadata,
  openAIAnalyze,
  openAIEdit,
  readAiMode,
  removeChromaBackground,
  removeUnwornGarmentBackground,
  resolveApiKey,
  resolveProvider,
} from "./import-job-api.mjs";
import { GARMENT_PART_ID_SET } from "../shared/garments.mjs";
import { recordSignal } from "./preferences-api.mjs";

const ASSET_ROOT = "/api/wishlist/assets";
const PARTS = GARMENT_PART_ID_SET;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function normalizeEdit(input, fallback) {
  return {
    name: typeof input.name === "string" ? input.name.trim().slice(0, 120) || fallback.name : fallback.name,
    part: typeof input.part === "string" && PARTS.has(input.part) ? input.part : fallback.part,
    color: typeof input.color === "string" && HEX_COLOR.test(input.color) ? input.color.toLowerCase() : fallback.color,
    secondaryColor: input.secondaryColor === null ? null
      : typeof input.secondaryColor === "string" && HEX_COLOR.test(input.secondaryColor) ? input.secondaryColor.toLowerCase() : fallback.secondaryColor,
    tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : fallback.tags,
  };
}

/**
 * Detects every distinct garment in a photo and creates one wishlist record per item, each with
 * its own crop and (best-effort) AI-generated clean cutout. Shared by the Inspo "Detect items"
 * endpoint — the pin's own summary fields are derived from the returned `aggregate`.
 */
export async function detectAndCreateWishlistItems({ imageBytes, sourcePinId = null, sourceUrl = null, setting, dataDir, wishlistFile, wishlistAssetDir }) {
  const { provider } = resolveProvider(setting);
  const mode = await readAiMode(dataDir);
  const { key, keyName } = resolveApiKey(setting, provider, mode);
  if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  const normalizedImage = await normalizeImage(imageBytes);
  const detected = provider === "gemini"
    ? await geminiAnalyze({ key, model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"), image: normalizedImage, mime: "image/png" })
    : await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: normalizedImage, mime: "image/png" });

  if (!detected.length) return { created: [], aggregate: null };

  const uniqueParts = new Set(detected.map((item) => item.part));
  const primary = detected[0];
  const aggregate = {
    category: uniqueParts.size > 2 || !PARTS.has(primary?.part) ? "full_look" : primary.part,
    name: primary?.name || "",
    colors: [primary?.color, primary?.secondaryColor].filter(Boolean),
  };

  await mkdir(wishlistAssetDir, { recursive: true });

  const records = await Promise.all(detected.map(async (item) => {
    const id = `wishlist-${randomUUID()}`;
    const now = new Date().toISOString();
    const { name, part, color, secondaryColor, tags, worn, rotationDegrees } = normalizeMetadata(item);

    const cropBytes = await cropDetectedItem(normalizedImage, item.boundingBox);
    const cropName = `${id}-crop.png`;
    await writeFile(path.join(wishlistAssetDir, cropName), cropBytes);
    const cropImage = `${ASSET_ROOT}/${cropName}`;

    let image = cropImage;
    let generateStatus = null;
    let generateError = null;
    try {
      const cutoutBytes = await generateCutout({ cropBytes, metadata: { name, part, color, secondaryColor, tags, worn, rotationDegrees }, provider, key, apiBaseUrl: apiBaseUrl(), setting });
      const cutoutName = `${id}-cutout.png`;
      await writeFile(path.join(wishlistAssetDir, cutoutName), cutoutBytes);
      image = `${ASSET_ROOT}/${cutoutName}`;
    } catch (error) {
      generateStatus = "error";
      generateError = error.message;
    }

    return {
      id, name, part, color, secondaryColor, worn, rotationDegrees,
      palette: [color, secondaryColor].filter(Boolean), tags,
      image, thumbnail: image, cropImage,
      generateStatus, generateError,
      sourcePinId, sourceUrl,
      createdAt: now, updatedAt: now,
    };
  }));

  const existing = await loadWishlist(wishlistFile);
  await atomicJson(wishlistFile, [...existing, ...records]);
  // Buy intent: the user asked for these to be pulled out of a reference they saved.
  for (const record of records) {
    await recordSignal(dataDir, { type: "wishlist_added", itemId: record.id, part: record.part, color: record.color, name: record.name });
  }
  return { created: records, aggregate };
}

async function generateCutout({ cropBytes, metadata, provider, key, apiBaseUrl, setting }) {
  // An unworn product photo's pixels are already correct — segment it out of whatever
  // background it's actually on instead of asking the AI edit model to repaint the garment.
  if (metadata.worn === false) return removeUnwornGarmentBackground(cropBytes, { rotationDegrees: metadata.rotationDegrees });
  const requestedChromaKey = chooseChromaKey(metadata.color);
  const prompt = buildGarmentPrompt(metadata, requestedChromaKey);
  const source = { data: cropBytes, mime: "image/png", name: "crop.png" };
  let bytes = provider === "gemini"
    ? await geminiEdit({ key, model: setting("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image"), imageSize: setting("GEMINI_IMAGE_SIZE", "1K"), size: "1024x1024", images: [source], prompt })
    : await openAIEdit({ key, baseUrl: apiBaseUrl, model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1024x1024", images: [source], prompt });
  const chromaKeyUsed = provider === "gemini" ? await detectBorderColor(bytes) : requestedChromaKey;
  return removeChromaBackground(bytes, chromaKeyUsed);
}

async function loadWishlist(wishlistFile) {
  try { return JSON.parse(await readFile(wishlistFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export function wishlistApi(options = {}) {
  let root;
  let dataDir;
  let wishlistFile;
  let wishlistAssetDir;
  const retrying = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  async function loadItems() {
    return loadWishlist(wishlistFile);
  }

  async function retryItem(id) {
    if (retrying.has(id)) return retrying.get(id);
    const task = (async () => {
      try {
        const items = await loadItems();
        const item = items.find((entry) => entry.id === id);
        if (!item) throw new Error("Wishlist item not found");
        const { provider } = resolveProvider(setting);
        const mode = await readAiMode(dataDir);
        const { key, keyName } = resolveApiKey(setting, provider, mode);
        if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
        const cropName = path.basename(item.cropImage);
        const cropBytes = await readFile(path.join(wishlistAssetDir, cropName));
        const cutoutBytes = await generateCutout({ cropBytes, metadata: item, provider, key, apiBaseUrl: apiBaseUrl(), setting });
        const cutoutName = `${id}-cutout.png`;
        await writeFile(path.join(wishlistAssetDir, cutoutName), cutoutBytes);
        const image = `${ASSET_ROOT}/${cutoutName}`;
        const fresh = await loadItems();
        await atomicJson(wishlistFile, fresh.map((entry) => entry.id === id
          ? { ...entry, image, thumbnail: image, generateStatus: null, generateError: null, updatedAt: new Date().toISOString() }
          : entry));
      } catch (error) {
        const fresh = await loadItems();
        await atomicJson(wishlistFile, fresh.map((entry) => entry.id === id
          ? { ...entry, generateStatus: "error", generateError: error.message, updatedAt: new Date().toISOString() }
          : entry));
      }
    })().finally(() => retrying.delete(id));
    retrying.set(id, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/wishlist")) return next();

    try {
      if (url.pathname === "/api/wishlist" && req.method === "GET") {
        return json(res, 200, await loadItems());
      }

      const retryMatch = url.pathname.match(/^\/api\/wishlist\/(wishlist-[a-f0-9-]{36})\/retry$/i);
      if (retryMatch && req.method === "POST") {
        const id = retryMatch[1];
        const items = await loadItems();
        const item = items.find((entry) => entry.id === id);
        if (!item) return json(res, 404, { error: "Wishlist item not found" });
        const updated = { ...item, generateStatus: "processing", generateError: null, updatedAt: new Date().toISOString() };
        await atomicJson(wishlistFile, items.map((entry) => entry.id === id ? updated : entry));
        void retryItem(id);
        return json(res, 202, updated);
      }

      const itemMatch = url.pathname.match(/^\/api\/wishlist\/(wishlist-[a-f0-9-]{36})$/i);
      if (itemMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const id = itemMatch[1];
        const items = await loadItems();
        const item = items.find((entry) => entry.id === id);
        if (!item) return json(res, 404, { error: "Wishlist item not found" });
        const input = await body(req);
        const edits = normalizeEdit(input, item);
        const updated = { ...item, ...edits, palette: [edits.color, edits.secondaryColor].filter(Boolean), updatedAt: new Date().toISOString() };
        await atomicJson(wishlistFile, items.map((entry) => entry.id === id ? updated : entry));
        return json(res, 200, updated);
      }

      if (itemMatch && req.method === "DELETE") {
        const id = itemMatch[1];
        const items = await loadItems();
        const item = items.find((entry) => entry.id === id);
        if (!item) return json(res, 404, { error: "Wishlist item not found" });
        const remaining = items.filter((entry) => entry.id !== id);
        await atomicJson(wishlistFile, remaining);
        // The reversal of buy intent — an explicit negative the user produced.
        await recordSignal(dataDir, { type: "wishlist_removed", itemId: id, part: item.part, color: item.color, name: item.name });
        await Promise.all([
          rm(path.join(wishlistAssetDir, path.basename(item.cropImage)), { force: true }),
          rm(path.join(wishlistAssetDir, `${id}-cutout.png`), { force: true }),
        ]);
        return json(res, 200, { deleted: true, id });
      }

      const assetMatch = url.pathname.match(/^\/api\/wishlist\/assets\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(wishlistAssetDir, path.basename(assetMatch[1]));
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-wishlist-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      wishlistFile = path.join(dataDir, "wishlist.json");
      wishlistAssetDir = path.join(dataDir, "wishlist-assets");
      await mkdir(dataDir, { recursive: true });
      await mkdir(wishlistAssetDir, { recursive: true });
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export function wishlistPaths(root, setting) {
  const dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
  return { dataDir, wishlistFile: path.join(dataDir, "wishlist.json"), wishlistAssetDir: path.join(dataDir, "wishlist-assets") };
}
