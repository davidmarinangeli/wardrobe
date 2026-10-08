import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import sharp from "sharp";
import { archivePathFromAsset, catalogForDisk, isArchiveAssetField, safeArchivePath } from "../shared/portable-assets.mjs";
import { ensureArchiveRecovered, withArchiveWriteLease } from "./archive-coordinator.mjs";

export const ARCHIVE_SCHEMA_VERSION = 1;
export const ARCHIVE_CATALOGS = Object.freeze([
  "library.json", "outfits.json", "inspo.json", "wishlist.json",
  "cheat-sheets.json", "preferences.json", "color-profile.json",
  "browser-state.json", "archive-metadata.json", "ai-mode.json",
]);
export const ARCHIVE_MEDIA_ROOTS = Object.freeze([
  "imported", "outfits-assets", "outfit-images", "inspo-assets",
  "wishlist-assets", "cheat-sheets-assets", "originals",
]);
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const BROWSER_MIGRATED_FIELDS = new Set([
  "itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges",
  "modelTier", "onboardingDismissed", "wornToday",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".avif", ".bmp", ".heic", ".heif"]);
const MIME_EXTENSIONS = new Map([
  ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"],
  ["image/gif", ".gif"], ["image/tiff", ".tiff"], ["image/avif", ".avif"],
  ["image/bmp", ".bmp"], ["image/heic", ".heic"], ["image/heif", ".heif"],
]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export async function hashArchiveFile(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function assertNoSymlink(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Archive path is a symbolic link: ${file}`);
    return info;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertArchiveRoot(dataDir) {
  const info = await assertNoSymlink(dataDir);
  if (info && !info.isDirectory()) throw new Error("Archive root is not a directory");
}

async function visitAllowedDirectory(dataDir, relativeDir, entries) {
  const dir = path.join(dataDir, relativeDir);
  const info = await assertNoSymlink(dir);
  if (!info) return;
  if (!info.isDirectory()) throw new Error(`Archive media root is not a directory: ${relativeDir}`);
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const child of children) {
    const relativePath = safeArchivePath(`${relativeDir}/${child.name}`);
    const absolutePath = path.join(dataDir, ...relativePath.split("/"));
    const childInfo = await assertNoSymlink(absolutePath);
    if (child.isDirectory()) {
      if (!childInfo?.isDirectory()) throw new Error(`Invalid archive directory: ${relativePath}`);
      if (isControlName(child.name)) continue;
      await visitAllowedDirectory(dataDir, relativePath, entries);
    } else if (childInfo?.isFile()) {
      if (isControlName(child.name) || !IMAGE_EXTENSIONS.has(path.extname(child.name).toLowerCase())) continue;
      const digest = await hashArchiveFile(absolutePath);
      entries.push({ path: relativePath, ...digest });
    } else {
      throw new Error(`Unsupported archive entry: ${relativePath}`);
    }
  }
}

function isControlName(name) {
  return name.startsWith(".")
    || /(?:^|[._-])(credentials?|tokens?|oauth|cache|temp|tmp|staging|lock|backup|snapshot)(?:[._-]|$)/i.test(name)
    || /\.(?:tmp|lock|bak|backup|old|swp)$/i.test(name);
}

function isCanonicalReference(name) {
  return /^model-reference(?:-face)?\.(?:png|jpe?g|webp)$/i.test(name);
}

export async function buildArchiveInventory(dataDir) {
  await assertArchiveRoot(dataDir);
  const entries = [];
  for (const name of ARCHIVE_CATALOGS) {
    const file = path.join(dataDir, name);
    const info = await assertNoSymlink(file);
    if (!info) continue;
    if (!info.isFile()) throw new Error(`Archive catalog is not a file: ${name}`);
    const digest = await hashArchiveFile(file);
    entries.push({ path: name, ...digest });
  }
  for (const name of ARCHIVE_MEDIA_ROOTS) await visitAllowedDirectory(dataDir, name, entries);
  for (const name of ["model-reference.png", "model-reference.jpg", "model-reference.jpeg", "model-reference.webp", "model-reference-face.png", "model-reference-face.jpg", "model-reference-face.jpeg", "model-reference-face.webp"]) {
    if (ARCHIVE_MEDIA_ROOTS.includes(name)) continue;
    const file = path.join(dataDir, name);
    const info = await assertNoSymlink(file);
    if (!info) continue;
    if (!info.isFile()) throw new Error(`Archive reference is not a file: ${name}`);
    const digest = await hashArchiveFile(file);
    entries.push({ path: name, ...digest });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { version: ARCHIVE_SCHEMA_VERSION, files: entries };
}

function inventoryFingerprint(inventory) {
  return sha256(Buffer.from(JSON.stringify(inventory)));
}

/** Captures one immutable, validated archive snapshot inside a caller-owned private directory. */
export async function createArchiveSnapshot({ sourceDir, stagingRoot, attempts = 3 } = {}) {
  if (!sourceDir || !stagingRoot) throw new TypeError("Archive source and private staging root are required");
  const stagingInfo = await assertNoSymlink(stagingRoot);
  if (stagingInfo && !stagingInfo.isDirectory()) throw new Error("Archive staging root is not a directory");
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const directory = path.join(stagingRoot, `snapshot-${randomUUID()}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      const before = await buildArchiveInventory(sourceDir);
      const sourceValidation = await validateArchive(sourceDir, before);
      if (!sourceValidation.valid) throw new Error(`Local archive is invalid: ${sourceValidation.errors.join("; ")}`);
      for (const entry of before.files) {
        const source = await resolveArchiveFile(sourceDir, entry.path);
        const destination = path.join(directory, ...entry.path.split("/"));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        const copied = await hashArchiveFile(destination);
        if (copied.size !== entry.size || copied.sha256 !== entry.sha256) throw new Error(`Archive changed while capturing: ${entry.path}`);
      }
      const after = await buildArchiveInventory(sourceDir);
      if (inventoryFingerprint(before) !== inventoryFingerprint(after)) throw new Error("Local archive changed while capturing snapshot");
      const staged = await buildArchiveInventory(directory);
      if (inventoryFingerprint(before) !== inventoryFingerprint(staged)) throw new Error("Staged archive snapshot failed inventory verification");
      const stagedValidation = await validateArchive(directory, before);
      if (!stagedValidation.valid) throw new Error(`Staged archive snapshot is invalid: ${stagedValidation.errors.join("; ")}`);
      return { directory, inventory: before, fingerprint: inventoryFingerprint(before) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (attempt + 1 >= attempts) throw error;
    }
  }
  throw new Error("Could not capture a stable local archive snapshot");
}

/** Copies the portable allowlist without parsing old catalogs, for corruption repair and rollback. */
export async function createRawArchiveSnapshot({ sourceDir, stagingRoot, attempts = 3 } = {}) {
  if (!sourceDir || !stagingRoot) throw new TypeError("Archive source and private staging root are required");
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const directory = path.join(stagingRoot, `raw-${randomUUID()}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      const before = await buildArchiveInventory(sourceDir);
      for (const entry of before.files) {
        const source = await resolveArchiveFile(sourceDir, entry.path);
        const destination = path.join(directory, ...entry.path.split("/"));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
        const copied = await hashArchiveFile(destination);
        if (copied.size !== entry.size || copied.sha256 !== entry.sha256) throw new Error(`Archive changed while capturing: ${entry.path}`);
      }
      const after = await buildArchiveInventory(sourceDir);
      if (inventoryFingerprint(before) !== inventoryFingerprint(after)) throw new Error("Local archive changed while capturing snapshot");
      const staged = await buildArchiveInventory(directory);
      if (inventoryFingerprint(before) !== inventoryFingerprint(staged)) throw new Error("Raw archive snapshot failed inventory verification");
      return { directory, inventory: before, fingerprint: inventoryFingerprint(before), valid: (await validateArchive(directory, before)).valid };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (attempt + 1 >= attempts) throw error;
    }
  }
  throw new Error("Could not capture a stable raw archive snapshot");
}

function visitMediaReferences(value, parentKey, parentParentKey, found, historical) {
  if (typeof value === "string") {
    const isAsset = isArchiveAssetField(parentKey) || (parentKey === "path" && parentParentKey === "sourceOriginal");
    const isCapturedOriginal = parentKey === "sourceRefs"
      && /^originals\/[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|tiff?|avif|bmp|heic|heif)$/i.test(value);
    if (!isAsset && !isCapturedOriginal) return;
    const local = archivePathFromAsset(value);
    if (local) found.add(local);
    else if (["original", "originalAsset", "originalUrl", "sourceOriginal", "sourceOriginals"].includes(parentKey) && value && !/^https?:\/\//i.test(value)) historical.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) visitMediaReferences(entry, parentKey, parentParentKey, found, historical);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) visitMediaReferences(entry, key, parentKey, found, historical);
  }
}

export async function validateArchive(dataDir, inventory) {
  await assertArchiveRoot(dataDir);
  const errors = [];
  const historicalMissing = [];
  if (!inventory || inventory.version !== ARCHIVE_SCHEMA_VERSION || !Array.isArray(inventory.files)) {
    return { valid: false, errors: ["Unsupported archive inventory schema"], historicalMissing };
  }
  const seen = new Set();
  const members = new Map();
  for (const entry of inventory.files) {
    let relative;
    try { relative = safeArchivePath(entry?.path); }
    catch (error) { errors.push(error.message); continue; }
    if (seen.has(relative)) { errors.push(`Duplicate archive path: ${relative}`); continue; }
    seen.add(relative);
    if (!isAllowedArchivePath(relative)) { errors.push(`Path is outside the archive allowlist: ${relative}`); continue; }
    members.set(relative, entry);
    const file = path.join(dataDir, ...relative.split("/"));
    try {
      const info = await assertNoSymlink(file);
      if (!info?.isFile()) { errors.push(`Missing archive file: ${relative}`); continue; }
      const digest = await hashArchiveFile(file);
      if (!Number.isInteger(entry.size) || entry.size !== digest.size) errors.push(`Archive size mismatch: ${relative}`);
      if (!/^[a-f0-9]{64}$/i.test(entry.sha256) || entry.sha256.toLowerCase() !== digest.sha256) errors.push(`Archive checksum mismatch: ${relative}`);
    } catch (error) { errors.push(error.message); }
  }
  try {
    const expected = await buildArchiveInventory(dataDir);
    const expectedPaths = new Set(expected.files.map((entry) => entry.path));
    for (const relative of expectedPaths) if (!seen.has(relative)) errors.push(`Archive inventory omits file: ${relative}`);
    for (const relative of seen) if (!expectedPaths.has(relative)) errors.push(`Inventory includes a file outside the current archive: ${relative}`);
  } catch (error) { errors.push(`Could not enumerate archive: ${error.message}`); }
  const referenced = new Set();
  const historical = new Set();
  for (const name of ARCHIVE_CATALOGS) {
    const file = path.join(dataDir, name);
    try {
      const content = JSON.parse(await readFile(file, "utf8"));
      const shapeError = validateCatalogShape(name, content);
      if (shapeError) errors.push(shapeError);
      visitMediaReferences(content, "", "", referenced, historical);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`Could not read archive catalog ${name}: ${error.message}`);
    }
  }
  for (const relative of referenced) {
    try {
      const info = await assertNoSymlink(path.join(dataDir, ...relative.split("/")));
      if (!info?.isFile()) errors.push(`Missing referenced media: ${relative}`);
      else if (!members.has(relative)) errors.push(`Referenced media is absent from inventory: ${relative}`);
    } catch (error) { errors.push(error.message); }
  }
  for (const name of historical) if (!referenced.has(name)) historicalMissing.push(name);
  return { valid: errors.length === 0, errors, historicalMissing: [...new Set(historicalMissing)].sort(), inventory };
}

/**
 * A startup migration must not normalize, default, or replay over user data
 * until every existing catalog can be parsed and structurally understood.
 * This deliberately checks catalog shape only: missing media and other
 * repairable archive damage must still be handled by the restore controller.
 */
export async function inspectArchiveCatalogs(dataDir) {
  await assertArchiveRoot(dataDir);
  const invalidCatalogs = [];
  for (const name of ARCHIVE_CATALOGS) {
    const file = path.join(dataDir, name);
    let info;
    try { info = await lstat(file); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_CATALOG_BYTES) {
      invalidCatalogs.push(name);
      continue;
    }
    let value;
    try { value = JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") invalidCatalogs.push(name);
      continue;
    }
    if (validateCatalogShape(name, value, { allowLegacyMedia: true })) invalidCatalogs.push(name);
  }
  return { valid: invalidCatalogs.length === 0, invalidCatalogs: [...new Set(invalidCatalogs)].sort() };
}

export function reportSkippedArchiveStartup(operation, preflight) {
  if (preflight?.valid) return;
  const catalogs = Array.isArray(preflight?.invalidCatalogs) ? preflight.invalidCatalogs.join(", ") : "unknown";
  console.warn(`[wardrobe] Skipping ${operation}; archive catalogs need repair (${catalogs}).`);
}

export class ArchiveCatalogPreflightError extends Error {
  constructor(preflight) {
    const catalogs = Array.isArray(preflight?.invalidCatalogs) ? preflight.invalidCatalogs : [];
    super(`Archive catalogs need repair before migration${catalogs.length ? `: ${catalogs.join(", ")}` : ""}`);
    this.name = "ArchiveCatalogPreflightError";
    this.code = "archive_catalog_invalid";
    this.status = 409;
    this.catalogs = catalogs;
  }
}

function validateCatalogShape(name, value, { allowLegacyMedia = false } = {}) {
  const isObject = (entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  const validId = (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512 && !/[\0\r\n]/.test(entry);
  const string = (entry, max = 20_000) => typeof entry === "string" && entry.length <= max && !entry.includes("\0");
  const nullableString = (entry, max = 20_000) => entry === null || string(entry, max);
  const stringArray = (entry, maxItems = 10_000, maxText = 4_096) => Array.isArray(entry)
    && entry.length <= maxItems && entry.every((item) => string(item, maxText));
  const finiteNumber = (entry, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) =>
    typeof entry === "number" && Number.isFinite(entry) && entry >= min && entry <= max;
  const httpUrl = (entry) => {
    if (!string(entry, 4_096)) return false;
    try {
      const parsed = new URL(entry);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch { return false; }
  };
  const asset = (entry, field, allowExternal = false) => {
    if (entry === null) return true;
    if (!string(entry, 4_096)) return false;
    try {
      if (archivePathFromAsset(entry)) return true;
    } catch { return false; }
    // Startup migrations must preserve supported older catalogs whose image
    // strings still point outside the portable archive. Publication/restore
    // call the strict default and continue to require archive-relative media.
    return (allowExternal && httpUrl(entry)) || (allowLegacyMedia && Boolean(entry.trim()));
  };
  const assetFields = new Set([
    "asset", "image", "thumbnail", "modeledImage", "crop", "cropImage", "original",
    "sourceOriginal", "sourceOriginals", "referenceImage", "imagePath", "thumbnailPath",
    "modeledImagePath", "originalImage", "thumbnailImage", "aiImage", "aiThumbnailImage",
  ]);
  const externalAssetFields = new Set(["original", "sourceOriginal", "sourceOriginals"]);
  const validateAssets = (entry) => {
    if (Array.isArray(entry)) return entry.every(validateAssets);
    if (!isObject(entry)) return true;
    for (const [key, child] of Object.entries(entry)) {
      if (assetFields.has(key)) {
        if (key === "sourceOriginal" && isObject(child)) {
          if (Object.hasOwn(child, "path") && !asset(child.path, "asset", true)) return false;
          if (!validateAssets(child)) return false;
        } else if (key === "sourceOriginals" && Array.isArray(child)) {
          if (!child.every((candidate) => typeof candidate === "string"
            ? asset(candidate, key, true)
            : isObject(candidate) && (!Object.hasOwn(candidate, "path") || asset(candidate.path, key, true)))) return false;
          if (!validateAssets(child)) return false;
        } else if (typeof child === "string" || child === null) {
          if (!asset(child, key, externalAssetFields.has(key))) return false;
        } else if (key === "asset" && isObject(child)) {
          if (Object.keys(child).some((field) => !["image", "url", "thumbnail", "revision", "status"].includes(field))) return false;
          if (["image", "url", "thumbnail"].some((field) => Object.hasOwn(child, field)
            && !asset(child[field], field, false))) return false;
          if (Object.hasOwn(child, "revision") && !Number.isSafeInteger(child.revision)) return false;
          if (Object.hasOwn(child, "status") && !["current", "stale", "pending", "rejected"].includes(child.status)) return false;
        } else return false;
      } else if (!validateAssets(child)) return false;
    }
    return true;
  };
  const validRecordArray = (entries) => Array.isArray(entries) && entries.length <= 100_000 && entries.every((entry) =>
    isObject(entry) && validId(entry.id) && validateAssets(entry));
  const validPieces = (pieces, max = 100) => Array.isArray(pieces) && pieces.length <= max && pieces.every((piece) =>
    isObject(piece) && validId(piece.itemId) && (!Object.hasOwn(piece, "variantId") || nullableString(piece.variantId, 512))
    && (!Object.hasOwn(piece, "scale") || finiteNumber(piece.scale, 0.5, 1.5)));
  const validVariants = (variants) => Array.isArray(variants) && variants.length <= 500 && variants.every((variant) =>
    isObject(variant) && validId(variant.id)
    && (!Object.hasOwn(variant, "name") || string(variant.name, 120))
    && (!Object.hasOwn(variant, "description") || string(variant.description, 500))
    && (!Object.hasOwn(variant, "tags") || stringArray(variant.tags, 24, 120))
    && (!Object.hasOwn(variant, "sourceRefs") || stringArray(variant.sourceRefs, 500, 512))
    && (!Object.hasOwn(variant, "origin") || ["photo", "generated"].includes(variant.origin))
    && (!Object.hasOwn(variant, "approvalStatus") || ["approved", "pending", "rejected"].includes(variant.approvalStatus))
    && (!Object.hasOwn(variant, "assetRevision") || Number.isSafeInteger(variant.assetRevision))
    && (!Object.hasOwn(variant, "modeledStatus") || [null, "processing", "error", "approved", "stale"].includes(variant.modeledStatus))
    && (!Object.hasOwn(variant, "modeledError") || nullableString(variant.modeledError))
    && (!Object.hasOwn(variant, "modeledTier") || [null, "standard", "premium", "openrouter"].includes(variant.modeledTier))
    && (!Object.hasOwn(variant, "cutout") || validAssetDescriptor(variant.cutout, ["current", "stale", "pending", "rejected"]))
    && (!Object.hasOwn(variant, "modeledPhoto") || validAssetDescriptor(variant.modeledPhoto, ["processing", "error", "approved", "stale"])));
  function validAssetDescriptor(value, statuses) {
    if (value === null) return true;
    if (typeof value === "string") return asset(value, "asset", false);
    if (!isObject(value) || Object.keys(value).some((key) => ![
      "image", "url", "thumbnail", "revision", "sourceRevision", "status", "error", "tier",
    ].includes(key))) return false;
    for (const field of ["image", "url", "thumbnail"]) {
      if (Object.hasOwn(value, field) && !asset(value[field], field, false)) return false;
    }
    for (const field of ["revision", "sourceRevision"]) {
      if (Object.hasOwn(value, field) && value[field] !== null && !Number.isSafeInteger(value[field])) return false;
    }
    if (Object.hasOwn(value, "status") && ![null, ...statuses].includes(value.status)) return false;
    if (Object.hasOwn(value, "error") && !nullableString(value.error)) return false;
    if (Object.hasOwn(value, "tier") && ![null, "standard", "premium", "openrouter"].includes(value.tier)) return false;
    return true;
  }
  const validReferences = (references) => Array.isArray(references) && references.length <= 500 && references.every((reference) =>
    isObject(reference) && (!Object.hasOwn(reference, "id") || validId(reference.id))
    && (!Object.hasOwn(reference, "scope") || ["item", "variant"].includes(reference.scope))
    && (!Object.hasOwn(reference, "role") || ["view", "detail"].includes(reference.role))
    && (!Object.hasOwn(reference, "variantId") || nullableString(reference.variantId, 512))
    && (!Object.hasOwn(reference, "label") || string(reference.label, 120))
    && (!Object.hasOwn(reference, "distinctive") || typeof reference.distinctive === "boolean"));
  const validStrings = (entry, field, maxItems = 10_000, maxText = 4_096) =>
    !Object.hasOwn(entry, field) || stringArray(entry[field], maxItems, maxText);

  if (["library.json", "outfits.json", "inspo.json", "wishlist.json", "cheat-sheets.json"].includes(name)) {
    if (!validRecordArray(value)) return `Invalid ${name} catalog shape`;
    for (const entry of value) {
      if (["library.json", "outfits.json", "inspo.json", "wishlist.json", "cheat-sheets.json"].includes(name)) {
        for (const field of ["name", "title", "description", "notes", "part", "color", "secondaryColor", "modeledStatus", "modeledError", "modeledTier", "createdAt", "updatedAt"]) {
          if (Object.hasOwn(entry, field) && !nullableString(entry[field])) return `Invalid ${name} catalog shape`;
        }
      }
      if (name === "library.json") {
        if ((Object.hasOwn(entry, "variants") && !validVariants(entry.variants))
            || (Object.hasOwn(entry, "references") && !validReferences(entry.references))
            || !["tags", "palette"].every((field) => validStrings(entry, field, 500, 256))
            || (Object.hasOwn(entry, "defaultVariantId") && !nullableString(entry.defaultVariantId, 512))
            || (Object.hasOwn(entry, "assetRevision") && !Number.isSafeInteger(entry.assetRevision))
            || (Object.hasOwn(entry, "modeledStatus") && ![null, "processing", "error", "approved", "stale"].includes(entry.modeledStatus))
            || (Object.hasOwn(entry, "modeledTier") && ![null, "standard", "premium", "openrouter"].includes(entry.modeledTier))) return "Invalid library catalog shape";
      } else if (name === "outfits.json") {
        if ((Object.hasOwn(entry, "pieces") && !validPieces(entry.pieces, 12))
            || !validStrings(entry, "itemIds", 12, 512)
            || !validStrings(entry, "tags", 100, 256)
            || (Object.hasOwn(entry, "modeledStatus") && ![null, "processing", "error"].includes(entry.modeledStatus))
            || (Object.hasOwn(entry, "modeledTier") && ![null, "standard", "premium", "openrouter"].includes(entry.modeledTier))) return "Invalid outfits.json catalog shape";
      } else if (name === "inspo.json") {
        if (!validStrings(entry, "colors", 20, 100)
            || (Object.hasOwn(entry, "sourceUrl") && !nullableString(entry.sourceUrl, 4_096))
            || (Object.hasOwn(entry, "sourceFilename") && !nullableString(entry.sourceFilename, 512))
            || (Object.hasOwn(entry, "category") && !nullableString(entry.category, 120))
            || (Object.hasOwn(entry, "detectStatus") && ![null, "processing", "error"].includes(entry.detectStatus))
            || (Object.hasOwn(entry, "detectError") && !nullableString(entry.detectError))) return "Invalid inspo.json catalog shape";
      } else if (name === "wishlist.json") {
        if (!validStrings(entry, "tags", 100, 256) || !validStrings(entry, "palette", 20, 100)
            || (Object.hasOwn(entry, "generateStatus") && ![null, "processing", "error"].includes(entry.generateStatus))
            || (Object.hasOwn(entry, "generateError") && !nullableString(entry.generateError))) return "Invalid wishlist.json catalog shape";
      } else if (name === "cheat-sheets.json") {
        if ((Object.hasOwn(entry, "pieces") && !validPieces(entry.pieces, 100))
            || (Object.hasOwn(entry, "revision") && !Number.isSafeInteger(entry.revision))
            || (Object.hasOwn(entry, "layoutVersion") && !Number.isSafeInteger(entry.layoutVersion))
            || (Object.hasOwn(entry, "sourceFingerprint") && !/^[a-f0-9]{64}$/i.test(entry.sourceFingerprint))
            || (Object.hasOwn(entry, "beautifyStatus") && ![null, "processing", "error", "ready"].includes(entry.beautifyStatus))
            || (Object.hasOwn(entry, "beautifyTier") && ![null, "standard", "premium", "openrouter"].includes(entry.beautifyTier))
            || (Object.hasOwn(entry, "beautifyError") && !nullableString(entry.beautifyError))
            || (Object.hasOwn(entry, "beautifyPrompt") && !nullableString(entry.beautifyPrompt, 100_000))) return "Invalid cheat-sheets.json catalog shape";
        if (Object.hasOwn(entry, "bands") && (!Array.isArray(entry.bands) || entry.bands.length > 101 || entry.bands.some((band) =>
          !isObject(band) || !["title", "row"].includes(band.kind)
          || (band.kind === "row" && (!validStrings(band, "itemIds", 4, 512) || !validId(band.groupId)))
          || (band.kind === "title" && Object.hasOwn(band, "itemIds") && !validStrings(band, "itemIds", 0, 512))))) return "Invalid cheat-sheets.json catalog shape";
        if (Object.hasOwn(entry, "settings")) {
          const settings = entry.settings;
          if (!isObject(settings)
              || Object.keys(settings).some((key) => !["layoutVersion", "pieceScales"].includes(key))
              || (Object.hasOwn(settings, "layoutVersion") && !Number.isSafeInteger(settings.layoutVersion))
              || (Object.hasOwn(settings, "pieceScales") && (!isObject(settings.pieceScales)
                || Object.entries(settings.pieceScales).length > 100
                || Object.entries(settings.pieceScales).some(([id, scale]) => !validId(id) || !finiteNumber(scale, 0.5, 1.5))))) {
            return "Invalid cheat-sheets.json catalog shape";
          }
        }
      }
    }
  } else if (name === "preferences.json") {
    if (!isObject(value) || value.version !== 1 || !Array.isArray(value.signals)
        || value.signals.length > 2000 || value.signals.some((signal) => !isObject(signal)
          || typeof signal.type !== "string" || typeof signal.at !== "string" || !Number.isFinite(Date.parse(signal.at)))) return "Invalid preferences catalog shape";
  } else if (name === "color-profile.json") {
    if (value !== null && (!isObject(value) || (value.season !== undefined && typeof value.season !== "string")
        || (value.palette !== undefined && (!Array.isArray(value.palette) || value.palette.some((color) => typeof color !== "string"))))) return "Invalid color profile catalog shape";
  } else if (name === "browser-state.json") {
    if (!isObject(value) || value.version !== 1 || !Number.isSafeInteger(value.archiveGeneration) || value.archiveGeneration < 1
        || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) || typeof value.migrationSealed !== "boolean"
        || !Array.isArray(value.migratedFields) || value.migratedFields.some((field) => !BROWSER_MIGRATED_FIELDS.has(field))
        || !Array.isArray(value.declutterKeptIds) || value.declutterKeptIds.some((id) => typeof id !== "string")
        || !Array.isArray(value.dismissedNudges) || value.dismissedNudges.some((id) => typeof id !== "string")
        || !["standard", "premium", "openrouter"].includes(value.modelTier) || typeof value.onboardingDismissed !== "boolean"
        || !isObject(value.wornToday) || typeof value.wornToday.day !== "string" || !Array.isArray(value.wornToday.ids)
        || value.wornToday.ids.some((id) => typeof id !== "string")) return "Invalid browser state catalog shape";
  } else if (name === "archive-metadata.json") {
    if (!isObject(value) || value.schemaVersion !== ARCHIVE_SCHEMA_VERSION || !Number.isSafeInteger(value.archiveGeneration) || value.archiveGeneration < 1
        || !isObject(value.referenceSources) || Object.keys(value).some((key) => !["schemaVersion", "archiveGeneration", "referenceSources"].includes(key))) return "Invalid archive metadata shape";
  } else if (name === "ai-mode.json") {
    if (!isObject(value) || !["test", "prod"].includes(value.mode) || Object.keys(value).some((key) => key !== "mode")) return "Invalid AI mode shape";
  }
  return null;
}

export function isAllowedArchivePath(relative) {
  if (ARCHIVE_CATALOGS.includes(relative) || isCanonicalReference(relative)) return true;
  const root = ARCHIVE_MEDIA_ROOTS.find((candidate) => relative.startsWith(`${candidate}/`));
  if (!root) return false;
  const segments = relative.split("/");
  if (segments.slice(1).some(isControlName)) return false;
  return IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

export async function resolveArchiveFile(dataDir, requestedPath) {
  await assertArchiveRoot(dataDir);
  let relative;
  try { relative = archivePathFromAsset(requestedPath) || safeArchivePath(requestedPath); }
  catch (error) { throw Object.assign(error, { status: error.status || 400 }); }
  if (!isAllowedArchivePath(relative)) throw Object.assign(new Error("Asset is outside the archive allowlist"), { status: 404 });
  let current = dataDir;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Object.assign(new Error("Archive assets cannot be symbolic links"), { status: 400 });
  }
  const info = await stat(current);
  if (!info.isFile()) throw Object.assign(new Error("Archive asset is not a file"), { status: 404 });
  return current;
}

function fileExtension({ mime, filename, bytes }) {
  const ext = path.extname(filename || "").toLowerCase();
  const mimeExtension = MIME_EXTENSIONS.get(String(mime || "").toLowerCase());
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return ".gif";
  if (["II*\0", "MM\0*"].includes(bytes.subarray(0, 4).toString("ascii"))) return ".tiff";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return ".bmp";
  const brand = bytes.subarray(4, 12).toString("ascii");
  if (brand.includes("ftypavif") || brand.includes("ftypavis")) return ".avif";
  if (/ftyp(?:heic|heix|hevc|hevx|mif1|msf1|heif)/.test(brand)) return brand.includes("heif") || brand.includes("mif1") || brand.includes("msf1") ? ".heif" : ".heic";
  if ((ext && IMAGE_EXTENSIONS.has(ext)) || (mimeExtension && IMAGE_EXTENSIONS.has(mimeExtension))) {
    throw new Error("Original content does not match a supported image signature");
  }
  if (!ext && !mimeExtension) throw new Error("Original content is not a supported image");
  throw new Error("Could not determine a supported image extension for the original");
}

export async function preserveOriginal({ dataDir, bytes, filePath, mime, filename }) {
  return withArchiveWriteLease(dataDir, async () => preserveOriginalUnlocked({ dataDir, bytes, filePath, mime, filename }));
}

async function preserveOriginalUnlocked({ dataDir, bytes, filePath, mime, filename }) {
  await assertArchiveRoot(dataDir);
  const sourceBytes = bytes ? Buffer.from(bytes) : await readFile(filePath);
  if (!sourceBytes.length) throw new Error("Original image is empty");
  const extension = fileExtension({ mime, filename: filename || filePath, bytes: sourceBytes });
  const digest = sha256(sourceBytes);
  const relative = `originals/${digest}${extension}`;
  const target = path.join(dataDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const originalsInfo = await assertNoSymlink(path.dirname(target));
  if (!originalsInfo?.isDirectory()) throw new Error("Original archive directory is not safe");
  const targetInfo = await assertNoSymlink(target);
  if (targetInfo?.isFile()) {
    const existing = await readFile(target);
    if (sha256(existing) !== digest) throw new Error(`Original checksum collision at ${relative}`);
  } else {
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await assertNoSymlink(temp);
    await writeFile(temp, sourceBytes, { flag: "wx" });
    await rename(temp, target);
  }
  return { path: relative, size: sourceBytes.length, sha256: digest, mime: mimeForExtension(extension), extension, filename: path.basename(filename || filePath || "original") };
}

export function mimeForExtension(extension) {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff", ".avif": "image/avif", ".bmp": "image/bmp", ".heic": "image/heic", ".heif": "image/heif" })[extension] || "application/octet-stream";
}

export function resolveReferencePath({ root, dataDir, setting, kind = "full" }) {
  const basename = kind === "face" ? "model-reference-face.png" : "model-reference.png";
  const canonical = path.join(dataDir, basename);
  const configured = setting(kind === "face" ? "WARDROBE_FACE_REFERENCE" : "WARDROBE_MODEL_REFERENCE", kind === "face" ? "" : "data/model-reference.png").trim();
  const external = configured ? path.resolve(root, configured) : canonical;
  return { canonical, configured: external, selected: canonical };
}

async function selectedReferenceGeneration(dataDir) {
  let generation = 0;
  let found = false;
  for (const name of ["archive-metadata.json", "browser-state.json"]) {
    try {
      const value = JSON.parse(await readFile(path.join(dataDir, name), "utf8"));
      found = true;
      if (!Number.isSafeInteger(value?.archiveGeneration) || value.archiveGeneration < 0) return Infinity;
      generation = Math.max(generation, value.archiveGeneration);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return Infinity;
    }
  }
  return found ? generation : 0;
}

export async function readReferenceBytes({ root, dataDir, setting, kind = "full" }) {
  if (kind === "face") {
    const configured = setting("WARDROBE_FACE_REFERENCE").trim().toLowerCase();
    if (["off", "none", "false", "0"].includes(configured)) return null;
  }
  const paths = resolveReferencePath({ root, dataDir, setting, kind });
  const base = kind === "face" ? "model-reference-face" : "model-reference";
  const canonicalCandidates = [".png", ".jpg", ".jpeg", ".webp"].map((extension) => path.join(dataDir, `${base}${extension}`));
  // Generation 1 is the pre-restore bootstrap case: preserve the configured
  // source's original MIME/bytes. After a total restore the archive's chosen
  // references (including deliberate absence) are authoritative over stale
  // external settings.
  const restoredGeneration = await selectedReferenceGeneration(dataDir) > 1;
  const candidates = restoredGeneration ? canonicalCandidates : [paths.configured, ...canonicalCandidates];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try {
      const relative = path.relative(dataDir, candidate);
      const archivePath = relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
        ? relative.split(path.sep).join("/")
        : null;
      const isCanonical = archivePath && isCanonicalReference(archivePath);
      const safeCandidate = isCanonical
        ? await resolveArchiveFile(dataDir, archivePath)
        : candidate;
      const info = isCanonical ? await stat(safeCandidate) : await assertNoSymlink(safeCandidate);
      if (!info?.isFile()) continue;
      const bytes = await readFile(safeCandidate);
      const mime = mimeForExtension(path.extname(safeCandidate).toLowerCase());
      let extension;
      try { extension = fileExtension({ mime, filename: safeCandidate, bytes }); }
      catch { continue; }
      return { data: bytes, mime: mimeForExtension(extension), name: path.basename(safeCandidate), path: safeCandidate };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

export async function prepareArchiveDirectory({ root, dataDir, setting }) {
  const resolvedDataDir = path.resolve(dataDir);
  return withArchiveWriteLease(resolvedDataDir, async () => prepareArchiveDirectoryUnlocked({ root, dataDir: resolvedDataDir, setting }));
}

async function prepareArchiveDirectoryUnlocked({ root, dataDir, setting }) {
  const preflight = await inspectArchiveCatalogs(dataDir);
  if (!preflight.valid) throw new ArchiveCatalogPreflightError(preflight);
  await mkdir(dataDir, { recursive: true });
  await assertArchiveRoot(dataDir);
  const metadataFile = path.join(dataDir, "archive-metadata.json");
  try { await readFile(metadataFile); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temp = `${metadataFile}.${process.pid}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify({ schemaVersion: ARCHIVE_SCHEMA_VERSION, archiveGeneration: 1, referenceSources: {} }, null, 2)}\n`, { flag: "wx" });
      await rename(temp, metadataFile);
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
    }
  }
  for (const kind of ["full", "face"]) {
    const base = kind === "face" ? "model-reference-face" : "model-reference";
    let hasCanonical = false;
    for (const extension of [".png", ".jpg", ".jpeg", ".webp"]) {
      const info = await assertNoSymlink(path.join(dataDir, `${base}${extension}`));
      if (info && !info.isFile()) throw new Error(`Canonical reference is not a file: ${path.join(dataDir, `${base}${extension}`)}`);
      hasCanonical ||= Boolean(info);
    }
    if (hasCanonical || await selectedReferenceGeneration(dataDir) > 1) continue;
    const paths = resolveReferencePath({ root, dataDir, setting, kind });
    const info = paths.configured ? await assertNoSymlink(paths.configured) : null;
    if (!info?.isFile() || path.resolve(paths.configured) === path.resolve(paths.canonical)) continue;
    const sourceBytes = await readFile(paths.configured);
    const ext = path.extname(paths.configured).toLowerCase();
    try { fileExtension({ mime: mimeForExtension(ext), filename: paths.configured, bytes: sourceBytes }); }
    catch { continue; }
    const canonical = paths.canonical;
    const targetInfo = await assertNoSymlink(canonical);
    if (targetInfo && !targetInfo.isFile()) throw new Error(`Canonical reference is not a file: ${canonical}`);
    // External settings bootstrap the archive only when no portable canonical
    // reference exists. Replacing one on every startup would undo restores;
    // explicit setup uploads update the canonical reference themselves.
    if (targetInfo) continue;
    let normalized;
    try { normalized = await sharp(sourceBytes).rotate().toColorspace("srgb").png().toBuffer(); }
    catch { continue; }
    const temp = `${canonical}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, normalized, { flag: "wx" });
    await rename(temp, canonical);
    // Capturing the external reference's bytes makes the provenance durable if
    // the user later removes the old configured path.
    await preserveOriginal({ dataDir, bytes: sourceBytes, mime: mimeForExtension(ext), filename: path.basename(paths.configured) });
  }
}

export async function migrateCatalogAssetPaths(dataDir, atomicJson, mutateLibrary) {
  return withArchiveWriteLease(dataDir, async () => migrateCatalogAssetPathsUnlocked(dataDir, atomicJson, mutateLibrary));
}

async function migrateCatalogAssetPathsUnlocked(dataDir, atomicJson, mutateLibrary) {
  const preflight = await inspectArchiveCatalogs(dataDir);
  if (!preflight.valid) throw new ArchiveCatalogPreflightError(preflight);
  for (const name of ARCHIVE_CATALOGS) {
    const file = path.join(dataDir, name);
    if (name === "library.json") {
      await mutateLibrary(dataDir, (records) => catalogForDisk(records));
      continue;
    }
    let value;
    try { value = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const converted = catalogForDisk(value);
    if (JSON.stringify(converted) !== JSON.stringify(value)) await atomicJson(file, converted);
  }
}
