import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson, buildModeledPrompt, checkSetup, computeIdentityProfile, geminiAnalyzeOutfitStyle, geminiEdit, isLikelyBottom, isLikelyCroppedOrShortBottom, isLikelySocks, isPremiumAllowed, loadFaceReference, miniMaxEdit, openAIAnalyzeOutfitStyle, openAIImage, openAIImageOptions, openRouterEdit, readAiMode, resolveApiKey, resolveModeledModel, resolveOpenAICompatibleBaseUrl, resolveProvider } from "./import-job-api.mjs";

import { recordSignal } from "./preferences-api.mjs";
import { summarizeOutfits } from "../shared/outfit-index.mjs";
import { migrateOutfit, normalizeItemV2, validateOutfitPieces, variantApprovedImage } from "../shared/wardrobe-model.mjs";

const OUTFIT_ASSET_ROOT = "/api/outfits/assets";

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 256 * 1024) {
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

function normalizeOutfit(value = {}, existing = null, items = []) {
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 120) : "";
  const itemIds = Array.isArray(value.itemIds) ? value.itemIds.filter((id) => typeof id === "string").slice(0, 12) : [];
  const pieces = Array.isArray(value.pieces)
    ? value.pieces.slice(0, 12)
    : itemIds.map((itemId) => ({ itemId, variantId: items.find((item) => item.id === itemId)?.defaultVariantId || null }));
  if (!name) throw Object.assign(new Error("An outfit name is required"), { status: 400 });
  const normalizedPieces = validateOutfitPieces(pieces, items);
  const normalizedItemIds = normalizedPieces.map((piece) => piece.itemId);
  const previousPieces = existing ? migrateOutfit(existing, items).pieces : [];
  const pieceKey = (piece) => `${piece.itemId}:${piece.variantId}`;
  const piecesChanged = existing && JSON.stringify(previousPieces.map(pieceKey).sort()) !== JSON.stringify(normalizedPieces.map(pieceKey).sort());
  return {
    id: existing?.id || randomUUID(),
    name,
    pieces: normalizedPieces,
    itemIds: normalizedItemIds,
    // A changed lineup invalidates any existing model photo — it was generated from the old set of pieces.
    modeledImage: piecesChanged ? null : existing?.modeledImage || null,
    modeledStatus: piecesChanged ? null : existing?.modeledStatus || null,
    modeledError: piecesChanged ? null : existing?.modeledError || null,
    modeledTier: piecesChanged ? null : existing?.modeledTier || null,
    description: piecesChanged ? null : existing?.description || null,
    tags: piecesChanged ? [] : existing?.tags || [],
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function outfitsApi(options = {}) {
  let root;
  let dataDir;
  let outfitsFile;
  let libraryAssetDir;
  let outfitAssetDir;
  const running = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = (provider) => resolveOpenAICompatibleBaseUrl(setting, provider);
  const miniMaxBaseUrl = () => setting("MINIMAX_API_BASE_URL", "https://api.minimax.io/v1").replace(/\/$/, "");
  const currentMode = () => readAiMode(dataDir);

  async function loadOutfits() {
    try { return JSON.parse(await readFile(outfitsFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function loadLibrary() {
    try { return (JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8")) || []).map((item) => normalizeItemV2(item)).filter(Boolean); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function loadOutfitGarments(outfit, libraryRecords) {
    const recordsById = new Map(libraryRecords.map((record) => [record.id, record]));
    const outfitRecords = outfit.pieces.map((piece) => recordsById.get(piece.itemId)).filter(Boolean);
    const hasFullLengthBottom = outfitRecords.some((record) => isLikelyBottom(record) && !isLikelySocks(record) && !isLikelyCroppedOrShortBottom(record));
    const garments = [];
    const garmentMeta = [];
    for (const piece of outfit.pieces) {
      const record = recordsById.get(piece.itemId);
      if (hasFullLengthBottom && isLikelySocks(record)) continue;
      if (!record) throw Object.assign(new Error(`Wardrobe item ${piece.itemId} not found`), { status: 409 });
      const variant = record.variants.find((candidate) => candidate.id === piece.variantId);
      const image = variant && variantApprovedImage(record, piece.variantId);
      if (!image) throw Object.assign(new Error(`Variant ${piece.variantId} of ${piece.itemId} has no approved cutout yet`), { status: 409 });
      const filename = path.basename(new URL(image, "http://localhost").pathname);
      let data;
      try {
        data = await readFile(path.join(libraryAssetDir, filename));
      } catch (error) {
        if (error.code === "ENOENT") throw Object.assign(new Error(`Variant ${piece.variantId} of ${piece.itemId} has no approved cutout yet`), { status: 409 });
        throw error;
      }
      garments.push({ data, mime: "image/png", name: `${piece.itemId}-${piece.variantId || "standard"}.png` });
      garmentMeta.push({ name: `${record.name} — ${variant.name}`, tags: [...(record.tags || []), ...(variant.tags || []), variant.description].filter(Boolean), part: record.part });
    }
    if (!garments.length) throw Object.assign(new Error("None of this outfit's pieces have a garment image to work from"), { status: 409 });
    return { garments, garmentMeta };
  }

  async function generateModeledForOutfit(id, { tier, prompt }) {
    if (running.has(id)) return running.get(id);
    const task = (async () => {
      try {
        const outfits = await loadOutfits();
        const libraryRecords = await loadLibrary();
        const outfit = outfits.map((entry) => migrateOutfit(entry, libraryRecords)).find((item) => item.id === id);
        if (!outfit) throw new Error("Outfit not found");
        const { garments, garmentMeta } = await loadOutfitGarments(outfit, libraryRecords);
        const { provider } = resolveProvider(setting);
        const mode = await currentMode();
        const { key, keyName } = resolveApiKey(setting, provider, mode);
        if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
        if (tier === "premium" && !isPremiumAllowed(provider, mode)) {
          throw new Error("Premium quality needs PROD mode — the free TEST key has no billing enabled for Nano Banana 2. Switch to PROD to generate this.");
        }
        const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
        let modelData;
        try {
          modelData = await readFile(modelPath);
        } catch (error) {
          if (error.code === "ENOENT") throw new Error(`Model reference not found at ${modelPath}. Set WARDROBE_MODEL_REFERENCE or add data/model-reference.png.`);
          throw error;
        }
        const model = { data: modelData, mime: "image/png", name: "model.png" };
        const face = await loadFaceReference(root, setting);
        const referenceImages = face ? [model, face] : [model];
        const basePrompt = options.modeledPrompt || buildModeledPrompt(garmentMeta, { hasFaceReference: Boolean(face) });
        const identityProfile = await computeIdentityProfile({ root, dataDir, setting, provider, mode });
        const withIdentity = identityProfile ? `${basePrompt}\nAdditional identity notes for consistency: ${identityProfile}` : basePrompt;
        const modeledPrompt = prompt ? `${withIdentity}\nUser regeneration direction: ${prompt}` : withIdentity;
        const resolved = resolveModeledModel(provider, tier, setting);
        let bytes;
        if (provider === "gemini") {
          bytes = await geminiEdit({ key, model: resolved.model, imageSize: resolved.imageSize, size: "1536x1024", images: [...referenceImages, ...garments], prompt: modeledPrompt });
        } else if (provider === "minimax") {
          const seedValue = setting("MINIMAX_IMAGE_SEED").trim();
          bytes = await miniMaxEdit({
            key, baseUrl: miniMaxBaseUrl(), model: resolved.model, prompt: modeledPrompt, images: [...referenceImages, ...garments], size: "1536x1024",
            aspectRatio: setting("MINIMAX_IMAGE_ASPECT_RATIO"),
            responseFormat: setting("MINIMAX_IMAGE_RESPONSE_FORMAT", "base64"),
            promptOptimizer: setting("MINIMAX_PROMPT_OPTIMIZER") === "true",
            seed: /^-?\d+$/.test(seedValue) ? Number(seedValue) : undefined,
          });
        } else if (provider === "openrouter") {
          bytes = await openRouterEdit({ key, baseUrl: apiBaseUrl(provider), model: resolved.model, quality: resolved.quality, size: "1536x1024", images: [...referenceImages, ...garments], prompt: modeledPrompt });
        } else {
          bytes = await openAIImage({ ...openAIImageOptions(setting), key, baseUrl: apiBaseUrl(provider), model: resolved.model, quality: resolved.quality, size: "1536x1024", images: [...referenceImages, ...garments], prompt: modeledPrompt });
        }
        const modeledName = `${id}-modeled.png`;
        await mkdir(outfitAssetDir, { recursive: true });
        await writeFile(path.join(outfitAssetDir, modeledName), bytes);
        const fresh = await loadOutfits();
        await atomicJson(outfitsFile, fresh.map((item) => item.id === id
          ? { ...item, modeledImage: `${OUTFIT_ASSET_ROOT}/${modeledName}?v=${Date.now()}`, modeledStatus: null, modeledError: null, modeledTier: tier }
          : item));
        // Non-fatal: the modeled photo already succeeded and was persisted above, so a style-analysis
        // failure (e.g. no OpenAI key configured when running on minimax) shouldn't surface as an error.
        try {
          // MiniMax has no text/vision path, so only it falls back to OpenAI.
          const styleProvider = provider === "gemini" || provider === "openrouter" ? provider : "openai";
          const styleKey = resolveApiKey(setting, styleProvider, mode).key;
          if (!styleKey) throw new Error("no vision API key configured for outfit style analysis");
          const style = styleProvider === "gemini"
            ? await geminiAnalyzeOutfitStyle({ key: styleKey, model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"), image: bytes, mime: "image/png" })
            : await openAIAnalyzeOutfitStyle({
              key: styleKey,
              baseUrl: apiBaseUrl(styleProvider),
              model: styleProvider === "openrouter" ? setting("OPENROUTER_VISION_MODEL", "openai/gpt-5.4-mini") : setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
              image: bytes,
              mime: "image/png",
            });
          const afterStyle = await loadOutfits();
          await atomicJson(outfitsFile, afterStyle.map((item) => item.id === id
            ? { ...item, description: style.description, tags: style.tags }
            : item));
        } catch (styleError) {
          console.warn(`Outfit style analysis failed (${styleError.message})`);
        }
      } catch (error) {
        const fresh = await loadOutfits();
        await atomicJson(outfitsFile, fresh.map((item) => item.id === id
          ? { ...item, modeledStatus: "error", modeledError: error.message }
          : item));
      }
    })().finally(() => running.delete(id));
    running.set(id, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/outfits")) return next();
    try {
      if (url.pathname === "/api/outfits" && req.method === "GET") {
        const items = await loadLibrary();
        return json(res, 200, (await loadOutfits()).map((outfit) => migrateOutfit(outfit, items)));
      }
      // Read-only, for the wardrobe grid: which outfits use which pieces, minus
      // the model photo state, style prose and timestamps the full list carries.
      // See shared/outfit-index.mjs for why the grouping happens on the client.
      if (url.pathname === "/api/outfits/index" && req.method === "GET") {
        const items = await loadLibrary();
        return json(res, 200, { outfits: summarizeOutfits((await loadOutfits()).map((outfit) => migrateOutfit(outfit, items))) });
      }
      if (url.pathname === "/api/outfits" && req.method === "POST") {
        const input = await body(req);
        const outfits = await loadOutfits();
        const items = await loadLibrary();
        const outfit = normalizeOutfit(input, null, items);
        await atomicJson(outfitsFile, [...outfits, outfit]);
        // Saving an outfit is the strongest positive signal the app can observe:
        // the user is stating they will wear this combination.
        await recordSignal(dataDir, {
          type: "outfit_saved",
          itemIds: outfit.itemIds,
          name: outfit.name,
          source: typeof input.source === "string" ? input.source : undefined,
        });
        return json(res, 201, outfit);
      }
      const match = url.pathname.match(/^\/api\/outfits\/([a-f0-9-]{36})$/i);
      if (match && (req.method === "PATCH" || req.method === "PUT")) {
        const outfits = await loadOutfits();
        const existing = outfits.find((outfit) => outfit.id === match[1]);
        if (!existing) return json(res, 404, { error: "Outfit not found" });
        const input = await body(req);
        const items = await loadLibrary();
        const value = input.pieces === undefined && Object.hasOwn(input, "itemIds")
          ? { ...existing, ...input, pieces: undefined }
          : { ...existing, ...input };
        const updated = normalizeOutfit(value, existing, items);
        await atomicJson(outfitsFile, outfits.map((outfit) => outfit.id === updated.id ? updated : outfit));
        return json(res, 200, updated);
      }
      if (match && req.method === "DELETE") {
        const outfits = await loadOutfits();
        const next = outfits.filter((outfit) => outfit.id !== match[1]);
        if (next.length === outfits.length) return json(res, 404, { error: "Outfit not found" });
        await atomicJson(outfitsFile, next);
        return json(res, 200, { deleted: true, id: match[1] });
      }
      const modeledMatch = url.pathname.match(/^\/api\/outfits\/([a-f0-9-]{36})\/modeled$/i);
      if (modeledMatch && req.method === "POST") {
        const id = modeledMatch[1];
        const outfits = await loadOutfits();
        const outfit = outfits.find((item) => item.id === id);
        if (!outfit) return json(res, 404, { error: "Outfit not found" });
        const items = await loadLibrary();
        await loadOutfitGarments(migrateOutfit(outfit, items), items);
        const setup = await checkSetup(root, setting, await currentMode());
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && `${setup.keyName} in .env for ${setup.mode.toUpperCase()} mode`,
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const tier = input.tier === "openrouter" && setup.provider === "openrouter"
          ? "openrouter"
          : input.tier === "premium" ? "premium" : "standard";
        if (tier === "premium" && !isPremiumAllowed(setup.provider, setup.mode)) {
          return json(res, 400, { error: "Premium quality needs PROD mode — the free TEST key has no billing enabled for Nano Banana 2. Switch to PROD to generate this." });
        }
        const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) : "";
        const updated = { ...outfit, modeledStatus: "processing", modeledError: null, modeledTier: tier };
        await atomicJson(outfitsFile, outfits.map((item) => item.id === id ? updated : item));
        void generateModeledForOutfit(id, { tier, prompt });
        return json(res, 202, updated);
      }
      const assetMatch = url.pathname.match(/^\/api\/outfits\/assets\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(outfitAssetDir, path.basename(assetMatch[1]));
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
    name: "wardrobe-outfits-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      outfitsFile = path.join(dataDir, "outfits.json");
      libraryAssetDir = path.join(dataDir, "imported");
      outfitAssetDir = path.join(dataDir, "outfits-assets");
      await mkdir(dataDir, { recursive: true });
      await mkdir(outfitAssetDir, { recursive: true });
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
