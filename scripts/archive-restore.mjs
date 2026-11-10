import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { ARCHIVE_SCHEMA_VERSION, buildArchiveInventory, createRawArchiveSnapshot, hashArchiveFile, isAllowedArchivePath, resolveArchiveFile, validateArchive } from "./archive-store.mjs";
import { safeArchivePath } from "../shared/portable-assets.mjs";
import { ArchiveMaintenanceError, archiveMaintenanceStatus, withArchiveMaintenance } from "./archive-coordinator.mjs";

const FIELDS = ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"];
const JOURNAL_DISAPPEARED_DURING_READ = Symbol("journal-disappeared-during-read");
const paths = (root) => { const dir = path.join(path.resolve(root), ".google-drive", "restore"); return { dir, journal: path.join(dir, "restore-journal.json") }; };
async function ensureDir(dir, create = false) {
  let s = await lstat(dir).catch((e) => e.code === "ENOENT" ? null : Promise.reject(e));
  if (s && (s.isSymbolicLink() || !s.isDirectory())) throw new ArchiveMaintenanceError("archive_control_invalid");
  if (!s && create) { await mkdir(dir, { mode: 0o700 }); s = await lstat(dir); }
  if (s?.isSymbolicLink() || (s && !s.isDirectory())) throw new ArchiveMaintenanceError("archive_control_invalid");
  if (s) await chmod(dir, 0o700);
  return Boolean(s);
}
async function syncFile(file, onDurability) {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await onDurability?.("file", file);
}
async function save(file, value, onDurability) {
  const tmp = file + "." + randomUUID() + ".tmp", handle = await open(tmp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await onDurability?.("file", tmp);
  await rename(tmp, file);
  await syncDirectory(path.dirname(file), onDurability);
}
function safeRelativeArchivePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) return false;
  try { return safeArchivePath(value) === value && isAllowedArchivePath(value); } catch { return false; }
}
function validInventory(inv) {
  if (!inv || inv.version !== ARCHIVE_SCHEMA_VERSION || !Array.isArray(inv.files) || inv.files.length > 50_000) return false;
  const seen = new Set(); let total = 0;
  return inv.files.every((e) => {
    if (!e || !safeRelativeArchivePath(e.path) || seen.has(e.path) || !Number.isSafeInteger(e.size) || e.size < 0 || !/^[a-f0-9]{64}$/.test(e.sha256 || "")) return false;
    total += e.size; if (!Number.isSafeInteger(total) || total > 2 ** 50) return false;
    seen.add(e.path); return true;
  }) && inv.files.every((entry, index) => index === 0 || inv.files[index - 1].path.localeCompare(entry.path, "en") <= 0);
}
function validTarget(target) {
  return Boolean(target && typeof target === "object" && !Array.isArray(target)
    && /^[a-f0-9]{64}$/.test(target.targetFingerprint || "")
    && typeof target.connectionGeneration === "string" && /^[a-f0-9-]{32,40}$/i.test(target.connectionGeneration)
    && typeof target.accountId === "string" && target.accountId.length >= 5 && target.accountId.length <= 200 && !/[\0\r\n]/.test(target.accountId)
    && typeof target.folderId === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(target.folderId)
    && (target.driveId === null || (typeof target.driveId === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(target.driveId))));
}
function validSnapshotName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\0\r\n]/.test(value);
}
function inventoryFingerprint(inventory) {
  return createHash("sha256").update(Buffer.from(JSON.stringify(inventory))).digest("hex");
}
function expectedRestoreProof(journal) {
  return {
    transactionId: journal.id,
    restoreAuthorizationId: journal.restoreAuthorizationId,
    target: journal.target,
    remoteFingerprint: journal.remoteFingerprint,
    descriptorFingerprint: journal.descriptorFingerprint,
    previousFingerprint: journal.previousFingerprint,
    snapshotId: journal.snapshotId,
    snapshotName: journal.snapshotName,
    activate: journal.activate,
    previousMode: journal.previousMode,
    epoch: journal.epoch,
    stagedFingerprint: inventoryFingerprint(journal.incomingInventory),
    completedFingerprint: inventoryFingerprint(journal.incomingInventory),
    phase: journal.phase,
  };
}
function validEntry(entry, relative) {
  return entry === null || (entry && typeof entry === "object" && entry.path === relative
    && Number.isSafeInteger(entry.size) && entry.size >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256 || ""));
}
async function readJournal(root) {
  const p = paths(root);
  if (!await ensureDir(p.dir)) return null;
  const info = await lstat(p.journal).catch((e) => e.code === "ENOENT" ? null : Promise.reject(e));
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 4 * 1024 * 1024) throw new ArchiveMaintenanceError("archive_control_invalid");
  let bytes;
  try { bytes = await readFile(p.journal); }
  catch (error) {
    // A second recovery can finish cleanup after our lstat. The caller must
    // recheck under maintenance and keep any active restore proof fenced.
    if (error.code === "ENOENT") return JOURNAL_DISAPPEARED_DURING_READ;
    throw error;
  }
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new ArchiveMaintenanceError("archive_control_invalid");
  let j; try { j = JSON.parse(bytes.toString("utf8")); } catch (cause) { throw new ArchiveMaintenanceError("archive_control_invalid", { cause }); }
  const tx = path.join(p.dir, j?.id || "invalid");
  const rollbackParent = path.join(tx, "rollback");
  const rel = (f) => path.relative(p.dir, path.resolve(f || ""));
  const rollbackRel = rel(j?.rollbackDirectory);
  const incomingRel = rel(j?.incomingDirectory);
  const operationPaths = new Set();
  const byPath = (inventory) => new Map(inventory.files.map((entry) => [entry.path, entry]));
  const previous = validInventory(j?.previousInventory) ? byPath(j.previousInventory) : new Map();
  const incoming = validInventory(j?.incomingInventory) ? byPath(j.incomingInventory) : new Map();
  const expectedPaths = new Set([...previous.keys(), ...incoming.keys()]);
  const validOperations = Array.isArray(j?.operations) && j.operations.length === expectedPaths.size
    && j.operations.every((op) => {
      if (!op || !safeRelativeArchivePath(op.path) || operationPaths.has(op.path)
          || !["pending", "old-intent", "old-moved", "new-intent", "new-moved"].includes(op.status)) return false;
      operationPaths.add(op.path);
      const old = previous.get(op.path) || null, next = incoming.get(op.path) || null;
      return JSON.stringify(op.old ?? null) === JSON.stringify(old) && JSON.stringify(op.next ?? null) === JSON.stringify(next)
        && expectedPaths.has(op.path) && !(op.old === null && op.status.startsWith("old"))
        && !(op.next === null && op.status.startsWith("new"));
    }) && operationPaths.size === expectedPaths.size;
  const targetValid = validTarget(j?.target);
  if (!j || j.version !== 1 || !/^[0-9a-f-]{36}$/i.test(j.id || "") || !["prepared", "fenced", "swapping", "rolling-back", "committed", "rolled-back"].includes(j.phase)
      || !targetValid || !/^[0-9a-f-]{36}$/i.test(j.restoreAuthorizationId || "")
      || !/^[a-f0-9]{64}$/.test(j.remoteFingerprint || "") || !/^[a-f0-9]{64}$/.test(j.descriptorFingerprint || "")
      || !/^[a-f0-9]{64}$/.test(j.previousFingerprint || "")
      || !/^[a-f0-9]{64}$/.test(j.stagedFingerprint || "")
      || !/^[A-Za-z0-9_-]{5,200}$/.test(j.snapshotId || "") || !validSnapshotName(j.snapshotName)
      || !Number.isSafeInteger(j.operationIndex) || j.operationIndex < 0 || j.operationIndex > (j.operations?.length || 0)
      || !j.previousMode || typeof j.previousMode.enabled !== "boolean" || typeof j.previousMode.paused !== "boolean"
      || typeof j.activate !== "boolean" || j.activate !== (j.activate === true)
      || j.incomingDirectory !== path.join(tx, "incoming")
      || !rollbackRel.startsWith(path.relative(p.dir, rollbackParent) + path.sep)
      || path.dirname(j.rollbackDirectory) !== rollbackParent || !/^raw-[0-9a-f-]{36}$/i.test(path.basename(j.rollbackDirectory))
      || rollbackRel.startsWith(".." + path.sep) || incomingRel !== path.relative(p.dir, path.join(tx, "incoming"))
      || !validInventory(j.previousInventory) || !validInventory(j.incomingInventory) || !Array.isArray(j.operations)
      || inventoryFingerprint(j.previousInventory) !== j.previousFingerprint
      || inventoryFingerprint(j.incomingInventory) !== j.stagedFingerprint
      || !validOperations || (j.epoch !== undefined && (!Number.isSafeInteger(j.epoch) || j.epoch < 1))
      || (j.phase === "committed" && !Number.isSafeInteger(j.epoch))) throw new ArchiveMaintenanceError("archive_control_invalid");
  for (const directory of [p.dir, tx, rollbackParent, j.rollbackDirectory, j.incomingDirectory]) {
    const info = await lstat(directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new ArchiveMaintenanceError("archive_control_invalid");
    if (!info && !["committed", "rolled-back"].includes(j.phase)) throw new ArchiveMaintenanceError("archive_control_invalid");
  }
  return j;
}
async function copyInventory(source, destination, inventory) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const e of inventory.files) {
    const from = await resolveArchiveFile(source, e.path), to = path.join(destination, ...e.path.split("/"));
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await pipeline(createReadStream(from), createWriteStream(to, { flags: "wx", mode: 0o600 }));
    const d = await hashArchiveFile(to); if (d.size !== e.size || d.sha256 !== e.sha256) throw new Error("Archive staging checksum mismatch");
  }
}
async function readCatalog(root, name, fallback) {
  try { return JSON.parse(await readFile(await resolveArchiveFile(root, name), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return structuredClone(fallback); throw e; }
}
async function generation(root, name) {
  try { const n = JSON.parse(await readFile(path.join(root, name), "utf8")).archiveGeneration; return Number.isSafeInteger(n) ? n : 0; } catch { return 0; }
}
async function transform(incoming, old, onDurability) {
  const metadata = await readCatalog(incoming, "archive-metadata.json", { schemaVersion: 1, archiveGeneration: 0, referenceSources: {} });
  const state = await readCatalog(incoming, "browser-state.json", { version: 1, archiveGeneration: 1, revision: 0, migrationSealed: false, migratedFields: [], declutterKeptIds: [], dismissedNudges: [], modelTier: "standard", onboardingDismissed: false, wornToday: { day: "", ids: [] } });
  const archiveGeneration = Math.max(await generation(old, "archive-metadata.json"), await generation(old, "browser-state.json"), metadata.archiveGeneration || 0, state.archiveGeneration || 0) + 1;
  await save(path.join(incoming, "archive-metadata.json"), { ...metadata, schemaVersion: 1, archiveGeneration }, onDurability);
  await save(path.join(incoming, "browser-state.json"), { ...state, version: 1, archiveGeneration, revision: Math.max(state.revision || 0, 0), migrationSealed: true, migratedFields: FIELDS }, onDurability);
  return archiveGeneration;
}
async function entryAt(root, relative) {
  try { return { path: relative, ...(await hashArchiveFile(await resolveArchiveFile(root, relative))) }; } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
async function syncDirectory(directory, onDurability) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await onDurability?.("directory", directory);
}
async function syncDirectoryChain(directory, root, onDurability) {
  let current = path.resolve(directory), boundary = path.resolve(root);
  while (current === boundary || current.startsWith(boundary + path.sep)) {
    await syncDirectory(current, onDurability);
    if (current === boundary) break;
    current = path.dirname(current);
  }
}
async function syncTree(directory, onDurability) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(child, onDurability);
    else if (entry.isFile()) await syncFile(child, onDurability);
    else throw new ArchiveMaintenanceError("archive_control_invalid");
  }
  await syncDirectory(directory, onDurability);
  await syncDirectory(path.dirname(directory), onDurability);
}
async function renameWithHook(from, to, hook, label, onDurability, destinationRoot) {
  await hook?.(label + ":before", { from, to });
  await rename(from, to);
  await syncDirectory(path.dirname(from), onDurability);
  if (path.dirname(to) !== path.dirname(from)) {
    if (destinationRoot) await syncDirectoryChain(path.dirname(to), destinationRoot, onDurability);
    else await syncDirectory(path.dirname(to), onDurability);
  }
  await hook?.(label + ":after", { from, to });
}
async function journalSave(root, j, hook, onDurability) { await hook?.("journal:before", structuredClone(j)); await save(paths(root).journal, j, onDurability); await hook?.("journal:after", structuredClone(j)); }
async function rollback(root, j, onRename, onJournalSave, onDurability, { preserveRestoreProof = true } = {}) {
  j.phase = "rolling-back"; await journalSave(root, j, onJournalSave, onDurability);
  for (const op of [...j.operations].reverse()) {
    const current = await entryAt(root, op.path);
    if (op.old && !(current?.sha256 === op.old.sha256 && current.size === op.old.size)) {
      if (current && (!op.next || current.sha256 !== op.next.sha256 || current.size !== op.next.size)) throw new ArchiveMaintenanceError("archive_control_invalid");
      const backup = path.join(j.rollbackDirectory, ...op.path.split("/")), d = await hashArchiveFile(backup).catch((e) => e.code === "ENOENT" ? null : Promise.reject(e));
      if (!d || d.sha256 !== op.old.sha256 || d.size !== op.old.size) throw new ArchiveMaintenanceError("archive_control_invalid");
      const tmp = path.join(j.rollbackDirectory, "restore-" + randomUUID() + ".tmp"); await pipeline(createReadStream(backup), createWriteStream(tmp, { flags: "wx", mode: 0o600 })); await syncFile(tmp, onDurability);
      const target = path.join(root, ...op.path.split("/")); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await renameWithHook(tmp, target, onRename, "rollback:" + op.path, onDurability, root);
    } else if (!op.old && current) {
      if (!op.next || current.sha256 !== op.next.sha256 || current.size !== op.next.size) throw new ArchiveMaintenanceError("archive_control_invalid");
      await unlink(path.join(root, ...op.path.split("/")));
      await syncDirectory(path.dirname(path.join(root, ...op.path.split("/"))), onDurability);
    }
    await journalSave(root, j, onJournalSave, onDurability);
  }
  await verifyInventoryBytes(root, j.previousInventory);
  j.phase = "rolled-back";
  await journalSave(root, j, onJournalSave, onDurability);
  const stateFile = path.join(root, ".google-drive", "sync-state.json");
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.restoreAuthorization?.transactionId === j.id) {
      state.paused = true;
      state.phase = state.enabled ? "paused" : "disabled";
      state.operations = {};
      await save(stateFile, state, onDurability); await save(path.join(root, ".google-drive", "sync-control.json"), { epoch: state.epoch, pauseRequested: true }, onDurability);
    }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
}
async function cleanup(root, j, onDurability) {
  await rm(path.join(paths(root).dir, j.id), { recursive: true, force: true });
  await syncDirectory(paths(root).dir, onDurability);
  await unlink(paths(root).journal).catch((e) => { if (e.code !== "ENOENT") throw e; });
  await syncDirectory(paths(root).dir, onDurability);
}

