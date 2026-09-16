import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  atomicJson,
  buildGarmentPrompt,
  buildModeledPrompt,
  checkSetup,
  chooseChromaKey,
  cropDetectedItem,
  detectBorderColor,
  geminiAnalyze,
  geminiEdit,
  isPremiumAllowed,
  loadFaceReference,
  miniMaxEdit,
  normalizeImage,
  normalizeMetadata,
  openAIAnalyze,
  openAIImage,
  openAIImageOptions,
  openRouterEdit,
  readAiMode,
  removeChromaBackground,
  removeUnwornGarmentBackground,
  resolveApiKey,
  resolveModeledModel,
  resolveOpenAICompatibleBaseUrl,
  resolveProvider,
} from "./import-job-api.mjs";
import {
  migrateOutfit,
  normalizeItemV2,
  normalizeReference,
  normalizeVariant,
  markVariantAssetsStale,
  variantApprovedImage,
  variantIdFor,
} from "../shared/wardrobe-model.mjs";
import { migrateDataDirectory } from "./wardrobe-data.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function clientId(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw Object.assign(new Error(`${label} id contains invalid characters`), { status: 400 });
  }
  return value;
}

function markReferenceChangeStale(item, changedReferences) {
  const references = (Array.isArray(changedReferences) ? changedReferences : [changedReferences]).filter(Boolean);
  if (!references.length) return normalizeItemV2(item);
  if (references.some((reference) => reference.scope !== "variant" || !reference.variantId)) {
    // The shared helper resolves references by id; this synthetic item-scoped
    // reference preserves old scope when a reference is moved or deleted.
    return markVariantAssetsStale(item, { id: `changed-${randomUUID()}`, scope: "item" });
  }
  return [...new Set(references.map((reference) => reference.variantId))]
    .reduce((next, variantId) => markVariantAssetsStale(next, { id: `changed-${randomUUID()}`, scope: "variant", variantId }), item);
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 32 * 1024 * 1024) {
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

function decodeImage(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/is);
  if (!match) throw Object.assign(new Error("imageDataUrl must contain a PNG, JPG, or WebP image"), { status: 400 });
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return bytes;
}

export function parseVariantRoute(pathname) {
  const match = pathname.match(/^\/api\/wardrobe\/items\/([^/]+)(?:(?:\/variants(?:\/([^/]+)(?:\/(default|modeled))?)?)|(?:\/references(?:\/([^/]+))?)|(?:\/(default-variant)))?$/);
  if (!match) return null;
  return { itemId: decodeURIComponent(match[1]), variantId: match[2] ? decodeURIComponent(match[2]) : null, action: match[3] || (match[5] === "default-variant" ? "default-variant" : null), referenceId: match[4] ? decodeURIComponent(match[4]) : null, variantsCollection: pathname.includes("/variants") && !match[2], referencesCollection: pathname.includes("/references") && !match[4] };
}

function replaceItem(items, next) {
  return items.map((item) => item.id === next.id ? normalizeItemV2(next) : item);
}

