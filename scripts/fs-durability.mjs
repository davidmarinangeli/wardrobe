import { open, readFile, rename } from "node:fs/promises";
import path from "node:path";

// Windows cannot fsync a directory handle (FlushFileBuffers on a directory
// fails with EPERM); NTFS journals the rename and create metadata itself, so
// there is nothing further to flush. Every other platform keeps the strict
// behaviour and surfaces the error.
const UNSUPPORTED_ON_WINDOWS = new Set(["EPERM", "EISDIR", "EINVAL", "EBADF"]);

function ignorable(error) {
  return process.platform === "win32" && UNSUPPORTED_ON_WINDOWS.has(error?.code);
}

/** Flushes a directory entry table after a create or rename (a no-op where the OS cannot). */
export async function fsyncDirectory(directory) {
  let handle;
  try { handle = await open(directory, "r"); }
  catch (error) { if (ignorable(error)) return; throw error; }
  try { await handle.sync(); }
  catch (error) { if (!ignorable(error)) throw error; }
  finally { await handle.close(); }
}

// On Windows a rename over a file fails while any handle is open on it, even
// a read-only handle that allows deletion and even one held by Wardrobe
// itself (a request reading the catalog, the Drive snapshot stream). libuv
// reports that sharing violation as EPERM for a rename and EBUSY for an open;
// EACCES covers a file an antivirus or indexer holds for a moment. The holder
// almost always lets go within milliseconds, so the operation is retried for
// about two seconds before the catalog is reported as busy.
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
export const BUSY_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 120, 160, 200, 250, 300, 350, 400]);

/** A catalog another handle holds open: retryable, never a sign of damage. */
export class CatalogBusyError extends Error {
  constructor(file, { cause } = {}) {
    const name = path.basename(String(file || "The catalog"));
    super(`${name} is in use; try again in a moment.`, cause ? { cause } : undefined);
    this.name = "CatalogBusyError";
    this.code = "catalog_busy";
    this.status = 503;
    this.retryable = true;
    this.file = file || null;
  }
}

export function isCatalogBusy(error) {
  return error?.code === "catalog_busy";
}

/** True for an error that means "another handle has this file open" on `platform`. */
export function isSharingViolation(error, platform = process.platform) {
  return platform === "win32" && BUSY_CODES.has(error?.code);
}

async function withBusyRetry(file, operation, { platform = process.platform, delays = BUSY_RETRY_DELAYS_MS, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (!isSharingViolation(error, platform)) throw error;
      if (attempt >= delays.length) throw new CatalogBusyError(file, { cause: error });
      await sleep(delays[attempt]);
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * rename(from, to) that rides out a transient sharing violation on Windows and
 * then fails with a `catalog_busy` (503) error naming `to`. Every other
 * platform, and every other error, is rethrown at once and unchanged.
 */
export function renameWithRetry(from, to, { platform = process.platform, renameImpl = rename, delays, sleep } = {}) {
  return withBusyRetry(to, () => renameImpl(from, to), { platform, delays, sleep });
}

/** readFile with the same Windows sharing-violation retry and `catalog_busy` error. */
export function readFileWithRetry(file, encoding, { platform = process.platform, readFileImpl = readFile, delays, sleep } = {}) {
  return withBusyRetry(file, () => readFileImpl(file, encoding), { platform, delays, sleep });
}