async function verifyInventoryBytes(root, inventory) {
  if (JSON.stringify(await buildArchiveInventory(root)) !== JSON.stringify(inventory)) throw new ArchiveMaintenanceError("archive_control_invalid");
  for (const entry of inventory.files) {
    const digest = await hashArchiveFile(await resolveArchiveFile(root, entry.path));
    if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw new ArchiveMaintenanceError("archive_control_invalid");
  }
}

async function hasActiveRestoreProof(root) {
  const stateFile = path.join(root, ".google-drive", "sync-state.json");
  const info = await lstat(stateFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024) throw new ArchiveMaintenanceError("archive_control_invalid");
  let state;
  try { state = JSON.parse(await readFile(stateFile, "utf8")); }
  catch (cause) { throw new ArchiveMaintenanceError("archive_control_invalid", { cause }); }
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new ArchiveMaintenanceError("archive_control_invalid");
  return state.restoreAuthorization?.active === true;
}

export async function recoverArchiveRestore({ dataDir, worker, onRename, onJournalSave, onDurability, recoverOrphan = false } = {}) {
  const root = path.resolve(dataDir);
  const rootInfo = await lstat(root).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!rootInfo) return { recovered: false };
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new ArchiveMaintenanceError("archive_control_invalid");
  const privateDir = path.join(root, ".google-drive");
  if (!await ensureDir(privateDir)) return { recovered: false };
  if (!await ensureDir(paths(root).dir)) return { recovered: false };
  const j = await readJournal(root);
  if (j === JOURNAL_DISAPPEARED_DURING_READ) {
    return withArchiveMaintenance(root, async () => {
      const current = await readJournal(root);
      if (current && current !== JOURNAL_DISAPPEARED_DURING_READ) throw new ArchiveMaintenanceError("archive_control_invalid");
      if (await hasActiveRestoreProof(root)) throw new ArchiveMaintenanceError("archive_control_invalid");
      return { recovered: false, outcome: "already-finalized" };
    }, { recovery: true });
  }
  if (!j) {
    if (!worker && await hasActiveRestoreProof(root)) throw new ArchiveMaintenanceError();
    if (recoverOrphan && worker?.recoverOrphanRestoreAuthorization) {
      return withArchiveMaintenance(root, async () => ({ recovered: await worker.recoverOrphanRestoreAuthorization(), outcome: "orphan-authorization" }), { recovery: true });
    }
    return { recovered: false };
  }
  if (!worker) throw new ArchiveMaintenanceError();
  return withArchiveMaintenance(root, async () => {
    const current = await readJournal(root);
    if (!current || JSON.stringify(current) !== JSON.stringify(j)) throw new ArchiveMaintenanceError("archive_control_invalid");
    await worker.verifyRestoreJournal({ ...expectedRestoreProof(j), phase: j.phase });
    if (j.phase === "committed") {
      const inv = await buildArchiveInventory(root); if (JSON.stringify(inv) !== JSON.stringify(j.incomingInventory) || !(await validateArchive(root, inv)).valid) throw new ArchiveMaintenanceError("archive_control_invalid");
      await worker.finishRestore({ transactionId: j.id, restoreAuthorizationId: j.restoreAuthorizationId, expectedProof: expectedRestoreProof(j) });
      await cleanup(root, j, onDurability); return { recovered: true, outcome: "committed" };
    }
    if (j.phase === "rolled-back") {
      await verifyInventoryBytes(root, j.previousInventory);
      await cleanup(root, j, onDurability);
      await worker.recoverOrphanRestoreAuthorization?.({ transactionId: j.id }); return { recovered: true, outcome: "rolled_back" };
    }
    await rollback(root, j, onRename, onJournalSave, onDurability, { preserveRestoreProof: true });
    await cleanup(root, j, onDurability);
    await worker.recoverOrphanRestoreAuthorization?.({ transactionId: j.id });
    return { recovered: true, outcome: "rolled_back" };
  }, { recovery: true });
}

