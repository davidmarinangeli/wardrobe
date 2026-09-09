// One-off backfill: most wardrobe records predate `createdAt` being written at
// import, so "how long have I owned this?" is unanswerable for them — and every
// declutter rule that refuses to judge an item of unknown age (see
// deriveDeclutter in scripts/preferences.mjs) stays silent about the whole
// wardrobe until this has run.
//
// The stand-in is the garment cutout's own timestamp on disk. That file is
// written once, by the import that created the record, so it dates the import
// accurately. It does NOT date the purchase: a coat bought in 2019 and imported
// last month backfills to last month. Every string built from this field must
// therefore say "in your wardrobe since", never "bought" — the app can only
// honestly claim to have known about the piece since it was imported.
//
// Reports by default and writes a review file. It never rewrites the wardrobe
// unless you pass --apply, and --apply only replays the review file you have
// already read.
//
//   node scripts/backfill-item-dates.mjs            # report + write review file
//   node scripts/backfill-item-dates.mjs --apply    # apply that review file

import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson } from "./import-job-api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.resolve(ROOT, process.env.WARDROBE_DATA_DIR || "data");
const LIBRARY = path.join(DATA_DIR, "library.json");
const REVIEW_FILE = path.join(DATA_DIR, "backfill-item-dates.review.json");

/**
 * Earliest trustworthy timestamp on the cutout. birthtime is the right answer
 * where the filesystem keeps one (APFS does), but it is 0 or garbage on some,
 * and a file copied between volumes can carry a birthtime later than its mtime.
 * Taking the smaller of the two valid ones is wrong in no case that matters.
 */
async function importedAt(id) {
  const file = path.join(DATA_DIR, "imported", `${id}-garment.png`);
  let stats;
  try { stats = await stat(file); } catch { return null; }

  const times = [stats.birthtimeMs, stats.mtimeMs].filter((ms) => Number.isFinite(ms) && ms > 0);
  if (!times.length) return null;
  return new Date(Math.min(...times)).toISOString();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const items = JSON.parse(await readFile(LIBRARY, "utf8"));

  if (apply) {
    let review;
    try { review = JSON.parse(await readFile(REVIEW_FILE, "utf8")); }
    catch { console.error(`No review file at ${REVIEW_FILE}. Run without --apply first.`); process.exit(1); }

    const dates = new Map(review.changes.map((change) => [change.id, change.createdAt]));
    let written = 0;
    const next = items.map((item) => {
      // Re-checked rather than trusted: the review file may be stale, and an
      // item that has since acquired a real createdAt must keep it.
      if (item.createdAt || !dates.has(item.id)) return item;
      written += 1;
      return { ...item, createdAt: dates.get(item.id) };
    });

    await atomicJson(LIBRARY, next);
    console.log(`Applied ${written} createdAt value${written === 1 ? "" : "s"} to ${path.relative(ROOT, LIBRARY)}.`);
    return;
  }

  const changes = [];
  const unresolved = [];
  for (const item of items) {
    if (item.createdAt || item.addedAt) continue;
    const createdAt = await importedAt(item.id);
    if (!createdAt) { unresolved.push(item); continue; }
    changes.push({ id: item.id, name: item.name, createdAt });
  }

  changes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const already = items.filter((item) => item.createdAt || item.addedAt).length;
  console.log(`${items.length} items — ${already} already dated, ${changes.length} datable from disk, ${unresolved.length} with no cutout on disk.\n`);
  for (const change of changes) console.log(`  ${change.createdAt.slice(0, 10)}  ${change.name}`);
  if (unresolved.length) {
    console.log(`\nNo cutout found for these; they keep an unknown age and stay out of every age-based rule:`);
    for (const item of unresolved) console.log(`  ${item.id}  ${item.name}`);
  }

  await writeFile(REVIEW_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), changes }, null, 2)}\n`);
  console.log(`\nReview written to ${path.relative(ROOT, REVIEW_FILE)}. Re-run with --apply to write them.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