export function variantApi(options = {}) {
  let root;
  let dataDir;
  let libraryFile;
  let outfitsFile;
  let libraryAssetDir;
  const running = new Map();
  const runningPipelines = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const currentMode = () => readAiMode(dataDir);
  const providerBase = (provider) => resolveOpenAICompatibleBaseUrl(setting, provider);

  async function loadItems() {
    const value = JSON.parse(await readFile(libraryFile, "utf8").catch((error) => error.code === "ENOENT" ? "[]" : Promise.reject(error)));
    return value.map((item) => normalizeItemV2(item)).filter(Boolean);
  }

  async function loadOutfits(items) {
    const value = JSON.parse(await readFile(outfitsFile, "utf8").catch((error) => error.code === "ENOENT" ? "[]" : Promise.reject(error)));
    return value.map((outfit) => migrateOutfit(outfit, items));
  }

  async function saveItems(items) { await atomicJson(libraryFile, items.map((item) => normalizeItemV2(item))); }
  async function saveOutfits(outfits) { await atomicJson(outfitsFile, outfits); }

  async function writeAsset(bytes, basename) {
    await mkdir(libraryAssetDir, { recursive: true });
    const normalized = await sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
    await writeFile(path.join(libraryAssetDir, basename), normalized);
    return `/api/import/library/${basename}`;
  }

  async function analyzeGarment(bytes, provider, mode) {
    const visionProvider = provider === "minimax" ? "openai" : provider;
    const { key, keyName } = resolveApiKey(setting, visionProvider, mode);
    if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
    const image = await normalizeImage(bytes);
    const detected = visionProvider === "gemini"
      ? await geminiAnalyze({ key, model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"), image, mime: "image/png" })
      : await openAIAnalyze({
        key,
        baseUrl: providerBase(visionProvider),
        model: visionProvider === "openrouter" ? setting("OPENROUTER_VISION_MODEL", "openai/gpt-5.4-mini") : setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
        image,
        mime: "image/png",
      });
    return { image, detected };
  }

  async function createCutout({ source, metadata, provider, key, tier, direction = "" }) {
    if (metadata.worn === false && !direction) {
      return removeUnwornGarmentBackground(source, { rotationDegrees: metadata.rotationDegrees });
    }
    const chromaKey = chooseChromaKey(metadata.color);
    const basePrompt = buildGarmentPrompt(metadata, chromaKey);
    const prompt = direction
      ? `${basePrompt}\nRequested usage variation: ${direction}\nApply exactly this presentation change while preserving the identity, fabric, color, construction, and every unrelated detail of the source garment.`
      : basePrompt;
    const reference = { data: source, mime: "image/png", name: "variant-source.png" };
    const resolved = resolveModeledModel(provider, tier, setting);
    let generated;
    if (provider === "gemini") {
      generated = await geminiEdit({ key, model: resolved.model, imageSize: resolved.imageSize, size: "1024x1024", images: [reference], prompt });
    } else if (provider === "minimax") {
      const seedValue = setting("MINIMAX_IMAGE_SEED").trim();
      generated = await miniMaxEdit({
        key,
        baseUrl: setting("MINIMAX_API_BASE_URL", "https://api.minimax.io/v1").replace(/\/$/, ""),
        model: resolved.model,
        prompt,
        images: [reference],
        size: "1024x1024",
        aspectRatio: setting("MINIMAX_IMAGE_ASPECT_RATIO"),
        responseFormat: setting("MINIMAX_IMAGE_RESPONSE_FORMAT", "base64"),
        promptOptimizer: setting("MINIMAX_PROMPT_OPTIMIZER") === "true",
        seed: /^-?\d+$/.test(seedValue) ? Number(seedValue) : undefined,
      });
    } else if (provider === "openrouter") {
      generated = await openRouterEdit({ key, baseUrl: providerBase(provider), model: resolved.model, quality: resolved.quality, size: "1024x1024", images: [reference], prompt });
    } else {
      generated = await openAIImage({ ...openAIImageOptions(setting), key, baseUrl: providerBase(provider), model: resolved.model, quality: resolved.quality, size: "1024x1024", images: [reference], prompt });
    }
    const actualKey = provider === "openai" ? chromaKey : await detectBorderColor(generated);
    return removeChromaBackground(generated, actualKey);
  }

  function findItem(items, itemId) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) throw Object.assign(new Error("Wardrobe item not found"), { status: 404 });
    return item;
  }

  function findVariant(item, variantId) {
    const variant = item.variants.find((candidate) => candidate.id === variantId);
    if (!variant) throw Object.assign(new Error("Variant not found"), { status: 404 });
    return variant;
  }

  async function generateVariant(itemId, variantId, { tier, prompt }) {
    const lock = `${itemId}:${variantId}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      try {
        const items = await loadItems();
        const item = findItem(items, itemId);
        const variant = findVariant(item, variantId);
        const image = variantApprovedImage(item, variantId);
        if (!image) throw Object.assign(new Error("This variant has no approved cutout yet"), { status: 409 });
        const garmentName = path.basename(new URL(image, "http://localhost").pathname);
        let garment;
        try {
          garment = { data: await readFile(path.join(libraryAssetDir, garmentName)), mime: "image/png", name: `${variant.id}.png` };
        } catch (error) {
          if (error.code === "ENOENT") throw Object.assign(new Error("This variant has no approved cutout yet"), { status: 409 });
          throw error;
        }
        const provider = resolveProvider(setting).provider;
        const mode = await currentMode();
        const { key, keyName } = resolveApiKey(setting, provider, mode);
        if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
        if (tier === "premium" && !isPremiumAllowed(provider, mode)) throw new Error("Premium quality needs PROD mode");
        const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
        const model = { data: await readFile(modelPath), mime: "image/png", name: "model.png" };
        const face = await loadFaceReference(root, setting);
        const refs = face ? [model, face] : [model];
        // Distinctive references are evidence for this usage mode, not extra
        // clothing. Include only locally-addressable images and silently skip
        // stale/missing ones; the response records the revision used.
        const referenceRevision = (item.references || [])
          .filter((reference) => reference.distinctive && (!reference.variantId || reference.variantId === variantId))
          .map((reference) => reference.revision)
          .reduce((max, revision) => Math.max(max, revision || 1), 0);
        for (const reference of item.references || []) {
          if (!reference.distinctive || (reference.variantId && reference.variantId !== variantId)) continue;
          const referenceImage = reference.asset || reference.crop || reference.original;
          if (!referenceImage) continue;
          try {
            const name = path.basename(new URL(referenceImage, "http://localhost").pathname);
            refs.push({ data: await readFile(path.join(libraryAssetDir, name)), mime: "image/png", name });
          } catch { /* references are advisory; the cutout remains mandatory */ }
        }
        const basePrompt = buildModeledPrompt([{ name: `${item.name} — ${variant.name}`, tags: [...(item.tags || []), ...(variant.tags || []), variant.description].filter(Boolean), part: item.part }], { hasFaceReference: Boolean(face) });
        const modeledPrompt = `${basePrompt}\nUsage variant: ${variant.name}. ${variant.description || "Preserve the exact selected presentation."}\nUse distinctive references only to preserve source-supported details.${prompt ? `\nUser direction: ${prompt}` : ""}`;
        const resolved = resolveModeledModel(provider, tier, setting);
        let bytes;
        if (provider === "gemini") bytes = await geminiEdit({ key, model: resolved.model, imageSize: resolved.imageSize, size: "1536x1024", images: [...refs, garment], prompt: modeledPrompt });
        else if (provider === "minimax") bytes = await miniMaxEdit({ key, baseUrl: setting("MINIMAX_API_BASE_URL", "https://api.minimax.io/v1").replace(/\/$/, ""), model: resolved.model, prompt: modeledPrompt, images: [...refs, garment], size: "1536x1024", responseFormat: setting("MINIMAX_IMAGE_RESPONSE_FORMAT", "base64") });
        else if (provider === "openrouter") bytes = await openRouterEdit({ key, baseUrl: providerBase(provider), model: resolved.model, quality: resolved.quality, size: "1536x1024", images: [...refs, garment], prompt: modeledPrompt });
        else bytes = await openAIImage({ ...openAIImageOptions(setting), key, baseUrl: providerBase(provider), model: resolved.model, quality: resolved.quality, size: "1536x1024", images: [...refs, garment], prompt: modeledPrompt });
        const modeledName = `${itemId}-${variantId}-modeled.png`.replace(/[^a-zA-Z0-9._-]/g, "-");
        await writeFile(path.join(libraryAssetDir, modeledName), bytes);
        const fresh = await loadItems();
        const current = findItem(fresh, itemId);
        const target = findVariant(current, variantId);
        const modeledPhoto = { ...(target.modeledPhoto || {}), image: `/api/import/library/${modeledName}`, status: "approved", error: null, tier, revision: (target.modeledPhoto?.revision || 0) + 1, sourceRevision: Math.max(target.assetRevision || 1, referenceRevision || 1) };
        target.modeledPhoto = modeledPhoto;
        target.modeledImage = modeledPhoto.image;
        target.modeledStatus = "approved";
        target.modeledError = null;
        target.modeledTier = tier;
        await saveItems(fresh);
      } catch (error) {
        try {
          const fresh = await loadItems();
          const item = findItem(fresh, itemId);
          const variant = findVariant(item, variantId);
          variant.modeledStatus = "error";
          variant.modeledError = error.message;
          variant.modeledPhoto = { ...(variant.modeledPhoto || {}), status: "error", error: error.message };
          await saveItems(fresh);
        } catch { /* preserve original generation error */ }
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function processVariant(itemId, variantId, input) {
    const lock = `${itemId}:${variantId}`;
    if (runningPipelines.has(lock)) return runningPipelines.get(lock);
    const task = (async () => {
      try {
        const provider = resolveProvider(setting).provider;
        const mode = await currentMode();
        const { key, keyName } = resolveApiKey(setting, provider, mode);
        if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);

        const initialItems = await loadItems();
        const initialItem = findItem(initialItems, itemId);
        const sourceVariant = input.sourceVariantId ? findVariant(initialItem, input.sourceVariantId) : null;
        let metadata;
        let source;

        if (input.imageData) {
          const analyzed = await analyzeGarment(input.imageData, provider, mode);
          const detected = analyzed.detected.find((candidate) => candidate.part === initialItem.part) || analyzed.detected[0];
          if (!detected) throw new Error("No garment was found in the selected photo");
          metadata = normalizeMetadata(detected);
          source = await cropDetectedItem(analyzed.image, metadata.boundingBox);
        } else {
          const sourceImage = variantApprovedImage(initialItem, sourceVariant?.id);
          if (!sourceImage) throw new Error("The source variant has no approved cutout");
          const sourceName = path.basename(new URL(sourceImage, "http://localhost").pathname);
          source = await readFile(path.join(libraryAssetDir, sourceName));
          metadata = normalizeMetadata({
            name: input.requestedName || initialItem.name,
            part: initialItem.part,
            color: initialItem.color,
            secondaryColor: initialItem.secondaryColor,
            tags: [...(initialItem.tags || []), ...(sourceVariant?.tags || [])],
            worn: true,
          });
        }

        const direction = input.imageData ? "" : [input.requestedName, input.description].filter(Boolean).join(". ");
        const cutoutBytes = await createCutout({ source, metadata, provider, key, tier: input.tier, direction });

        if (!input.imageData) {
          try {
            const analyzedCutout = await analyzeGarment(cutoutBytes, provider, mode);
            const detected = analyzedCutout.detected.find((candidate) => candidate.part === initialItem.part) || analyzedCutout.detected[0];
            if (detected) metadata = normalizeMetadata(detected);
          } catch (error) {
            console.warn(`Variant metadata analysis failed (${error.message}); keeping source metadata.`);
          }
        }

        const asset = await writeAsset(cutoutBytes, `${itemId}-${variantId}-garment.png`.replace(/[^a-zA-Z0-9._-]/g, "-"));
        const fresh = await loadItems();
        const current = findItem(fresh, itemId);
        findVariant(current, variantId);
        const enriched = {
          name: input.requestedName || metadata.name,
          description: input.description,
          tags: metadata.tags,
          part: metadata.part,
          color: metadata.color,
          secondaryColor: metadata.secondaryColor,
          worn: metadata.worn,
          rotationDegrees: metadata.rotationDegrees,
          image: asset,
          thumbnail: asset,
          cutout: { image: asset, thumbnail: asset, revision: 1, status: "current" },
          approvalStatus: "approved",
          processingStatus: "processing",
          processingStage: "modeled",
          processingError: null,
          modeledStatus: "processing",
          modeledError: null,
          modeledTier: input.tier,
          modeledPhoto: { status: "processing", error: null, tier: input.tier },
        };
        const withCutout = { ...current, variants: current.variants.map((variant) => variant.id === variantId ? { ...variant, ...enriched } : variant) };
        await saveItems(replaceItem(fresh, withCutout));

        await generateVariant(itemId, variantId, { tier: input.tier, prompt: input.description });
        const completedItems = await loadItems();
        const completedItem = findItem(completedItems, itemId);
        const completedVariant = findVariant(completedItem, variantId);
        if (completedVariant.modeledStatus !== "approved") throw new Error(completedVariant.modeledError || "Could not generate the modeled photo");
        const completed = { ...completedItem, variants: completedItem.variants.map((variant) => variant.id === variantId ? { ...variant, processingStatus: "approved", processingStage: null, processingError: null } : variant) };
        await saveItems(replaceItem(completedItems, completed));
      } catch (error) {
        try {
          const fresh = await loadItems();
          const current = findItem(fresh, itemId);
          const failed = { ...current, variants: current.variants.map((variant) => variant.id === variantId ? { ...variant, processingStatus: "error", processingStage: null, processingError: error.message } : variant) };
          await saveItems(replaceItem(fresh, failed));
        } catch { /* preserve the pipeline error */ }
      }
    })().finally(() => runningPipelines.delete(lock));
    runningPipelines.set(lock, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/wardrobe/items/")) return next();
    try {
      const route = parseVariantRoute(url.pathname);
      if (!route) return json(res, 404, { error: "Not found" });
      if (route.variantId) clientId(route.variantId, "Variant");
      if (route.referenceId) clientId(route.referenceId, "Reference");
      const items = await loadItems();
      const item = findItem(items, route.itemId);

      if (!route.variantId && !route.action && !route.referenceId && req.method === "PATCH") {
        const input = await body(req);
        const updated = normalizeItemV2({ ...item, ...input, id: item.id, variants: item.variants, references: item.references });
        await saveItems(replaceItem(items, updated));
        return json(res, 200, normalizeItemV2(updated));
      }

      if (!route.variantId && route.referenceId && req.method === "PATCH") {
        const input = await body(req);
        const index = item.references.findIndex((reference) => reference.id === route.referenceId);
        if (index === -1) return json(res, 404, { error: "Reference not found" });
        const old = item.references[index];
        const requestedVariantId = input.variantId === undefined ? old.variantId : clientId(input.variantId, "Variant");
        const scope = input.scope === undefined ? old.scope : input.scope === "variant" ? "variant" : "item";
        if (scope === "variant" && !requestedVariantId) throw Object.assign(new Error("A variant-scoped reference requires variantId"), { status: 400 });
        if (requestedVariantId) findVariant(item, requestedVariantId);
        const updatedReference = normalizeReference({ ...old, ...input, id: old.id, scope, variantId: scope === "variant" ? requestedVariantId : null, revision: old.revision }, index, item.id);
        const imageData = decodeImage(input.imageDataUrl);
        if (imageData) {
          updatedReference.asset = await writeAsset(imageData, `reference-${randomUUID()}.png`);
          updatedReference.revision = old.revision + 1;
        }
        const updated = markReferenceChangeStale({ ...item, references: item.references.map((reference, i) => i === index ? updatedReference : reference) }, [old, updatedReference]);
        await saveItems(replaceItem(items, updated));
        return json(res, 200, normalizeItemV2(updated));
      }

      if (!route.variantId && route.referenceId && req.method === "DELETE") {
        const reference = item.references.find((candidate) => candidate.id === route.referenceId);
        if (!reference) return json(res, 404, { error: "Reference not found" });
        const updated = markReferenceChangeStale({ ...item, references: item.references.filter((candidate) => candidate.id !== route.referenceId) }, reference);
        await saveItems(replaceItem(items, updated));
        return json(res, 200, normalizeItemV2(updated));
      }

      if (route.referencesCollection && !route.referenceId && req.method === "POST") {
        const input = await body(req);
        const imageData = decodeImage(input.imageDataUrl);
        const index = item.references.length;
        const referenceId = clientId(input.id, "Reference") || `${item.id}-reference-${index + 1}`;
        clientId(referenceId, "Reference");
        if (item.references.some((reference) => reference.id === referenceId)) throw Object.assign(new Error("Reference id already exists"), { status: 409 });
        const requestedVariantId = clientId(input.variantId, "Variant");
        const scope = input.scope === "variant" ? "variant" : "item";
        if (scope === "variant" && !requestedVariantId) throw Object.assign(new Error("A variant-scoped reference requires variantId"), { status: 400 });
        if (requestedVariantId) findVariant(item, requestedVariantId);
        const reference = normalizeReference({ ...input, id: referenceId, scope, variantId: scope === "variant" ? requestedVariantId : null, asset: null, revision: 1 }, index, item.id);
        if (imageData) reference.asset = await writeAsset(imageData, `reference-${randomUUID()}.png`);
        const updated = markReferenceChangeStale({ ...item, references: [...item.references, reference] }, reference);
        await saveItems(replaceItem(items, updated));
        return json(res, 201, reference);
      }

      if (route.variantsCollection && !route.referenceId && req.method === "GET") return json(res, 200, item.variants);
      if (route.referencesCollection && !route.referenceId && req.method === "GET") return json(res, 200, item.references);
      if (!route.variantId && !route.referenceId && !route.action && req.method === "GET") return json(res, 200, normalizeItemV2(item));

      if (route.variantsCollection && !route.referenceId && req.method === "POST") {
        const input = await body(req);
        const imageData = decodeImage(input.imageDataUrl);
        const requestedName = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
        const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) : "";
        if (!imageData && !requestedName && !description) throw Object.assign(new Error("Add a description or choose a photo for the variant"), { status: 400 });
        const setup = await checkSetup(root, setting, await currentMode());
        if (!setup.ready) return json(res, 503, { error: "Setup required before processing a variant" });
        const tier = input.tier === "openrouter" && setup.provider === "openrouter"
          ? "openrouter"
          : input.tier === "premium" ? "premium" : "standard";
        if (tier === "premium" && !isPremiumAllowed(setup.provider, setup.mode)) return json(res, 400, { error: "Premium quality needs PROD mode" });
        const variantId = clientId(input.id, "Variant") || variantIdFor(item.id, input.name || `variant-${item.variants.length + 1}`);
        clientId(variantId, "Variant");
        if (item.variants.some((variant) => variant.id === variantId)) throw Object.assign(new Error("Variant id already exists"), { status: 409 });
        const sourceVariantId = clientId(input.sourceVariantId, "Variant");
        const sourceVariant = sourceVariantId ? findVariant(item, sourceVariantId) : null;
        if (input.origin === "generated" && !sourceVariant) throw Object.assign(new Error("A generated variant requires sourceVariantId"), { status: 400 });
        const variant = normalizeVariant({
          ...input,
          id: variantId,
          name: requestedName || `Variant ${item.variants.length + 1}`,
          description,
          origin: imageData ? "photo" : "generated",
          sourceRefs: input.sourceRefs || (sourceVariant ? [sourceVariant.id] : []),
          image: null,
          approvalStatus: "pending",
          processingStatus: "processing",
          processingStage: "analysis",
          processingError: null,
        }, item.id, item.variants.length);
        const updated = { ...item, variants: [...item.variants, variant] };
        await saveItems(replaceItem(items, updated));
        void processVariant(item.id, variant.id, { imageData, requestedName, description, sourceVariantId, tier });
        return json(res, 202, { ...normalizeItemV2(updated), createdVariantId: variant.id });
      }

      if (route.variantId && !route.action && !route.referenceId && req.method === "PATCH") {
        const input = await body(req);
        const targetIndex = item.variants.findIndex((variant) => variant.id === route.variantId);
        if (targetIndex === -1) return json(res, 404, { error: "Variant not found" });
        const old = item.variants[targetIndex];
        const imageData = decodeImage(input.imageDataUrl);
        const updatedVariant = normalizeVariant({ ...old, ...input, id: old.id }, item.id, targetIndex);
        if (imageData) {
          const asset = await writeAsset(imageData, `${item.id}-${old.id}-garment-${Date.now()}.png`.replace(/[^a-zA-Z0-9._-]/g, "-"));
          updatedVariant.image = asset; updatedVariant.thumbnail = asset; updatedVariant.cutout = { image: asset, thumbnail: asset, revision: (old.cutout?.revision || 0) + 1, status: "current" };
          updatedVariant.modeledPhoto = updatedVariant.modeledPhoto?.image ? { ...updatedVariant.modeledPhoto, status: "stale" } : updatedVariant.modeledPhoto;
          updatedVariant.modeledStatus = updatedVariant.modeledPhoto?.image ? "stale" : updatedVariant.modeledStatus;
        }
        const updated = { ...item, variants: item.variants.map((variant, index) => index === targetIndex ? updatedVariant : variant) };
        await saveItems(replaceItem(items, updated));
        return json(res, 200, normalizeItemV2(updated));
      }

      if (route.variantId && !route.action && !route.referenceId && req.method === "DELETE") {
        const variant = findVariant(item, route.variantId);
        const input = await body(req);
        const replacementId = clientId(input.replacementVariantId, "Variant");
        const outfits = await loadOutfits(items);
        const used = outfits.some((outfit) => outfit.pieces.some((piece) => piece.itemId === item.id && piece.variantId === variant.id));
        if ((used || item.variants.length === 1 || item.defaultVariantId === variant.id) && !replacementId) throw Object.assign(new Error("replacementVariantId is required to remove this variant"), { status: 409 });
        if (replacementId) {
          findVariant(item, replacementId);
          if (replacementId === variant.id) throw Object.assign(new Error("Replacement variant must be different"), { status: 400 });
        }
        const nextVariants = item.variants.filter((candidate) => candidate.id !== variant.id);
        const updated = { ...item, variants: nextVariants, defaultVariantId: item.defaultVariantId === variant.id ? replacementId : item.defaultVariantId };
        const nextOutfits = replacementId
          ? outfits.map((outfit) => {
            const pieces = outfit.pieces.map((piece) => piece.itemId === item.id && piece.variantId === variant.id ? { ...piece, variantId: replacementId } : piece);
            if (pieces.every((piece, index) => piece.variantId === outfit.pieces[index].variantId)) return outfit;
            return {
              ...outfit,
              pieces,
              itemIds: pieces.map((piece) => piece.itemId),
              modeledImage: null,
              modeledStatus: null,
              modeledError: null,
              modeledTier: null,
              description: null,
              tags: [],
            };
          })
          : outfits;
        await saveItems(replaceItem(items, updated));
        if (replacementId && nextOutfits.some((outfit, index) => JSON.stringify(outfit) !== JSON.stringify(outfits[index]))) await saveOutfits(nextOutfits);
        return json(res, 200, { deleted: true, id: variant.id, item: normalizeItemV2(updated) });
      }

      if ((route.variantId && route.action === "default" || route.action === "default-variant") && !route.referenceId && ["PUT", "PATCH", "POST"].includes(req.method)) {
        const input = await body(req);
        const defaultId = clientId(input.variantId, "Variant") || route.variantId;
        if (!defaultId) throw Object.assign(new Error("variantId is required"), { status: 400 });
        findVariant(item, defaultId);
        const updated = { ...item, defaultVariantId: defaultId };
        await saveItems(replaceItem(items, updated));
        return json(res, 200, normalizeItemV2(updated));
      }

      if (route.variantId && route.action === "modeled" && !route.referenceId && req.method === "POST") {
        const variant = findVariant(item, route.variantId);
        if (variant.approvalStatus !== "approved") throw Object.assign(new Error("Approve this variant before generating a modeled photo"), { status: 409 });
        if (!variantApprovedImage(item, variant.id)) return json(res, 409, { error: "This variant has no approved cutout yet" });
        const setup = await checkSetup(root, setting, await currentMode());
        if (!setup.ready) return json(res, 503, { error: "Setup required before generating a variant photo" });
        const input = await body(req);
        const tier = input.tier === "openrouter" && setup.provider === "openrouter"
          ? "openrouter"
          : input.tier === "premium" ? "premium" : "standard";
        if (tier === "premium" && !isPremiumAllowed(setup.provider, setup.mode)) return json(res, 400, { error: "Premium quality needs PROD mode" });
        const updated = { ...item, variants: item.variants.map((candidate) => candidate.id === variant.id ? { ...candidate, modeledStatus: "processing", modeledError: null, modeledTier: tier, modeledPhoto: { ...(candidate.modeledPhoto || {}), status: "processing", error: null, tier } } : candidate) };
        await saveItems(replaceItem(items, updated));
        void generateVariant(item.id, variant.id, { tier, prompt: typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) : "" });
        return json(res, 202, normalizeItemV2(updated));
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error.status || (error.code === "ENOENT" ? 404 : 500);
      return json(res, status, { error: status === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-variant-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      libraryFile = path.join(dataDir, "library.json");
      outfitsFile = path.join(dataDir, "outfits.json");
      libraryAssetDir = path.join(dataDir, "imported");
      await mkdir(libraryAssetDir, { recursive: true });
      await migrateDataDirectory(dataDir);
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
