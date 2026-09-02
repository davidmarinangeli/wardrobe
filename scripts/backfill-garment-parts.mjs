// One-off backfill: finds wardrobe/wishlist/inspo records that predate the
// dress/skirt/jumpsuit/bodysuit/shorts categories and are therefore filed under
// `upperbody` or `lowerbody` because detection had no better option.
//
// Reports by default and writes a review file. It never rewrites the wardrobe
// unless you pass --apply, and --apply only replays the review file you have
// already read.
//
//   node scripts/backfill-garment-parts.mjs            # report + write review file
//   node scripts/backfill-garment-parts.mjs --apply    # apply that review file
//
// The matcher is deliberately conservative. Names and tags in a real library are
// full of traps — "short sleeve" is not `shorts`, a "dress shirt" is not a
// `dress` — so every rule is word-boundary anchored and carries explicit
// negative guards. A miss is cheap (the item keeps its current, already-wrong
// part); a false positive silently refiles a garment the user classified
// correctly, so the rules err toward missing.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GARMENT_PART_ID_SET } from "../shared/garments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_FILE = path.join(ROOT, "data", "backfill-garment-parts.review.json");

// Only records sitting in one of these are candidates — anything already filed
// as shoes/socks/accessories/jacket was not a victim of the missing categories.
const REFILEABLE_FROM = new Set(["upperbody", "lowerbody"]);

// Each rule: the part to propose, the evidence that proposes it, and the
// look-alikes that must veto it. `negative` is checked against the whole
// haystack first, so "light blue dress shirt slim" never reaches the dress rule.
const RULES = [
  {
    part: "dress",
    positive: [/\bdress(es)?\b/, /\b(sun|shirt|sweater|slip|wrap|tank|midi|maxi|mini)dress(es)?\b/],
    // "dress shirt", "dress pants", "dress shoes" are menswear staples, and
    // "dressy"/"dressed" are adjectives — none of them are dresses.
    negative: [/\bdress(ed|y)\b/, /\bdress\s*-?\s*(shirt|pant|trouser|short|sock|shoe|boot|code|down|up)/],
  },
  {
    part: "skirt",
    // A skort reads as a skirt (shared/garments.mjs states the same rule to the
    // vision model), so it lands here rather than under shorts.
    positive: [/\bskirts?\b/, /\bskorts?\b/],
    negative: [/\bskirting\b/],
  },
  {
    part: "jumpsuit",
    // Rompers, playsuits, boilersuits and dungarees are all one-piece garments;
    // the vocabulary expresses them all as `jumpsuit`.
    positive: [/\bjump\s*-?\s*suits?\b/, /\brompers?\b/, /\bplay\s*-?\s*suits?\b/, /\bboiler\s*-?\s*suits?\b/, /\bdungarees\b/, /\boveralls\b/],
    negative: [],
  },
  {
    part: "bodysuit",
    positive: [/\bbody\s*-?\s*suits?\b/, /\bleotards?\b/, /\bunitards?\b/],
    negative: [],
  },
  {
    part: "shorts",
    // Plural, word-anchored: "short sleeve" / "short-sleeve" / "shorter" all
    // contain "short" but never "shorts", which is what makes this safe.
    positive: [/\bshorts\b/, /\bbermudas?\b/],
    negative: [/\bshorts?\s*-?\s*(sleeve|sleeved)\b/],
  },
];

