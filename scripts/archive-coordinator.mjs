import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, link, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTROLS = "archive-coordination";
const leasesContext = new AsyncLocalStorage();
const recoveryByRoot = new Map();
const recoveryPending = new Map();

export class ArchiveMaintenanceError extends Error {
  constructor(code = "archive_maintenance", { cause } = {}) {
    super(code === "archive_maintenance" ? "Archive maintenance is in progress" : "Archive coordination state is invalid", cause ? { cause } : undefined);
    this.name = "ArchiveMaintenanceError";
    this.code = code;
    this.status = code === "archive_maintenance" ? 503 : 500;
    this.retryable = code === "archive_maintenance";
  }
}

function controlPaths(dataDir) {
  const root = path.resolve(dataDir);
  const privateDir = path.join(root, ".google-drive");
  const directory = path.join(privateDir, CONTROLS);
  return { root, privateDir, directory, gate: path.join(directory, "gate.lock"), leases: path.join(directory, "leases"), maintenance: path.join(directory, "maintenance.json") };
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureControlDirectory(dataDir) {
  const paths = controlPaths(dataDir);
  const rootInfo = await lstat(paths.root).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (rootInfo && (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())) throw new ArchiveMaintenanceError("archive_control_invalid");
  if (!rootInfo) await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const checkedRoot = await lstat(paths.root);
  if (checkedRoot.isSymbolicLink() || !checkedRoot.isDirectory()) throw new ArchiveMaintenanceError("archive_control_invalid");
  const ensurePrivateDir = async (directory) => {
    const info = await lstat(directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new ArchiveMaintenanceError("archive_control_invalid");
    if (!info) {
      try { await mkdir(directory, { mode: 0o700 }); await syncDirectory(path.dirname(directory)); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const latest = await lstat(directory);
    if (latest.isSymbolicLink() || !latest.isDirectory()) throw new ArchiveMaintenanceError("archive_control_invalid");
    await chmod(directory, 0o700);
  };
  await ensurePrivateDir(paths.privateDir);
  await ensurePrivateDir(paths.directory);
  await ensurePrivateDir(paths.leases);
  return paths;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function readRecord(file, expectedKind) {
  const info = await lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 16 * 1024) throw new ArchiveMaintenanceError("archive_control_invalid");
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (bytes.length > 16 * 1024) throw new ArchiveMaintenanceError("archive_control_invalid");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (cause) { throw new ArchiveMaintenanceError("archive_control_invalid", { cause }); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.kind !== expectedKind
      || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.owner !== "string"
      || !/^[a-f0-9-]{36}$/i.test(value.owner) || !Number.isFinite(value.createdAt)) {
    throw new ArchiveMaintenanceError("archive_control_invalid");
  }
  return value;
}

async function acquireGate(paths, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const lock = { pid: process.pid, owner: randomUUID(), createdAt: Date.now() };
    const candidate = `${paths.gate}.${lock.owner}.tmp`;
    try {
      const handle = await open(candidate, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(lock)); await handle.sync(); }
      finally { await handle.close(); }
      // Publish a complete gate record in one no-clobber filesystem operation.
      // Opening gate.lock and writing it in place lets another process observe
      // a transient empty/partial JSON document and mistake normal contention
      // for corrupted private control state.
      await link(candidate, paths.gate);
      await unlink(candidate).catch(() => {});
      await syncDirectory(paths.directory);
      return async () => {
        let current;
        try { current = JSON.parse(await readFile(paths.gate, "utf8")); }
        catch (error) { if (error.code === "ENOENT") return; throw new ArchiveMaintenanceError("archive_control_invalid", { cause: error }); }
        if (current?.owner !== lock.owner || current.pid !== process.pid) throw new ArchiveMaintenanceError("archive_control_invalid");
        await unlink(paths.gate).catch((error) => { if (error.code !== "ENOENT") throw error; });
        await syncDirectory(paths.directory);
      };
    } catch (error) {
      await unlink(candidate).catch(() => {});
      if (error.code !== "EEXIST") throw error;
      // A gate is only held while one tiny control record is changed. If its
      // owner died, remove it after verifying the on-disk owner and PID.
      const info = await lstat(paths.gate).catch((e) => e.code === "ENOENT" ? null : Promise.reject(e));
      if (info?.isSymbolicLink() || (info && (!info.isFile() || info.size < 1 || info.size > 16 * 1024))) throw new ArchiveMaintenanceError("archive_control_invalid");
      if (info) {
        let bytes;
        try { bytes = await readFile(paths.gate); }
        catch (cause) {
          // The prior holder can release between our lstat and readFile. That
          // is ordinary gate contention, not malformed private control data.
          if (cause.code === "ENOENT") continue;
          throw new ArchiveMaintenanceError("archive_control_invalid", { cause });
        }
        if (!bytes.length || bytes.length > 16 * 1024) throw new ArchiveMaintenanceError("archive_control_invalid");
        let raw;
        try { raw = JSON.parse(bytes.toString("utf8")); }
        catch (cause) { throw new ArchiveMaintenanceError("archive_control_invalid", { cause }); }
        if (!raw || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || typeof raw.owner !== "string" || !/^[a-f0-9-]{36}$/i.test(raw.owner)) throw new ArchiveMaintenanceError("archive_control_invalid");
        if (!processAlive(raw.pid)) {
          const latest = await readFile(paths.gate, "utf8").catch((e) => e.code === "ENOENT" ? "" : Promise.reject(e));
          if (latest === JSON.stringify(raw)) await unlink(paths.gate).catch(() => {});
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new ArchiveMaintenanceError("archive_maintenance");
}

async function writeExclusiveJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(tmp, file);
  await syncDirectory(path.dirname(file));
}

async function assertMaintenance(paths, { reapDead = false } = {}) {
  const record = await readRecord(paths.maintenance, "maintenance");
  if (!record) return null;
  if (!processAlive(record.pid)) {
    const latest = await readRecord(paths.maintenance, "maintenance");
    if (reapDead && latest?.owner === record.owner && !processAlive(latest.pid)) {
      await unlink(paths.maintenance).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return null;
    }
  }
  return record;
}

async function acquireWriter(dataDir) {
  const paths = await ensureControlDirectory(dataDir);
  const releaseGate = await acquireGate(paths);
  try {
    if (await assertMaintenance(paths)) throw new ArchiveMaintenanceError();
    const owner = randomUUID();
    let generation = null;
    try {
      const metadata = JSON.parse(await readFile(path.join(dataDir, "archive-metadata.json"), "utf8"));
      if (Number.isSafeInteger(metadata.archiveGeneration) && metadata.archiveGeneration >= 1) generation = metadata.archiveGeneration;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    const record = { kind: "writer", pid: process.pid, owner, createdAt: Date.now(), generation };
    await writeExclusiveJson(path.join(paths.leases, `${owner}.json`), record);
    return { paths, owner, generation };
  } finally { await releaseGate(); }
}

async function releaseWriter(lease) {
  if (!lease) return;
  const record = await readRecord(path.join(lease.paths.leases, `${lease.owner}.json`), "writer");
  if (record?.owner === lease.owner && record.pid === process.pid) {
    await unlink(path.join(lease.paths.leases, `${lease.owner}.json`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await syncDirectory(lease.paths.leases);
  }
}

function activeLease(dataDir) {
  const root = path.resolve(dataDir);
  const context = leasesContext.getStore();
  return context?.root === root ? context : null;
}

export async function withArchiveWriteLease(dataDir, task) {
  if (typeof task !== "function") throw new TypeError("Archive writer task is required");
  const root = path.resolve(dataDir);
  const inherited = activeLease(root);
  if (inherited) return task(inherited);
  await ensureArchiveRecovered(root);
  const lease = await acquireWriter(root);
  const context = { root, lease, background: new Set() };
  try {
    const result = await leasesContext.run(context, () => task(lease));
    return result;
  }
  finally {
    await drainBackground(context);
    await releaseWriter(lease);
  }
}

async function drainBackground(context) {
  while (context.background.size) await Promise.allSettled([...context.background]);
}

/** Keeps an HTTP-originated background continuation inside the admitted writer lifetime. */
export function trackArchivePromise(dataDir, promiseOrFactory) {
  const root = path.resolve(dataDir);
  const context = activeLease(root);
  if (!context) {
    if (typeof promiseOrFactory !== "function") throw new TypeError("Use a promise factory so archive work starts after admission");
    return withArchiveWriteLease(root, () => promiseOrFactory());
  }
  const tracked = Promise.resolve().then(() => typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory);
  context.background.add(tracked);
  tracked.finally(() => context.background.delete(tracked)).catch(() => {});
  return tracked;
}

/**
 * Wraps an API middleware in the archive writer lifetime. The HTTP response
 * can disappear while an async handler is still awaiting a provider; keeping
 * the handler promise in the lease prevents maintenance from swapping files
 * underneath that continuation.
 */
export function createArchiveRequestHandler(dataDir, handler) {
  if (typeof handler !== "function") throw new TypeError("Archive request handler is required");
  return function archiveRequestHandler(req, res, next) {
    const url = new URL(req.url || "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return handler(req, res, next);
    return trackArchivePromise(dataDir, async () => {
      try { return await handler(req, res, next); }
      catch (error) { return next(error); }
    });
  };
}

export function createArchiveAdmissionMiddleware(dataDir) {
  const root = path.resolve(dataDir);
  return function archiveAdmission(req, res, next) {
    const url = new URL(req.url || "/", "http://localhost");
    if (!url.pathname.startsWith("/api/") || url.pathname === "/api/google-drive/status" || url.pathname.startsWith("/api/google-drive/")) return next();
    void withArchiveWriteLease(root, () => new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      res.once?.("finish", finish);
      res.once?.("close", finish);
      try { next(); } catch (error) { finish(); throw error; }
    })).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      const status = error instanceof ArchiveMaintenanceError ? error.status : 500;
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ error: { code: error.code || "archive_unavailable", message: status === 503 ? "L’archivio è in manutenzione. Riprova tra poco." : "L’archivio non è disponibile in modo sicuro.", retryable: status === 503 } }));
    });
  };
}

export async function withArchiveMaintenance(dataDir, task, { recovery = false, waitMs = Infinity } = {}) {
  if (typeof task !== "function") throw new TypeError("Archive maintenance task is required");
  const root = path.resolve(dataDir);
  const inherited = activeLease(root);
  if (inherited) throw new ArchiveMaintenanceError("archive_maintenance");
  if (!recovery) await ensureArchiveRecovered(root);
  const paths = await ensureControlDirectory(root);
  const releaseGate = await acquireGate(paths);
  let owner = null;
  try {
    if (await assertMaintenance(paths, { reapDead: recovery })) {
      throw new ArchiveMaintenanceError();
    }
    owner = randomUUID();
    await writeExclusiveJson(paths.maintenance, { kind: "maintenance", pid: process.pid, owner, createdAt: Date.now(), recovery });
  } finally { await releaseGate(); }
  try {
    const started = Date.now();
    while (true) {
      const names = await readdir(paths.leases);
      let waiting = 0;
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.json$/i.test(name)) throw new ArchiveMaintenanceError("archive_control_invalid");
        const file = path.join(paths.leases, name);
        const lease = await readRecord(file, "writer");
        if (!lease) continue;
        if (!processAlive(lease.pid)) {
          const latest = await readRecord(file, "writer");
          if (latest?.owner === lease.owner && !processAlive(latest.pid)) await unlink(file).catch(() => {});
        } else waiting += 1;
      }
      if (!waiting) break;
      if (Number.isFinite(waitMs) && Date.now() - started >= waitMs) throw new ArchiveMaintenanceError();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return await task({ owner, dataDir: root });
  } finally {
    const release = await acquireGate(paths);
    try {
      const current = await readRecord(paths.maintenance, "maintenance");
      if (current?.owner === owner && current.pid === process.pid) await unlink(paths.maintenance).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await syncDirectory(paths.directory);
    } finally { await release(); }
  }
}

export function setArchiveRecovery(dataDir, recovery) {
  if (typeof recovery !== "function") throw new TypeError("Archive recovery callback is required");
  recoveryByRoot.set(path.resolve(dataDir), recovery);
}

export async function ensureArchiveRecovered(dataDir) {
  const root = path.resolve(dataDir);
  if (recoveryPending.has(root)) return recoveryPending.get(root);
  const task = (async () => {
    let recovery = recoveryByRoot.get(root);
    if (!recovery) {
      const module = await import("./archive-restore.mjs");
      recovery = () => module.recoverArchiveRestore({ dataDir: root });
      recoveryByRoot.set(root, recovery);
    }
    const result = await recovery();
    const paths = await ensureControlDirectory(root);
    const release = await acquireGate(paths);
    try {
      const stale = await readRecord(paths.maintenance, "maintenance");
      if (stale && !processAlive(stale.pid)) {
        const latest = await readRecord(paths.maintenance, "maintenance");
        if (latest?.owner === stale.owner && latest.pid === stale.pid && !processAlive(latest.pid)) {
          await unlink(paths.maintenance).catch((error) => { if (error.code !== "ENOENT") throw error; });
        }
      }
    } finally { await release(); }
    return result;
  })();
  recoveryPending.set(root, task);
  try { return await task; }
  finally { if (recoveryPending.get(root) === task) recoveryPending.delete(root); }
}

export function archiveMaintenanceStatus(dataDir) {
  const paths = controlPaths(dataDir);
  return readRecord(paths.maintenance, "maintenance").then((maintenance) => ({ active: Boolean(maintenance) }))
    .catch((error) => ({ active: true, error: error.code || "archive_control_invalid" }));
}
