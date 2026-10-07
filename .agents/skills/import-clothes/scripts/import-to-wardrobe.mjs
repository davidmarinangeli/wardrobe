#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { normalizeItemV2, variantIdFor } from "../../../../shared/wardrobe-model.mjs";
import { mutateLibrary } from "../../../../shared/wardrobe-library.mjs";
import { safeArchivePath } from "../../../../shared/portable-assets.mjs";
import { prepareArchiveDirectory, preserveOriginal, resolveArchiveFile } from "../../../../scripts/archive-store.mjs";

const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX = /^#[0-9a-f]{6}$/i;
const ARCHIVE_SETTINGS = new Set(["WARDROBE_DATA_DIR", "WARDROBE_MODEL_REFERENCE", "WARDROBE_FACE_REFERENCE"]);

async function readArchiveSettings(repo) {
  const settings = Object.fromEntries([...ARCHIVE_SETTINGS].map((name) => [name, process.env[name] || ""]));
  let envText = "";
  try { envText = await readFile(path.join(repo, ".env"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*(WARDROBE_DATA_DIR|WARDROBE_MODEL_REFERENCE|WARDROBE_FACE_REFERENCE)\s*=\s*(.*?)\s*$/);
    if (!match || settings[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    settings[match[1]] = value;
  }
  return settings;
}

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: import-to-wardrobe.mjs --items <directory> --manifest <file> [--modeled <directory>] [--repo <directory>] [--dry-run]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = { repo: process.cwd(), dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (!["--items", "--manifest", "--modeled", "--repo"].includes(argument)) usage(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.items) usage("--items is required");
  if (!options.manifest) usage("--manifest is required");
  return options;
}

function safeSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`Invalid slug: ${value}`);
  return value;
}

const MANIFEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Compatibility only: old manifests have no importId and the previous
// importer identified their records from the cutout hash. New manifests with
// an importId never use this path, so identical new candidates stay separate.
function legacyImportUuid(bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function validateManifestId(value, label) {
  if (typeof value !== "string" || !MANIFEST_ID.test(value)) throw new Error(`${label} id contains invalid characters`);
  return value;
}

function normalizeItem(item, index) {
  const slug = safeSlug(item.slug || `item-${index + 1}`);
  if (item.status !== "accepted") return null;
  if (!PARTS.has(item.part)) throw new Error(`${slug}: invalid part ${item.part}`);
  if (!HEX.test(item.color)) throw new Error(`${slug}: color must be a six-digit hex value`);
  if (item.secondaryColor !== null && item.secondaryColor !== undefined && !HEX.test(item.secondaryColor)) throw new Error(`${slug}: secondaryColor must be null or a six-digit hex value`);
  const tags = Array.isArray(item.tags)
    ? item.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
  const importId = item.importId === undefined ? null : validateManifestId(item.importId, "Import");
  if (item.originalSources !== undefined && (!Array.isArray(item.originalSources) || !item.originalSources.length)) {
    throw new Error(slug + ": originalSources must declare at least one captured source");
  }
  const variants = (item.variants?.length
    ? item.variants
    : [{ id: `${slug}-standard`, name: "Standard", file: item.file || `${slug}.png`, modeledFile: item.modeledFile, origin: "photo" }])
    .map((variant, variantIndex) => ({
      ...variant,
      id: validateManifestId(variant.id || `${slug}-${variantIndex === 0 ? "standard" : `variant-${variantIndex + 1}`}`, "Variant"),
      name: typeof variant.name === "string" && variant.name.trim() ? variant.name.trim() : "Standard",
    }));
  if (variants.length !== 1 || variants[0]?.name !== "Standard") {
    throw new Error(`${slug}: import manifests must contain exactly one Standard variant`);
  }
  return {
    slug,
    importId,
    id: importId ? `import-${importId}` : null,
    file: item.file || variants[0].file || `${slug}.png`,
    modeledFile: typeof item.modeledFile === "string" && item.modeledFile ? item.modeledFile : (typeof variants[0].modeledFile === "string" && variants[0].modeledFile ? variants[0].modeledFile : null),
    variants,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : slug.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    part: item.part,
    color: item.color.toLowerCase(),
    secondaryColor: item.secondaryColor?.toLowerCase() || null,
    tags,
    sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs : [],
    references: Array.isArray(item.references) ? item.references : [],
    originalSources: Array.isArray(item.originalSources) ? item.originalSources : [],
    assetRevision: item.assetRevision,
  };
}

async function validatePng(file, slug) {
  const bytes = await readFile(file);
  const image = sharp(bytes);
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.hasAlpha) throw new Error(`${slug}: PNG has no alpha channel`);
  const stats = await image.stats();
  const alpha = stats.channels[3];
  if (!alpha || alpha.min !== 0 || alpha.max === 0) throw new Error(`${slug}: PNG must contain transparent and visible pixels`);
  return { bytes };
}

async function validateModeledPng(file, slug) {
  const metadata = await sharp(file).metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.width || !metadata.height) throw new Error(`${slug}: modeled PNG has invalid dimensions`);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

const options = parseArgs(process.argv.slice(2));
const repo = path.resolve(options.repo);
const itemsDir = path.resolve(options.items);
const modeledDir = options.modeled ? path.resolve(options.modeled) : null;
const manifestFile = path.resolve(options.manifest);
const packageFile = path.join(repo, "package.json");
const packageJson = await readJson(packageFile, null);
if (!packageJson || packageJson.name !== "wardrobe") throw new Error(`Not a Wardrobe repository: ${repo}`);

const archiveSettings = await readArchiveSettings(repo);
const setting = (name, fallback = "") => archiveSettings[name] || fallback;
const dataDir = path.resolve(repo, archiveSettings.WARDROBE_DATA_DIR || "data");

const manifest = await readJson(manifestFile, null);
if (!manifest || !Array.isArray(manifest.items)) throw new Error("Manifest must contain an items array");
const accepted = manifest.items.map(normalizeItem).filter(Boolean);
if (!accepted.length) throw new Error("Manifest contains no accepted items");
const importIds = new Set();

const prepared = [];
for (const item of accepted) {
  const source = path.resolve(itemsDir, item.file);
  if (path.dirname(source) !== itemsDir) throw new Error(`${item.slug}: file must be directly inside the items directory`);
  if (!(await stat(source)).isFile()) throw new Error(`${item.slug}: source is not a file`);
  const { bytes } = await validatePng(source, item.slug);
  const importId = item.importId || legacyImportUuid(bytes);
  if (importIds.has(importId)) throw new Error(`Duplicate importId "${importId}"`);
  importIds.add(importId);
  const id = `import-${importId}`;
  let modeledSource = null;
  let modeledAssetName = null;
  if (item.modeledFile) {
    if (!modeledDir) throw new Error(`${item.slug}: --modeled is required when modeledFile is set`);
    modeledSource = path.resolve(modeledDir, item.modeledFile);
    if (path.dirname(modeledSource) !== modeledDir) throw new Error(`${item.slug}: modeledFile must be directly inside the modeled directory`);
    if (!(await stat(modeledSource)).isFile()) throw new Error(`${item.slug}: modeled source is not a file`);
    await validateModeledPng(modeledSource, item.slug);
    modeledAssetName = `${id}-modeled.png`;
  }
  prepared.push({ ...item, importId, id, bytes, source, assetName: `${id}-garment.png`, modeledSource, modeledAssetName });
}

for (const item of prepared) {
  item.archivedOriginals = [];
  const sourceByPath = new Map();
  for (const declared of item.originalSources) {
    if (!declared || typeof declared.path !== "string" || !Number.isInteger(declared.size) || !/^[a-f0-9]{64}$/i.test(declared.sha256 || "")) {
      throw new Error(item.slug + ": captured original metadata is incomplete");
    }
    const relative = safeArchivePath(declared.path);
    if (!relative.startsWith("originals/")) throw new Error(item.slug + ": captured originals must be inside originals/");
    const sourceFile = await resolveArchiveFile(dataDir, relative);
    const sourceBytes = await readFile(sourceFile);
    const digest = createHash("sha256").update(sourceBytes).digest("hex");
    if (sourceBytes.length !== declared.size || digest !== declared.sha256.toLowerCase()) {
      throw new Error(item.slug + ": captured original checksum mismatch for " + (declared.sourceRef || relative));
    }
    sourceByPath.set(relative, { ...declared, path: relative, bytes: sourceBytes });
    if (typeof declared.sourceRef === "string") sourceByPath.set(declared.sourceRef, sourceByPath.get(relative));
  }
  const uniqueSources = [...new Set(sourceByPath.values())];
  for (const source of uniqueSources) {
    const saved = options.dryRun
      ? { path: source.path, size: source.size, sha256: source.sha256, mime: source.mime, filename: source.filename }
      : await preserveOriginal({ dataDir, bytes: source.bytes, filename: source.filename || path.basename(source.path) });
    item.archivedOriginals.push({ ...source, ...saved });
  }
  const pathBySource = new Map();
  for (const source of item.archivedOriginals) {
    pathBySource.set(source.path, source);
    if (typeof source.sourceRef === "string") pathBySource.set(source.sourceRef, source);
  }
  item.importReferences = item.references.map((reference) => {
    const captured = pathBySource.get(reference.original);
    return captured
      ? { ...reference, original: captured.path, ...(reference.asset ? { asset: captured.path } : {}), label: reference.label || captured.filename || captured.sourceRef }
      : reference;
  });
  for (const source of item.archivedOriginals) {
    if (item.importReferences.some((reference) => reference.original === source.path)) continue;
    item.importReferences.push({
      id: item.slug + "-source-" + (item.importReferences.length + 1),
      original: source.path,
      asset: source.path,
      role: "view",
      scope: "item",
      label: source.filename || source.sourceRef || "Original source photo",
      distinctive: false,
      revision: 1,
    });
  }
}
if (!options.dryRun) await prepareArchiveDirectory({ root: repo, dataDir, setting });

const importedDir = path.join(dataDir, "imported");
const libraryFile = path.join(dataDir, "library.json");
const records = await readJson(libraryFile, []);
if (!Array.isArray(records)) throw new Error(`${libraryFile} must contain a JSON array`);

const recordsToWrite = [];
for (const item of prepared) {
  const assetUrl = `/api/import/library/${item.assetName}`;
  const modeledUrl = item.modeledAssetName ? `/api/import/library/${item.modeledAssetName}` : null;
  const existing = records.find((entry) => entry.id === item.id) || null;
  const manifestVariant = item.variants[0];
  const variantId = manifestVariant.id || variantIdFor(item.id);
  const existingVariant = existing?.variants?.find((candidate) => candidate.id === variantId);
  const variant = {
    id: variantId,
    name: "Standard",
    description: manifestVariant.description || "Source presentation",
    origin: manifestVariant.origin === "generated" ? "generated" : "photo",
    sourceRefs: item.sourceRefs || manifestVariant.sourceRefs || [],
    tags: item.tags,
    image: assetUrl,
    thumbnail: assetUrl,
    cutout: { image: assetUrl, thumbnail: assetUrl, revision: manifestVariant.assetRevision || item.assetRevision || 1, status: "current" },
    modeledImage: modeledUrl,
    modeledPhoto: modeledUrl ? { image: modeledUrl, status: "approved", revision: manifestVariant.assetRevision || item.assetRevision || 1 } : null,
    approvalStatus: "approved",
    assetRevision: manifestVariant.assetRevision || item.assetRevision || 1,
    createdAt: existingVariant?.createdAt,
    updatedAt: existingVariant?.updatedAt,
  };
  const record = normalizeItemV2({
    schemaVersion: 2,
    id: item.id,
    name: item.name,
    part: item.part,
    color: item.color,
    secondaryColor: item.secondaryColor,
    palette: [item.color, item.secondaryColor].filter(Boolean),
    tags: item.tags,
    image: assetUrl,
    thumbnail: assetUrl,
    defaultVariantId: existing?.defaultVariantId || variantId,
    variants: [variant],
    references: item.importReferences || item.references || [],
    sourceOriginals: item.archivedOriginals.map((source) => source.path),
    importJobId: item.importId,
    createdAt: existing?.createdAt,
    updatedAt: existing?.updatedAt,
  });
  recordsToWrite.push(record);
}

const resultingIds = new Set(records.map((record) => record.id));
for (const record of recordsToWrite) resultingIds.add(record.id);
let total = resultingIds.size;
if (!options.dryRun) {
  await mkdir(importedDir, { recursive: true });
  for (const item of prepared) {
    await copyFile(item.source, path.join(importedDir, item.assetName));
    if (item.modeledSource) await copyFile(item.modeledSource, path.join(importedDir, item.modeledAssetName));
  }
  const saved = await mutateLibrary(dataDir, (current) => {
    const next = [...current];
    for (const incoming of recordsToWrite) {
      const index = next.findIndex((entry) => entry.id === incoming.id);
      const existing = index === -1 ? null : next[index];
      const variants = incoming.variants.map((variant) => {
        const previous = existing?.variants?.find((candidate) => candidate.id === variant.id);
        return { ...variant, createdAt: previous?.createdAt || variant.createdAt, updatedAt: previous?.updatedAt || variant.updatedAt };
      });
      const record = normalizeItemV2({
        ...(existing || {}),
        ...incoming,
        tags: existing?.tags || incoming.tags,
        defaultVariantId: existing?.defaultVariantId || incoming.defaultVariantId,
        createdAt: existing?.createdAt || incoming.createdAt,
        updatedAt: existing?.updatedAt || incoming.updatedAt,
        variants,
      });
      if (index === -1) next.push(record); else next[index] = record;
    }
    return next;
  });
  total = saved.length;
}

console.log(JSON.stringify({
  dryRun: options.dryRun,
  imported: prepared.length,
  total,
  library: libraryFile,
  items: prepared.map(({ id, name, part, assetName, modeledAssetName }) => ({ id, name, part, assetName, modeledAssetName })),
  unavailableOriginals: prepared.flatMap((item) => item.archivedOriginals.length ? [] : [
    ...item.sourceRefs,
    ...item.references.map((reference) => reference.original).filter((original) => typeof original === "string"),
  ]),
}, null, 2));