/** Everything a record says about itself, lowercased into one searchable string. */
export function haystack(record) {
  return [record?.name, ...(Array.isArray(record?.tags) ? record.tags : [])]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Proposes a new part for one record, or null to leave it alone.
 * @returns {{part: string, matched: string} | null}
 */
export function proposePart(record, currentPart) {
  if (!REFILEABLE_FROM.has(currentPart)) return null;
  const text = haystack(record);
  if (!text) return null;

  for (const rule of RULES) {
    if (rule.negative.some((pattern) => pattern.test(text))) continue;
    const hit = rule.positive.find((pattern) => pattern.test(text));
    if (!hit) continue;
    if (rule.part === currentPart) return null;
    if (!GARMENT_PART_ID_SET.has(rule.part)) continue;
    return { part: rule.part, matched: text.match(hit)[0] };
  }
  return null;
}

// library.json and wishlist.json store the category on `part`; inspo pins store
// theirs on `category`. Everything else about the scan is identical.
const SOURCES = [
  { file: "library.json", field: "part", label: "wardrobe" },
  { file: "wishlist.json", field: "part", label: "wishlist" },
  { file: "inspo.json", field: "category", label: "inspo" },
];

async function readJsonArray(dataDir, file) {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, file), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export const DATA_DIR = path.join(ROOT, "data");

export async function scan(dataDir = DATA_DIR) {
  const results = [];
  for (const source of SOURCES) {
    const records = await readJsonArray(dataDir, source.file);
    if (records === null) {
      results.push({ ...source, missing: true, scanned: 0, candidates: [] });
      continue;
    }
    const candidates = [];
    for (const record of records) {
      const currentPart = record?.[source.field];
      const proposal = proposePart(record, currentPart);
      if (!proposal) continue;
      candidates.push({
        id: record.id,
        name: record.name || "",
        tags: record.tags || [],
        image: record.image || null,
        field: source.field,
        from: currentPart,
        to: proposal.part,
        matched: proposal.matched,
      });
    }
    results.push({ ...source, missing: false, scanned: records.length, candidates });
  }
  return results;
}

async function report() {
  const results = await scan();
  const total = results.reduce((sum, result) => sum + result.candidates.length, 0);

  for (const result of results) {
    if (result.missing) {
      console.log(`${result.label.padEnd(9)} ${result.file} — not found, skipped`);
      continue;
    }
    console.log(`${result.label.padEnd(9)} ${String(result.scanned).padStart(3)} records, ${result.candidates.length} would change part`);
    for (const candidate of result.candidates) {
      console.log(`            ${candidate.from} -> ${candidate.to}  ${JSON.stringify(candidate.name)}  (matched "${candidate.matched}")`);
    }
  }

  console.log(`\n${total} item${total === 1 ? "" : "s"} would change part. Nothing has been modified.`);

  await writeFile(REVIEW_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), total, results }, null, 2)}\n`, "utf8");
  console.log(`Review file: ${path.relative(ROOT, REVIEW_FILE)}`);
  if (total) console.log("Check it, delete any row you disagree with, then re-run with --apply.");
}

async function apply() {
  let review;
  try {
    review = JSON.parse(await readFile(REVIEW_FILE, "utf8"));
  } catch {
    console.error(`No review file at ${path.relative(ROOT, REVIEW_FILE)} — run without --apply first, and read it.`);
    process.exitCode = 1;
    return;
  }

  let changed = 0;
  for (const result of review.results || []) {
    if (!result.candidates?.length) continue;
    const filePath = path.join(ROOT, "data", result.file);
    const records = JSON.parse(await readFile(filePath, "utf8"));
    const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));

    let applied = 0;
    const updated = records.map((record) => {
      const candidate = byId.get(record?.id);
      // Only refile a record still sitting where the review said it was, so a
      // stale review file can never clobber a part edited since the scan.
      if (!candidate || record[candidate.field] !== candidate.from) return record;
      applied += 1;
      return { ...record, [candidate.field]: candidate.to, updatedAt: new Date().toISOString() };
    });
    changed += applied;

    await writeFile(`${filePath}.bak`, JSON.stringify(records, null, 2), "utf8");
    await writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    console.log(`${result.file}: ${result.candidates.length} proposed, ${applied} applied (backup at ${result.file}.bak)`);
  }
  console.log(`\n${changed} item${changed === 1 ? "" : "s"} refiled.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = process.argv.includes("--apply") ? apply : report;
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
