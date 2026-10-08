#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { migrateOutfit, normalizeItemV2 } from "../shared/wardrobe-model.mjs";
import { catalogForDisk, safeArchivePath } from "../shared/portable-assets.mjs";
import { buildArchiveInventory, prepareArchiveDirectory, validateArchive } from "./archive-store.mjs";
import { withArchiveWriteLease } from "./archive-coordinator.mjs";

function args(argv) {
  const result = { repo: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--manifest", "--images", "--repo"].includes(option)) throw new Error(`Unknown option: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    result[option.slice(2)] = value;
    index += 1;
  }
  if (!result.manifest || !result.images) throw new Error("--manifest and --images are required");
  return result;
}

async function readSetting(repo, name) {
  if (process.env[name]) return process.env[name];
  try {
    const env = await readFile(path.join(repo, ".env"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
      if (!match) continue;
      const value = match[1];
      return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value;
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return "";
}

async function archiveGeneration(dataDir) {
  let generation = 0;
  for (const name of ["archive-metadata.json", "browser-state.json"]) {
    try {
      const value = JSON.parse(await readFile(path.join(dataDir, name), "utf8"));
      if (Number.isSafeInteger(value?.archiveGeneration) && value.archiveGeneration > generation) generation = value.archiveGeneration;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
  return generation;
}

async function atomicCatalog(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(catalogForDisk(value), null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const parent = await open(path.dirname(file), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

async function run() {
  const options = args(process.argv.slice(2));
  const repo = path.resolve(options.repo);
  const dataDir = path.resolve(repo, await readSetting(repo, "WARDROBE_DATA_DIR") || "data");
  const manifestFile = path.resolve(options.manifest);
  const imagesDir = path.resolve(options.images);
  await withArchiveWriteLease(dataDir, async () => {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (!Number.isSafeInteger(manifest?.provenanceGeneration) || manifest.provenanceGeneration !== await archiveGeneration(dataDir)) {
      throw new Error("Prepared outfits are stale: the archive generation changed after preparation");
    }
    if (!Array.isArray(manifest.outfits) || manifest.outfits.length > 10_000) throw new Error("Manifest must contain an outfits array");
    const libraryPath = path.join(dataDir, "library.json");
    const library = JSON.parse(await readFile(libraryPath, "utf8"));
    if (!Array.isArray(library)) throw new Error("Wardrobe library must be an array");
    const normalizedLibrary = library.map((item) => normalizeItemV2(item));
    const accepted = manifest.outfits.filter((outfit) => outfit?.status === "accepted");
    if (!accepted.length) throw new Error("Manifest contains no accepted outfits");
    const ids = new Set();
    const outputs = [];
    for (const outfit of accepted) {
      if (!outfit || typeof outfit.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(outfit.id) || ids.has(outfit.id)) throw new Error("Outfit IDs must be unique lowercase slugs");
      ids.add(outfit.id);
      const rawPieces = Array.isArray(outfit.pieces) ? outfit.pieces
        : (outfit.garmentIds || outfit.itemIds || []).map((itemId) => ({ itemId }));
      const migrated = migrateOutfit({ ...outfit, pieces: rawPieces }, normalizedLibrary);
      if (!migrated.pieces.length || migrated.pieces.length !== rawPieces.length) throw new Error(`${outfit.id}: every selected wardrobe item must still exist`);
      for (const piece of migrated.pieces) {
        const item = normalizedLibrary.find((candidate) => candidate.id === piece.itemId);
        if (!item?.variants.some((variant) => variant.id === piece.variantId)) throw new Error(`${outfit.id}: prepared variant no longer exists`);
      }
      const imageFile = path.join(imagesDir, `${outfit.id}.png`);
      if (path.dirname(imageFile) !== imagesDir || !(await stat(imageFile)).isFile()) throw new Error(`${outfit.id}: modeled PNG is missing`);
      const bytes = await readFile(imageFile);
      const image = await sharp(bytes).metadata();
      if (image.format !== "png" || !image.width || image.width !== image.height) throw new Error(`${outfit.id}: modeled image must be a square PNG`);
      const imagePath = safeArchivePath(`outfit-images/${outfit.id}.png`);
      outputs.push({ ...migrated, image: imagePath, modeledImage: imagePath, status: "approved", modeledStatus: null, modeledError: null });
    }
    const setting = (name, fallback = "") => name === "WARDROBE_DATA_DIR" ? path.relative(repo, dataDir) || fallback : process.env[name] || fallback;
    await prepareArchiveDirectory({ root: repo, dataDir, setting });
    const assetDir = path.join(dataDir, "outfit-images");
    await mkdir(assetDir, { recursive: true });
    for (const outfit of outputs) {
      const source = path.join(imagesDir, `${outfit.id}.png`);
      const target = path.join(dataDir, ...outfit.image.split("/"));
      const temporary = `${target}.${randomUUID()}.tmp`;
      await copyFile(source, temporary);
      const bytes = await readFile(temporary);
      await rename(temporary, target);
      if (createHash("sha256").update(bytes).digest("hex") !== createHash("sha256").update(await readFile(target)).digest("hex")) throw new Error(`${outfit.id}: copied image failed verification`);
    }
    await atomicCatalog(path.join(dataDir, "outfits.json"), outputs);
    const inventory = await buildArchiveInventory(dataDir);
    const validation = await validateArchive(dataDir, inventory);
    if (!validation.valid) throw new Error(`Applied outfit archive is invalid: ${validation.errors.join("; ")}`);
    console.log(JSON.stringify({ applied: outputs.length, provenanceGeneration: manifest.provenanceGeneration, outfitsFile: path.join(dataDir, "outfits.json") }, null, 2));
  });
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
