#!/usr/bin/env node
// Renders what the Mirror actually says, across the whole space at once.
//
// The test suite answers "is any of this wrong". It cannot answer the question
// that matters just as much for this feature — does it READ well? Tone, whether
// the same phrasing turns up on every third outfit, whether a critique lands as
// help or as a verdict: those are things you have to see side by side, and no
// assertion is going to catch them.
//
//   node scripts/mirror-bench.mjs                  every scenario, offline
//   node scripts/mirror-bench.mjs --live           ...with the real judge writing the prose
//   node scripts/mirror-bench.mjs --photos <dir>   real images, full pipeline
//   node scripts/mirror-bench.mjs --html out.html  write a gallery instead of a table
//
// Offline mode simulates a judge that is exactly right: it reports every rule
// whose evidence genuinely holds, and borrows the catalogue's own wording. That
// shows the engine's shape and its remedies honestly, but its prose is blunter
// than a real judge's — use --live when you are reviewing copy.

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMirrorCritique, verifyEvidence } from "./style-rules.mjs";
import { MIRROR_RULE_IDS, MIRROR_RULE_MAP, rulesForRegister } from "../shared/style-catalogue.mjs";
import { SCENARIOS, DEGENERATE } from "../test/scenarios.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };

const wardrobe = JSON.parse(await readFile(path.join(ROOT, "data/library.json"), "utf8"));
const itemById = Object.fromEntries(wardrobe.map((item) => [item.id, item]));

/** Reads .env the same way the dev server does, without pulling in vite. */
async function env() {
  const text = await readFile(path.join(ROOT, ".env"), "utf8").catch(() => "");
  return Object.fromEntries(text.split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]));
}

// A judge that is exactly right: every rule in play whose evidence holds, and
// nothing else. The ceiling and the ranking still apply downstream, so this
// shows the most the engine would ever say about an outfit.
function perfectJudgment(perception) {
  const outfit = perception.garments || [];
  return {
    findings: rulesForRegister(perception.register)
      .filter((rule) => verifyEvidence(rule.id, outfit, outfit))
      .map((rule) => ({
        ruleId: rule.id,
        garmentIndices: outfit.map((_, index) => index),
        confidence: "high",
        summary: rule.what.split(".")[0] + ".",
      })),
    works: [],
  };
}

async function liveJudgment(perception, key, model) {
  const { geminiJudgeOutfit } = await import("./mirror-judge.mjs");
  try { return await geminiJudgeOutfit({ key, model, perception }); }
  catch (error) { return { findings: [], works: [], error: error.message }; }
}

/** Perception straight off a photo, for --photos. */
async function perceivePhoto(file, key, model) {
  const { geminiPerceiveOutfit, normalizeImage } = await import("./import-job-api.mjs");
  const image = await normalizeImage(await readFile(file));
  return geminiPerceiveOutfit({ key, model, image, mime: "image/png" });
}

// ---------------------------------------------------------------------------
// Collecting the runs
// ---------------------------------------------------------------------------

