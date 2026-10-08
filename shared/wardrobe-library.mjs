import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const queues = new Map();
const LOCK_STALE_AFTER_MS = 3 * 60_000;

async function readLibrary(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(value)) throw new Error("Wardrobe library must be a JSON array");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireFileLock(lockDir, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let delay = 12;
  while (true) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting to update the wardrobe library");
    try {
      await mkdir(lockDir);
      await atomicWrite(path.join(lockDir, "owner.json"), { pid: process.pid, createdAt: Date.now() });
      return async () => rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }

    try {
      const observedStat = await stat(lockDir);
      if (await isStaleLock(lockDir, observedStat)) {
        await recoverStaleLock(lockDir, observedStat);
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        // The lock or its owner marker can disappear during acquisition.
      } else {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(120, Math.round(delay * 1.4));
  }
}

async function isStaleLock(lockDir, observedStat) {
  let owner;
  try {
    owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return Date.now() - observedStat.mtimeMs >= LOCK_STALE_AFTER_MS;
  }
  if (!owner || typeof owner !== "object" || Array.isArray(owner)
    || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return Date.now() - observedStat.mtimeMs >= LOCK_STALE_AFTER_MS;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

async function claimRecovery(lockDir) {
  const recoveryDir = path.join(lockDir, ".recovery");
  try {
    await mkdir(recoveryDir);
  } catch (error) {
    if (error.code !== "EEXIST") return null;
    await recoverAbandonedRecovery(recoveryDir);
    return null;
  }

  const token = randomUUID();
  const claimStat = await stat(recoveryDir);
  try {
    await atomicWrite(path.join(recoveryDir, "owner.json"), { pid: process.pid, token, createdAt: Date.now() });
  } catch (error) {
    await releaseRecoveryClaim(recoveryDir, claimStat, token);
    throw error;
  }
  return { recoveryDir, claimStat, token };
}

async function recoverAbandonedRecovery(recoveryDir) {
  let observedStat;
  try { observedStat = await stat(recoveryDir); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }

  let owner;
  try { owner = JSON.parse(await readFile(path.join(recoveryDir, "owner.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  let stale = false;
  if (owner && typeof owner === "object" && !Array.isArray(owner)
    && Number.isInteger(owner.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); }
    catch (error) { stale = error.code === "ESRCH"; }
  } else {
    stale = Date.now() - observedStat.mtimeMs >= LOCK_STALE_AFTER_MS;
  }
  if (!stale) return false;

  const quarantineDir = `${recoveryDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(recoveryDir, quarantineDir);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const movedStat = await stat(quarantineDir);
    if (movedStat.dev !== observedStat.dev || movedStat.ino !== observedStat.ino) {
      await rename(quarantineDir, recoveryDir).catch(() => {});
      return false;
    }
    await rm(quarantineDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function releaseRecoveryClaim(recoveryDir, claimStat, token) {
  try {
    const currentStat = await stat(recoveryDir);
    if (currentStat.dev !== claimStat.dev || currentStat.ino !== claimStat.ino) return;
    const owner = JSON.parse(await readFile(path.join(recoveryDir, "owner.json"), "utf8"));
    if (owner.token === token) await rm(recoveryDir, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

async function recoverStaleLock(lockDir, observedStat) {
  // One contender claims recovery inside the exact directory it inspected.
  // Others wait, so an old observation cannot remove the winner's new lock.
  const claim = await claimRecovery(lockDir);
  if (!claim) return false;
  const quarantineDir = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    const currentStat = await stat(lockDir);
    if (currentStat.dev !== observedStat.dev || currentStat.ino !== observedStat.ino) return false;
    const claimStat = await stat(claim.recoveryDir);
    if (claimStat.dev !== claim.claimStat.dev || claimStat.ino !== claim.claimStat.ino) return false;
    // Creating .recovery updates the directory mtime. Keep the original age,
    // while rereading owner.json so a live process is never evicted.
    if (!(await isStaleLock(lockDir, observedStat))) return false;
    // The recovery claim may itself have been retired while we rechecked the
    // stale lock; verify ownership once more immediately before the rename.
    const finalClaimStat = await stat(claim.recoveryDir);
    if (finalClaimStat.dev !== claim.claimStat.dev || finalClaimStat.ino !== claim.claimStat.ino) return false;
    await rename(lockDir, quarantineDir);
    await rm(quarantineDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    await releaseRecoveryClaim(claim.recoveryDir, claim.claimStat, claim.token).catch(() => {});
  }
}

function serializeInProcess(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(key, tail);
  return result.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
}

/**
 * Serialize a short, synchronous read/modify/write mutation of library.json.
 * The in-process queue avoids polling between API calls; the lock directory
 * also coordinates the app with CLI importers running in another process.
 */
export function mutateLibrary(dataDir, mutation) {
  const file = path.join(dataDir, "library.json");
  return serializeInProcess(file, async () => {
    const release = await acquireFileLock(`${file}.lock`);
    try {
      const current = await readLibrary(file);
      const next = await mutation(current);
      if (!Array.isArray(next)) throw new TypeError("Library mutation must return an array");
      await atomicWrite(file, next);
      return next;
    } finally {
      await release();
    }
  });
}
