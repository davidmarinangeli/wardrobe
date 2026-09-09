import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  atomicJson,
  buildModeledPrompt,
  checkSetup,
  computeIdentityProfile,
  geminiAnalyzeOutfitStyle,
  geminiEdit,
  isLikelyBottom,
  isLikelyCroppedOrShortBottom,
  isLikelySocks,
  loadFaceReference,
  openAIAnalyzeOutfitStyle,
  openAIImage,
  openAIImageOptions,
  openRouterEdit,
  readAiMode,
  resolveApiKey,
  resolveModeledModel,
  resolveOpenAICompatibleBaseUrl,
  resolveProvider,
} from "./import-job-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const envSetting = (name, fallback = "") => process.env[name] || fallback;

function printHelp() {
  console.log(`Regenerate modeled photos for Wardrobe outfits.

Usage:
  node --env-file=.env scripts/regenerate-outfits.mjs [options]

Options:
  --provider <name>   AI provider to use ("gemini", "openai", "openrouter") (default from .env)
  --tier <tier>       Quality tier ("premium" or "standard") (default: "premium")
  --model <name>      Override image generation model (e.g. "gemini-3.1-flash-image")
  --only-missing      Only generate images for outfits that currently have none or failed
  --force-all         Regenerate all outfits, including ones updated today
  --dry-run           Show planned outfits, prompts, and garments without generating images
  --delay <ms>        Delay between requests in milliseconds (default: 2000)
  --id <outfitId>     Regenerate only a single outfit by ID
  -h, --help          Show this help
`);
}

