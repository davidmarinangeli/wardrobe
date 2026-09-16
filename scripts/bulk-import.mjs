import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicJson,
  buildGarmentPrompt,
  buildModeledPrompt,
  chooseChromaKey,
  cropDetectedItem,
  detectBorderColor,
  geminiAnalyze,
  geminiEdit,
  normalizeImage,
  normalizeMetadata,
  openAIAnalyze,
  openAIImage,
  openAIImageOptions,
  openRouterEdit,
  removeChromaBackground,
  removeUnwornGarmentBackground,
} from "./import-job-api.mjs";
import { migrateLibrary, normalizeItemV2, normalizeReference, variantIdFor } from "../shared/wardrobe-model.mjs";

// This script reads configuration straight from process.env rather than the app's settings
// store, so shape it like the setting() lookups the shared helpers expect.
const envSetting = (name, fallback = "") => process.env[name] || fallback;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".gif", ".avif"]);
const SKIPPED_EXTENSIONS = new Set([".heic", ".heif"]);
function printHelp() {
  console.log(`Bulk-import clothes from a folder of photos into this Wardrobe.

Usage:
  node --env-file=.env scripts/bulk-import.mjs --input <folder> [options]

Options:
  --input <folder>      Folder of outfit/garment photos to import (required)
  --dry-run             Detect and generate, but don't write to the wardrobe
  --prepare             Generate a reviewable v2 manifest and assets; does not touch the wardrobe
  --apply                Apply an approved manifest prepared by an earlier run
  --manifest <file>     Manifest path for --prepare/--apply (required for --apply)
  --items <directory>   Prepared cutout directory for --apply (defaults beside manifest)
  --limit <n>           Only process the first n photos found (for a cheap test run)
  --concurrency <n>     Parallel API requests during detection/generation (default 3)
  --no-modeled          Skip generating modeled photos even if data/model-reference.png exists
  -h, --help            Show this help

Uses the same AI_PROVIDER and provider-specific settings as .env for the web app.`);
}

function parseArgs(argv) {
  const args = { concurrency: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") args.input = argv[++index];
    else if (arg === "--items") args.items = argv[++index];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--prepare") args.prepare = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--manifest") args.manifest = argv[++index];
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++index]);
    else if (arg === "--no-modeled") args.noModeled = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
  }
  return args;
}

function safeSlug(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "item").slice(0, 90);
}

const MANIFEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Compatibility only: manifests written before importId used the cutout hash
// as their record identity. New manifests always take the importId branch and
// must remain independent even when their PNG bytes are equal.
function legacyImportUuid(bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function validateManifestId(id, label) {
  if (typeof id !== "string" || !MANIFEST_ID.test(id)) {
    throw new Error(`${label} id contains invalid characters`);
  }
  return id;
}

export async function applyPreparedManifest({ manifestFile, itemsDir, modeledDir, dataDir }) {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.version !== 2 || !Array.isArray(manifest.items)) throw new Error("Manifest must be a v2 object with an items array");
  const accepted = manifest.items.filter((item) => item.status === "accepted");
  if (!accepted.length) throw new Error("Manifest contains no accepted items");
  const importedDir = path.join(dataDir, "imported");
  const libraryFile = path.join(dataDir, "library.json");
  await mkdir(importedDir, { recursive: true });
  const current = JSON.parse(await readFile(libraryFile, "utf8").catch((error) => error.code === "ENOENT" ? "[]" : Promise.reject(error)));
  const migrated = migrateLibrary(current).items;
  const next = [...migrated];
  const prepared = [];
  const imported = [];
  const importIds = new Set();
  for (const item of accepted) {
    const primary = item.variants?.[0] || item;
    const fileName = primary.file || item.file;
    if (!fileName) throw new Error(`${item.name || "item"}: variant file is missing`);
    const source = path.resolve(itemsDir, fileName);
    if (path.dirname(source) !== path.resolve(itemsDir) || !(await stat(source)).isFile()) throw new Error(`${item.name || fileName}: cutout is missing`);
    const bytes = await readFile(source);
    const importId = item.importId === undefined
      ? legacyImportUuid(bytes)
      : validateManifestId(item.importId, "Import");
    if (importIds.has(importId)) throw new Error(`Duplicate importId "${importId}"`);
    importIds.add(importId);
    const id = `import-${importId}`;
    const existingIndex = next.findIndex((entry) => entry.id === id);
    const existingRecord = existingIndex === -1 ? null : next[existingIndex];
    const variants = (item.variants?.length ? item.variants : [{ id: `${safeSlug(item.slug || item.name || "item")}-standard`, name: "Standard", origin: "photo", file: item.file, modeledFile: item.modeledFile, tags: item.tags, sourceRefs: item.sourceRefs }]).map((variant, index) => {
      const variantFile = variant.file || (index === 0 ? item.file : null);
      if (!variantFile) throw new Error(`${item.name || id}: every variant needs a file`);
      const variantId = validateManifestId(variant.id || variantIdFor(id, variant.name || `variant-${index + 1}`), "Variant");
      return { ...variant, id: variantId, name: variant.name || "Standard", file: variantFile, modeledFile: variant.modeledFile || null };
    });
    const variantIds = new Set();
    for (const variant of variants) {
      if (variantIds.has(variant.id)) throw new Error(`Duplicate variant id "${variant.id}"`);
      variantIds.add(variant.id);
    }
    if (variants.length !== 1 || variants[0].name !== "Standard") {
      throw new Error(`${item.name || id}: import manifests must contain exactly one Standard variant`);
    }
    const references = (Array.isArray(item.references) ? item.references : [])
      .map((reference, index) => normalizeReference(reference, index, id));
    const referenceIds = new Set();
    for (const reference of references) {
      validateManifestId(reference.id, "Reference");
      if (referenceIds.has(reference.id)) throw new Error(`Duplicate reference id "${reference.id}"`);
      referenceIds.add(reference.id);
    }
    for (const variant of variants) {
      const variantSource = path.resolve(itemsDir, variant.file);
      if (path.dirname(variantSource) !== path.resolve(itemsDir) || !(await stat(variantSource)).isFile()) throw new Error(`${item.name || id}: variant ${variant.name} cutout is missing`);
      await readFile(variantSource);
      if (variant.modeledFile) {
        if (!modeledDir) throw new Error(`${item.name || id}: --modeled is required for modeled variants`);
        const modeledSource = path.resolve(modeledDir, variant.modeledFile);
        if (path.dirname(modeledSource) !== path.resolve(modeledDir) || !(await stat(modeledSource)).isFile()) throw new Error(`${item.name || id}: modeled variant is missing`);
        await readFile(modeledSource);
      }
    }
    prepared.push({ item: { ...item, importId }, id, existingIndex, existingRecord, variants, references });
  }
  for (const { item, id, existingIndex, existingRecord, variants, references } of prepared) {
    const recordVariants = [];
    for (const variant of variants) {
      const variantSource = path.resolve(itemsDir, variant.file);
      const assetName = `${id}-${variant.id}-garment.png`.replace(/[^a-zA-Z0-9._-]/g, "-");
      await copyFile(variantSource, path.join(importedDir, assetName));
      let modeledImage = null;
      if (variant.modeledFile) {
        const modeledSource = path.resolve(modeledDir, variant.modeledFile);
        const modeledName = `${id}-${variant.id}-modeled.png`.replace(/[^a-zA-Z0-9._-]/g, "-");
        await copyFile(modeledSource, path.join(importedDir, modeledName));
        modeledImage = `/api/import/library/${modeledName}`;
      }
      const asset = `/api/import/library/${assetName}`;
      const previousVariant = existingRecord?.variants?.find((candidate) => candidate.id === variant.id);
      recordVariants.push(normalizeItemV2({ id, part: item.part, color: item.color, secondaryColor: item.secondaryColor, tags: item.tags, name: item.name, defaultVariantId: variants[0].id, variants: [{ ...variant, createdAt: previousVariant?.createdAt, updatedAt: previousVariant?.updatedAt, image: asset, thumbnail: asset, modeledImage, cutout: { image: asset, thumbnail: asset, revision: variant.assetRevision || 1, status: "current" }, modeledPhoto: modeledImage ? { image: modeledImage, status: "approved", revision: variant.assetRevision || 1 } : null, approvalStatus: "approved" }], references }).variants[0]);
    }
    const record = normalizeItemV2({ id, name: item.name, part: item.part, color: item.color, secondaryColor: item.secondaryColor, defaultVariantId: recordVariants[0].id, variants: recordVariants, references, importJobId: id.replace(/^import-/, ""), createdAt: existingRecord?.createdAt, updatedAt: existingRecord?.updatedAt });
    if (existingIndex === -1) next.push(record); else next[existingIndex] = record;
    imported.push({ id, name: record.name, variants: record.variants.length });
  }
  await mkdir(dataDir, { recursive: true });
  await atomicJson(libraryFile, next);
  return { imported, total: next.length, library: libraryFile };
}