async function collect() {
  const live = flag("--live");
  const photoDir = value("--photos");
  const settings = live || photoDir ? await env() : {};
  const key = settings.GEMINI_API_KEY_TEST || settings.GEMINI_API_KEY;
  const model = settings.GEMINI_VISION_MODEL || "gemini-3.6-flash";
  if ((live || photoDir) && !key) throw new Error("No Gemini key in .env — drop --live/--photos to run offline.");

  if (photoDir) {
    const dir = path.resolve(process.cwd(), photoDir);
    const files = (await readdir(dir)).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).sort();
    if (!files.length) throw new Error(`No images in ${dir}`);
    const runs = [];
    for (const file of files) {
      process.stderr.write(`  reading ${file}…\n`);
      const perception = await perceivePhoto(path.join(dir, file), key, model);
      const judgment = await liveJudgment(perception, key, model);
      runs.push({ name: file, group: "photo", perception, judgment, critique: buildMirrorCritique(perception, judgment, wardrobe) });
    }
    return runs;
  }

  const cases = [
    ...SCENARIOS.map((scenario) => ({ ...scenario, group: scenario.rule || "shape" })),
    ...DEGENERATE.map((shape) => ({ ...shape, group: "edge case" })),
  ];
  const runs = [];
  for (const item of cases) {
    if (live) process.stderr.write(`  judging ${item.name}…\n`);
    const judgment = live ? await liveJudgment(item.perception, key, model) : perfectJudgment(item.perception);
    runs.push({ name: item.name, group: item.group, perception: item.perception, judgment, critique: buildMirrorCritique(item.perception, judgment, wardrobe) });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const remedyLine = (remedy) => {
  if (!remedy || remedy.action === "none") return `no swap — ${remedy?.guidance || "nothing in the wardrobe answers it"}`;
  if (remedy.action === "remove") return `take off the ${remedy.target} — ${remedy.reason}`;
  const item = itemById[remedy.itemId];
  return `${remedy.action} with ${item ? item.name : remedy.itemId} — ${remedy.reason}`;
};

function printReport(runs) {
  let lastGroup = null;
  const counts = {};
  for (const run of runs) {
    if (run.group !== lastGroup) { console.log(`\n\x1b[2m── ${run.group} ${"─".repeat(Math.max(0, 60 - run.group.length))}\x1b[0m`); lastGroup = run.group; }
    const { critique } = run;
    const dot = critique.verdict === "clean" ? "\x1b[32m●\x1b[0m" : critique.verdict === "minor" ? "\x1b[33m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    console.log(`\n${dot} \x1b[1m${run.name}\x1b[0m \x1b[2m(${critique.register}/${critique.photoQuality})\x1b[0m`);
    console.log(`  ${critique.overall}`);
    for (const work of critique.works) console.log(`  \x1b[32m✓\x1b[0m ${work}`);
    for (const issue of critique.issues) {
      counts[issue.id] = (counts[issue.id] || 0) + 1;
      console.log(`  \x1b[33m!\x1b[0m ${issue.label} — ${issue.summary}`);
      console.log(`    \x1b[2m→ ${remedyLine(issue.remedy)}\x1b[0m`);
    }
    if (run.judgment.error) console.log(`  \x1b[31mjudge failed: ${run.judgment.error}\x1b[0m`);
  }

  // The distribution is the thing worth staring at. One rule accounting for
  // most of the findings means it is either too loose or standing in for a
  // question the catalogue does not ask yet.
  console.log(`\n\x1b[2m── how often each rule reached the user ${"─".repeat(24)}\x1b[0m`);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0) || 1;
  for (const id of MIRROR_RULE_IDS) {
    const n = counts[id] || 0;
    const bar = "█".repeat(Math.round((n / total) * 40));
    console.log(`  ${id.padEnd(16)} ${String(n).padStart(3)}  ${bar}`);
  }
  const silent = runs.filter((run) => !run.critique.issues.length).length;
  console.log(`\n  ${runs.length} outfits · ${total} findings · ${silent} said nothing was wrong\n`);
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function renderHtml(runs) {
  const cards = runs.map((run) => {
    const { critique } = run;
    return `<article class="card" data-verdict="${critique.verdict}">
  <header><h2>${escapeHtml(run.name)}</h2><p class="meta">${escapeHtml(critique.register)} · ${escapeHtml(critique.photoQuality)} · ${escapeHtml(critique.verdict)}</p></header>
  <p class="overall">${escapeHtml(critique.overall)}</p>
  <ul class="garments">${(run.perception.garments || []).map((g) => `<li><span class="swatch" style="background:${escapeHtml(g.colorHex || "#bbb")}"></span>${escapeHtml(g.description || g.region)}</li>`).join("")}</ul>
  ${critique.works.length ? `<h3>What's working</h3><ul class="works">${critique.works.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
  ${critique.issues.length ? `<h3>Room to improve</h3>${critique.issues.map((i) => `<div class="issue"><p class="label">${escapeHtml(i.label)}</p><p>${escapeHtml(i.summary)}</p><p class="remedy">${escapeHtml(remedyLine(i.remedy))}</p></div>`).join("")}` : ""}
</article>`;
  }).join("\n");

  return `<title>Mirror bench</title>
<style>
  :root { --ink:#1c1b19; --muted:#6b6862; --line:#e2ded6; --paper:#faf8f4; --raised:#fff; --ok:#3f7d4e; --warn:#a8762a; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ink:#f0ece5; --muted:#9d988f; --line:#33312e; --paper:#171614; --raised:#201f1c; --ok:#7fb389; --warn:#d0a25c; } }
  :root[data-theme="dark"] { --ink:#f0ece5; --muted:#9d988f; --line:#33312e; --paper:#171614; --raised:#201f1c; --ok:#7fb389; --warn:#d0a25c; }
  body { background:var(--paper); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,sans-serif; margin:0; padding:40px 24px 64px; }
  .wrap { max-width:1200px; margin:0 auto; }
  h1 { font-size:28px; letter-spacing:-0.02em; margin:0 0 4px; }
  .lede { color:var(--muted); margin:0 0 32px; max-width:60ch; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); }
  .card { background:var(--raised); border:1px solid var(--line); border-radius:14px; padding:18px; }
  .card[data-verdict="clean"] { border-left:3px solid var(--ok); }
  .card[data-verdict="notable"] { border-left:3px solid var(--warn); }
  h2 { font-size:15px; margin:0; }
  .meta { color:var(--muted); font-size:12px; margin:2px 0 12px; text-transform:lowercase; }
  .overall { margin:0 0 12px; font-size:14px; }
  h3 { font-size:10px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted); margin:16px 0 6px; }
  ul { margin:0; padding-left:18px; font-size:13px; }
  .garments { list-style:none; padding:0; display:flex; flex-wrap:wrap; gap:6px; font-size:11px; color:var(--muted); }
  .garments li { display:flex; align-items:center; gap:4px; border:1px solid var(--line); border-radius:999px; padding:2px 8px; }
  .swatch { width:9px; height:9px; border-radius:50%; border:1px solid rgba(128,128,128,.35); }
  .issue { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; font-size:13px; }
  .issue p { margin:0 0 4px; }
  .label { font-weight:600; }
  .remedy { color:var(--muted); font-size:12px; }
</style>
<div class="wrap">
  <h1>Mirror bench</h1>
  <p class="lede">Every scenario the engine is tested against, rendered as the panel would show it. Read it for tone and repetition — the assertions are in test/mirror-invariants.test.mjs.</p>
  <div class="grid">
${cards}
  </div>
</div>`;
}

const runs = await collect();
const htmlOut = value("--html");
if (htmlOut) {
  const target = path.resolve(process.cwd(), htmlOut);
  await writeFile(target, renderHtml(runs), "utf8");
  console.log(`Wrote ${runs.length} runs to ${target}`);
} else {
  printReport(runs);
}
