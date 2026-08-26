import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
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
  openAIEdit,
  removeChromaBackground,
  removeUnwornGarmentBackground,
} from "./import-job-api.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".gif", ".avif"]);
const SKIPPED_EXTENSIONS = new Set([".heic", ".heif"]);
const MAX_DEDUP_ITEMS = 60;

function printHelp() {
  console.log(`Bulk-import clothes from a folder of photos into this Wardrobe.

Usage:
  node --env-file=.env scripts/bulk-import.mjs --input <folder> [options]

Options:
  --input <folder>      Folder of outfit/garment photos to import (required)
  --dry-run             Detect, deduplicate, and generate, but don't write to the wardrobe
  --limit <n>           Only process the first n photos found (for a cheap test run)
  --concurrency <n>     Parallel API requests during detection/generation (default 3)
  --no-modeled          Skip generating modeled photos even if data/model-reference.png exists
  -h, --help            Show this help

Uses the same AI_PROVIDER / OPENAI_* / GEMINI_* settings as .env for the web app.`);
}

function parseArgs(argv) {
  const args = { concurrency: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") args.input = argv[++index];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++index]);
    else if (arg === "--no-modeled") args.noModeled = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
  }
  return args;
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
    : await openAIAnalyze({ key, baseUrl, model: process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini", image: normalized, mime: "image/png" });
  const items = [];
  for (const rawItem of detected) {
    const metadata = normalizeMetadata(rawItem);
    const crop = await cropDetectedItem(normalized, metadata.boundingBox);
    items.push({ sourceFile: path.basename(filePath), metadata, crop });
  }
  return items;
}

async function makeThumbnail(buffer) {
  const resized = await sharp(buffer).resize(220, 220, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return resized.toString("base64");
}

const GROUP_SCHEMA = { type: "object", properties: { groups: { type: "array", items: { type: "array", items: { type: "integer" } } } }, required: ["groups"] };

async function geminiFindDuplicates({ key, prompt, thumbnails }) {
  const parts = [{ text: prompt }, ...thumbnails.map((data) => ({ inlineData: { mimeType: "image/png", data } }))];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_VISION_MODEL || "gemini-3.6-flash"}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: GROUP_SCHEMA },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini grouping request failed (${response.status})`);
  const outputText = result.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!outputText) throw new Error("Gemini grouping returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.groups)) throw new Error("Gemini grouping returned an invalid groups array");
  return parsed.groups;
}

async function openAIFindDuplicates({ key, baseUrl, prompt, thumbnails }) {
  const content = [
    { type: "input_text", text: prompt },
    ...thumbnails.map((data) => ({ type: "input_image", image_url: `data:image/png;base64,${data}` })),
  ];
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini",
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "duplicate_groups", strict: true, schema: { type: "object", additionalProperties: false, properties: { groups: { type: "array", items: { type: "array", items: { type: "integer" } } } }, required: ["groups"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI grouping request failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI grouping returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.groups)) throw new Error("OpenAI grouping returned an invalid groups array");
  return parsed.groups;
}

export function normalizeGroups(groups, count) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    const cleaned = [...new Set(group)].filter((index) => Number.isInteger(index) && index >= 0 && index < count && !seen.has(index));
    cleaned.forEach((index) => seen.add(index));
    if (cleaned.length) result.push(cleaned);
  }
  for (let index = 0; index < count; index += 1) {
    if (!seen.has(index)) result.push([index]);
  }
  return result;
}

async function findDuplicateGroups({ provider, key, baseUrl, items }) {
  if (items.length <= 1) return items.map((_, index) => [index]);
  if (items.length > MAX_DEDUP_ITEMS) {
    console.warn(`Skipping cross-photo duplicate detection: ${items.length} items exceeds the ${MAX_DEDUP_ITEMS}-item limit for one grouping call. Every item will be imported separately.`);
    return items.map((_, index) => [index]);
  }
  const thumbnails = await Promise.all(items.map((item) => makeThumbnail(item.crop)));
  const prompt = `Each numbered image below (0 to ${items.length - 1}, in order) is a cropped clothing item automatically detected from a folder of outfit photos. Some crops may show the exact same physical garment worn on different occasions or in different lighting. Group indices that show the same physical garment together. Only group items you are confident are the same physical piece — matching construction, pattern placement, hardware, and distinctive details. When unsure, keep items in separate singleton groups; do not merge two different items just because they share a category or color. Every index from 0 to ${items.length - 1} must appear in exactly one group.`;
  try {
    const groups = provider === "gemini"
      ? await geminiFindDuplicates({ key, prompt, thumbnails })
      : await openAIFindDuplicates({ key, baseUrl, prompt, thumbnails });
    return normalizeGroups(groups, items.length);
  } catch (error) {
    console.warn(`Cross-photo duplicate detection failed (${error.message}); importing every detected item separately.`);
    return items.map((_, index) => [index]);
  }
}

async function generateGarmentCutout({ provider, key, baseUrl, item }) {
  // An unworn product photo's pixels are already correct — segment it out of whatever
  // background it's actually on instead of asking the AI edit model to repaint the garment.
  if (item.metadata.worn === false) return removeUnwornGarmentBackground(item.crop, { rotationDegrees: item.metadata.rotationDegrees });
  const requestedChromaKey = chooseChromaKey(item.metadata.color);
  const prompt = buildGarmentPrompt(item.metadata, requestedChromaKey);
  const source = { data: item.crop, mime: "image/png", name: "source.png" };
  const rawBytes = provider === "gemini"
    ? await geminiEdit({ key, model: process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image", imageSize: process.env.GEMINI_IMAGE_SIZE || "1K", size: "1024x1024", images: [source], prompt })
    : await openAIEdit({ key, baseUrl, model: process.env.OPENAI_GARMENT_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", quality: process.env.OPENAI_IMAGE_QUALITY || "high", size: "1024x1024", images: [source], prompt });
  // Gemini doesn't reliably render the exact requested chroma color, so detect whatever solid backdrop it actually used instead of trusting the request.
  const actualChromaKey = provider === "gemini" ? await detectBorderColor(rawBytes) : requestedChromaKey;
  return removeChromaBackground(rawBytes, actualChromaKey);
}

async function generateModeledPhoto({ provider, key, baseUrl, garmentBuffer, modelBuffer, faceBuffer }) {
  const model = { data: modelBuffer, mime: "image/png", name: "model.png" };
  const garment = { data: garmentBuffer, mime: "image/png", name: "garment.png" };
  const face = faceBuffer ? { data: faceBuffer, mime: "image/png", name: "model-face.png" } : null;
  const referenceImages = face ? [model, face] : [model];
  const prompt = buildModeledPrompt(1, { hasFaceReference: Boolean(face) });
  return provider === "gemini"
    ? await geminiEdit({ key, model: process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image", imageSize: process.env.GEMINI_IMAGE_SIZE || "1K", size: "1536x1024", images: [...referenceImages, garment], prompt })
    : await openAIEdit({ key, baseUrl, model: process.env.OPENAI_MODELED_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", quality: process.env.OPENAI_IMAGE_QUALITY || "high", size: "1536x1024", images: [...referenceImages, garment], prompt });
}

async function writeLibraryItem({ libraryAssetDir, id, metadata, garmentBuffer, modeledBuffer }) {
  await mkdir(libraryAssetDir, { recursive: true });
  const garmentName = `${id}-garment.png`;
  await writeFile(path.join(libraryAssetDir, garmentName), garmentBuffer);
  let modeledImage = null;
  if (modeledBuffer) {
    const modeledName = `${id}-modeled.png`;
    await writeFile(path.join(libraryAssetDir, modeledName), modeledBuffer);
    modeledImage = `/api/import/library/${modeledName}`;
  }
  return {
    id,
    name: metadata.name,
    part: metadata.part,
    color: metadata.color,
    secondaryColor: metadata.secondaryColor,
    palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
    tags: metadata.tags,
    image: `/api/import/library/${garmentName}`,
    thumbnail: `/api/import/library/${garmentName}`,
    modeledImage,
    importJobId: null,
  };
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
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = path.resolve(root, process.env.WARDROBE_DATA_DIR || "data");
  const libraryAssetDir = path.join(dataDir, "imported");
  const importedFile = path.join(dataDir, "library.json");
  const modelReferencePath = path.resolve(root, process.env.WARDROBE_MODEL_REFERENCE || "data/model-reference.png");
  const faceReferencePath = path.resolve(root, process.env.WARDROBE_FACE_REFERENCE || "data/model-reference-face.png");

  const provider = process.env.AI_PROVIDER === "gemini" ? "gemini" : "openai";
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const key = process.env[keyName];
  if (!key) {
    console.error(`Missing ${keyName}. Set it in .env, then run with:\n  node --env-file=.env scripts/bulk-import.mjs --input <folder>`);
    process.exit(1);
  }
  const baseUrl = (process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

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
      allItems.push(...items);
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
  console.log(`\nDetected ${allItems.length} item(s) total across ${files.length} photo(s). Checking for duplicates across photos...`);

  const groups = await findDuplicateGroups({ provider, key, baseUrl, items: allItems });
  const duplicatesMerged = allItems.length - groups.length;
  console.log(`Found ${groups.length} unique physical item(s)${duplicatesMerged ? ` (merged ${duplicatesMerged} duplicate detection${duplicatesMerged === 1 ? "" : "s"})` : ""}.`);

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
  let processedGroups = 0;
  await Promise.all(groups.map((group) => limit(async () => {
    const representative = allItems[group[0]];
    const sourceFiles = [...new Set(group.map((index) => allItems[index].sourceFile))];
    try {
      const garmentBuffer = await generateGarmentCutout({ provider, key, baseUrl, item: representative });
      let modeledBuffer = null;
      if (modelBuffer) {
        try {
          modeledBuffer = await generateModeledPhoto({ provider, key, baseUrl, garmentBuffer, modelBuffer, faceBuffer });
        } catch (error) {
          console.warn(`  Modeled photo failed for "${representative.metadata.name}": ${error.message} (keeping the cutout)`);
        }
      }
      processedGroups += 1;
      console.log(`[${processedGroups}/${groups.length}] Generated "${representative.metadata.name}" (from ${sourceFiles.join(", ")})`);
      generated.push({ metadata: representative.metadata, garmentBuffer, modeledBuffer, sourceFiles });
    } catch (error) {
      processedGroups += 1;
      console.warn(`[${processedGroups}/${groups.length}] Failed "${representative.metadata.name}": ${error.message}`);
      failed.push({ metadata: representative.metadata, sourceFiles, error: error.message });
    }
  })));

  console.log(`\n${generated.length} item(s) generated, ${failed.length} failed.`);

  if (args.dryRun) {
    console.log("\nDry run — nothing written. Would have imported:");
    generated.forEach((item) => console.log(`  - ${item.metadata.name} (${item.metadata.part}, ${item.metadata.color}) from ${item.sourceFiles.join(", ")}`));
    return;
  }

  const records = [];
  for (const item of generated) {
    const id = `import-${randomUUID()}`;
    records.push(await writeLibraryItem({ libraryAssetDir, id, metadata: item.metadata, garmentBuffer: item.garmentBuffer, modeledBuffer: item.modeledBuffer }));
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