// Maintenance blocks every archive request while it waits for in-flight
// writers. A user-started operation gives up instead of freezing the app.
const ACTIVATION_DRAIN_MS = 20_000;
const RESTORE_DRAIN_MS = 60_000;

export function createGoogleDriveArchiveManager({ dataDir, service, worker, now = Date.now, onJournalSave, onRename, onDurability, activationDrainMs = ACTIVATION_DRAIN_MS, restoreDrainMs = RESTORE_DRAIN_MS } = {}) {
  const root = path.resolve(dataDir), actions = new Map(); let operation = null, activeActionToken = null, busy = false, activating = false;
  const resume = async (a) => { if (a.previousMode.enabled && !a.previousMode.paused) { const t = await service.getTarget(); if (["targetFingerprint", "connectionGeneration", "accountId", "folderId", "driveId"].every((k) => (t[k] ?? null) === (a.target[k] ?? null))) await worker.resume(); } };
  async function prune() {
    const expired = [];
    for (const [token, action] of actions) if (action.expiresAt <= now()) { actions.delete(token); expired.push([token, action]); }
    while (actions.size > 24) { const [token, action] = actions.entries().next().value; actions.delete(token); expired.push([token, action]); }
    for (const [token, action] of expired) {
      if (activeActionToken === token) activeActionToken = null;
      await worker.cancelPreview(action.evidenceId).catch(() => {});
      await resume(action).catch(() => {});
    }
  }
  function assertAvailable() {
    if (busy || activeActionToken || (operation && !["complete", "failed", "recovery_required"].includes(operation.stage))) {
      throw new ArchiveMaintenanceError();
    }
  }
  function decision(e, kind = "activation") {
    if (kind === "restore") {
      if (!e.remote.valid || !e.remote.exists) return { decision: "unavailable", choices: ["cancel"] };
      const current = decision(e, "activation");
      return { ...current, choices: ["use-drive", "cancel"] };
    }
    if (!e.remote.valid) return { decision: "unavailable", choices: ["cancel"] };
    if (e.local.valid && e.local.populated && !e.remote.populated) return { decision: "local_to_empty", choices: ["use-local", "cancel"] };
    if (e.local.valid && !e.local.populated && !e.remote.populated) return { decision: "initialize", choices: ["initialize", "cancel"] };
    if (e.remote.populated && !e.local.populated) return { decision: e.local.valid ? "drive_to_empty" : "local_invalid", choices: ["use-drive", "cancel"] };
    if (e.local.valid && e.local.populated && e.remote.populated && e.local.fingerprint === e.remote.fingerprint) return { decision: "equivalent", choices: ["equivalent", "cancel"] };
    if (e.local.valid && e.local.populated && e.remote.populated) return { decision: "different", choices: ["use-local", "use-drive", "cancel"] };
    return { decision: "local_invalid", choices: e.remote.populated ? ["use-drive", "cancel"] : ["cancel"] };
  }
  async function preview(kind = "activation") {
    await prune(); assertAvailable(); busy = true;
    try {
      const s = await worker.getSafeStatus(), target = await service.getTarget(), mode = { enabled: s.backupEnabled === true, paused: s.syncPaused === true };
      await worker.pauseAndDrain();
      let evidence; try { evidence = await worker.preview({ allowInvalidLocal: true, previousMode: mode }); } catch (e) { await resume({ target, previousMode: mode }).catch(() => {}); throw e; }
      const actionToken = randomUUID(); actions.set(actionToken, { evidenceId: evidence.evidenceId, target, preview: evidence, previousMode: mode, kind, expiresAt: now() + 600_000 }); activeActionToken = actionToken;
      await prune();
      const d = decision(evidence, kind), size = (v) => ({ files: v?.files?.length || 0, bytes: (v?.files || []).reduce((n, f) => n + f.size, 0) });
      return { actionToken, operation: kind, decision: d.decision, choices: d.choices, expiresInMs: 600_000,
        local: { valid: evidence.local.valid, populated: evidence.local.populated, fingerprint: evidence.local.fingerprint, ...size(evidence.local.inventory) },
      remote: { valid: evidence.remote.valid, empty: evidence.remote.valid && !evidence.remote.populated, populated: evidence.remote.populated, fingerprint: evidence.remote.fingerprint, error: evidence.remote.errorCode || null, ...size(evidence.remote.inventory) } };
    } finally { busy = false; }
  }
  async function choose({ actionToken, choice, operation: kind } = {}) {
    await prune();
    if (busy) throw new ArchiveMaintenanceError();
    const a = actions.get(actionToken);
    if (!a || activeActionToken !== actionToken || a.expiresAt <= now() || (kind && kind !== a.kind) || !decision(a.preview, a.kind).choices.includes(choice)) throw Object.assign(new Error("Preview evidence changed"), { code: "sync_conflict", status: 409 });
    busy = true;
    try {
      if (choice === "cancel") {
        actions.delete(actionToken); activeActionToken = null;
        await worker.cancelPreview(a.evidenceId); await resume(a).catch(() => {}); return { status: "cancelled" };
      }
      if (choice !== "use-drive") {
        if (a.kind !== "activation") throw Object.assign(new Error("Manual restore requires a Drive archive"), { code: "sync_conflict", status: 409 });
        actions.delete(actionToken); activeActionToken = null;
        activating = true;
        try {
          const result = await withArchiveMaintenance(root, () => worker.commitArchiveChoice({ evidenceId: a.evidenceId, source: "feature04", confirmed: true, choice }), { waitMs: activationDrainMs });
          return { status: "complete", backupEnabled: result.backupEnabled };
        } catch (error) {
          await worker.cancelPreview(a.evidenceId).catch(() => {});
          await resume(a).catch(() => {});
          throw error;
        } finally { activating = false; }
      }
      const transactionId = randomUUID();
      let authorization;
      try {
        authorization = await worker.authorizeRestore({ evidenceId: a.evidenceId, source: "feature04", confirmed: true, choice: "use-drive", previousMode: a.previousMode, activate: a.kind === "activation", transactionId });
      } catch (error) {
        actions.delete(actionToken); activeActionToken = null;
        await worker.cancelPreview(a.evidenceId).catch(() => {});
        await resume(a).catch(() => {});
        throw error;
      }
      actions.delete(actionToken); activeActionToken = null;
      const operationId = randomUUID(); operation = { operationId, stage: "running", progress: 0, startedAt: new Date(now()).toISOString(), error: null };
      void perform(a, operationId, transactionId, authorization).catch(() => {}); return { status: "running", operationId };
    } finally { busy = false; }
  }
  async function perform(a, operationId, id, auth) {
    const p = paths(root), startedAt = operation?.startedAt;
    try {
      const result = await withArchiveMaintenance(root, async () => {
        operation = { operationId, stage: "capturing", progress: 5, startedAt, error: null }; await ensureDir(p.dir, true);
        await syncDirectory(path.dirname(p.dir), onDurability);
        const tx = path.join(p.dir, id); await mkdir(tx, { mode: 0o700 }); await syncDirectory(p.dir, onDurability);
        const old = await createRawArchiveSnapshot({ sourceDir: root, stagingRoot: path.join(tx, "rollback") });
        if (old.fingerprint !== a.preview.local.fingerprint) throw Object.assign(new Error("Local archive changed after preview"), { code: "snapshot_changed", status: 409 });
        const r = a.preview.remote; if (!r.valid || !r.exists || !r.inventory) throw Object.assign(new Error("Drive archive unavailable"), { code: "archive_invalid", status: 409 });
        const staged = await createRawArchiveSnapshot({ sourceDir: r.directory, stagingRoot: tx });
        if (!staged.valid || JSON.stringify(staged.inventory) !== JSON.stringify(r.inventory) || !(await validateArchive(staged.directory, r.inventory)).valid) throw Object.assign(new Error("Drive archive invalid"), { code: "archive_invalid", status: 409 });
        const incoming = path.join(tx, "incoming"); await copyInventory(staged.directory, incoming, staged.inventory); await rm(staged.directory, { recursive: true, force: true });
        const archiveGeneration = await transform(incoming, old.directory, onDurability), next = await buildArchiveInventory(incoming);
        if (!(await validateArchive(incoming, next)).valid) throw Object.assign(new Error("Restored archive invalid"), { code: "archive_invalid", status: 409 });
        await syncTree(tx, onDurability);
        const map = new Map(); for (const e of old.inventory.files) map.set(e.path, { path: e.path, old: e, next: null, status: "pending" });
        for (const e of next.files) { const op = map.get(e.path) || { path: e.path, old: null, next: null, status: "pending" }; op.next = e; map.set(e.path, op); }
        const journal = { version: 1, id, phase: "prepared", restoreAuthorizationId: auth.restoreAuthorizationId, target: auth.target,
      remoteFingerprint: r.fingerprint, descriptorFingerprint: r.descriptorFingerprint, snapshotId: r.snapshotId, snapshotName: r.snapshotName,
          previousFingerprint: old.fingerprint, stagedFingerprint: inventoryFingerprint(next),
          activate: a.kind === "activation", previousMode: a.previousMode, rollbackDirectory: old.directory, incomingDirectory: incoming,
          previousInventory: old.inventory, incomingInventory: next, operationIndex: 0, operations: [...map.values()].sort((x, y) => x.path.localeCompare(y.path, "en")) };
        await worker.bindRestoreIncoming({ target: auth.target, restoreAuthorizationId: auth.restoreAuthorizationId,
          transactionId: id, previousFingerprint: old.fingerprint, incomingFingerprint: journal.stagedFingerprint });
        await journalSave(root, journal, onJournalSave, onDurability);
        const persisted = await readJournal(root);
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(journal)) throw new ArchiveMaintenanceError("archive_control_invalid");
        operation = { operationId, stage: "fencing", progress: 25, startedAt, error: null };
        const fence = await worker.invalidateAfterRestore({ target: auth.target, restoreAuthorizationId: auth.restoreAuthorizationId, transactionId: id });
        journal.phase = "fenced"; journal.epoch = fence.epoch; await journalSave(root, journal, onJournalSave, onDurability);
        journal.phase = "swapping"; operation = { operationId, stage: "replacing", progress: 35, startedAt, error: null };
        for (let i = 0; i < journal.operations.length; i += 1) {
          const op = journal.operations[i], live = path.join(root, ...op.path.split("/")), local = await entryAt(root, op.path);
          if (local) {
            if (!op.old || local.size !== op.old.size || local.sha256 !== op.old.sha256) throw Object.assign(new Error("Local archive changed"), { code: "snapshot_changed", status: 409 });
            const displaced = path.join(tx, "displaced", ...op.path.split("/")); await mkdir(path.dirname(displaced), { recursive: true, mode: 0o700 });
            op.status = "old-intent"; journal.operationIndex = i; await journalSave(root, journal, onJournalSave, onDurability);
            await renameWithHook(live, displaced, onRename, "old:" + op.path, onDurability, tx); op.status = "old-moved"; await journalSave(root, journal, onJournalSave, onDurability);
          }
          if (op.next) {
            const source = path.join(incoming, ...op.path.split("/")); await mkdir(path.dirname(live), { recursive: true, mode: 0o700 });
            op.status = "new-intent"; journal.operationIndex = i; await journalSave(root, journal, onJournalSave, onDurability);
            await renameWithHook(source, live, onRename, "new:" + op.path, onDurability, root); op.status = "new-moved"; await journalSave(root, journal, onJournalSave, onDurability);
          }
        }
        const actual = await buildArchiveInventory(root);
        if (JSON.stringify(actual) !== JSON.stringify(next) || !(await validateArchive(root, actual)).valid) throw Object.assign(new Error("Replacement validation failed"), { code: "archive_invalid", status: 409 });
        operation = { operationId, stage: "sync_commit", progress: 85, startedAt, error: null };
        await worker.completeRestore({ target: auth.target, epoch: fence.epoch, restoreAuthorizationId: auth.restoreAuthorizationId, keepPaused: true });
        journal.phase = "committed"; await journalSave(root, journal, onJournalSave, onDurability);
        await worker.finishRestore({ transactionId: id, restoreAuthorizationId: auth.restoreAuthorizationId, expectedProof: expectedRestoreProof(journal) });
        await cleanup(root, journal, onDurability);
        return { archiveGeneration };
      }, { waitMs: restoreDrainMs });
      operation = { operationId, stage: "complete", progress: 100, startedAt, error: null };
      return result;
    } catch (e) {
      try {
        const j = await readJournal(root);
        if (j === JOURNAL_DISAPPEARED_DURING_READ) throw new ArchiveMaintenanceError("archive_control_invalid");
        if (j?.id === id && j.phase === "committed") {
          await withArchiveMaintenance(root, async () => {
            const current = await readJournal(root);
            if (!current || JSON.stringify(current) !== JSON.stringify(j)) throw new ArchiveMaintenanceError("archive_control_invalid");
            await worker.verifyRestoreJournal({ ...expectedRestoreProof(j), phase: j.phase });
            const actual = await buildArchiveInventory(root);
            if (JSON.stringify(actual) !== JSON.stringify(j.incomingInventory) || !(await validateArchive(root, actual)).valid) throw new ArchiveMaintenanceError("archive_control_invalid");
            await worker.finishRestore({ transactionId: id, restoreAuthorizationId: j.restoreAuthorizationId, expectedProof: expectedRestoreProof(j) });
            await cleanup(root, j, onDurability);
          }, { recovery: true });
          operation = { operationId, stage: "complete", progress: 100, startedAt, error: null };
          return { archiveGeneration: await generation(root, "archive-metadata.json") };
        }
        if (j?.id === id && j.phase === "rolled-back") await withArchiveMaintenance(root, async () => {
          const current = await readJournal(root);
          if (!current || JSON.stringify(current) !== JSON.stringify(j)) throw new ArchiveMaintenanceError("archive_control_invalid");
          await worker.verifyRestoreJournal({ ...expectedRestoreProof(j), phase: j.phase });
          await verifyInventoryBytes(root, j.previousInventory);
          await cleanup(root, j, onDurability);
          await worker.recoverOrphanRestoreAuthorization?.({ transactionId: id });
        }, { recovery: true });
        else if (j?.id === id) await withArchiveMaintenance(root, async () => {
          const current = await readJournal(root);
          if (!current || JSON.stringify(current) !== JSON.stringify(j)) throw new ArchiveMaintenanceError("archive_control_invalid");
          await worker.verifyRestoreJournal({ ...expectedRestoreProof(j), phase: j.phase });
          await rollback(root, j, onRename, onJournalSave, onDurability, { preserveRestoreProof: true });
          await cleanup(root, j, onDurability);
          await worker.recoverOrphanRestoreAuthorization?.({ transactionId: id });
        }, { recovery: true });
        else if (!j) {
          await rm(path.join(p.dir, id), { recursive: true, force: true }).catch((error) => { if (error.code !== "ENOENT") throw error; });
          await syncDirectory(p.dir).catch((error) => { if (error.code !== "ENOENT") throw error; });
          await worker.recoverOrphanRestoreAuthorization?.({ transactionId: id });
        } else await worker.recoverOrphanRestoreAuthorization?.({ transactionId: id });
      }
      catch (failure) { operation = { operationId, stage: "recovery_required", progress: operation?.progress || 0, startedAt, error: "archive_control_invalid" }; throw failure; }
      operation = { operationId, stage: "failed", progress: operation?.progress || 0, startedAt, error: ["archive_invalid", "snapshot_changed", "target_changed", "sync_conflict", "archive_maintenance"].includes(e.code) ? e.code : "remote_unavailable" }; throw e;
    }
  }
  async function status() {
    const maintenance = await archiveMaintenanceStatus(root);
    let archiveGeneration = null;
    try {
      const candidate = JSON.parse(await readFile(path.join(root, "archive-metadata.json"), "utf8")).archiveGeneration;
      if (Number.isSafeInteger(candidate) && candidate >= 1) archiveGeneration = candidate;
    } catch {}
    return { maintenance: { active: maintenance.active, error: maintenance.error || null, activation: activating }, archiveGeneration, restore: operation };
  }
  return Object.freeze({ preview, choose, status });
}
