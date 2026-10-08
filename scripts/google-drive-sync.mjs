import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import {
  ARCHIVE_CATALOGS,
  ARCHIVE_SCHEMA_VERSION,
  buildArchiveInventory,
  createArchiveSnapshot,
  hashArchiveFile,
  isAllowedArchivePath,
  validateArchive,
} from "./archive-store.mjs";
import { hasGoogleDrivePrivatePathComponent } from "./google-drive-private-path.mjs";
import { safeArchivePath } from "../shared/portable-assets.mjs";

export const GOOGLE_DRIVE_OUTAGE_NOTICE = "Le modifiche vengono salvate sul computer. Quando il collegamento sarà ripristinato, l’archivio locale sovrascriverà quello su Google Drive.";

const STATE_VERSION = 1;
const COMMIT_NAME = "wardrobe-archive-commit.json";
const INVENTORY_NAME = ".wardrobe-inventory.json";
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 15_000;
const VERIFY_INTERVAL_MS = 5 * 60 * 1000;

export class GoogleDriveSyncError extends Error {
  constructor(code, message = code, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "GoogleDriveSyncError";
    this.code = code;
    this.retryable = retryable;
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function fingerprint(inventory) { return sha256(Buffer.from(JSON.stringify(inventory))); }
function sameTarget(left, right) {
  return Boolean(left && right && ["targetFingerprint", "connectionGeneration", "accountId", "folderId", "driveId"]
    .every((key) => (left[key] ?? null) === (right[key] ?? null)));
}
function sameArchiveDestination(left, right) {
  return Boolean(left && right && ["targetFingerprint", "accountId", "folderId", "driveId"]
    .every((key) => (left[key] ?? null) === (right[key] ?? null)));
}
function validTargetRecord(target) {
  return Boolean(target && typeof target === "object" && !Array.isArray(target)
    && typeof target.targetFingerprint === "string" && /^[a-f0-9]{64}$/.test(target.targetFingerprint)
    && typeof target.connectionGeneration === "string" && /^[a-f0-9-]{32,40}$/i.test(target.connectionGeneration)
    && typeof target.accountId === "string" && target.accountId.length >= 5 && target.accountId.length <= 200
    && !/[\0\r\n]/.test(target.accountId)
    && typeof target.folderId === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(target.folderId)
    && (target.driveId === null || (typeof target.driveId === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(target.driveId))));
}
function owned(metadata, version, relativePath) {
  return metadata?.appProperties?.wardrobeVersion === version
    && [sha256(Buffer.from(relativePath)), relativePath].includes(metadata.appProperties?.wardrobePath);
}
function props(version, relativePath, digest = "") {
  return { wardrobeVersion: version, wardrobePath: sha256(Buffer.from(relativePath)), wardrobeSha256: digest };
}
function isAllowedArchiveDirectory(relative) {
  return ["imported", "outfits-assets", "outfit-images", "inspo-assets", "wishlist-assets", "cheat-sheets-assets", "originals"]
    .some((root) => relative === root || relative.startsWith(`${root}/`));
}
function safeErrorCode(error) {
  const codes = new Set([
    "target_changed", "stale_connection", "reconnect_required", "private_state_invalid",
    "google_unavailable", "google_permission_denied", "folder_access_denied", "folder_read_denied",
    "folder_write_denied", "file_read_denied", "file_write_denied", "file_delete_denied", "file_trashed", "incomplete_drive_listing",
    "malformed_drive_listing", "drive_listing_too_large", "drive_listing_too_many_pages",
    "drive_parent_ambiguous", "drive_parent_mismatch", "shortcut_not_supported",
    "google_document_not_supported", "file_too_large", "resumable_session_expired",
    "remote_checksum_mismatch", "sync_conflict", "sync_state_invalid", "archive_invalid",
    "snapshot_changed", "sync_paused", "sync_lock_busy", "upload_failed", "sync_failed", "cleanup_pending",
  ]);
  return codes.has(error?.code) ? error.code : "sync_failed";
}
function defaultState() {
  return {
    version: STATE_VERSION,
    enabled: false,
    paused: true,
    epoch: 0,
    target: null,
    phase: "disabled",
    desiredFingerprint: null,
    candidate: null,
    lastCompleted: null,
    operations: {},
    pendingCleanup: null,
    pendingCleanups: [],
    orphanCandidates: [],
    restoreAuthorization: null,
    progress: { currentFiles: 0, totalFiles: 0, currentBytes: 0, totalBytes: 0 },
    retry: { attempts: 0, at: null },
    lastError: null,
    lastVerifiedAt: null,
  };
}
function validState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const safeErrors = new Set([
    "target_changed", "stale_connection", "reconnect_required", "private_state_invalid", "google_unavailable",
    "google_permission_denied", "folder_access_denied", "folder_read_denied", "folder_write_denied", "file_read_denied",
    "file_write_denied", "file_delete_denied", "file_trashed", "incomplete_drive_listing", "malformed_drive_listing",
    "drive_listing_too_large", "drive_listing_too_many_pages", "drive_parent_ambiguous", "drive_parent_mismatch",
    "shortcut_not_supported", "google_document_not_supported", "file_too_large", "resumable_session_expired",
    "remote_checksum_mismatch", "sync_conflict", "sync_state_invalid", "archive_invalid", "snapshot_changed",
    "sync_paused", "sync_lock_busy", "upload_failed", "sync_failed", "cleanup_pending",
  ]);
  const validOrphan = (item) => item && typeof item === "object" && !Array.isArray(item)
    && typeof item.name === "string" && /^wardrobe-snapshot-[a-f0-9]{20}-\d+-[a-f0-9-]{8,40}$/.test(item.name)
    && /^[a-f0-9]{64}$/.test(item.fingerprint || "")
    && (item.descriptorFingerprint === null || item.descriptorFingerprint === undefined || /^[a-f0-9]{64}$/.test(item.descriptorFingerprint))
    && (item.snapshotId === null || /^[A-Za-z0-9_-]{5,200}$/.test(item.snapshotId || ""))
    && Array.isArray(item.inventory?.files) && validTargetRecord(item.target)
    && item.files && typeof item.files === "object" && !Array.isArray(item.files)
    && (item.inventoryId === null || /^[A-Za-z0-9_-]{5,200}$/.test(item.inventoryId || ""))
    && (item.inventorySha256 === null || /^[a-f0-9]{64}$/.test(item.inventorySha256 || ""))
    && ((item.inventoryId === null) === (item.inventorySha256 === null));
  const validRestoreAuthorization = state.restoreAuthorization === undefined || state.restoreAuthorization === null
    || (typeof state.restoreAuthorization === "object" && typeof state.restoreAuthorization.id === "string"
      && /^[0-9a-f-]{36}$/i.test(state.restoreAuthorization.id)
      && Number.isFinite(state.restoreAuthorization.expiresAt) && validTargetRecord(state.restoreAuthorization.target)
      && /^[a-f0-9]{64}$/.test(state.restoreAuthorization.remoteFingerprint || "")
      && /^[a-f0-9]{64}$/.test(state.restoreAuthorization.descriptorFingerprint || "")
      && typeof state.restoreAuthorization.snapshotId === "string"
      && /^[A-Za-z0-9_-]{5,200}$/.test(state.restoreAuthorization.snapshotId)
      && typeof state.restoreAuthorization.snapshotName === "string"
      && state.restoreAuthorization.snapshotName.length > 0 && state.restoreAuthorization.snapshotName.length <= 255
      && !/[\0\r\n/\\]/.test(state.restoreAuthorization.snapshotName)
      && Math.abs(state.restoreAuthorization.expiresAt) <= 8.64e15);
  const validCandidate = state.candidate === null || (state.candidate && typeof state.candidate.name === "string"
    && typeof state.candidate.fingerprint === "string" && /^[a-f0-9]{64}$/.test(state.candidate.fingerprint)
    && typeof state.candidate.directory === "string" && state.candidate.inventory && Array.isArray(state.candidate.inventory.files));
  const validCompleted = state.lastCompleted === null || (state.lastCompleted && typeof state.lastCompleted.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(state.lastCompleted.fingerprint) && typeof state.lastCompleted.snapshotName === "string"
    && typeof state.lastCompleted.snapshotId === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(state.lastCompleted.snapshotId)
    && state.lastCompleted.snapshotName.length > 0 && state.lastCompleted.snapshotName.length <= 255 && !/[\0\r\n/\\]/.test(state.lastCompleted.snapshotName)
    && (state.lastCompleted.descriptorFingerprint === undefined || /^[a-f0-9]{64}$/.test(state.lastCompleted.descriptorFingerprint))
    && Number.isSafeInteger(state.lastCompleted.fileCount) && state.lastCompleted.fileCount >= 0
    && Number.isSafeInteger(state.lastCompleted.totalBytes) && state.lastCompleted.totalBytes >= 0
    && state.lastCompleted.files && typeof state.lastCompleted.files === "object" && !Array.isArray(state.lastCompleted.files)
    && typeof state.lastCompleted.completedAt === "string" && Number.isFinite(Date.parse(state.lastCompleted.completedAt))
    && new Date(state.lastCompleted.completedAt).toISOString() === state.lastCompleted.completedAt
    && Array.isArray(state.lastCompleted.directories || [])
    && (state.lastCompleted.hasUnknownRootMembers === undefined || typeof state.lastCompleted.hasUnknownRootMembers === "boolean"));
  return state.version === STATE_VERSION && typeof state.enabled === "boolean" && typeof state.paused === "boolean"
    && Number.isSafeInteger(state.epoch) && state.epoch >= 0
    && ["disabled", "paused", "idle", "syncing", "error", "cleanup_pending"].includes(state.phase)
    && state.operations && typeof state.operations === "object" && !Array.isArray(state.operations) && Object.keys(state.operations).length <= 100_000
    && (state.lastError === null || safeErrors.has(state.lastError))
    && state.progress && ["currentFiles", "totalFiles", "currentBytes", "totalBytes"].every((key) => Number.isSafeInteger(state.progress[key]) && state.progress[key] >= 0)
    && state.retry && Number.isSafeInteger(state.retry.attempts) && state.retry.attempts >= 0 && state.retry.attempts <= 20
    && (state.retry.at === null || (Number.isFinite(state.retry.at) && Math.abs(state.retry.at) <= 8.64e15))
    && (state.lastVerifiedAt === null || (Number.isFinite(state.lastVerifiedAt) && Math.abs(state.lastVerifiedAt) <= 8.64e15))
    && (state.pendingCleanups === undefined || (Array.isArray(state.pendingCleanups) && state.pendingCleanups.length <= 1000))
    && (state.pendingCleanup === null || validCleanupRecord(state.pendingCleanup))
    && (state.pendingCleanups === undefined || state.pendingCleanups.every(validCleanupRecord))
    && (state.orphanCandidates === undefined || (Array.isArray(state.orphanCandidates) && state.orphanCandidates.length <= 1000 && state.orphanCandidates.every(validOrphan)))
    && validRestoreAuthorization && validCandidate && validCompleted
    && (state.target === null || validTargetRecord(state.target));
}

function validCleanupRecord(cleanup) {
  if (!cleanup || typeof cleanup !== "object" || Array.isArray(cleanup)
      || !["snapshot", "root-members"].includes(cleanup.kind)
      || !/^[a-f0-9]{64}$/.test(cleanup.afterFingerprint || "")
      || (cleanup.afterSnapshotId !== undefined && (typeof cleanup.afterSnapshotId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(cleanup.afterSnapshotId)))
      || (cleanup.afterSnapshotName !== undefined && (typeof cleanup.afterSnapshotName !== "string" || !/^wardrobe-snapshot-[a-f0-9]{20}-\d+-[a-f0-9-]{8,40}$/.test(cleanup.afterSnapshotName)))
      || (cleanup.afterDescriptorFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(cleanup.afterDescriptorFingerprint))
      || !Array.isArray(cleanup.members) || !Array.isArray(cleanup.directories)
      || (cleanup.committed !== undefined && typeof cleanup.committed !== "boolean")
      || (cleanup.portableSnapshot !== undefined && typeof cleanup.portableSnapshot !== "boolean")
      || (cleanup.inventoryOperationOwned !== undefined && typeof cleanup.inventoryOperationOwned !== "boolean")
      || (cleanup.target !== undefined && !validTargetRecord(cleanup.target))) return false;
  if ((cleanup.inventoryId === null || cleanup.inventoryId === undefined)
      !== (cleanup.inventorySha256 === null || cleanup.inventorySha256 === undefined)) return false;
  if (cleanup.inventoryId !== null && cleanup.inventoryId !== undefined
      && (typeof cleanup.inventoryId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(cleanup.inventoryId))) return false;
  if (cleanup.inventorySha256 !== null && cleanup.inventorySha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(cleanup.inventorySha256)) return false;
  if (cleanup.kind === "snapshot") return typeof cleanup.snapshotId === "string"
      && /^[A-Za-z0-9_-]{5,200}$/.test(cleanup.snapshotId)
      && typeof cleanup.snapshotName === "string" && cleanup.snapshotName.length > 0
      && cleanup.snapshotName.length <= 255 && !/[\0\r\n/\\]/.test(cleanup.snapshotName);
  return typeof cleanup.rootId === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(cleanup.rootId)
    && cleanup.containerId === cleanup.rootId && typeof cleanup.preserveUnknown === "boolean";
}
function sessionUrlIsSafe(value, operation = null) {
  try {
    const url = new URL(value);
    const ids = url.searchParams.getAll("upload_id");
    const expectedPath = operation?.updating
      ? `/upload/drive/v3/files/${encodeURIComponent(operation.fileId || operation.id || "")}`
      : "/upload/drive/v3/files";
    return url.protocol === "https:" && url.origin === "https://www.googleapis.com"
      && url.pathname === expectedPath && !url.username && !url.password && !url.hash
      && ids.length === 1 && Boolean(ids[0]) && ids[0].length <= 1024 && !/[\0\r\n]/.test(ids[0])
      && [...url.searchParams.keys()].every((key) => key === "upload_id" || key === "uploadType");
  } catch { return false; }
}
function validateLoadedState(state) {
  if (!validState(state)) throw new GoogleDriveSyncError("sync_state_invalid");
  const validateMappings = (files) => {
    if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length > 50_000) throw new GoogleDriveSyncError("sync_state_invalid");
    const ids = new Set();
    for (const [relative, value] of Object.entries(files)) {
      if (!isAllowedArchivePath(relative) || !value || typeof value !== "object"
          || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(value.id)
          || !Number.isSafeInteger(value.size) || value.size < 0 || !/^[a-f0-9]{64}$/.test(value.sha256)
          || (value.parentId !== undefined && (typeof value.parentId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(value.parentId)))) {
        throw new GoogleDriveSyncError("sync_state_invalid");
      }
      if (ids.has(value.id)) throw new GoogleDriveSyncError("sync_state_invalid");
      ids.add(value.id);
    }
  };
  const validateDirectories = (directories) => {
    if (!Array.isArray(directories)) throw new GoogleDriveSyncError("sync_state_invalid");
    const paths = new Set();
    const ids = new Set();
    for (const item of directories) {
      if (!item || !isAllowedArchiveDirectory(item.path) || typeof item.id !== "string"
          || !/^[A-Za-z0-9_-]{5,200}$/.test(item.id) || typeof item.parentId !== "string"
          || !/^[A-Za-z0-9_-]{5,200}$/.test(item.parentId)) throw new GoogleDriveSyncError("sync_state_invalid");
      if (paths.has(item.path) || ids.has(item.id)) throw new GoogleDriveSyncError("sync_state_invalid");
      paths.add(item.path);
      ids.add(item.id);
    }
  };
  if (state.candidate) validateMappings(state.candidate.files);
  if (state.candidate) validateDirectories(state.candidate.directories);
  for (const orphan of state.orphanCandidates || []) {
    validateInventory(orphan.inventory);
    validateMappings(orphan.files);
    validateDirectories(orphan.directories || []);
  }
  if (state.lastCompleted) {
    validateMappings(state.lastCompleted.files);
    validateDirectories(state.lastCompleted.directories);
  }
  for (const cleanup of state.pendingCleanups || (state.pendingCleanup ? [state.pendingCleanup] : [])) {
    for (const item of cleanup.members) {
      if (!item || !isAllowedArchivePath(item.path) || typeof item.id !== "string"
          || !/^[A-Za-z0-9_-]{5,200}$/.test(item.id) || !Number.isSafeInteger(item.size) || item.size < 0
          || !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.parentId !== "string"
          || !/^[A-Za-z0-9_-]{5,200}$/.test(item.parentId)
          || (item.operationOwned !== undefined && typeof item.operationOwned !== "boolean")) throw new GoogleDriveSyncError("sync_state_invalid");
    }
    for (const item of cleanup.directories) {
      if (!item || !isAllowedArchiveDirectory(item.path) || typeof item.id !== "string" || typeof item.parentId !== "string"
          || !/^[A-Za-z0-9_-]{5,200}$/.test(item.id) || !/^[A-Za-z0-9_-]{5,200}$/.test(item.parentId)) {
        throw new GoogleDriveSyncError("sync_state_invalid");
      }
    }
  }
  for (const operation of Object.values(state.operations)) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)
        || (operation.id !== undefined && (typeof operation.id !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(operation.id)))
        || (operation.kind !== undefined && !["folder", "inventory"].includes(operation.kind))
        || (operation.kind === "folder" && (typeof operation.path !== "string" || !(operation.path.startsWith(".folder/") || operation.path.startsWith(".snapshot/"))))
        || (operation.kind === "inventory" && (typeof operation.parentId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(operation.parentId)
          || !/^[a-f0-9]{64}$/.test(operation.sha256 || "") || !Number.isSafeInteger(operation.size) || operation.size < 0))
        || (operation.sessionUrl && (!sessionUrlIsSafe(operation.sessionUrl, operation)
          || !operation.parentId || !operation.relativePath || !isAllowedArchivePath(operation.relativePath)
          || !Number.isSafeInteger(operation.size) || !/^[a-f0-9]{64}$/.test(operation.sha256)))
        || (operation.id === undefined && !["folder", "inventory"].includes(operation.kind))
        || (operation.sessionUrl && operation.complete === true)
        || (operation.complete !== undefined && typeof operation.complete !== "boolean")
        || (operation.offset !== undefined && (!Number.isSafeInteger(operation.offset) || operation.offset < 0))
        || (operation.size !== undefined && (!Number.isSafeInteger(operation.size) || operation.size < 0 || (operation.offset || 0) > operation.size))
        || (operation.parentId !== undefined && (typeof operation.parentId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(operation.parentId)))
        || (operation.fileId !== undefined && (typeof operation.fileId !== "string" || !/^[A-Za-z0-9_-]{5,200}$/.test(operation.fileId)))
        || (operation.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(operation.sha256))
        || (operation.relativePath !== undefined && !isAllowedArchivePath(operation.relativePath))
        || (operation.updating !== undefined && typeof operation.updating !== "boolean")
        || (operation.updating === true && (!operation.fileId || operation.id !== operation.fileId))) throw new GoogleDriveSyncError("sync_state_invalid");
  }
  return state;
}

