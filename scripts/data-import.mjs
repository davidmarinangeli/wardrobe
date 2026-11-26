/**
 * `node scripts/server.mjs import-data --from <dir> --to <dataDir> [--replace]`
 *
 * Copies an existing Wardrobe data folder (a repo clone's `data/`, a restored
 * backup) into the data directory the desktop app uses. Only the portable
 * archive is copied: the catalogs, the media roots and the canonical reference
 * photos, through the same inventory, allowlist and validation the Google
 * Drive archive uses. `.env`, `.google-drive/`, `jobs/`, locks, temp files and
 * backups never travel.
 *
 * The copy is staged next to the target and verified before it is renamed into
 * place, so a failed import leaves the target as it was. The server must not
 * be running on `<dataDir>` while this runs.
 *
 * Exit codes: 0 imported (JSON summary on stdout), 1 unexpected failure,
 * 2 usage error or invalid source archive (report on stderr), 3 the target
 * already holds a wardrobe and --replace was not given.
 */
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildArchiveInventory, createArchiveSnapshot, validateArchive } from "./archive-store.mjs";

export const IMPORT_DATA_EXIT = Object.freeze({ ok: 0, failed: 1, invalid: 2, targetPopulated: 3 });

export class DataImportError extends Error {
  constructor(code, message, { exitCode = IMPORT_DATA_EXIT.failed, details = {} } = {}) {
    super(message);
    this.name = "DataImportError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

async function lstatOrNull(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `20261126T153012Z`: sortable and safe in a file name on every platform. */
export function importTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function freeSibling(base) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt ? `${base}-${attempt}` : base;
    if (!(await lstatOrNull(candidate))) return candidate;
  }
  throw new DataImportError("target_busy", `Could not find a free name next to ${base}`);
}

/**
 * Validates the source like an archive snapshot: the inventory must be
 * complete, every inventoried file must match, and every referenced media file
 * must exist. Returns the validation, or throws `archive_invalid`.
 */
export async function validateImportSource(from) {
  const info = await lstatOrNull(from);
  if (!info) throw new DataImportError("source_missing", `Source folder not found: ${from}`, { exitCode: IMPORT_DATA_EXIT.invalid });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new DataImportError("source_invalid", `Source is not a folder: ${from}`, { exitCode: IMPORT_DATA_EXIT.invalid });
  }
  let inventory;
  try { inventory = await buildArchiveInventory(from); }
  catch (error) {
    throw new DataImportError("archive_invalid", `The source is not a valid Wardrobe archive: ${error.message}`, {
      exitCode: IMPORT_DATA_EXIT.invalid,
      details: { errors: [error.message], historicalMissing: [] },
    });
  }
  const validation = await validateArchive(from, inventory);
  const errors = [...validation.errors];
  if (!inventory.files.some((entry) => entry.path === "library.json")) {
    errors.unshift(`No library.json in ${from}: this is not a Wardrobe data folder`);
  }
  if (errors.length) {
    throw new DataImportError("archive_invalid", "The source is not a valid, complete Wardrobe archive", {
      exitCode: IMPORT_DATA_EXIT.invalid,
      details: { errors, historicalMissing: validation.historicalMissing || [] },
    });
  }
  return validation;
}

/**
 * Imports `from` into `to`. Resolves with `{ files, bytes, warnings, to, backup }`.
 *
 * - `to` missing or empty: the staged copy becomes `to`.
 * - `to` holds a `library.json`: refused (`target_populated`) unless `replace`,
 *   which first moves `to` to `<to>.before-import-<timestamp>`.
 * - `to` holds other files but no wardrobe (what a server leaves behind after
 *   one start): moved aside the same way, with a warning, so nothing is lost.
 */
