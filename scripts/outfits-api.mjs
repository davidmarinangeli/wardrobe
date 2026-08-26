import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson, buildModeledPrompt, checkSetup, geminiAnalyzeOutfitStyle, geminiEdit, isPremiumAllowed, loadFaceReference, miniMaxEdit, openAIAnalyzeOutfitStyle, openAIEdit, readAiMode, resolveApiKey, resolveModeledModel, resolveProvider } from "./import-job-api.mjs";

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

function normalizeOutfit(value = {}, existing = null) {
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 120) : "";
  const itemIds = Array.isArray(value.itemIds) ? value.itemIds.filter((id) => typeof id === "string").slice(0, 12) : [];
  if (!name) throw Object.assign(new Error("An outfit name is required"), { status: 400 });
  if (!itemIds.length) throw Object.assign(new Error("An outfit needs at least one item"), { status: 400 });
  const itemsChanged = existing && JSON.stringify([...existing.itemIds].sort()) !== JSON.stringify([...itemIds].sort());
  return {
    id: existing?.id || randomUUID(),
    name,
    itemIds,
    // A changed lineup invalidates any existing model photo — it was generated from the old set of pieces.
    modeledImage: itemsChanged ? null : existing?.modeledImage || null,
    modeledStatus: itemsChanged ? null : existing?.modeledStatus || null,
    modeledError: itemsChanged ? null : existing?.modeledError || null,
    modeledTier: itemsChanged ? null : existing?.modeledTier || null,
    description: itemsChanged ? null : existing?.description || null,
    tags: itemsChanged ? [] : existing?.tags || [],
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
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const miniMaxBaseUrl = () => setting("MINIMAX_API_BASE_URL", "https://api.minimax.io/v1").replace(/\/$/, "");
  const currentMode = () => readAiMode(dataDir);

  async function loadOutfits() {
    try { return JSON.parse(await readFile(outfitsFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function generateModeledForOutfit(id, { tier, prompt }) {
    if (running.has(id)) return running.get(id);
    const task = (async () => {
      try {
        const { provider } = resolveProvider(setting);
        const mode = await currentMode();
        const { key, keyName } = resolveApiKey(setting, provider, mode);
        if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
        if (tier === "premium" && !isPremiumAllowed(provider, mode)) {
          throw new Error("Premium quality needs PROD mode — the free TEST key has no billing enabled for Nano Banana 2. Switch to PROD to generate this.");
        }
        const outfits = await loadOutfits();
        const outfit = outfits.find((item) => item.id === id);
        if (!outfit) throw new Error("Outfit not found");
        const garments = [];
        for (const itemId of outfit.itemIds) {
          try {
            garments.push({ data: await readFile(path.join(libraryAssetDir, `${itemId}-garment.png`)), mime: "image/png", name: `${itemId}.png` });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        if (!garments.length) throw new Error("None of this outfit's pieces have a garment image to work from");
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
        const basePrompt = options.modeledPrompt || buildModeledPrompt(garments.length, { hasFaceReference: Boolean(face) });
        const modeledPrompt = prompt ? `${basePrompt}\nUser regeneration direction: ${prompt}` : basePrompt;
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
        } else {
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: resolved.model, quality: resolved.quality, size: "1536x1024", images: [...referenceImages, ...garments], prompt: modeledPrompt });
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
          // Neither Gemini's nor MiniMax's setup here has a text/vision analysis path proven out for this
          // free-form task, so style analysis always uses OpenAI vision, falling back to it for minimax too.
          const styleProvider = provider === "gemini" ? "gemini" : "openai";
          const styleKey = styleProvider === "gemini" ? key : setting("OPENAI_API_KEY");
          if (!styleKey) throw new Error("no vision API key configured for outfit style analysis");
          const style = styleProvider === "gemini"
            ? await geminiAnalyzeOutfitStyle({ key: styleKey, model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"), image: bytes, mime: "image/png" })
            : await openAIAnalyzeOutfitStyle({ key: styleKey, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: bytes, mime: "image/png" });
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
        return json(res, 200, await loadOutfits());
      }
      if (url.pathname === "/api/outfits" && req.method === "POST") {
        const input = await body(req);
        const outfit = normalizeOutfit(input);
        const outfits = await loadOutfits();
        await atomicJson(outfitsFile, [...outfits, outfit]);
        return json(res, 201, outfit);
      }
      const match = url.pathname.match(/^\/api\/outfits\/([a-f0-9-]{36})$/i);
      if (match && (req.method === "PATCH" || req.method === "PUT")) {
        const outfits = await loadOutfits();
        const existing = outfits.find((outfit) => outfit.id === match[1]);
        if (!existing) return json(res, 404, { error: "Outfit not found" });
        const input = await body(req);
        const updated = normalizeOutfit({ ...existing, ...input }, existing);
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
        const setup = await checkSetup(root, setting, await currentMode());
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && `${setup.keyName} in .env for ${setup.mode.toUpperCase()} mode`,
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const tier = input.tier === "premium" ? "premium" : "standard";
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