export async function writePreparedManifest({ generated, manifestFile }) {
  const manifestDir = path.dirname(path.resolve(manifestFile));
  const itemsDir = path.join(manifestDir, "items");
  const modeledDir = path.join(manifestDir, "modeled");
  const entries = [];
  const usedImportIds = new Set();
  for (const entry of generated) {
    const importId = entry.importId === undefined ? randomUUID() : validateManifestId(entry.importId, "Import");
    if (usedImportIds.has(importId)) throw new Error(`Duplicate importId "${importId}"`);
    usedImportIds.add(importId);
    entries.push({ ...entry, importId });
  }
  await mkdir(itemsDir, { recursive: true });
  await mkdir(modeledDir, { recursive: true });
  const items = [];
  const usedSlugs = new Set();
  for (const entry of entries) {
    const baseSlug = safeSlug(entry.metadata.name);
    let slug = baseSlug;
    let suffix = 2;
    while (usedSlugs.has(slug)) slug = `${baseSlug}-${suffix++}`;
    usedSlugs.add(slug);
    const { importId } = entry;
    const file = `${slug}.png`;
    await writeFile(path.join(itemsDir, file), entry.garmentBuffer);
    let modeledFile = null;
    if (entry.modeledBuffer) { modeledFile = `${slug}.png`; await writeFile(path.join(modeledDir, modeledFile), entry.modeledBuffer); }
    items.push({
      slug,
      importId,
      name: entry.metadata.name,
      part: entry.metadata.part,
      color: entry.metadata.color,
      secondaryColor: entry.metadata.secondaryColor,
      tags: entry.metadata.tags,
      status: "accepted",
      sourceRefs: entry.sourceFiles,
      variants: [{ id: `${slug}-standard`, name: "Standard", description: "Source presentation", origin: "photo", file, modeledFile, tags: entry.metadata.tags, sourceRefs: entry.sourceFiles, approvalStatus: "approved", assetRevision: 1 }],
      references: entry.sourceFiles.map((source, index) => ({ id: `${slug}-reference-${index + 1}`, original: source, role: "view", scope: "item", label: source, distinctive: false, revision: 1 })),
    });
  }
  await writeFile(manifestFile, `${JSON.stringify({ version: 2, status: "prepared", createdAt: new Date().toISOString(), items }, null, 2)}\n`);
  return { manifestFile: path.resolve(manifestFile), itemsDir, modeledDir, count: items.length };
}

export function createIndependentCandidates(items) {
  return items.map((item) => ({ ...item, importId: randomUUID() }));
}

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

async function discoverImages(inputDir) {
  const entries = await readdir(inputDir, { withFileTypes: true });
  const skipped = entries.filter((entry) => entry.isFile() && SKIPPED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  if (skipped.length) console.warn(`Skipping ${skipped.length} HEIC/HEIF photo(s) — convert to JPEG or PNG first.`);
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputDir, entry.name))
    .sort();
}