export async function importDataFolder({ from, to, replace = false, now = () => new Date() } = {}) {
  if (!from || !to) throw new DataImportError("usage", "Both --from and --to are required", { exitCode: IMPORT_DATA_EXIT.invalid });
  const source = path.resolve(from);
  const target = path.resolve(to);
  if (samePath(source, target) || isInside(source, target) || isInside(target, source)) {
    throw new DataImportError("usage", "--from and --to must be separate folders, neither inside the other", { exitCode: IMPORT_DATA_EXIT.invalid });
  }

  const validation = await validateImportSource(source);

  const targetInfo = await lstatOrNull(target);
  if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isDirectory())) {
    throw new DataImportError("target_invalid", `Target is not a folder: ${target}`);
  }
  const targetEntries = targetInfo ? await readdir(target) : [];
  const populated = targetEntries.includes("library.json");
  if (populated && !replace) {
    throw new DataImportError("target_populated", `${target} already contains a wardrobe (library.json). Pass --replace to move it aside and import over it.`, {
      exitCode: IMPORT_DATA_EXIT.targetPopulated,
    });
  }

  const stamp = importTimestamp(now());
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  // Staged next to the target, on the same volume, so placing it is a rename.
  const stagingRoot = await freeSibling(path.join(parent, `.${path.basename(target)}.import-${stamp}`));
  const warnings = validation.historicalMissing.map((name) => `Historical source photo not in the archive (kept as a reference only): ${name}`);
  let backup = null;
  try {
    const snapshot = await createArchiveSnapshot({ sourceDir: source, stagingRoot });
    if (targetEntries.length) {
      backup = await freeSibling(`${target}.before-import-${stamp}`);
      try { await rename(target, backup); }
      catch (error) {
        throw new DataImportError("target_busy", `Could not move ${target} aside (${error.code || error.message}). Stop the Wardrobe server and try again.`);
      }
      if (!populated) warnings.push(`${target} held files but no wardrobe; they were moved to ${backup}`);
    } else if (targetInfo) {
      await rmdir(target);
    }
    try { await rename(snapshot.directory, target); }
    catch (error) {
      if (backup) await rename(backup, target).catch(() => {});
      throw error;
    }
    const bytes = snapshot.inventory.files.reduce((total, entry) => total + entry.size, 0);
    return { files: snapshot.inventory.files.length, bytes, warnings, to: target, backup };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}

export const IMPORT_DATA_HELP = `Usage: node scripts/server.mjs import-data --from <dir> --to <dataDir> [--replace]

Copies a Wardrobe data folder into <dataDir>: catalogs, images and the
reference photos. Never copies .env, .google-drive/, jobs/, locks or backups.
Stop the Wardrobe server that uses <dataDir> first.

  --from <dir>      The data folder to import (for example a clone's data/)
  --to <dataDir>    The data directory to fill
  --replace         If <dataDir> already holds a wardrobe, move it to
                    <dataDir>.before-import-<timestamp> and import anyway
  -h, --help        Show this help

Prints {"files","bytes","warnings","to","backup"} as JSON on stdout.
Exit codes: 0 imported, 1 failed, 2 usage error or invalid source (JSON
report on stderr), 3 <dataDir> already holds a wardrobe (use --replace).
`;

// Resolves once the text is handed to the OS, so the process.exit() that
// follows in server.mjs cannot cut a piped summary short.
function write(stream, text) {
  return new Promise((resolve) => { stream.write(text, () => resolve()); });
}

function errorJson(error) {
  return `${JSON.stringify({ error: { code: error.code || "import_failed", message: error.message || String(error), ...(error.details || {}) } })}\n`;
}

/** CLI entry for `server.mjs import-data`. Resolves with the exit code. */
export async function runImportDataCli(argv, { stdout = process.stdout, stderr = process.stderr, now } = {}) {
  let flags;
  try {
    ({ values: flags } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        replace: { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    await write(stderr, `${error.message}\n\n${IMPORT_DATA_HELP}`);
    return IMPORT_DATA_EXIT.invalid;
  }
  if (flags.help) { await write(stdout, IMPORT_DATA_HELP); return IMPORT_DATA_EXIT.ok; }
  if (!flags.from || !flags.to) {
    await write(stderr, `Both --from and --to are required.\n\n${IMPORT_DATA_HELP}`);
    return IMPORT_DATA_EXIT.invalid;
  }
  try {
    const summary = await importDataFolder({ from: flags.from, to: flags.to, replace: flags.replace, ...(now ? { now } : {}) });
    await write(stdout, `${JSON.stringify(summary)}\n`);
    return IMPORT_DATA_EXIT.ok;
  } catch (error) {
    await write(stderr, errorJson(error));
    return error instanceof DataImportError ? error.exitCode : IMPORT_DATA_EXIT.failed;
  }
}