async function ensurePrivateDirectory(directory) {
  if (!hasGoogleDrivePrivatePathComponent(directory)) throw new GoogleDriveSyncError("private_state_invalid");
  const info = await lstat(directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new GoogleDriveSyncError("private_state_invalid");
  if (!info) await mkdir(directory, { recursive: false, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function ensurePrivateChild(parent, child) {
  await ensurePrivateDirectory(parent);
  const info = await lstat(child).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new GoogleDriveSyncError("private_state_invalid");
  if (!info) await mkdir(child, { recursive: false, mode: 0o700 });
  await chmod(child, 0o700);
}

async function atomicJson(filePath, value) {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temp = path.join(directory, `.sync-state-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally { await handle.close(); }
  try { await rename(temp, filePath); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

async function writeChunk(stream, bytes) {
  if (stream.write(bytes)) return;
  await Promise.race([
    once(stream, "drain"),
    once(stream, "error").then(([error]) => Promise.reject(error)),
  ]);
}

async function readJsonFile(client, id, maxBytes = 16 * 1024 * 1024) {
  const bytes = await client.readFile(id);
  if (bytes.length > maxBytes) throw new GoogleDriveSyncError("file_too_large");
  try { return { value: JSON.parse(bytes.toString("utf8")), bytes }; }
  catch (error) { throw new GoogleDriveSyncError("archive_invalid", "Remote archive metadata is invalid", { cause: error }); }
}

// Catalog emptiness is asynchronous because catalogs may be large even though media hashing is streamed.
async function isSemanticallyEmpty(inventory, directory) {
  if (inventory.files.some((entry) => !ARCHIVE_CATALOGS.includes(entry.path))) return false;
  for (const entry of inventory.files) {
    let value;
    try { value = JSON.parse(await readFile(path.join(directory, ...entry.path.split("/")), "utf8")); }
    catch { return false; }
    if (entry.path === "archive-metadata.json") {
      if (!value || typeof value !== "object" || Array.isArray(value)
          || !["schemaVersion", "archiveGeneration", "referenceSources"].every((key) => Object.hasOwn(value, key))
          || Object.keys(value).some((key) => !["schemaVersion", "archiveGeneration", "referenceSources"].includes(key))
          || value.schemaVersion !== ARCHIVE_SCHEMA_VERSION || !Number.isSafeInteger(value.archiveGeneration) || value.archiveGeneration < 1
          || !value.referenceSources || typeof value.referenceSources !== "object" || Array.isArray(value.referenceSources)
          || Object.keys(value.referenceSources).length > 0) return false;
      continue;
    }
    if (entry.path === "ai-mode.json") {
      if (!value || typeof value !== "object" || Array.isArray(value) || value.mode !== "prod"
          || Object.keys(value).some((key) => key !== "mode")) return false;
      continue;
    }
    if (entry.path === "browser-state.json") {
      const defaults = {
        declutterKeptIds: [], dismissedNudges: [], modelTier: "standard",
        onboardingDismissed: false, wornToday: { day: "", ids: [] },
      };
      const userState = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      if (!Array.isArray(userState.declutterKeptIds) || !Array.isArray(userState.dismissedNudges)
          || typeof userState.modelTier !== "string" || typeof userState.onboardingDismissed !== "boolean"
          || !userState.wornToday || typeof userState.wornToday !== "object" || Array.isArray(userState.wornToday)
          || typeof userState.wornToday.day !== "string" || !Array.isArray(userState.wornToday.ids)
          || JSON.stringify(userState.declutterKeptIds) !== "[]"
          || JSON.stringify(userState.dismissedNudges) !== "[]"
          || userState.modelTier !== defaults.modelTier
          || userState.onboardingDismissed !== defaults.onboardingDismissed
          || JSON.stringify(userState.wornToday) !== JSON.stringify(defaults.wornToday)) return false;
      for (const key of ["itemEdits", "deletedIds"]) {
        const legacy = userState[key];
        if (legacy && (Array.isArray(legacy) ? legacy.length : Object.keys(legacy).length)) return false;
      }
      const known = new Set(["version", "archiveGeneration", "revision", "migrationSealed", "migratedFields", ...Object.keys(defaults), "itemEdits", "deletedIds"]);
      if (Object.keys(userState).some((key) => !known.has(key))) return false;
      continue;
    }
    if (Array.isArray(value) && value.length > 0) return false;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) return false;
    if (value !== null && !Array.isArray(value) && typeof value !== "object" && value !== "") return false;
  }
  return true;
}

async function readOptionalJson(directory, relative, fallback) {
  try { return JSON.parse(await readFile(path.join(directory, ...relative.split("/")), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw new GoogleDriveSyncError("archive_invalid"); }
}

async function verifyRestoreControlTransform({ remoteDirectory, localDirectory, remoteInventory, localInventory, previousLocalDirectory }) {
  const remoteFiles = new Map(remoteInventory.files.map((entry) => [entry.path, entry]));
  const localFiles = new Map(localInventory.files.map((entry) => [entry.path, entry]));
  const controlPaths = new Set(["archive-metadata.json", "browser-state.json"]);
  const remotePayloadPaths = [...remoteFiles.keys()].filter((relative) => !controlPaths.has(relative)).sort();
  const localPayloadPaths = [...localFiles.keys()].filter((relative) => !controlPaths.has(relative)).sort();
  if (JSON.stringify(remotePayloadPaths) !== JSON.stringify(localPayloadPaths)) throw new GoogleDriveSyncError("snapshot_changed");
  for (const relative of remotePayloadPaths) {
    const before = remoteFiles.get(relative);
    const after = localFiles.get(relative);
    if (before.size !== after.size || before.sha256 !== after.sha256) throw new GoogleDriveSyncError("snapshot_changed");
  }

  const metadataDefault = { schemaVersion: ARCHIVE_SCHEMA_VERSION, archiveGeneration: 0, referenceSources: {} };
  const remoteMetadata = await readOptionalJson(remoteDirectory, "archive-metadata.json", metadataDefault);
  const localMetadata = await readOptionalJson(localDirectory, "archive-metadata.json", metadataDefault);
  const previousMetadata = previousLocalDirectory
    ? await readOptionalJson(previousLocalDirectory, "archive-metadata.json", metadataDefault) : metadataDefault;
  const generation = localMetadata?.archiveGeneration;
  const maximumPriorGeneration = Math.max(remoteMetadata?.archiveGeneration || 0, previousMetadata?.archiveGeneration || 0);
  const normalizedRemoteMetadata = { ...remoteMetadata, archiveGeneration: generation };
  if (!Number.isSafeInteger(generation) || generation <= maximumPriorGeneration
      || localMetadata?.schemaVersion !== remoteMetadata?.schemaVersion
      || canonicalJson(normalizedRemoteMetadata) !== canonicalJson(localMetadata)) throw new GoogleDriveSyncError("snapshot_changed");

  const emptyBrowserState = {
    version: 1, archiveGeneration: remoteMetadata?.archiveGeneration || 1, revision: 0,
    migrationSealed: false, migratedFields: [], declutterKeptIds: [], dismissedNudges: [],
    modelTier: "standard", onboardingDismissed: false, wornToday: { day: "", ids: [] },
  };
  const remoteBrowser = await readOptionalJson(remoteDirectory, "browser-state.json", emptyBrowserState);
  const localBrowser = await readOptionalJson(localDirectory, "browser-state.json", emptyBrowserState);
  const browserGeneration = localBrowser?.archiveGeneration;
  const previousBrowser = previousLocalDirectory
    ? await readOptionalJson(previousLocalDirectory, "browser-state.json", emptyBrowserState) : emptyBrowserState;
  const knownMigratedFields = ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"];
  const stripBrowserControls = (value) => {
    const { archiveGeneration: _generation, revision: _revision, migrationSealed: _sealed, migratedFields: _migrated, ...payload } = value;
    return payload;
  };
  if (!Number.isSafeInteger(browserGeneration) || browserGeneration <= Math.max(remoteBrowser.archiveGeneration || 0, previousBrowser.archiveGeneration || 0)
      || browserGeneration !== generation || localBrowser.migrationSealed !== true
      || JSON.stringify(localBrowser.migratedFields) !== JSON.stringify(knownMigratedFields)
      || !Number.isSafeInteger(localBrowser.revision) || localBrowser.revision < (remoteBrowser.revision || 0)
      || canonicalJson(stripBrowserControls(localBrowser)) !== canonicalJson(stripBrowserControls(remoteBrowser))) {
    throw new GoogleDriveSyncError("snapshot_changed");
  }
  return generation;
}

async function removePrivateDirectory(directory) {
  if (typeof directory !== "string" || !hasGoogleDrivePrivatePathComponent(directory)) return;
  const info = await lstat(directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
  await rm(directory, { recursive: true, force: true });
}

function validateInventory(value) {
  if (!value || value.version !== ARCHIVE_SCHEMA_VERSION || !Array.isArray(value.files) || value.files.length > 50_000) throw new GoogleDriveSyncError("archive_invalid");
  let previous = "";
  let totalBytes = 0;
  for (const entry of value.files) {
    if (!entry || !isAllowedArchivePath(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || (previous && entry.path.localeCompare(previous, "en") <= 0)) throw new GoogleDriveSyncError("archive_invalid");
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) throw new GoogleDriveSyncError("archive_invalid");
    previous = entry.path;
  }
  return value;
}

async function streamToFile(client, fileId, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  try {
    const digest = await client.downloadFile(fileId, (bytes) => writeChunk(output, bytes));
    output.end();
    await finished(output);
    const local = await hashArchiveFile(destination);
    if (local.size !== digest.size || local.sha256 !== digest.sha256) throw new GoogleDriveSyncError("remote_checksum_mismatch");
    return digest;
  } catch (error) {
    output.destroy();
    await unlink(destination).catch(() => {});
    throw error;
  }
}

function snapshotName(fingerprintValue, epoch, nonce = randomUUID().slice(0, 8)) {
  return `wardrobe-snapshot-${fingerprintValue.slice(0, 20)}-${epoch}-${nonce}`;
}

/** One persistent sync coordinator for one existing Google auth-service instance and archive. */
export function createGoogleDriveSyncWorker({ service, dataDir, pollIntervalMs = DEFAULT_POLL_MS, now = Date.now } = {}) {
  if (!service || typeof service.getTarget !== "function" || typeof service.getClient !== "function") throw new TypeError("The existing Google Drive auth service is required");
  const resolvedDataDir = path.resolve(dataDir || path.dirname(service.privateDir));
  const privateDir = path.resolve(service.privateDir || path.join(resolvedDataDir, ".google-drive"));
  if (!hasGoogleDrivePrivatePathComponent(privateDir)) throw new TypeError("The Google Drive private directory is invalid");
  const stateFile = path.join(privateDir, "sync-state.json");
  const lockFile = path.join(privateDir, "sync.lock");
  const controlFile = path.join(privateDir, "sync-control.json");
  const snapshotsDir = path.join(privateDir, "snapshots");
  const previewsDir = path.join(privateDir, "previews");
  let serialization = Promise.resolve();
  let timer = null;
  let activeRun = null;
  let stopping = false;
  let stopPromise = null;
  let runtimeError = null;
  const previewEvidence = new Map();
  const restoreAuthorizations = new Map();
  const MAX_PREVIEW_EVIDENCE = 24;

  function serialize(task) {
    const run = serialization.then(task, task);
    serialization = run.catch(() => {});
    return run;
  }

  async function readState() {
    const info = await lstat(privateDir).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) return defaultState();
    if (info.isSymbolicLink() || !info.isDirectory()) throw new GoogleDriveSyncError("sync_state_invalid");
    await chmod(privateDir, 0o700);
    const stateInfo = await lstat(stateFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stateInfo) return defaultState();
    if (stateInfo.isSymbolicLink() || !stateInfo.isFile()) throw new GoogleDriveSyncError("sync_state_invalid");
    await chmod(stateFile, 0o600);
    try {
      const bytes = await readFile(stateFile);
      if (bytes.length > 64 * 1024 * 1024) throw new GoogleDriveSyncError("sync_state_invalid");
      const parsed = JSON.parse(bytes.toString("utf8"));
      const state = {
        ...parsed,
        pendingCleanups: Array.isArray(parsed.pendingCleanups) ? parsed.pendingCleanups : (parsed.pendingCleanup ? [{
          ...parsed.pendingCleanup, target: parsed.pendingCleanup.target || parsed.target || null,
          committed: parsed.pendingCleanup.committed === true,
        }] : []),
        orphanCandidates: Array.isArray(parsed.orphanCandidates) ? parsed.orphanCandidates : [],
        restoreAuthorization: parsed.restoreAuthorization || null,
      };
      state.pendingCleanup = state.pendingCleanups[0] || null;
      validateLoadedState(state);
      if (state.candidate) {
        validateInventory(state.candidate.inventory);
        if (fingerprint(state.candidate.inventory) !== state.candidate.fingerprint
            || !/^wardrobe-snapshot-[a-f0-9]{20}-\d+-[a-f0-9-]{8,40}$/.test(state.candidate.name)
            || (state.candidate.folderId !== null && typeof state.candidate.folderId !== "string")
            || !state.candidate.files || typeof state.candidate.files !== "object"
            || (state.candidate.descriptor && (state.candidate.descriptor.snapshotName !== state.candidate.name
              || state.candidate.descriptor.snapshotFingerprint !== state.candidate.fingerprint))) throw new GoogleDriveSyncError("sync_state_invalid");
        const relative = path.relative(snapshotsDir, path.resolve(state.candidate.directory));
        if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
            || !path.basename(state.candidate.directory).startsWith("snapshot-")) throw new GoogleDriveSyncError("sync_state_invalid");
        const stagedInfo = await lstat(state.candidate.directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!stagedInfo || stagedInfo.isSymbolicLink() || !stagedInfo.isDirectory()) throw new GoogleDriveSyncError("sync_state_invalid");
        if (!Array.isArray(state.candidate.directories || [])
            || (state.candidate.inventoryId !== null && typeof state.candidate.inventoryId !== "string")
            || (state.candidate.inventorySha256 !== null && !/^[a-f0-9]{64}$/.test(state.candidate.inventorySha256))) {
          throw new GoogleDriveSyncError("sync_state_invalid");
        }
        if (state.candidate.inventoryId !== null && !/^[A-Za-z0-9_-]{5,200}$/.test(state.candidate.inventoryId)) throw new GoogleDriveSyncError("sync_state_invalid");
        if (state.candidate.folderId !== null && !/^[A-Za-z0-9_-]{5,200}$/.test(state.candidate.folderId)) throw new GoogleDriveSyncError("sync_state_invalid");
        if (state.candidate.descriptor !== null && (!state.candidate.descriptor || state.candidate.descriptor.version !== 1
            || state.candidate.descriptor.inventoryName !== INVENTORY_NAME
            || state.candidate.descriptor.snapshotName !== state.candidate.name
            || state.candidate.descriptor.snapshotFingerprint !== state.candidate.fingerprint
            || !/^[a-f0-9]{64}$/.test(state.candidate.descriptor.inventorySha256 || "")
            || typeof state.candidate.descriptor.publishedAt !== "string")) throw new GoogleDriveSyncError("sync_state_invalid");
      }
      return state;
    }
    catch (error) {
      if (error instanceof GoogleDriveSyncError) throw error;
      throw new GoogleDriveSyncError("sync_state_invalid", "Private sync state cannot be read", { cause: error });
    }
  }

  async function writeState(state) {
    state.pendingCleanups ||= state.pendingCleanup ? [state.pendingCleanup] : [];
    state.pendingCleanup = state.pendingCleanups[0] || null;
    state.orphanCandidates ||= [];
    state.restoreAuthorization ??= null;
    validateLoadedState(state);
    try { await atomicJson(stateFile, state); }
    catch (error) { throw new GoogleDriveSyncError("sync_state_invalid", "Private sync state could not be saved", { cause: error }); }
  }

  async function pruneOrphanSnapshotStages(state) {
    const retained = state.candidate?.directory ? path.resolve(state.candidate.directory) : null;
    let entries;
    try { entries = await readdir(snapshotsDir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^snapshot-[0-9a-f-]{36}$/.test(entry.name)) continue;
      const directory = path.join(snapshotsDir, entry.name);
      if (path.resolve(directory) === retained) continue;
      const info = await lstat(directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
      await removePrivateDirectory(directory).catch(() => {});
    }
  }

  async function disposePreview(token) {
    if (!token) return;
    await removePrivateDirectory(token.local?.directory).catch(() => {});
    await removePrivateDirectory(token.remote?.directory).catch(() => {});
  }

  async function prunePreviewEvidence({ removeAll = false, scanPrivate = false } = {}) {
    for (const [id, token] of previewEvidence) {
      if (removeAll || token.expiresAt <= now()) {
        previewEvidence.delete(id);
        await disposePreview(token);
      }
    }
    while (previewEvidence.size > MAX_PREVIEW_EVIDENCE) {
      const oldest = previewEvidence.entries().next().value;
      if (!oldest) break;
      previewEvidence.delete(oldest[0]);
      await disposePreview(oldest[1]);
    }
    for (const [id, authorization] of restoreAuthorizations) {
      if (removeAll || authorization.expiresAt <= now()) {
        restoreAuthorizations.delete(id);
        await disposePreview(authorization.token);
      }
    }
    if (!scanPrivate) return;
    await ensurePrivateChild(privateDir, previewsDir);
    const retainedDirectories = new Set();
    for (const token of previewEvidence.values()) {
      if (token.local?.directory) retainedDirectories.add(path.resolve(token.local.directory));
      if (token.remote?.directory) retainedDirectories.add(path.resolve(token.remote.directory));
    }
    for (const authorization of restoreAuthorizations.values()) {
      const token = authorization.token;
      if (token.local?.directory) retainedDirectories.add(path.resolve(token.local.directory));
      if (token.remote?.directory) retainedDirectories.add(path.resolve(token.remote.directory));
    }
    for (const name of await readdir(previewsDir)) {
      const child = path.join(previewsDir, name);
      if (!retainedDirectories.has(path.resolve(child))) await removePrivateDirectory(child).catch(() => {});
    }
  }

  async function withWriterLock(task) {
    await ensurePrivateDirectory(privateDir);
    let handle;
    let token;
    try {
      token = randomUUID();
      handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: now() }));
      await handle.sync();
    } catch (error) {
      if (error.code === "EEXIST") {
        try {
          const existing = JSON.parse(await readFile(lockFile, "utf8"));
          const lockInfo = await stat(lockFile);
          let alive = true;
          if (Number.isInteger(existing.pid)) {
            try { process.kill(existing.pid, 0); } catch (probeError) { alive = probeError.code === "EPERM"; }
          }
          if (!alive && now() - lockInfo.mtimeMs > 1000) {
            await unlink(lockFile);
            return withWriterLock(task);
          }
        } catch (lockError) {
          if (lockError.code === "ENOENT") return withWriterLock(task);
          if (lockError instanceof SyntaxError) throw new GoogleDriveSyncError("sync_state_invalid", "Sync writer lock is malformed");
        }
        throw new GoogleDriveSyncError("sync_lock_busy", "Another archive worker owns the sync lock", { retryable: true });
      }
      throw error;
    }
    await handle.close();
    try { return await task(); }
    finally {
      try {
        const lock = JSON.parse(await readFile(lockFile, "utf8"));
        if (lock.token === token) await unlink(lockFile);
      } catch (error) { if (error.code !== "ENOENT") { /* Keep an unrecognized lock for explicit recovery. */ } }
    }
  }

  async function getControl() {
    try {
      const info = await lstat(controlFile);
      if (info.isSymbolicLink() || !info.isFile()) throw new GoogleDriveSyncError("sync_state_invalid");
      const value = JSON.parse(await readFile(controlFile, "utf8"));
      if (value.version !== STATE_VERSION || !Number.isSafeInteger(value.epoch) || typeof value.pauseRequested !== "boolean") throw new Error("shape");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { version: STATE_VERSION, epoch: 0, pauseRequested: false };
      if (error instanceof GoogleDriveSyncError) throw error;
      throw new GoogleDriveSyncError("sync_state_invalid", "Sync control state is invalid", { cause: error });
    }
  }

  async function setControl(value) {
    await atomicJson(controlFile, { version: STATE_VERSION, ...value });
  }

  async function currentTarget(expected) {
    let target;
    try { target = await service.getTarget(); }
    catch (error) { throw new GoogleDriveSyncError(safeErrorCode(error), undefined, { retryable: Boolean(error?.retryable), cause: error }); }
    if (!sameTarget(expected, target)) throw new GoogleDriveSyncError("target_changed");
    return target;
  }

  async function assertFence(expected, epoch) {
    await currentTarget(expected);
    const [state, control] = await Promise.all([readState(), getControl()]);
    if (!state.enabled || state.paused || state.epoch !== epoch || !sameTarget(state.target, expected)
        || (control.pauseRequested && control.epoch === epoch)) throw new GoogleDriveSyncError("sync_paused");
  }

  async function boundedClient(target, epoch = null) {
    await currentTarget(target);
    const client = await service.getClient(target);
    await currentTarget(target);
    return new Proxy(client, {
      get(source, key) {
        const method = source[key];
        if (typeof method !== "function") return method;
        return async (...args) => {
          const fence = async () => epoch === null ? currentTarget(target) : assertFence(target, epoch);
          await fence();
          try {
            const result = await method(...args);
            await fence();
            return result;
          } catch (error) {
            await fence();
            throw error;
          }
        };
      },
    });
  }

  async function listRemoteArchive(client, snapshotFolderId, destination, { download = false } = {}) {
    const files = new Map();
    const directories = new Map([["", snapshotFolderId]]);
    const visited = new Set();
    async function walk(parentId, prefix) {
      if (visited.has(parentId)) throw new GoogleDriveSyncError("sync_conflict");
      visited.add(parentId);
      const children = await client.listChildren(parentId);
      for (const child of children) {
        let relative;
        try { relative = safeArchivePath(prefix ? `${prefix}/${child.name}` : child.name); }
        catch { continue; }
        if (child.mimeType === "application/vnd.google-apps.folder") {
          if (!isAllowedDirectory(relative)) continue;
          if (directories.has(relative)) throw new GoogleDriveSyncError("sync_conflict");
          directories.set(relative, child.id);
          await walk(child.id, relative);
          continue;
        }
        if (relative === INVENTORY_NAME) continue;
        if (!isAllowedArchivePath(relative)) continue;
        if (files.has(relative)) throw new GoogleDriveSyncError("sync_conflict");
        files.set(relative, child);
        if (download) {
          const destinationPath = path.join(destination, ...relative.split("/"));
          await streamToFile(client, child.id, destinationPath);
        }
      }
    }
    await walk(snapshotFolderId, "");
    return { files, directories };
  }

  function isAllowedDirectory(relative) {
    return isAllowedArchiveDirectory(relative);
  }

  async function inspectRemote(client, root, rootChildren, { download = false } = {}) {
    const pointers = rootChildren.filter((item) => item.name === COMMIT_NAME);
    if (pointers.length > 1) throw new GoogleDriveSyncError("sync_conflict");
    if (!pointers.length) {
      const visibleChildren = rootChildren.filter((item) => !(item.mimeType === "application/vnd.google-apps.folder"
        && /^wardrobe-snapshot-[a-f0-9]{20}-\d+-[a-f0-9-]{8,40}$/.test(item.name)
        && owned(item, "snapshot-v1", `.snapshot/${item.name}`)));
      const directInventories = visibleChildren.filter((item) => item.name === INVENTORY_NAME && item.mimeType !== "application/vnd.google-apps.folder");
      if (directInventories.length === 1) return inspectSnapshot(client, rootChildren, root.id, root.name, null, download, rootChildren);
      if (directInventories.length > 1) throw new GoogleDriveSyncError("sync_conflict");
      const folderSnapshots = [];
      for (const folder of visibleChildren.filter((item) => item.mimeType === "application/vnd.google-apps.folder")) {
        const children = await client.listChildren(folder.id);
        if (children.some((item) => item.name === INVENTORY_NAME && item.mimeType !== "application/vnd.google-apps.folder")) folderSnapshots.push(folder);
      }
      if (folderSnapshots.length > 1) throw new GoogleDriveSyncError("sync_conflict");
      if (folderSnapshots.length === 1) {
        const folder = folderSnapshots[0];
        return inspectSnapshot(client, await client.listChildren(folder.id), folder.id, folder.name, null, download, rootChildren);
      }
      if (visibleChildren.length > 0) {
        throw new GoogleDriveSyncError("archive_invalid");
      }
      return { valid: true, empty: true, exists: false, fingerprint: null, manifestMatches: true, files: new Map() };
    }
    const pointerFile = pointers[0];
    const { value: descriptor, bytes: descriptorBytes } = await readJsonFile(client, pointerFile.id, 1024 * 1024);
    if (!descriptor || descriptor.version !== 1 || typeof descriptor.snapshotName !== "string"
        || !/^wardrobe-snapshot-[a-f0-9]{20}-\d+-[a-f0-9-]{8,40}$/.test(descriptor.snapshotName)
        || typeof descriptor.snapshotFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.snapshotFingerprint)
        || descriptor.inventoryName !== INVENTORY_NAME || !/^[a-f0-9]{64}$/.test(descriptor.inventorySha256 || "")) throw new GoogleDriveSyncError("archive_invalid");
    const snapshotMatches = rootChildren.filter((item) => item.name === descriptor.snapshotName
      && item.mimeType === "application/vnd.google-apps.folder");
    if (snapshotMatches.length !== 1) throw new GoogleDriveSyncError("archive_invalid");
    const snapshot = snapshotMatches[0];
    const snapshotChildren = await client.listChildren(snapshot.id);
    return inspectSnapshot(client, snapshotChildren, snapshot.id, snapshot.name, { pointerFile, descriptor, descriptorBytes }, download, rootChildren);
  }

  async function inspectSnapshot(client, snapshotChildren, snapshotId, name, commit = null, download = false, rootChildren = []) {
    const inventoryMatches = snapshotChildren.filter((item) => item.name === INVENTORY_NAME && item.mimeType !== "application/vnd.google-apps.folder");
    if (inventoryMatches.length !== 1) throw new GoogleDriveSyncError("archive_invalid");
    const inventoryFile = inventoryMatches[0];
    const { value: inventory, bytes: inventoryBytes } = await readJsonFile(client, inventoryFile.id, 16 * 1024 * 1024);
    validateInventory(inventory);
    const declaredFingerprint = fingerprint(inventory);
    if ((commit && declaredFingerprint !== commit.descriptor.snapshotFingerprint)
        || (commit && sha256(inventoryBytes) !== commit.descriptor.inventorySha256)) {
      throw new GoogleDriveSyncError("archive_invalid");
    }
    const previewDirectory = path.join(previewsDir, `remote-${randomUUID()}`);
    try {
    if (download) await mkdir(previewDirectory, { recursive: false, mode: 0o700 });
    const remote = await listRemoteArchive(client, snapshotId, previewDirectory, { download });
    const mappedInventory = new Map(inventory.files.map((entry) => [entry.path, entry]));
    if (remote.files.size !== mappedInventory.size) throw new GoogleDriveSyncError("archive_invalid");
    for (const [relative, entry] of mappedInventory) {
      const remoteFile = remote.files.get(relative);
      if (!remoteFile) throw new GoogleDriveSyncError("archive_invalid");
      if (!download && !await verifiedRemoteFile(client, remoteFile, entry)) throw new GoogleDriveSyncError("remote_checksum_mismatch");
    }
    if (download) {
      const actualInventory = await buildArchiveInventory(previewDirectory);
      const validation = await validateArchive(previewDirectory, actualInventory);
      if (!validation.valid || fingerprint(actualInventory) !== declaredFingerprint) throw new GoogleDriveSyncError("archive_invalid");
      return {
        valid: true,
        empty: false,
        exists: true,
        fingerprint: fingerprint(actualInventory),
        manifestFingerprint: declaredFingerprint,
        manifestMatches: true,
        inventory: actualInventory,
        directory: previewDirectory,
        snapshotName: name,
        snapshotId,
        pointerId: commit?.pointerFile?.id || null,
        inventoryId: inventoryFile.id,
        inventorySha256: sha256(inventoryBytes),
        descriptor: commit?.descriptor || null,
        descriptorFingerprint: commit ? sha256(commit.descriptorBytes) : sha256(inventoryBytes),
        files: remote.files,
        directories: remote.directories,
        rootChildren,
      };
    }
    return {
      valid: true,
      empty: false,
      exists: true,
      fingerprint: declaredFingerprint,
      manifestFingerprint: declaredFingerprint,
      manifestMatches: true,
      inventory,
      snapshotName: name,
      snapshotId,
      pointerId: commit?.pointerFile?.id || null,
      inventoryId: inventoryFile.id,
      inventorySha256: sha256(inventoryBytes),
      descriptor: commit?.descriptor || null,
      descriptorFingerprint: commit ? sha256(commit.descriptorBytes) : sha256(inventoryBytes),
      files: remote.files,
      directories: remote.directories,
      rootChildren,
    };
    } catch (error) {
      if (download) await removePrivateDirectory(previewDirectory).catch(() => {});
      throw error;
    }
  }

  async function verifiedRemoteFile(client, metadata, expected) {
    if (metadata.mimeType.startsWith("application/vnd.google-apps.")) throw new GoogleDriveSyncError("google_document_not_supported");
    if (Number(metadata.size) !== expected.size) return false;
    if (metadata.sha256Checksum) return metadata.sha256Checksum.toLowerCase() === expected.sha256;
    const actual = await client.hashFile(metadata.id);
    return actual.size === expected.size && actual.sha256 === expected.sha256;
  }

  async function remoteRoot(client) {
    const root = await client.verifyRoot();
    const children = await client.listChildren(root.id);
    return { root, children };
  }

  async function ensureFolder(client, state, target, epoch, parentId, name, markerPath, version, snapshotFingerprint) {
    const operationKey = sha256(JSON.stringify({ target: target.targetFingerprint, generation: target.connectionGeneration, epoch, snapshotFingerprint, path: markerPath, kind: "folder" }));
    let operation = state.operations[operationKey];
    let mappedIdMissing = false;
    if (operation?.id) {
      try {
        const current = await client.getMetadata(operation.id);
        if (current.mimeType === "application/vnd.google-apps.folder" && current.name === name
            && current.parents?.length === 1 && current.parents[0] === parentId && owned(current, version, markerPath)) return current;
        mappedIdMissing = true;
      } catch (error) {
        if (error.status !== 404 && error.code !== "file_trashed") throw error;
        // A complete parent listing is mandatory before treating a mapped 404 as absence.
        await client.listChildren(parentId);
        mappedIdMissing = true;
      }
    }
    const children = await client.listChildren(parentId);
    const byName = children.filter((child) => child.name === name);
    if (byName.length > 1) throw new GoogleDriveSyncError("sync_conflict");
    const tagged = children.filter((child) => owned(child, version, markerPath));
    if (tagged.length > 1) throw new GoogleDriveSyncError("sync_conflict");
    if (tagged.length === 1) {
      if (byName.length === 1 && byName[0].id !== tagged[0].id) throw new GoogleDriveSyncError("sync_conflict");
      if (operation?.id !== tagged[0].id) {
        operation = { ...(operation || {}), id: tagged[0].id, kind: "folder", path: markerPath };
        state.operations[operationKey] = operation;
        await writeState(state);
      }
      return tagged[0];
    }
    if (byName.length === 1) {
      if (byName[0].mimeType !== "application/vnd.google-apps.folder") throw new GoogleDriveSyncError("sync_conflict");
      if (version === "snapshot-v1" && !owned(byName[0], version, markerPath)) throw new GoogleDriveSyncError("sync_conflict");
      if (operation?.id !== byName[0].id) {
        operation = { ...(operation || {}), id: byName[0].id, kind: "folder", path: markerPath };
        state.operations[operationKey] = operation;
        await writeState(state);
      }
      return byName[0];
    }
    const id = !mappedIdMissing && operation?.id ? operation.id : await client.generateId();
    operation = { id, kind: "folder", path: markerPath };
    state.operations[operationKey] = operation;
    await writeState(state);
    const created = await client.createFolder({ name, parentId, id, appProperties: props(version, markerPath, version === "snapshot-v1" ? snapshotFingerprint : "") });
    return created;
  }

  async function findFileAtPath(client, parentId, name, relativePath) {
    const children = await client.listChildren(parentId);
    const marker = sha256(Buffer.from(relativePath));
    const matches = children.filter((child) => child.name === name || [marker, relativePath].includes(child.appProperties?.wardrobePath));
    if (matches.length > 1) throw new GoogleDriveSyncError("sync_conflict");
    return matches[0] || null;
  }

  async function prepareOperationId(client, state, operationKey) {
    let operation = state.operations[operationKey];
    if (!operation?.id) {
      operation = { ...(operation || {}), id: await client.generateId() };
      state.operations[operationKey] = operation;
      await writeState(state);
    }
    return operation;
  }

  async function transferResumable(client, state, target, epoch, sourcePath, { name, relativePath, parentId, digest, mimeType, operationKey, existing }) {
    let operation = await prepareOperationId(client, state, operationKey);
    const expectedVersion = "archive-file-v1";
    const size = digest.size;
    let existingId = existing?.id || null;
    if (existingId && await verifiedRemoteFile(client, existing, digest)) return existing;
    if (operation.sessionUrl && (!sessionUrlIsSafe(operation.sessionUrl, operation)
        || operation.parentId !== parentId || operation.relativePath !== relativePath
        || operation.sha256 !== digest.sha256 || operation.size !== size
        || (operation.updating && operation.fileId !== existingId))) {
      throw new GoogleDriveSyncError("sync_state_invalid");
    }
    let sessionUrl = operation.sessionUrl || null;
    let offset = Number.isSafeInteger(operation.offset) ? operation.offset : 0;
    const appProperties = props(expectedVersion, relativePath, digest.sha256);
    const beginSession = async () => {
      if (existingId) {
        operation = { ...operation, id: existingId, fileId: existingId, updating: true, parentId, relativePath, sha256: digest.sha256, size };
        state.operations[operationKey] = operation;
        await writeState(state);
      }
      const session = await client.startResumableUpload({
        name,
        mimeType,
        size,
        parentId,
        id: existingId ? undefined : operation.id,
        fileId: existingId || undefined,
        appProperties,
      });
      sessionUrl = session.sessionUrl;
      operation = { ...operation, sessionUrl, offset: 0, parentId, relativePath, sha256: digest.sha256, size, updating: Boolean(existingId), ...(existingId ? { fileId: existingId } : {}) };
      if (!sessionUrlIsSafe(sessionUrl, operation)) throw new GoogleDriveSyncError("sync_state_invalid");
      state.operations[operationKey] = operation;
      await writeState(state);
      offset = 0;
    };
    if (!sessionUrl) await beginSession();
    const finish = async (result) => {
      if (!result?.complete || !result.metadata || result.metadata.name !== name
          || result.metadata.parents?.length !== 1 || result.metadata.parents[0] !== parentId) throw new GoogleDriveSyncError("upload_failed", undefined, { retryable: true });
      const completeMeta = await client.getMetadata(result.metadata.id);
      if (!owned(completeMeta, expectedVersion, relativePath) || !await verifiedRemoteFile(client, completeMeta, digest)) {
        throw new GoogleDriveSyncError("remote_checksum_mismatch");
      }
      operation = { ...operation, id: completeMeta.id, complete: true, sessionUrl: null, offset: size, parentId, relativePath, sha256: digest.sha256, size };
      state.operations[operationKey] = operation;
      state.candidate.files[relativePath] = { id: completeMeta.id, size, sha256: digest.sha256, parentId };
      await writeState(state);
      return completeMeta;
    };
    try {
      let probe = await client.queryResumableUpload({ sessionUrl, total: size, parentId, fileId: existingId || undefined });
      if (probe.complete) return finish(probe);
      const priorOffset = Number.isSafeInteger(operation.offset) ? operation.offset : 0;
      offset = probe.offset;
      operation = { ...operation, offset };
      state.progress.currentBytes = Math.max(0, Math.min(state.progress.totalBytes, state.progress.currentBytes + offset - priorOffset));
      state.operations[operationKey] = operation;
      await writeState(state);
    } catch (error) {
      if (error.code !== "resumable_session_expired") throw error;
      const children = await client.listChildren(parentId);
      const matching = children.find((item) => item.id === (existingId || operation.id));
      if (matching && await verifiedRemoteFile(client, matching, digest)) return finish({ complete: true, offset: size, metadata: matching });
      if (matching) {
        existingId = matching.id;
        operation = { ...operation, id: matching.id, fileId: matching.id, updating: true, offset: 0 };
        state.operations[operationKey] = operation;
      }
      sessionUrl = null;
      offset = 0;
      operation = { ...operation, sessionUrl: null, offset: 0 };
      state.operations[operationKey] = operation;
      await writeState(state);
      await beginSession();
    }
    let noProgress = 0;
    while (offset < size) {
      await assertFence(target, epoch);
      const length = Math.min(CHUNK_BYTES, size - offset);
      const handle = await open(sourcePath, "r");
      let bytes;
      try {
        bytes = Buffer.alloc(length);
        const { bytesRead } = await handle.read(bytes, 0, length, offset);
        if (bytesRead !== length) throw new GoogleDriveSyncError("snapshot_changed");
      } finally { await handle.close(); }
      await assertFence(target, epoch);
      const result = await client.uploadResumableChunk({ sessionUrl, offset, endOffset: offset + length, total: size, parentId, fileId: existingId || undefined, bytes });
      if (result.complete) return finish(result);
      const confirmed = result.offset;
      if (!Number.isSafeInteger(confirmed) || confirmed < offset || confirmed > offset + length) throw new GoogleDriveSyncError("upload_failed", undefined, { retryable: true });
      noProgress = confirmed === offset ? noProgress + 1 : 0;
      if (noProgress > 2) throw new GoogleDriveSyncError("upload_failed", undefined, { retryable: true });
      const previousOffset = offset;
      offset = confirmed;
      operation = { ...operation, sessionUrl, offset, lastOffset: offset };
      state.progress.currentBytes = Math.max(0, Math.min(state.progress.totalBytes, state.progress.currentBytes + offset - previousOffset));
      state.operations[operationKey] = operation;
      await writeState(state);
    }
    const finalProbe = await client.queryResumableUpload({ sessionUrl, total: size, parentId, fileId: existingId || undefined });
    if (finalProbe.complete) return finish(finalProbe);
    throw new GoogleDriveSyncError("upload_failed", undefined, { retryable: true });
  }

  async function ensureRemoteFile(client, state, target, epoch, candidate, parentId, relativePath, localEntry, sourceDirectory, oldFiles) {
    const existing = await findFileAtPath(client, parentId, path.posix.basename(relativePath), relativePath);
    if (existing?.mimeType === "application/vnd.google-apps.folder") throw new GoogleDriveSyncError("sync_conflict");
    const expected = { size: localEntry.size, sha256: localEntry.sha256 };
    if (existing && await verifiedRemoteFile(client, existing, expected)) {
      candidate.files[relativePath] = { id: existing.id, size: expected.size, sha256: expected.sha256, parentId };
      state.progress.currentFiles += 1;
      return existing;
    }
    const operationKey = sha256(JSON.stringify({
      target: target.targetFingerprint,
      generation: target.connectionGeneration,
      epoch,
      snapshotFingerprint: candidate.fingerprint,
      snapshotName: candidate.name,
      path: relativePath,
      sha256: localEntry.sha256,
    }));
    const source = oldFiles?.get(relativePath);
    const sourceIsVerified = source && source.mimeType !== "application/vnd.google-apps.folder"
      && await verifiedRemoteFile(client, source, expected);
    if (!existing && sourceIsVerified) {
      const operation = await prepareOperationId(client, state, operationKey);
      const copied = await client.copyFile({
        fileId: source.id,
        name: path.posix.basename(relativePath),
        parentId,
        id: operation.id,
        appProperties: props("archive-file-v1", relativePath, localEntry.sha256),
      });
      if (!await verifiedRemoteFile(client, copied, expected)) throw new GoogleDriveSyncError("remote_checksum_mismatch");
      candidate.files[relativePath] = { id: copied.id, size: expected.size, sha256: expected.sha256, parentId };
      state.operations[operationKey] = { ...operation, complete: true, parentId, relativePath, sha256: localEntry.sha256, size: localEntry.size };
      state.progress.currentFiles += 1;
      await writeState(state);
      return copied;
    }
    const sourcePath = path.join(sourceDirectory, ...relativePath.split("/"));
    const localDigest = await hashArchiveFile(sourcePath);
    if (localDigest.size !== expected.size || localDigest.sha256 !== expected.sha256) throw new GoogleDriveSyncError("snapshot_changed");
    const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff", ".avif": "image/avif", ".bmp": "image/bmp", ".heic": "image/heic", ".heif": "image/heif", ".json": "application/json" })[path.extname(relativePath).toLowerCase()] || "application/octet-stream";
    const uploaded = await transferResumable(client, state, target, epoch, sourcePath, {
      name: path.posix.basename(relativePath), relativePath, parentId, digest: expected, mimeType, operationKey, existing,
    });
    candidate.files[relativePath] = { id: uploaded.id, size: expected.size, sha256: expected.sha256, parentId };
    state.progress.currentFiles += 1;
    await writeState(state);
    return uploaded;
  }

  async function cleanupArchiveMembers(client, cleanup) {
    let complete = true;
    for (const member of cleanup.members || []) {
      let metadata;
      try { metadata = await client.getMetadata(member.id); }
      catch (error) {
        if (error.status !== 404 && error.code !== "file_trashed") throw error;
        const listed = await client.listChildren(member.parentId);
        if (listed.some((item) => item.id === member.id)) complete = false;
        continue;
      }
      if (metadata.parents?.length !== 1 || metadata.parents[0] !== member.parentId
          || metadata.name !== path.posix.basename(member.path) || metadata.mimeType === "application/vnd.google-apps.folder"
          || (member.operationOwned === true
            ? !owned(metadata, "archive-file-v1", member.path) || metadata.appProperties?.wardrobeSha256 !== member.sha256
            : !await verifiedRemoteFile(client, metadata, member))) {
        complete = false;
        continue;
      }
      await client.deleteFile(metadata.id);
    }
    if (cleanup.inventoryId) {
      let metadata;
      try { metadata = await client.getMetadata(cleanup.inventoryId); }
      catch (error) {
        if (error.status !== 404 && error.code !== "file_trashed") throw error;
        metadata = null;
      }
      if (metadata) {
        const inventoryBytes = await client.readFile(metadata.id);
        if (metadata.parents?.length !== 1 || metadata.parents[0] !== cleanup.containerId
            || metadata.name !== INVENTORY_NAME
            || (sha256(inventoryBytes) !== cleanup.inventorySha256
              && !(cleanup.inventoryOperationOwned === true && owned(metadata, "inventory-v1", INVENTORY_NAME)))) complete = false;
        else await client.deleteFile(metadata.id);
      }
    }
    const directories = [...(cleanup.directories || [])].sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    for (const directory of directories) {
      let metadata;
      try { metadata = await client.getMetadata(directory.id); }
      catch (error) {
        if (error.status !== 404 && error.code !== "file_trashed") throw error;
        const listed = await client.listChildren(directory.parentId);
        if (listed.some((item) => item.id === directory.id)) complete = false;
        continue;
      }
      if (metadata.mimeType !== "application/vnd.google-apps.folder" || metadata.name !== path.posix.basename(directory.path)
          || metadata.parents?.length !== 1 || metadata.parents[0] !== directory.parentId) {
        complete = false;
        continue;
      }
      if ((await client.listChildren(metadata.id)).length) { complete = false; continue; }
      await client.deleteFile(metadata.id);
    }
    return complete;
  }

  async function cleanupManagedSnapshot(client, cleanup, rootId) {
    let snapshot;
    try { snapshot = await client.getMetadata(cleanup.snapshotId); }
    catch (error) {
      if (error.status !== 404 && error.code !== "file_trashed") throw error;
      const rootChildren = await client.listChildren(rootId);
      return !rootChildren.some((item) => item.id === cleanup.snapshotId);
    }
    if (snapshot.id === rootId || snapshot.name !== cleanup.snapshotName
        || (!owned(snapshot, "snapshot-v1", `.snapshot/${cleanup.snapshotName}`) && cleanup.portableSnapshot !== true)
        || snapshot.parents?.length !== 1 || snapshot.parents[0] !== rootId) return false;
    const complete = await cleanupArchiveMembers(client, { ...cleanup, containerId: snapshot.id });
    const remaining = await client.listChildren(snapshot.id);
    if (complete && remaining.length === 0) await client.deleteFile(snapshot.id);
    return complete && remaining.length === 0;
  }

  async function cleanupRawRoot(client, cleanup, targetRootId) {
    if (cleanup.rootId !== targetRootId) return false;
    const complete = await cleanupArchiveMembers(client, { ...cleanup, containerId: targetRootId });
    return complete && cleanup.preserveUnknown !== true;
  }

  async function cleanupOrphanCandidates(client, state, target) {
    let selectedRemote;
    try {
      const { root, children } = await remoteRoot(client);
      selectedRemote = await inspectRemote(client, root, children);
      if (!selectedRemote.valid) return false;
    } catch {
      // An unreadable or ambiguous pointer is never permission to delete staging.
      return false;
    }
    const remaining = [];
    for (const orphan of state.orphanCandidates || []) {
      if (!sameArchiveDestination(orphan.target, target)) { remaining.push(orphan); continue; }
      const stateSelectsOrphan = state.lastCompleted?.snapshotId === orphan.snapshotId
        && state.lastCompleted.snapshotName === orphan.name
        && state.lastCompleted.fingerprint === orphan.fingerprint
        && state.lastCompleted.descriptorFingerprint === orphan.descriptorFingerprint;
      const remoteSelectsOrphan = selectedRemote.snapshotId === orphan.snapshotId
        && selectedRemote.snapshotName === orphan.name
        && selectedRemote.fingerprint === orphan.fingerprint
        && selectedRemote.descriptorFingerprint === orphan.descriptorFingerprint;
      if (stateSelectsOrphan && remoteSelectsOrphan) {
        // Explicit equivalence adoption makes this formerly orphaned object the
        // completed backup. Drop only its cleanup record; never delete the selected copy.
        continue;
      }
      if (selectedRemote.snapshotId === orphan.snapshotId) {
        remaining.push(orphan);
        continue;
      }
      let snapshot;
      try { snapshot = await client.getMetadata(orphan.snapshotId); }
      catch (error) {
        if (error.status !== 404 && error.code !== "file_trashed") { remaining.push(orphan); continue; }
        const rootChildren = await client.listChildren(target.folderId);
        if (rootChildren.some((item) => item.id === orphan.snapshotId)) remaining.push(orphan);
        continue;
      }
      if (snapshot.name !== orphan.name || snapshot.mimeType !== "application/vnd.google-apps.folder"
          || snapshot.parents?.length !== 1 || snapshot.parents[0] !== target.folderId
          || !owned(snapshot, "snapshot-v1", `.snapshot/${orphan.name}`)) {
        remaining.push(orphan);
        continue;
      }
      try {
        const remote = await listRemoteArchive(client, snapshot.id, "");
        const expected = new Map(orphan.inventory.files.map((entry) => [entry.path, entry]));
        const members = [];
        for (const [relative, metadata] of remote.files) {
          const entry = expected.get(relative);
          const mapped = orphan.files[relative];
          if (!entry || !mapped || mapped.id !== metadata.id || !owned(metadata, "archive-file-v1", relative)
              || metadata.appProperties?.wardrobeSha256 !== entry.sha256) continue;
          members.push({ path: relative, id: metadata.id, size: entry.size, sha256: entry.sha256,
            parentId: metadata.parents?.[0], operationOwned: true });
        }
        const direct = await client.listChildren(snapshot.id);
        const inventoryFiles = direct.filter((item) => item.name === INVENTORY_NAME && item.mimeType !== "application/vnd.google-apps.folder");
        let inventoryId = null;
        let inventorySha256 = null;
        let inventoryOperationOwned = false;
        if (inventoryFiles.length === 1) {
          const manifest = inventoryFiles[0];
          const manifestBytes = await client.readFile(manifest.id);
          if (orphan.inventoryId === manifest.id || fingerprint(JSON.parse(manifestBytes.toString("utf8"))) === orphan.fingerprint) {
            inventoryId = manifest.id;
            inventorySha256 = sha256(manifestBytes);
            inventoryOperationOwned = true;
          }
        }
        const cleanup = {
          kind: "snapshot", snapshotId: orphan.snapshotId, snapshotName: orphan.name,
          members, directories: [...remote.directories].filter(([relative]) => relative)
            .map(([relative, id]) => {
              const parentRelative = path.posix.dirname(relative);
              return { path: relative, id, parentId: parentRelative === "." ? snapshot.id : remote.directories.get(parentRelative) };
            }),
          inventoryId, inventorySha256, inventoryOperationOwned,
        };
        const { root: freshRoot, children: freshChildren } = await remoteRoot(client);
        const freshSelection = await inspectRemote(client, freshRoot, freshChildren);
        if (!freshSelection.valid || freshSelection.snapshotId === orphan.snapshotId) {
          remaining.push(orphan);
          continue;
        }
        if (!await cleanupManagedSnapshot(client, cleanup, target.folderId)) remaining.push(orphan);
      } catch { remaining.push(orphan); }
    }
    state.orphanCandidates = remaining;
    return remaining.length === 0;
  }

  async function publishPointer(client, state, target, epoch, candidate, descriptor, staged) {
    const rootChildren = await client.listChildren(target.folderId);
    const matches = rootChildren.filter((item) => item.name === COMMIT_NAME);
    if (matches.length > 1) throw new GoogleDriveSyncError("sync_conflict");
    const bytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    const digest = sha256(bytes);
    const verifyCandidateAtCommit = async () => {
      const stagedInventory = await buildArchiveInventory(staged.directory);
      if (fingerprint(stagedInventory) !== staged.fingerprint || !(await validateArchive(staged.directory, staged.inventory)).valid) {
        throw new GoogleDriveSyncError("snapshot_changed");
      }
      const snapshot = await client.getMetadata(candidate.folderId);
      await verifyCandidate(client, snapshot, candidate, staged);
    };
    if (matches.length === 1) {
      if (!owned(matches[0], "commit-v1", ".wardrobe-commit")) {
        const { value: existingDescriptor } = await readJsonFile(client, matches[0].id, 1024 * 1024);
        if (!existingDescriptor || existingDescriptor.version !== 1 || typeof existingDescriptor.snapshotName !== "string"
            || !/^[a-f0-9]{64}$/.test(existingDescriptor.snapshotFingerprint || "")) throw new GoogleDriveSyncError("sync_conflict");
      }
      const current = await client.readFile(matches[0].id);
      await verifyCandidateAtCommit();
      if (current.equals(bytes)) return matches[0];
      return client.updateFile({ fileId: matches[0].id, mimeType: "application/json", bytes, appProperties: props("commit-v1", ".wardrobe-commit", digest) });
    }
    const operationKey = sha256(JSON.stringify({ target: target.targetFingerprint, generation: target.connectionGeneration, epoch, path: COMMIT_NAME, sha256: digest }));
    const operation = await prepareOperationId(client, state, operationKey);
    await verifyCandidateAtCommit();
    return client.createFile({ id: operation.id, name: COMMIT_NAME, mimeType: "application/json", bytes, parentId: target.folderId, appProperties: props("commit-v1", ".wardrobe-commit", digest) });
  }

  async function verifyPublishedPointer(client, target, candidate, descriptor) {
    const children = await client.listChildren(target.folderId);
    const matches = children.filter((item) => item.name === COMMIT_NAME);
    if (matches.length !== 1) throw new GoogleDriveSyncError("sync_conflict");
    const { value, bytes } = await readJsonFile(client, matches[0].id, 1024 * 1024);
    if (JSON.stringify(value) !== JSON.stringify(descriptor)
        || (matches[0].appProperties?.wardrobeSha256 && matches[0].appProperties.wardrobeSha256 !== sha256(bytes))) throw new GoogleDriveSyncError("upload_failed", undefined, { retryable: true });
    const folders = children.filter((item) => item.name === candidate.name && item.id === candidate.folderId
      && owned(item, "snapshot-v1", `.snapshot/${candidate.name}`));
    if (folders.length !== 1) throw new GoogleDriveSyncError("archive_invalid");
    return matches[0];
  }

  async function verifyCandidate(client, snapshot, candidate, staged) {
    if (!owned(snapshot, "snapshot-v1", `.snapshot/${candidate.name}`) || snapshot.name !== candidate.name) throw new GoogleDriveSyncError("archive_invalid");
    const expected = new Map(staged.inventory.files.map((entry) => [entry.path, entry]));
    let remote = await listRemoteArchive(client, snapshot.id, "");
    for (const [relative, metadata] of remote.files) {
      if (!expected.has(relative)) await client.deleteFile(metadata.id);
    }
    remote = await listRemoteArchive(client, snapshot.id, "");
    if (remote.files.size !== expected.size) throw new GoogleDriveSyncError("archive_invalid");
    const verified = {};
    for (const [relative, entry] of expected) {
      const metadata = remote.files.get(relative);
      if (!metadata || !await verifiedRemoteFile(client, metadata, entry)) throw new GoogleDriveSyncError("remote_checksum_mismatch");
      const parentId = metadata.parents?.[0];
      if (!parentId) throw new GoogleDriveSyncError("drive_parent_ambiguous");
      verified[relative] = { id: metadata.id, size: entry.size, sha256: entry.sha256, parentId };
    }
    const direct = await client.listChildren(snapshot.id);
    const manifests = direct.filter((item) => item.name === INVENTORY_NAME && item.mimeType !== "application/vnd.google-apps.folder");
    if (manifests.length !== 1) throw new GoogleDriveSyncError("archive_invalid");
    const { value, bytes } = await readJsonFile(client, manifests[0].id, 16 * 1024 * 1024);
    if (fingerprint(validateInventory(value)) !== staged.fingerprint
        || (candidate.descriptor && candidate.descriptor.inventorySha256 !== sha256(bytes))) throw new GoogleDriveSyncError("remote_checksum_mismatch");
    const inventoryEntry = manifests[0];
    const directoryPaths = new Set();
    for (const entry of staged.inventory.files) {
      const parts = entry.path.split("/");
      for (let index = 1; index < parts.length; index += 1) directoryPaths.add(parts.slice(0, index).join("/"));
    }
    const directories = [];
    for (const relative of [...directoryPaths].sort((a, b) => a.localeCompare(b, "en"))) {
      const id = remote.directories.get(relative);
      if (!id) throw new GoogleDriveSyncError("archive_invalid");
      const metadata = await client.getMetadata(id);
      const parentRelative = path.posix.dirname(relative);
      const parentId = parentRelative === "." ? snapshot.id : remote.directories.get(parentRelative);
      if (!parentId || metadata.mimeType !== "application/vnd.google-apps.folder"
          || metadata.name !== path.posix.basename(relative) || metadata.parents?.length !== 1 || metadata.parents[0] !== parentId) {
        throw new GoogleDriveSyncError("archive_invalid");
      }
      directories.push({ path: relative, id, parentId });
    }
    return { files: verified, directories, inventoryId: inventoryEntry.id, inventorySha256: sha256(bytes) };
  }

  function pendingCleanupFor(previous, rootId, committed, target) {
    if (!previous?.snapshotId) return null;
    if (!committed?.snapshotId || !committed?.snapshotName || !committed?.descriptorFingerprint) return null;
    const members = Object.entries(previous.files || {}).map(([relative, file]) => ({ path: relative, ...file }));
    const base = {
      afterFingerprint: committed.fingerprint,
      afterSnapshotId: committed.snapshotId,
      afterSnapshotName: committed.snapshotName,
      afterDescriptorFingerprint: committed.descriptorFingerprint,
      committed: true,
      target: target ? { ...target } : null,
      portableSnapshot: previous.portableSnapshot === true,
      members,
      directories: Array.isArray(previous.directories) ? previous.directories : [],
      inventoryId: previous.inventoryId || null,
      inventorySha256: previous.inventorySha256 || null,
    };
    if (previous.snapshotId === rootId) return {
      kind: "root-members", rootId, containerId: rootId,
      preserveUnknown: previous.hasUnknownRootMembers === true,
      ...base,
    };
    if (!previous.snapshotName) return null;
    return { kind: "snapshot", snapshotId: previous.snapshotId, snapshotName: previous.snapshotName, ...base };
  }

  function completedFromRemote(remote, completedAt = new Date(now()).toISOString()) {
    const hashes = new Map(remote.inventory.files.map((entry) => [entry.path, entry.sha256]));
    const directories = [];
    for (const [relative, id] of remote.directories || []) {
      if (!relative) continue;
      const parentPath = path.posix.dirname(relative);
      directories.push({ path: relative, id, parentId: parentPath === "." ? remote.snapshotId : remote.directories.get(parentPath) });
    }
    const isRawRoot = (remote.rootChildren || []).some((item) => item.id === remote.inventoryId);
    const knownRootIds = new Set([remote.inventoryId, remote.pointerId, ...[...remote.files.values()].map((item) => item.id)]);
    for (const directory of remote.directories || []) {
      const [relative, id] = directory;
      if (!relative || (remote.rootChildren || []).some((item) => item.id === id)) knownRootIds.add(id);
    }
    const hasUnknownRootMembers = isRawRoot && (remote.rootChildren || []).some((item) => !knownRootIds.has(item.id));
    return {
      fingerprint: remote.fingerprint,
      snapshotName: remote.snapshotName,
      snapshotId: remote.snapshotId,
      descriptorFingerprint: remote.descriptorFingerprint,
      completedAt,
      fileCount: remote.inventory.files.length,
      totalBytes: remote.inventory.files.reduce((sum, item) => sum + item.size, 0),
      files: Object.fromEntries([...remote.files].map(([relative, metadata]) => [relative, {
        id: metadata.id, size: Number(metadata.size), sha256: hashes.get(relative),
        parentId: metadata.parents?.[0],
      }])),
      directories,
      inventoryId: remote.inventoryId,
      inventorySha256: remote.inventorySha256,
      portableSnapshot: true,
      ...(isRawRoot ? { hasUnknownRootMembers } : {}),
    };
  }

  function queuePendingCleanup(state, cleanup) {
    if (!cleanup) return;
    state.pendingCleanups ||= state.pendingCleanup ? [state.pendingCleanup] : [];
    const key = `${cleanup.kind}:${cleanup.snapshotId || cleanup.rootId}:${cleanup.target?.targetFingerprint || ""}`;
    const existingIndex = state.pendingCleanups.findIndex((item) => `${item.kind}:${item.snapshotId || item.rootId}:${item.target?.targetFingerprint || ""}` === key);
    if (existingIndex === -1) state.pendingCleanups.push(cleanup);
    else state.pendingCleanups[existingIndex] = { ...state.pendingCleanups[existingIndex], ...cleanup };
    state.pendingCleanup = state.pendingCleanups[0] || null;
  }

  function orphanRecordFromCandidate(state, target) {
    const candidate = state.candidate;
    if (!candidate) return null;
    const snapshotOperation = Object.values(state.operations || {}).find((item) => item?.kind === "folder" && item.path === `.snapshot/${candidate.name}`);
    const snapshotId = candidate.folderId || snapshotOperation?.id || null;
    if (!snapshotId) return null;
    const files = { ...(candidate.files || {}) };
    for (const operation of Object.values(state.operations || {})) {
      if (!operation?.relativePath || !operation.id || !isAllowedArchivePath(operation.relativePath)) continue;
      const inventoryEntry = candidate.inventory.files.find((entry) => entry.path === operation.relativePath);
      if (!inventoryEntry) continue;
      files[operation.relativePath] = {
        id: operation.id, size: inventoryEntry.size, sha256: inventoryEntry.sha256,
        parentId: operation.parentId,
      };
    }
    const inventoryOperation = Object.values(state.operations || {}).find((item) => item?.kind === "inventory" && item.id);
    return {
      snapshotId,
      name: candidate.name,
      fingerprint: candidate.fingerprint,
      descriptorFingerprint: candidate.descriptor
        ? sha256(Buffer.from(`${JSON.stringify(candidate.descriptor, null, 2)}\n`)) : null,
      inventory: candidate.inventory,
      files,
      directories: candidate.directories || [],
      inventoryId: candidate.inventoryId || inventoryOperation?.id || null,
      inventorySha256: candidate.inventorySha256 || (inventoryOperation?.sha256 || null),
      target: { ...target },
    };
  }

  function queueOrphanCandidate(state, target) {
    const orphan = orphanRecordFromCandidate(state, target);
    if (!orphan) return;
    state.orphanCandidates ||= [];
    if (!state.orphanCandidates.some((item) => item.snapshotId === orphan.snapshotId && sameTarget(item.target, target))) {
      state.orphanCandidates.push(orphan);
    }
  }

  async function loadCandidateStage(candidate) {
    const inventory = await buildArchiveInventory(candidate.directory);
    const validation = await validateArchive(candidate.directory, candidate.inventory);
    if (!validation.valid || fingerprint(inventory) !== candidate.fingerprint
        || fingerprint(candidate.inventory) !== candidate.fingerprint) throw new GoogleDriveSyncError("snapshot_changed");
    return { directory: candidate.directory, inventory: candidate.inventory, fingerprint: candidate.fingerprint };
  }

  function invalidateCandidateSubtree(state, candidate, relativePrefix, keepFolderPath = null) {
    const inScope = (relative) => relativePrefix === null
      || relative === relativePrefix || relative.startsWith(`${relativePrefix}/`);
    candidate.files = Object.fromEntries(Object.entries(candidate.files || {}).filter(([relative]) => !inScope(relative)));
    candidate.directories = (candidate.directories || []).filter((item) => !inScope(item.path));
    for (const [key, operation] of Object.entries(state.operations || {})) {
      if (operation?.kind === "folder" && typeof operation.path === "string") {
        if (operation.path === keepFolderPath || operation.path === `.snapshot/${candidate.name}`) continue;
        const relative = operation.path.startsWith(".folder/") ? operation.path.slice(".folder/".length) : null;
        if (relative !== null && inScope(relative)) delete state.operations[key];
      } else if (relativePrefix === null) {
        if (operation?.kind === "inventory" || typeof operation?.relativePath === "string") delete state.operations[key];
      } else if (typeof operation?.relativePath === "string" && inScope(operation.relativePath)) {
        delete state.operations[key];
      }
    }
    if (relativePrefix === null) {
      candidate.inventoryId = null;
      candidate.inventorySha256 = null;
    }
  }

  async function publishSnapshot(client, state, target, epoch, staged, oldFiles, previousCompleted) {
    const candidate = state.candidate;
    const snapshot = await ensureFolder(client, state, target, epoch, target.folderId, candidate.name, `.snapshot/${candidate.name}`, "snapshot-v1", staged.fingerprint);
    const priorSnapshotId = candidate.folderId;
    if (priorSnapshotId && priorSnapshotId !== snapshot.id) {
      invalidateCandidateSubtree(state, candidate, null, `.snapshot/${candidate.name}`);
    }
    candidate.folderId = snapshot.id;
    await writeState(state);
    candidate.directories ||= [];
    const directories = new Map([["", snapshot.id], ...candidate.directories.map((item) => [item.path, item.id])]);
    for (const entry of staged.inventory.files) {
      const parts = entry.path.split("/");
      let relativeParent = "";
      for (const part of parts.slice(0, -1)) {
        relativeParent = relativeParent ? `${relativeParent}/${part}` : part;
        const parentKey = path.posix.dirname(relativeParent);
        const parent = directories.get(parentKey === "." ? "" : parentKey);
        if (!parent) throw new GoogleDriveSyncError("sync_state_invalid");
        const cachedId = directories.get(relativeParent);
        const folder = await ensureFolder(client, state, target, epoch, parent, part, `.folder/${relativeParent}`, "folder-v1", staged.fingerprint);
        if (cachedId && cachedId !== folder.id) {
          invalidateCandidateSubtree(state, candidate, relativeParent, `.folder/${relativeParent}`);
        }
        directories.set(relativeParent, folder.id);
        const directoryEntry = { path: relativeParent, id: folder.id, parentId: parent };
        candidate.directories = [...candidate.directories.filter((item) => item.path !== relativeParent), directoryEntry];
        await writeState(state);
      }
      const parentKey = path.posix.dirname(entry.path);
      const parentId = directories.get(parentKey === "." ? "" : parentKey) || snapshot.id;
      await ensureRemoteFile(client, state, target, epoch, candidate, parentId, entry.path, entry, staged.directory, oldFiles);
      state.progress.currentFiles = Math.min(state.progress.totalFiles, state.progress.currentFiles);
      await writeState(state);
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(staged.inventory, null, 2)}\n`);
    const manifestDigest = sha256(manifestBytes);
    const manifestParent = snapshot.id;
    const manifestExisting = await findFileAtPath(client, manifestParent, INVENTORY_NAME, INVENTORY_NAME);
    if (manifestExisting) {
      if (manifestExisting.mimeType.startsWith("application/vnd.google-apps.")) throw new GoogleDriveSyncError("google_document_not_supported");
      const existingBytes = await client.readFile(manifestExisting.id);
      if (!existingBytes.equals(manifestBytes)) await client.updateFile({ fileId: manifestExisting.id, mimeType: "application/json", bytes: manifestBytes, appProperties: props("inventory-v1", INVENTORY_NAME, manifestDigest) });
    } else {
      const opKey = sha256(JSON.stringify({ target: target.targetFingerprint, generation: target.connectionGeneration, epoch, snapshotFingerprint: staged.fingerprint, snapshotName: candidate.name, path: INVENTORY_NAME }));
      const op = await prepareOperationId(client, state, opKey);
      Object.assign(op, { kind: "inventory", parentId: manifestParent, sha256: manifestDigest, size: manifestBytes.length });
      state.operations[opKey] = op;
      await writeState(state);
      await client.createFile({ id: op.id, name: INVENTORY_NAME, mimeType: "application/json", bytes: manifestBytes, parentId: manifestParent, appProperties: props("inventory-v1", INVENTORY_NAME, manifestDigest) });
    }
    const verifiedManifest = await findFileAtPath(client, snapshot.id, INVENTORY_NAME, INVENTORY_NAME);
    if (!verifiedManifest || verifiedManifest.mimeType.startsWith("application/vnd.google-apps.")) throw new GoogleDriveSyncError("archive_invalid");
    const remoteManifest = await client.readFile(verifiedManifest.id);
    if (!remoteManifest.equals(manifestBytes)) throw new GoogleDriveSyncError("remote_checksum_mismatch");
    candidate.inventoryId = verifiedManifest.id;
    candidate.inventorySha256 = manifestDigest;
    candidate.descriptor ||= {
      version: 1,
      snapshotName: candidate.name,
      snapshotFingerprint: staged.fingerprint,
      inventoryName: INVENTORY_NAME,
      inventorySha256: manifestDigest,
      publishedAt: new Date(now()).toISOString(),
    };
    if (candidate.descriptor.inventorySha256 !== manifestDigest) throw new GoogleDriveSyncError("sync_state_invalid");
    await writeState(state);
    const auditedFiles = await verifyCandidate(client, snapshot, candidate, staged);
    const descriptor = candidate.descriptor;
    await publishPointer(client, state, target, epoch, { ...candidate, folderId: snapshot.id }, descriptor, staged);
    await verifyPublishedPointer(client, target, { ...candidate, folderId: snapshot.id }, descriptor);
    const oldSnapshotId = previousCompleted?.snapshotId || null;
    if (oldSnapshotId && oldSnapshotId !== snapshot.id) {
      const committed = {
        snapshotId: snapshot.id,
        snapshotName: candidate.name,
        fingerprint: staged.fingerprint,
        descriptorFingerprint: sha256(Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)),
      };
      queuePendingCleanup(state, pendingCleanupFor(previousCompleted, target.folderId, committed, target));
    }
    state.lastCompleted = {
      fingerprint: staged.fingerprint,
      snapshotName: candidate.name,
      snapshotId: snapshot.id,
      descriptorFingerprint: sha256(Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)),
      completedAt: descriptor.publishedAt,
      fileCount: staged.inventory.files.length,
      totalBytes: staged.inventory.files.reduce((sum, entry) => sum + entry.size, 0),
      files: { ...auditedFiles.files },
      directories: auditedFiles.directories,
      inventoryId: auditedFiles.inventoryId,
      inventorySha256: auditedFiles.inventorySha256,
    };
    state.candidate = null;
    state.operations = {};
    state.desiredFingerprint = staged.fingerprint;
    state.phase = "idle";
    state.lastError = null;
    state.retry = { attempts: 0, at: null };
    state.lastVerifiedAt = now();
    state.progress.currentFiles = staged.inventory.files.length;
    state.progress.currentBytes = state.progress.totalBytes;
    await writeState(state);
    await finishPendingCleanup(client, state, target);
  }

  async function finishPendingCleanup(client, state, target) {
    const cleanups = state.pendingCleanups || (state.pendingCleanup ? [state.pendingCleanup] : []);
    if (!cleanups.length) return true;
    const remaining = [];
    for (const cleanup of cleanups) {
      const committed = state.lastCompleted;
      const stateSelectsCandidate = cleanup.afterSnapshotId === committed?.snapshotId
        && cleanup.afterSnapshotName === committed?.snapshotName
        && cleanup.afterFingerprint === committed?.fingerprint
        && cleanup.afterDescriptorFingerprint === committed?.descriptorFingerprint;
      if (!stateSelectsCandidate || !cleanup.afterSnapshotId || !cleanup.afterSnapshotName
          || !cleanup.afterDescriptorFingerprint || (cleanup.target && !sameArchiveDestination(cleanup.target, target))) {
        remaining.push(cleanup);
        continue;
      }
      try {
        // A matching local state record is not sufficient proof: cleanup is destructive,
        // so resolve the current portable pointer and candidate again before each retirement.
        const { root, children } = await remoteRoot(client);
        const selected = await inspectRemote(client, root, children);
        const remotelySelectsCandidate = selected.exists
          && selected.snapshotId === cleanup.afterSnapshotId
          && selected.snapshotName === cleanup.afterSnapshotName
          && selected.fingerprint === cleanup.afterFingerprint
          && selected.descriptorFingerprint === cleanup.afterDescriptorFingerprint;
        if (!remotelySelectsCandidate) {
          remaining.push(cleanup);
          continue;
        }
        const removed = cleanup.kind === "root-members"
          ? await cleanupRawRoot(client, cleanup, target.folderId)
          : await cleanupManagedSnapshot(client, cleanup, target.folderId);
        if (!removed) remaining.push(cleanup);
      } catch {
        remaining.push(cleanup);
      }
    }
    state.pendingCleanups = remaining;
    state.pendingCleanup = remaining[0] || null;
    if (remaining.length) {
      if (state.phase !== "syncing") state.phase = "idle";
      state.lastError = "cleanup_pending";
    } else if (state.lastError === "cleanup_pending") {
      state.lastError = null;
      if (state.phase === "cleanup_pending") state.phase = "idle";
    }
    await writeState(state);
    return remaining.length === 0;
  }

  async function recoverCommittedCandidate(client, state, target, staged) {
    if (!state.candidate || state.candidate.fingerprint !== staged.fingerprint) return false;
    const rootChildren = await client.listChildren(target.folderId);
    const pointers = rootChildren.filter((item) => item.name === COMMIT_NAME);
    if (pointers.length > 1) throw new GoogleDriveSyncError("sync_conflict");
    if (!pointers.length) return false;
    const { value: selectedDescriptor } = await readJsonFile(client, pointers[0].id, 1024 * 1024);
    // A valid old commit can now fail byte verification after an external edit. That is
    // precisely when a durable local candidate must continue its repair publication;
    // only inspect a pointer as a lost-ack completion when it selects this candidate.
    if (!selectedDescriptor || selectedDescriptor.snapshotName !== state.candidate.name
        || selectedDescriptor.snapshotFingerprint !== staged.fingerprint
        || JSON.stringify(selectedDescriptor) !== JSON.stringify(state.candidate.descriptor)) return false;
    const remote = await inspectRemote(client, await client.verifyRoot(), rootChildren);
    if (!remote.exists || remote.snapshotName !== state.candidate.name || remote.fingerprint !== staged.fingerprint
        || !remote.manifestMatches || JSON.stringify(remote.descriptor) !== JSON.stringify(state.candidate.descriptor)) return false;
    const snapshot = rootChildren.find((item) => item.id === remote.snapshotId && item.name === state.candidate.name
      && owned(item, "snapshot-v1", `.snapshot/${state.candidate.name}`));
    if (!snapshot) throw new GoogleDriveSyncError("archive_invalid");
    state.candidate.folderId = snapshot.id;
    const descriptor = remote.descriptor;
    await verifyPublishedPointer(client, target, { ...state.candidate, folderId: snapshot.id }, descriptor);
    const audited = await verifyCandidate(client, snapshot, state.candidate, staged);
    const previous = state.lastCompleted;
    if (previous?.snapshotId && previous.snapshotId !== snapshot.id) {
      queuePendingCleanup(state, pendingCleanupFor(previous, target.folderId, {
        fingerprint: staged.fingerprint, snapshotName: snapshot.name, snapshotId: snapshot.id,
        descriptorFingerprint: remote.descriptorFingerprint,
      }, target));
    }
    state.lastCompleted = {
      fingerprint: staged.fingerprint, snapshotName: snapshot.name, snapshotId: snapshot.id,
      descriptorFingerprint: remote.descriptorFingerprint,
      completedAt: descriptor.publishedAt, fileCount: staged.inventory.files.length,
      totalBytes: staged.inventory.files.reduce((sum, entry) => sum + entry.size, 0), files: audited.files,
      directories: audited.directories, inventoryId: audited.inventoryId, inventorySha256: audited.inventorySha256,
    };
    state.candidate = null;
    state.operations = {};
    state.phase = "idle";
    state.lastError = null;
    state.retry = { attempts: 0, at: null };
    state.lastVerifiedAt = now();
    await writeState(state);
    await finishPendingCleanup(client, state, target);
    return true;
  }

  async function runOnceInternal() {
    let state;
    let target = null;
    let epoch = null;
    let staged = null;
    try {
      state = await readState();
      try { await pruneOrphanSnapshotStages(state); } catch { /* Keep valid durable state usable if housekeeping fails. */ }
      if (!state.enabled || state.paused) return getSafeStatus();
      if (state.retry?.at && state.retry.at > now()) return getSafeStatus();
      target = await currentTarget(state.target);
      epoch = state.epoch;
      await assertFence(target, epoch);
      await ensurePrivateChild(privateDir, snapshotsDir);
      await ensurePrivateChild(privateDir, previewsDir);
      const client = await boundedClient(target, epoch);

      if (state.candidate) {
        staged = await loadCandidateStage(state.candidate);
        if (await recoverCommittedCandidate(client, state, target, staged)) {
          await removePrivateDirectory(staged.directory).catch(() => {});
          staged = null;
          state = await readState();
        }
      }

      if (state.pendingCleanups?.length || state.pendingCleanup) await finishPendingCleanup(client, state, target);
      if (state.orphanCandidates?.length) {
        try {
          await cleanupOrphanCandidates(client, state, target);
          await writeState(state);
        } catch {
          // Orphan cleanup is housekeeping and never prevents a new committed snapshot.
        }
      }

      if (!staged) {
        const localInventory = await buildArchiveInventory(resolvedDataDir);
        const localValidation = await validateArchive(resolvedDataDir, localInventory);
        if (!localValidation.valid) throw new GoogleDriveSyncError("archive_invalid");
        const localFingerprint = fingerprint(localInventory);
        const previous = state.lastCompleted;
        const verificationDue = !state.lastVerifiedAt || now() - state.lastVerifiedAt >= VERIFY_INTERVAL_MS;
        if (previous?.fingerprint === localFingerprint && !verificationDue) {
          state.desiredFingerprint = localFingerprint;
          state.phase = "idle";
          state.lastError = null;
          state.progress = { currentFiles: localInventory.files.length, totalFiles: localInventory.files.length, currentBytes: previous.totalBytes, totalBytes: previous.totalBytes };
          await writeState(state);
          runtimeError = null;
          return getSafeStatus();
        }

        const { root, children } = await remoteRoot(client);
        if (previous?.fingerprint === localFingerprint && verificationDue) {
          let remote;
          try { remote = await inspectRemote(client, root, children); }
          catch (error) {
            if (!new Set(["archive_invalid", "remote_checksum_mismatch"]).has(error.code)) throw error;
          }
          if (remote?.valid && remote.exists && remote.manifestMatches && remote.fingerprint === localFingerprint) {
            state.lastCompleted = completedFromRemote(remote, previous.completedAt);
            state.lastVerifiedAt = now();
            state.desiredFingerprint = localFingerprint;
            state.phase = "idle";
            state.lastError = null;
            state.retry = { attempts: 0, at: null };
            state.progress = { currentFiles: localInventory.files.length, totalFiles: localInventory.files.length, currentBytes: state.lastCompleted.totalBytes, totalBytes: state.lastCompleted.totalBytes };
            await writeState(state);
            runtimeError = null;
            return getSafeStatus();
          }
        }

        staged = await createArchiveSnapshot({ sourceDir: resolvedDataDir, stagingRoot: snapshotsDir });
        state.candidate = {
          name: snapshotName(staged.fingerprint, epoch), fingerprint: staged.fingerprint,
          directory: staged.directory, inventory: staged.inventory, folderId: null,
          files: {}, directories: [], inventoryId: null, inventorySha256: null, descriptor: null,
        };
        state.desiredFingerprint = staged.fingerprint;
        state.phase = "syncing";
        state.lastError = null;
        state.progress = { currentFiles: 0, totalFiles: staged.inventory.files.length, currentBytes: 0, totalBytes: staged.inventory.files.reduce((sum, item) => sum + item.size, 0) };
        await writeState(state);
      }

      await assertFence(target, epoch);
      const previous = state.lastCompleted;
      const { root } = await remoteRoot(client);
      let oldFiles = new Map();
      if (previous?.snapshotId) {
        try {
          const oldSnapshot = await client.getMetadata(previous.snapshotId);
          if (oldSnapshot.id === target.folderId) oldFiles = (await listRemoteArchive(client, target.folderId, "")).files;
          else if (oldSnapshot.parents?.length === 1 && oldSnapshot.parents[0] === target.folderId) {
            oldFiles = (await listRemoteArchive(client, previous.snapshotId, "")).files;
          }
        } catch (error) {
          if (error.status !== 404 && error.code !== "file_trashed") throw error;
          await client.listChildren(target.folderId);
        }
      }
      // A complete root read distinguishes missing prior mappings from an access failure.
      await client.listChildren(root.id);
      state.phase = "syncing";
      state.lastError = null;
      await writeState(state);
      await publishSnapshot(client, state, target, epoch, staged, oldFiles, previous);
      runtimeError = null;
      return getSafeStatus();
    } catch (error) {
      const code = safeErrorCode(error);
      runtimeError = code;
      if (state && target && epoch !== null) {
        try {
          const [latest, liveTarget] = await Promise.all([readState(), service.getTarget()]);
          if (latest.epoch === epoch && sameTarget(latest.target, target) && sameTarget(liveTarget, target)) {
            const attempts = Math.min(20, (latest.retry?.attempts || 0) + 1);
            const delay = Math.min(MAX_RETRY_MS, 1000 * (2 ** Math.min(attempts - 1, 8)));
            latest.phase = "error";
            latest.lastError = code;
            latest.retry = { attempts, at: now() + delay };
            await writeState(latest);
          }
        } catch {
          // Never write an old target/epoch's failure into a new connection's queue.
        }
      }
      throw error;
    } finally {
      if (staged?.directory) {
        let retained = false;
        try { retained = (await readState()).candidate?.directory === staged.directory; } catch { retained = true; }
        if (!retained) await removePrivateDirectory(staged.directory).catch(() => {});
      }
    }
  }

  async function getSafeStatus() {
    let state;
    try { state = await readState(); }
    catch (error) {
      return {
        backupEnabled: false, syncState: "error", syncCurrentFiles: 0, syncTotalFiles: 0,
        syncCurrentBytes: 0, syncTotalBytes: 0, pendingChanges: false, syncPaused: true,
        syncError: { code: safeErrorCode(error), message: "Lo stato della sincronizzazione non è leggibile.", retryable: false },
        lastCompletedBackup: null, outageNotice: GOOGLE_DRIVE_OUTAGE_NOTICE,
      };
    }
    const status = state.paused ? (state.enabled ? "paused" : "disabled") : state.phase;
    let liveTargetMatches = true;
    if (state.enabled && state.target) {
      try { liveTargetMatches = sameTarget(await service.getTarget(), state.target); }
      catch { liveTargetMatches = false; }
    }
    const visibleError = !liveTargetMatches ? "target_changed"
      : runtimeError || (state.pendingCleanups?.length || state.orphanCandidates?.length ? "cleanup_pending" : state.lastError);
    return {
      backupEnabled: state.enabled,
      syncState: !liveTargetMatches ? "error" : (visibleError === "cleanup_pending" ? "cleanup_pending" : (visibleError && !state.paused ? "error" : status)),
      syncCurrentFiles: state.progress.currentFiles,
      syncTotalFiles: state.progress.totalFiles,
      syncCurrentBytes: state.progress.currentBytes,
      syncTotalBytes: state.progress.totalBytes,
      pendingChanges: Boolean(state.enabled && (!state.lastCompleted || state.desiredFingerprint !== state.lastCompleted.fingerprint || state.phase !== "idle")),
      syncPaused: state.paused,
      syncError: visibleError ? {
        code: visibleError,
        message: visibleError === "google_unavailable" ? "Google Drive non è raggiungibile in questo momento."
          : visibleError === "target_changed" ? "La destinazione Google Drive è cambiata. Rivedi l’archivio prima di riattivare la sincronizzazione."
            : "La sincronizzazione è in attesa di essere ripresa.",
        retryable: visibleError === "google_unavailable" || Boolean(state.retry?.at),
      } : null,
      retryAt: Number.isFinite(state.retry?.at) ? new Date(state.retry.at).toISOString() : null,
      lastCompletedBackup: state.lastCompleted ? { completedAt: state.lastCompleted.completedAt, fileCount: state.lastCompleted.fileCount, totalBytes: state.lastCompleted.totalBytes } : null,
      outageNotice: GOOGLE_DRIVE_OUTAGE_NOTICE,
    };
  }

  async function preview() {
    const target = await service.getTarget();
    await ensurePrivateChild(privateDir, snapshotsDir);
    await ensurePrivateChild(privateDir, previewsDir);
    return withWriterLock(async () => {
      await prunePreviewEvidence({ scanPrivate: true });
      const local = await createArchiveSnapshot({ sourceDir: resolvedDataDir, stagingRoot: previewsDir });
      let remote;
      const client = await boundedClient(target);
      try {
        const { root, children } = await remoteRoot(client);
        remote = await inspectRemote(client, root, children, { download: true });
        if (remote.exists) {
          const validation = await validateArchive(remote.directory, remote.inventory);
          if (!validation.valid) throw new GoogleDriveSyncError("archive_invalid");
        }
      } catch (error) {
        await removePrivateDirectory(remote?.directory).catch(() => {});
        remote = { valid: false, empty: false, exists: false, fingerprint: null, code: safeErrorCode(error), rootChildren: [] };
      }
      const localPopulated = !(await isSemanticallyEmpty(local.inventory, local.directory));
      const remotePopulated = remote.valid && remote.exists && !(await isSemanticallyEmpty(remote.inventory, remote.directory));
      const evidenceId = randomUUID();
      previewEvidence.set(evidenceId, { target, local, localPopulated, remote, remotePopulated, expiresAt: now() + 10 * 60 * 1000 });
      await prunePreviewEvidence();
      return {
        evidenceId,
        target,
        local: { fingerprint: local.fingerprint, inventory: local.inventory, populated: localPopulated, directory: local.directory },
        remote: {
          valid: remote.valid,
          empty: remote.valid && !remote.exists,
          exists: Boolean(remote.exists),
          fingerprint: remote.fingerprint || null,
          manifestMatches: Boolean(remote.manifestMatches),
          populated: remotePopulated,
          directory: remote.directory || null,
          inventory: remote.inventory || null,
          snapshotName: remote.snapshotName || null,
          snapshotId: remote.snapshotId || null,
          pointerId: remote.pointerId || null,
          descriptorFingerprint: remote.descriptorFingerprint || null,
          files: remote.files || new Map(),
          directories: remote.directories || new Map(),
          inventoryId: remote.inventoryId || null,
          inventorySha256: remote.inventorySha256 || null,
          errorCode: remote.code || null,
        },
      };
    });
  }

  async function discardPreview(evidenceId) {
    return serialize(() => withWriterLock(async () => {
      const token = previewEvidence.get(evidenceId);
      if (!token) return false;
      previewEvidence.delete(evidenceId);
      await disposePreview(token);
      return true;
    }));
  }

  async function cancelPreview(evidenceId) {
    return discardPreview(evidenceId);
  }

  async function commitArchiveChoice(decision = {}) {
    return serialize(() => withWriterLock(async () => {
      await prunePreviewEvidence({ scanPrivate: true });
      const token = typeof decision.evidenceId === "string" ? previewEvidence.get(decision.evidenceId) : null;
      if (!token || token.expiresAt <= now()) throw new GoogleDriveSyncError("sync_conflict");
      previewEvidence.delete(decision.evidenceId);
      try {
        const target = await service.getTarget();
        if (!sameTarget(target, token.target)) throw new GoogleDriveSyncError("target_changed");
        await ensurePrivateChild(privateDir, previewsDir);
        const freshLocal = await createArchiveSnapshot({ sourceDir: resolvedDataDir, stagingRoot: previewsDir });
        try {
          if (freshLocal.fingerprint !== token.local.fingerprint) throw new GoogleDriveSyncError("snapshot_changed");
          const client = await boundedClient(target);
          const { root, children } = await remoteRoot(client);
          const freshRemote = await inspectRemote(client, root, children);
          const previewRemote = token.remote;
          if (!previewRemote.valid || freshRemote.exists !== previewRemote.exists
              || (freshRemote.exists && (!freshRemote.manifestMatches || freshRemote.fingerprint !== previewRemote.fingerprint
                || freshRemote.descriptorFingerprint !== previewRemote.descriptorFingerprint
                || freshRemote.snapshotName !== previewRemote.snapshotName))) throw new GoogleDriveSyncError("sync_conflict");
          if (!sameTarget(await service.getTarget(), token.target)) throw new GoogleDriveSyncError("target_changed");
          if (decision.confirmed !== true || decision.source !== "feature04" || decision.choice === "use-drive") throw new GoogleDriveSyncError("sync_conflict");
          const localPopulated = !(await isSemanticallyEmpty(freshLocal.inventory, freshLocal.directory));
          const remotePopulated = freshRemote.exists && !(await isSemanticallyEmpty(freshRemote.inventory, token.remote.directory));
          if (localPopulated !== token.localPopulated || remotePopulated !== token.remotePopulated) throw new GoogleDriveSyncError("snapshot_changed");
          if (decision.choice === "equivalent") {
            if (!freshRemote.exists || !freshRemote.manifestMatches || freshLocal.fingerprint !== freshRemote.fingerprint) throw new GoogleDriveSyncError("sync_conflict");
          } else if (decision.choice === "initialize") {
            if (localPopulated || remotePopulated || freshRemote.exists) throw new GoogleDriveSyncError("sync_conflict");
          } else if (decision.choice === "use-local") {
            if (!localPopulated && remotePopulated) throw new GoogleDriveSyncError("sync_conflict");
          } else throw new GoogleDriveSyncError("sync_conflict");
          const state = await readState();
          const control = await getControl();
          if (state.enabled && !state.paused && control.pauseRequested) throw new GoogleDriveSyncError("sync_paused");
          if (!sameTarget(await service.getTarget(), token.target)) throw new GoogleDriveSyncError("target_changed");
          if (state.target) queueOrphanCandidate(state, state.target);
          state.enabled = true;
          state.paused = false;
          state.epoch += 1;
          state.target = target;
          state.phase = "idle";
          state.desiredFingerprint = token.local.fingerprint;
          state.candidate = null;
          state.operations = {};
          state.lastError = null;
          state.retry = { attempts: 0, at: null };
          state.lastCompleted = freshRemote.exists ? completedFromRemote(freshRemote) : null;
          state.lastVerifiedAt = decision.choice === "equivalent" ? now() : null;
          state.progress = state.lastCompleted ? {
            currentFiles: state.lastCompleted.fileCount, totalFiles: state.lastCompleted.fileCount,
            currentBytes: state.lastCompleted.totalBytes, totalBytes: state.lastCompleted.totalBytes,
          } : { currentFiles: 0, totalFiles: 0, currentBytes: 0, totalBytes: freshLocal.inventory.files.reduce((sum, entry) => sum + entry.size, 0) };
          await writeState(state);
          await setControl({ epoch: state.epoch, pauseRequested: false });
          queueMicrotask(() => { void runOnce().catch(() => {}); });
          runtimeError = null;
          return getSafeStatus();
        } finally {
          await removePrivateDirectory(freshLocal.directory).catch(() => {});
        }
      } finally {
        await removePrivateDirectory(token.local.directory).catch(() => {});
        await removePrivateDirectory(token.remote.directory).catch(() => {});
      }
    }));
  }

  async function authorizeRestore(decision = {}) {
    return serialize(() => withWriterLock(async () => {
      await prunePreviewEvidence({ scanPrivate: true });
      const token = typeof decision.evidenceId === "string" ? previewEvidence.get(decision.evidenceId) : null;
      if (!token || token.expiresAt <= now() || decision.source !== "feature04"
          || decision.confirmed !== true || decision.choice !== "use-drive"
          || !token.remote?.valid || !token.remote.exists) throw new GoogleDriveSyncError("sync_conflict");
      const target = await service.getTarget();
      if (!sameTarget(target, token.target)) throw new GoogleDriveSyncError("target_changed");
      const local = await createArchiveSnapshot({ sourceDir: resolvedDataDir, stagingRoot: previewsDir });
      try {
        if (local.fingerprint !== token.local.fingerprint) throw new GoogleDriveSyncError("snapshot_changed");
        const client = await boundedClient(target);
        const { root, children } = await remoteRoot(client);
        const remote = await inspectRemote(client, root, children);
        if (!remote.exists || !remote.manifestMatches || remote.fingerprint !== token.remote.fingerprint
            || remote.descriptorFingerprint !== token.remote.descriptorFingerprint
            || remote.snapshotName !== token.remote.snapshotName) throw new GoogleDriveSyncError("sync_conflict");
        if (!sameTarget(await service.getTarget(), token.target)) throw new GoogleDriveSyncError("target_changed");
        const restoreAuthorizationId = randomUUID();
        const authorization = { token, target, expiresAt: token.expiresAt };
        restoreAuthorizations.set(restoreAuthorizationId, authorization);
        previewEvidence.delete(decision.evidenceId);
        await prunePreviewEvidence();
        return { restoreAuthorizationId, target };
      } finally {
        await removePrivateDirectory(local.directory).catch(() => {});
      }
    }));
  }

  async function requestPause(epoch) {
    await ensurePrivateDirectory(privateDir);
    await setControl({ epoch, pauseRequested: true });
  }

  async function pauseAndDrain() {
    const before = await readState();
    await requestPause(before.epoch);
    return serialize(() => withWriterLock(async () => {
      const state = await readState();
      state.paused = true;
      state.phase = state.enabled ? "paused" : "disabled";
      state.progress = { currentFiles: 0, totalFiles: 0, currentBytes: 0, totalBytes: 0 };
      await writeState(state);
      await setControl({ epoch: state.epoch, pauseRequested: false });
      return getSafeStatus();
    }));
  }

  async function resume() {
    return serialize(() => withWriterLock(async () => {
      const state = await readState();
      const target = await service.getTarget();
      if (!state.enabled || !sameTarget(target, state.target)) throw new GoogleDriveSyncError("target_changed");
      state.paused = false;
      state.phase = "idle";
      state.lastError = null;
      state.retry = { attempts: 0, at: null };
      await writeState(state);
      await setControl({ epoch: state.epoch, pauseRequested: false });
      queueMicrotask(() => { void runOnce().catch(() => {}); });
      return getSafeStatus();
    }));
  }

  async function disable() {
    const before = await readState();
    await requestPause(before.epoch);
    return serialize(() => withWriterLock(async () => {
      const state = await readState();
      const stagedDirectory = state.candidate?.directory;
      if (state.target) queueOrphanCandidate(state, state.target);
      state.enabled = false;
      state.paused = true;
      state.epoch += 1;
      state.phase = "disabled";
      state.operations = {};
      state.candidate = null;
      state.retry = { attempts: 0, at: null };
      state.lastError = null;
      state.restoreAuthorization = null;
      await writeState(state);
      await setControl({ epoch: state.epoch, pauseRequested: false });
      await removePrivateDirectory(stagedDirectory).catch(() => {});
      return getSafeStatus();
    }));
  }

  async function invalidateAfterRestore({ target: expectedTarget, restoreAuthorizationId } = {}) {
    await prunePreviewEvidence();
    const authorization = restoreAuthorizations.get(restoreAuthorizationId);
    if (!authorization || authorization.expiresAt <= now()) throw new GoogleDriveSyncError("sync_conflict");
    const before = await readState();
    await requestPause(before.epoch);
    return serialize(() => withWriterLock(async () => {
      const target = await service.getTarget();
      if ((expectedTarget && !sameTarget(target, expectedTarget)) || !sameTarget(target, authorization.target)) throw new GoogleDriveSyncError("target_changed");
      const state = await readState();
      if (state.target) queueOrphanCandidate(state, state.target);
      const stagedDirectory = state.candidate?.directory;
      state.epoch += 1;
      state.paused = true;
      state.enabled = Boolean(state.enabled);
      state.target = target;
      state.phase = state.enabled ? "paused" : "disabled";
      state.operations = {};
      state.candidate = null;
      state.desiredFingerprint = null;
      state.restoreAuthorization = {
        id: restoreAuthorizationId,
        expiresAt: authorization.expiresAt,
        target,
        remoteFingerprint: authorization.token.remote.fingerprint,
        descriptorFingerprint: authorization.token.remote.descriptorFingerprint,
        snapshotId: authorization.token.remote.snapshotId,
        snapshotName: authorization.token.remote.snapshotName,
      };
      await writeState(state);
      await setControl({ epoch: state.epoch, pauseRequested: false });
      await removePrivateDirectory(stagedDirectory).catch(() => {});
      return { epoch: state.epoch, target, restoreAuthorizationId };
    }));
  }

  async function completeRestore({ target: expectedTarget, epoch, restoreAuthorizationId } = {}) {
    return serialize(() => withWriterLock(async () => {
      const state = await readState();
      const target = await service.getTarget();
      const authorization = restoreAuthorizations.get(restoreAuthorizationId);
      if (!state.paused || state.epoch !== epoch || state.restoreAuthorization?.id !== restoreAuthorizationId
          || !authorization || authorization.expiresAt <= now() || !sameTarget(target, expectedTarget || state.target)
          || !sameTarget(target, authorization.target)) throw new GoogleDriveSyncError("target_changed");
      const remoteToken = authorization.token;
      if (!remoteToken.remote.valid || !remoteToken.remote.exists) throw new GoogleDriveSyncError("sync_conflict");
      const assertRestoreFence = async () => {
        const [latest, liveTarget, control] = await Promise.all([readState(), service.getTarget(), getControl()]);
        if (!latest.paused || latest.epoch !== epoch || latest.restoreAuthorization?.id !== restoreAuthorizationId || !sameTarget(latest.target, target)
            || !sameTarget(liveTarget, target) || (control.pauseRequested && control.epoch === epoch)) {
          throw new GoogleDriveSyncError("target_changed");
        }
      };
      let localStage = null;
      try {
        let freshRemote = null;
        const client = await boundedClient(target);
        const { root, children } = await remoteRoot(client);
        freshRemote = await inspectRemote(client, root, children);
        if (!freshRemote.exists || !freshRemote.manifestMatches
            || freshRemote.fingerprint !== remoteToken.remote.fingerprint
            || freshRemote.descriptorFingerprint !== remoteToken.remote.descriptorFingerprint
            || freshRemote.snapshotId !== remoteToken.remote.snapshotId
            || freshRemote.snapshotName !== remoteToken.remote.snapshotName) throw new GoogleDriveSyncError("sync_conflict");
        await assertRestoreFence();
        await ensurePrivateChild(privateDir, previewsDir);
        localStage = await createArchiveSnapshot({ sourceDir: resolvedDataDir, stagingRoot: previewsDir });
        await verifyRestoreControlTransform({
          remoteDirectory: remoteToken.remote.directory,
          localDirectory: localStage.directory,
          remoteInventory: remoteToken.remote.inventory,
          localInventory: localStage.inventory,
          previousLocalDirectory: remoteToken.local.directory,
        });
        await assertRestoreFence();
        const freshState = await readState();
        freshState.target = target;
        freshState.desiredFingerprint = localStage.fingerprint;
        freshState.lastCompleted = completedFromRemote(freshRemote);
        freshState.lastVerifiedAt = now();
        freshState.operations = {};
        freshState.candidate = null;
        freshState.pendingCleanups ||= freshState.pendingCleanup ? [freshState.pendingCleanup] : [];
        freshState.pendingCleanup = freshState.pendingCleanups[0] || null;
        freshState.enabled = true;
        freshState.paused = false;
        freshState.phase = "idle";
        freshState.lastError = null;
        freshState.restoreAuthorization = null;
        freshState.retry = { attempts: 0, at: null };
        freshState.progress = freshState.lastCompleted ? {
          currentFiles: freshState.lastCompleted.fileCount, totalFiles: freshState.lastCompleted.fileCount,
          currentBytes: freshState.lastCompleted.totalBytes, totalBytes: freshState.lastCompleted.totalBytes,
        } : { currentFiles: 0, totalFiles: 0, currentBytes: 0, totalBytes: 0 };
        await assertRestoreFence();
        await writeState(freshState);
        await setControl({ epoch: freshState.epoch, pauseRequested: false });
        restoreAuthorizations.delete(restoreAuthorizationId);
        runtimeError = null;
        return getSafeStatus();
      } finally {
        if (localStage?.directory) await removePrivateDirectory(localStage.directory).catch(() => {});
        restoreAuthorizations.delete(restoreAuthorizationId);
        await disposePreview(remoteToken);
      }
    }));
  }

  async function runOnce() {
    if (stopping) return getSafeStatus();
    if (activeRun) return activeRun;
    activeRun = serialize(() => withWriterLock(runOnceInternal)).finally(() => { activeRun = null; });
    return activeRun;
  }

  function start() {
    if (timer) return;
    stopping = false;
    stopPromise = null;
    void serialize(() => withWriterLock(async () => prunePreviewEvidence({ scanPrivate: true }))).catch(() => {});
    const interval = Math.max(1000, Number(pollIntervalMs) || DEFAULT_POLL_MS);
    timer = setInterval(() => { void runOnce().catch(() => {}); }, interval);
    timer.unref?.();
    void runOnce().catch(() => {});
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    stopPromise = (async () => {
      if (activeRun) await activeRun.catch(() => {});
      await serialize(() => withWriterLock(async () => {
        await prunePreviewEvidence({ removeAll: true, scanPrivate: true });
        try {
          const state = await readState();
          state.restoreAuthorization = null;
          await writeState(state);
        } catch { /* Preserve malformed private state. */ }
      })).catch(() => {});
    })();
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    runOnce,
    getSafeStatus,
    getStatus: getSafeStatus,
    preview,
    discardPreview,
    cancelPreview,
    commitArchiveChoice,
    authorizeRestore,
    pauseAndDrain,
    resume,
    disable,
    invalidateAfterRestore,
    completeRestore,
    privateDir,
  });
}

const workersByService = new WeakMap();
export function getGoogleDriveSyncWorker({ service, dataDir, ...options } = {}) {
  let workers = workersByService.get(service);
  if (!workers) { workers = new Map(); workersByService.set(service, workers); }
  const key = path.resolve(dataDir || path.dirname(service.privateDir));
  if (!workers.has(key)) workers.set(key, createGoogleDriveSyncWorker({ service, dataDir: key, ...options }));
  return workers.get(key);
}