async function detectPhotoItems({ provider, key, baseUrl, filePath }) {
  const raw = await readFile(filePath);
  const normalized = await normalizeImage(raw);
  const detected = provider === "gemini"
    ? await geminiAnalyze({ key, model: process.env.GEMINI_VISION_MODEL || "gemini-3.6-flash", image: normalized, mime: "image/png" })
    : await openAIAnalyze({ key, baseUrl, model: provider === "openrouter" ? process.env.OPENROUTER_VISION_MODEL || "openai/gpt-5.4-mini" : process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini", image: normalized, mime: "image/png" });
  const items = [];
  for (const rawItem of detected) {
    const metadata = normalizeMetadata(rawItem);
    const crop = await cropDetectedItem(normalized, metadata.boundingBox);
    items.push({ sourceFile: path.basename(filePath), metadata, crop });
  }
  return items;
}

async function generateGarmentCutout({ provider, key, baseUrl, item }) {
  // An unworn product photo's pixels are already correct — segment it out of whatever
  // background it's actually on instead of asking the AI edit model to repaint the garment.
  if (item.metadata.worn === false) return removeUnwornGarmentBackground(item.crop, { rotationDegrees: item.metadata.rotationDegrees });
  const requestedChromaKey = chooseChromaKey(item.metadata.color);
  const prompt = buildGarmentPrompt(item.metadata, requestedChromaKey);
  const source = { data: item.crop, mime: "image/png", name: "source.png" };
  let rawBytes;
  if (provider === "gemini") {
    rawBytes = await geminiEdit({ key, model: process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image", imageSize: process.env.GEMINI_IMAGE_SIZE || "1K", size: "1024x1024", images: [source], prompt });
  } else if (provider === "openrouter") {
    rawBytes = await openRouterEdit({ key, baseUrl, model: process.env.OPENROUTER_GARMENT_MODEL || process.env.OPENROUTER_IMAGE_MODEL || "openai/gpt-image-2", quality: process.env.OPENROUTER_IMAGE_QUALITY || "high", size: "1024x1024", images: [source], prompt });
  } else {
    rawBytes = await openAIImage({ ...openAIImageOptions(envSetting), key, baseUrl, model: process.env.OPENAI_GARMENT_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", quality: process.env.OPENAI_IMAGE_QUALITY || "high", size: "1024x1024", images: [source], prompt });
  }
  const actualChromaKey = provider === "openai" ? requestedChromaKey : await detectBorderColor(rawBytes);
  return removeChromaBackground(rawBytes, actualChromaKey);
}

async function generateModeledPhoto({ provider, key, baseUrl, garmentBuffer, modelBuffer, faceBuffer, metadata }) {
  const model = { data: modelBuffer, mime: "image/png", name: "model.png" };
  const garment = { data: garmentBuffer, mime: "image/png", name: "garment.png" };
  const face = faceBuffer ? { data: faceBuffer, mime: "image/png", name: "model-face.png" } : null;
  const referenceImages = face ? [model, face] : [model];
  const prompt = buildModeledPrompt([{ name: metadata?.name, tags: metadata?.tags }], { hasFaceReference: Boolean(face) });
  if (provider === "gemini") {
    return geminiEdit({ key, model: process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image", imageSize: process.env.GEMINI_IMAGE_SIZE || "1K", size: "1536x1024", images: [...referenceImages, garment], prompt });
  }
  if (provider === "openrouter") {
    return openRouterEdit({ key, baseUrl, model: process.env.OPENROUTER_MODELED_MODEL || process.env.OPENROUTER_IMAGE_MODEL || "openai/gpt-image-2", quality: process.env.OPENROUTER_IMAGE_QUALITY || "high", size: "1536x1024", images: [...referenceImages, garment], prompt });
  }
  return openAIImage({ ...openAIImageOptions(envSetting), key, baseUrl, model: process.env.OPENAI_MODELED_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", quality: process.env.OPENAI_IMAGE_QUALITY || "high", size: "1536x1024", images: [...referenceImages, garment], prompt });
}

async function writeLibraryItem({ libraryAssetDir, id, importId, metadata, garmentBuffer, modeledBuffer }) {
  await mkdir(libraryAssetDir, { recursive: true });
  const garmentName = `${id}-garment.png`;
  await writeFile(path.join(libraryAssetDir, garmentName), garmentBuffer);
  let modeledImage = null;
  if (modeledBuffer) {
    const modeledName = `${id}-modeled.png`;
    await writeFile(path.join(libraryAssetDir, modeledName), modeledBuffer);
    modeledImage = `/api/import/library/${modeledName}`;
  }
  const image = `/api/import/library/${garmentName}`;
  const variantId = variantIdFor(id);
  return normalizeItemV2({
    schemaVersion: 2,
    id,
    name: metadata.name,
    part: metadata.part,
    color: metadata.color,
    secondaryColor: metadata.secondaryColor,
    palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
    tags: metadata.tags,
    image,
    thumbnail: image,
    modeledImage,
    importJobId: importId,
    defaultVariantId: variantId,
    variants: [{ id: variantId, name: "Standard", origin: "photo", image, thumbnail: image, modeledImage, tags: metadata.tags, approvalStatus: "approved", assetRevision: 1 }],
  });
}

async function appendToLibrary(importedFile, records) {
  let current = [];
  try {
    current = JSON.parse(await readFile(importedFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicJson(importedFile, [...current, ...records]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.input && !args.apply)) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = path.resolve(root, process.env.WARDROBE_DATA_DIR || "data");
  if (args.apply) {
    if (!args.manifest) throw new Error("--manifest is required with --apply");
    const manifestFile = path.resolve(args.manifest);
    const manifestRoot = path.dirname(manifestFile);
    const result = await applyPreparedManifest({
      manifestFile,
      itemsDir: path.resolve(args.items || path.join(manifestRoot, "items")),
      modeledDir: args.modeled ? path.resolve(args.modeled) : path.join(manifestRoot, "modeled"),
      dataDir,
    });
    console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
    return;
  }
  const libraryAssetDir = path.join(dataDir, "imported");
  const importedFile = path.join(dataDir, "library.json");
  const modelReferencePath = path.resolve(root, process.env.WARDROBE_MODEL_REFERENCE || "data/model-reference.png");
  const faceReferencePath = path.resolve(root, process.env.WARDROBE_FACE_REFERENCE || "data/model-reference-face.png");

  const provider = ["openai", "openrouter", "gemini"].includes(process.env.AI_PROVIDER) ? process.env.AI_PROVIDER : "openai";
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
  const key = process.env[keyName];
  if (!key) {
    console.error(`Missing ${keyName}. Set it in .env, then run with:\n  node --env-file=.env scripts/bulk-import.mjs --input <folder>`);
    process.exit(1);
  }
  const baseUrl = (provider === "openrouter"
    ? process.env.OPENROUTER_API_BASE_URL || "https://openrouter.ai/api/v1"
    : process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

  const inputDir = path.resolve(args.input);
  let files;
  try {
    files = await discoverImages(inputDir);
  } catch (error) {
    console.error(`Could not read ${inputDir}: ${error.message}`);
    process.exit(1);
  }
  if (!files.length) {
    console.error(`No supported image files found in ${inputDir}.`);
    process.exit(1);
  }
  if (args.limit) files = files.slice(0, args.limit);

  console.log(`Found ${files.length} photo(s) in ${inputDir}. Using ${provider} for detection and generation.`);

  const limit = createLimiter(Math.max(1, args.concurrency || 3));

  const allItems = [];
  let processedPhotos = 0;
  await Promise.all(files.map((filePath) => limit(async () => {
    try {
      const items = await detectPhotoItems({ provider, key, baseUrl, filePath });
      allItems.push(...createIndependentCandidates(items));
      processedPhotos += 1;
      console.log(`[${processedPhotos}/${files.length}] ${path.basename(filePath)} — detected ${items.length} item(s)`);
    } catch (error) {
      processedPhotos += 1;
      console.warn(`[${processedPhotos}/${files.length}] ${path.basename(filePath)} — detection failed: ${error.message}`);
    }
  })));

  if (!allItems.length) {
    console.error("No clothing items were detected in any photo.");
    process.exit(1);
  }
  console.log(`\nDetected ${allItems.length} independent item(s) across ${files.length} photo(s).`);

  let modelBuffer = null;
  let faceBuffer = null;
  if (!args.noModeled) {
    try {
      modelBuffer = await readFile(modelReferencePath);
    } catch {
      console.log(`No model reference found at ${modelReferencePath} — skipping modeled photos, cutouts only.`);
    }
    if (modelBuffer) {
      try {
        faceBuffer = await readFile(faceReferencePath);
        console.log(`Using face closeup at ${faceReferencePath} for extra identity consistency.`);
      } catch {
        // Optional — falls back to the full-body reference alone.
      }
    }
  }

  const generated = [];
  const failed = [];
  let processedItems = 0;
  await Promise.all(allItems.map((item) => limit(async () => {
    const sourceFiles = [item.sourceFile];
    try {
      const garmentBuffer = await generateGarmentCutout({ provider, key, baseUrl, item });
      let modeledBuffer = null;
      if (modelBuffer) {
        try {
          modeledBuffer = await generateModeledPhoto({ provider, key, baseUrl, garmentBuffer, modelBuffer, faceBuffer, metadata: item.metadata });
        } catch (error) {
          console.warn(`  Modeled photo failed for "${item.metadata.name}": ${error.message} (keeping the cutout)`);
        }
      }
      processedItems += 1;
      console.log(`[${processedItems}/${allItems.length}] Generated "${item.metadata.name}" (from ${sourceFiles.join(", ")})`);
      generated.push({ importId: item.importId, metadata: item.metadata, garmentBuffer, modeledBuffer, sourceFiles });
    } catch (error) {
      processedItems += 1;
      console.warn(`[${processedItems}/${allItems.length}] Failed "${item.metadata.name}": ${error.message}`);
      failed.push({ importId: item.importId, metadata: item.metadata, sourceFiles, error: error.message });
    }
  })));

  console.log(`\n${generated.length} item(s) generated, ${failed.length} failed.`);

  if (args.prepare) {
    const manifestFile = path.resolve(args.manifest || path.join(inputDir, "wardrobe-manifest-v2.json"));
    const prepared = await writePreparedManifest({ generated, manifestFile });
    console.log(JSON.stringify({ mode: "prepare", ...prepared, failed: failed.map((item) => ({ name: item.metadata.name, sourceFiles: item.sourceFiles, error: item.error })) }, null, 2));
    return;
  }

  if (args.dryRun) {
    console.log("\nDry run — nothing written. Would have imported:");
    generated.forEach((item) => console.log(`  - ${item.metadata.name} (${item.metadata.part}, ${item.metadata.color}) from ${item.sourceFiles.join(", ")}`));
    return;
  }

  const records = [];
  for (const item of generated) {
    const importId = item.importId || randomUUID();
    const id = `import-${importId}`;
    records.push(await writeLibraryItem({ libraryAssetDir, id, importId, metadata: item.metadata, garmentBuffer: item.garmentBuffer, modeledBuffer: item.modeledBuffer }));
  }
  await mkdir(dataDir, { recursive: true });
  await appendToLibrary(importedFile, records);

  console.log(`\nImported ${records.length} item(s) into ${importedFile}.`);
  if (failed.length) {
    console.log(`Skipped ${failed.length} item(s):`);
    failed.forEach((item) => console.log(`  - ${item.metadata.name} (${item.sourceFiles.join(", ")}): ${item.error}`));
  }
  console.log("Restart the dev server if it's already running, then check the gallery.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