function parseArgs(argv) {
  const args = { tier: "premium", delay: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--provider") args.provider = argv[++i];
    else if (arg === "--tier") args.tier = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--only-missing") args.onlyMissing = true;
    else if (arg === "--force-all") args.forceAll = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--delay") args.delay = Number(argv[++i]);
    else if (arg === "--id") args.id = argv[++i];
    else if (arg === "--prompt") args.prompt = argv[++i];
    else if (arg === "-h" || arg === "--help") args.help = true;
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const dataDir = path.join(ROOT, envSetting("WARDROBE_DATA_DIR", "data"));
  const outfitsFile = path.join(dataDir, "outfits.json");
  const libraryFile = path.join(dataDir, "library.json");
  const outfitAssetDir = path.join(dataDir, "outfits-assets");
  const libraryAssetDir = path.join(dataDir, "imported");

  await mkdir(outfitAssetDir, { recursive: true });

  const outfits = JSON.parse(await readFile(outfitsFile, "utf8"));
  const library = JSON.parse(await readFile(libraryFile, "utf8"));
  const recordsById = new Map(library.map((r) => [r.id, r]));

  const provider = args.provider || resolveProvider(envSetting).provider;
  const mode = (await readAiMode(dataDir)) || "prod";
  const { key, keyName } = resolveApiKey(envSetting, provider, mode);

  if (!key && !args.dryRun) {
    console.error(`Error: ${keyName} is not configured in .env for ${mode.toUpperCase()} mode.`);
    process.exit(1);
  }

  const modelPath = path.resolve(ROOT, envSetting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
  const modelData = await readFile(modelPath).catch(() => null);
  if (!modelData && !args.dryRun) {
    console.error(`Error: Model reference photo not found at ${modelPath}`);
    process.exit(1);
  }

  const face = await loadFaceReference(ROOT, envSetting);
  const model = modelData ? { data: modelData, mime: "image/png", name: "model.png" } : null;
  const referenceImages = face ? [model, face].filter(Boolean) : [model].filter(Boolean);

  const resolved = resolveModeledModel(provider, args.tier, envSetting);
  const activeModel = args.model || resolved.model;

  console.log(`\n=== Wardrobe Outfit Regeneration ===`);
  console.log(`Provider: ${provider.toUpperCase()} (${mode.toUpperCase()} mode)`);
  console.log(`Model:    ${activeModel} (tier: ${args.tier})`);
  console.log(`Face ref: ${face ? "Yes (close-up attached)" : "None"}`);

  const today = new Date().toISOString().slice(0, 10);
  const skippedIds = new Set(["d9e6b039-6fa5-4970-bba7-cbefdc41178d"]); // casual office has deleted piece

  let targets = outfits;
  if (args.id) {
    targets = outfits.filter((o) => o.id === args.id);
  } else {
    targets = outfits.filter((o) => {
      if (skippedIds.has(o.id)) return false;
      if (args.onlyMissing) return !o.modeledImage || o.modeledStatus === "error";
      if (!args.forceAll && o.updatedAt?.startsWith(today)) return false;
      return true;
    });
  }

  console.log(`Selected ${targets.length} outfits to process.\n`);

  if (args.dryRun) {
    console.log(`--- Dry Run Plan ---`);
    for (const o of targets) {
      const pieces = o.itemIds.map((id) => recordsById.get(id)?.name || id).join(" + ");
      console.log(`- [${o.id}] "${o.name}": ${pieces}`);
    }
    console.log(`\nDry run completed. Run without --dry-run to generate.`);
    return;
  }

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const outfit = targets[i];
    console.log(`[${i + 1}/${targets.length}] Generating "${outfit.name}" (${outfit.id})...`);

    try {
      const outfitRecords = outfit.itemIds.map((itemId) => recordsById.get(itemId)).filter(Boolean);
      const hasFullLengthBottom = outfitRecords.some((r) => isLikelyBottom(r) && !isLikelySocks(r) && !isLikelyCroppedOrShortBottom(r));

      const garments = [];
      const garmentMeta = [];
      for (const itemId of outfit.itemIds) {
        const record = recordsById.get(itemId);
        if (hasFullLengthBottom && isLikelySocks(record)) continue;
        try {
          const data = await readFile(path.join(libraryAssetDir, `${itemId}-garment.png`));
          garments.push({ data, mime: "image/png", name: `${itemId}.png` });
          garmentMeta.push({ name: record?.name, tags: record?.tags, part: record?.part });
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }

      if (!garments.length) throw new Error("No garment cutouts found for outfit pieces");

      const basePrompt = buildModeledPrompt(garmentMeta, { hasFaceReference: Boolean(face) });
      const identityProfile = await computeIdentityProfile({ root: ROOT, dataDir, setting: envSetting, provider, mode });
      const withIdentity = identityProfile ? `${basePrompt}\nAdditional identity notes for consistency: ${identityProfile}` : basePrompt;
      const modeledPrompt = args.prompt ? `${withIdentity}\nUser regeneration direction: ${args.prompt}` : withIdentity;

      let bytes;
      if (provider === "gemini") {
        bytes = await geminiEdit({
          key,
          model: activeModel,
          imageSize: resolved.imageSize || "1K",
          size: "1536x1024",
          images: [...referenceImages, ...garments],
          prompt: modeledPrompt,
        });
      } else if (provider === "openrouter") {
        bytes = await openRouterEdit({
          key,
          baseUrl: resolveOpenAICompatibleBaseUrl(envSetting, provider),
          model: activeModel,
          quality: resolved.quality,
          size: "1536x1024",
          images: [...referenceImages, ...garments],
          prompt: modeledPrompt,
        });
      } else {
        bytes = await openAIImage({
          ...openAIImageOptions(envSetting),
          key,
          baseUrl: resolveOpenAICompatibleBaseUrl(envSetting, provider),
          model: activeModel,
          quality: resolved.quality,
          size: "1536x1024",
          images: [...referenceImages, ...garments],
          prompt: modeledPrompt,
        });
      }

      // Convert or save PNG
      const pngBuffer = await sharp(bytes).png().toBuffer();
      const modeledName = `${outfit.id}-modeled.png`;
      await writeFile(path.join(outfitAssetDir, modeledName), pngBuffer);

      // Update outfit record
      const freshOutfits = JSON.parse(await readFile(outfitsFile, "utf8"));
      await atomicJson(
        outfitsFile,
        freshOutfits.map((item) =>
          item.id === outfit.id
            ? {
                ...item,
                modeledImage: `/api/outfits/assets/${modeledName}?v=${Date.now()}`,
                modeledStatus: null,
                modeledError: null,
                modeledTier: args.tier,
                updatedAt: new Date().toISOString(),
              }
            : item
        )
      );

      // Run style analysis
      try {
        const styleProvider = provider === "gemini" || provider === "openrouter" ? provider : "openai";
        const styleKey = resolveApiKey(envSetting, styleProvider, mode).key;
        if (styleKey) {
          const style =
            styleProvider === "gemini"
              ? await geminiAnalyzeOutfitStyle({
                  key: styleKey,
                  model: envSetting("GEMINI_VISION_MODEL", "gemini-3.6-flash"),
                  image: pngBuffer,
                  mime: "image/png",
                })
              : await openAIAnalyzeOutfitStyle({
                  key: styleKey,
                  baseUrl: resolveOpenAICompatibleBaseUrl(envSetting, styleProvider),
                  model: styleProvider === "openrouter" ? envSetting("OPENROUTER_VISION_MODEL", "openai/gpt-5.4-mini") : envSetting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
                  image: pngBuffer,
                  mime: "image/png",
                });
          const afterStyle = JSON.parse(await readFile(outfitsFile, "utf8"));
          await atomicJson(
            outfitsFile,
            afterStyle.map((item) => (item.id === outfit.id ? { ...item, description: style.description, tags: style.tags } : item))
          );
        }
      } catch (styleErr) {
        console.warn(`  Warning: Style analysis skipped (${styleErr.message})`);
      }

      console.log(`  ✓ Successfully generated and saved ${modeledName}`);
      completed++;

      if (i < targets.length - 1 && args.delay > 0) {
        await sleep(args.delay);
      }
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      failed++;
      const current = JSON.parse(await readFile(outfitsFile, "utf8"));
      await atomicJson(
        outfitsFile,
        current.map((item) => (item.id === outfit.id ? { ...item, modeledStatus: "error", modeledError: err.message } : item))
      );
    }
  }

  console.log(`\nFinished: ${completed} generated successfully, ${failed} failed.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
