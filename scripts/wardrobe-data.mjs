import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrateLibrary, migrateOutfits } from "../shared/wardrobe-model.mjs";

async function readArray(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

async function backupOnce(file) {
  const backup = `${file}.v1-backup.json`;
  try { await readFile(backup); return backup; }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { await copyFile(file, backup); return backup; }
    catch (copyError) { if (copyError.code === "ENOENT") return null; throw copyError; }
  }
}

/**
 * Upgrade both data files as one logical operation. The backups are created
 * before either file changes and never overwritten, making retries idempotent
 * and giving a user a recoverable v1 snapshot.
 */
export async function migrateDataDirectory(dataDir, { backup = true } = {}) {
  await mkdir(dataDir, { recursive: true });
  const libraryFile = path.join(dataDir, "library.json");
  const outfitsFile = path.join(dataDir, "outfits.json");
  const library = await readArray(libraryFile);
  const migratedLibrary = migrateLibrary(library);
  const migratedOutfits = migrateOutfits(await readArray(outfitsFile), migratedLibrary.items);
  const changed = migratedLibrary.changed || migratedOutfits.changed;
  let backups = null;
  if (changed && backup) {
    backups = {
      library: await backupOnce(libraryFile),
      outfits: await backupOnce(outfitsFile),
    };
    if (!backups.library && !backups.outfits) backups = null;
  }
  if (migratedLibrary.changed) await atomicJson(libraryFile, migratedLibrary.items);
  if (migratedOutfits.changed) await atomicJson(outfitsFile, migratedOutfits.outfits);
  return {
    changed,
    libraryChanged: migratedLibrary.changed,
    outfitsChanged: migratedOutfits.changed,
    items: migratedLibrary.items,
    outfits: migratedOutfits.outfits,
    backups,
  };
}
