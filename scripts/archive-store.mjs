import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import sharp from "sharp";
import { archivePathFromAsset, catalogForDisk, isArchiveAssetField, safeArchivePath } from "../shared/portable-assets.mjs";

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

export async function readReferenceBytes({ root, dataDir, setting, kind = "full" }) {
  if (kind === "face") {
    const configured = setting("WARDROBE_FACE_REFERENCE").trim().toLowerCase();
    if (["off", "none", "false", "0"].includes(configured)) return null;
  }
  const paths = resolveReferencePath({ root, dataDir, setting, kind });
  const base = kind === "face" ? "model-reference-face" : "model-reference";
  const canonicalCandidates = [".png", ".jpg", ".jpeg", ".webp"].map((extension) => path.join(dataDir, `${base}${extension}`));
  for (const candidate of new Set([paths.configured, ...canonicalCandidates])) {
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
    for (const extension of [".png", ".jpg", ".jpeg", ".webp"]) {
      await assertNoSymlink(path.join(dataDir, `${base}${extension}`));
    }
  }
  for (const kind of ["full", "face"]) {
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
    let normalized;
    try { normalized = await sharp(sourceBytes).rotate().toColorspace("srgb").png().toBuffer(); }
    catch { continue; }
    const previous = targetInfo ? await readFile(canonical) : null;
    if (!previous || !previous.equals(normalized)) {
      const temp = `${canonical}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, normalized, { flag: "wx" });
      await rename(temp, canonical);
    }
    // Capturing the external reference's bytes makes the provenance durable if
    // the user later removes the old configured path.
    await preserveOriginal({ dataDir, bytes: sourceBytes, mime: mimeForExtension(ext), filename: path.basename(paths.configured) });
  }
}

export async function migrateCatalogAssetPaths(dataDir, atomicJson, mutateLibrary) {
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
