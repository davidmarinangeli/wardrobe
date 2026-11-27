#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareArchiveDirectory } from "./archive-store.mjs";
import { withArchiveWriteLease } from "./archive-coordinator.mjs";

async function readSettings(root) {
  const settings = { WARDROBE_DATA_DIR: process.env.WARDROBE_DATA_DIR || "" };
  let source = "";
  try { source = await readFile(path.join(root, ".env"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*WARDROBE_DATA_DIR\s*=\s*(.*?)\s*$/);
    if (!match || settings.WARDROBE_DATA_DIR) continue;
    let value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    settings.WARDROBE_DATA_DIR = value;
  }
  return settings;
}

async function readGeneration(dataDir) {
  let generation = 0;
  for (const name of ["archive-metadata.json", "browser-state.json"]) {
    try {
      const value = JSON.parse(await readFile(path.join(dataDir, name), "utf8"));
      if (Number.isSafeInteger(value?.archiveGeneration) && value.archiveGeneration > generation) generation = value.archiveGeneration;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
  return generation;
}

export async function captureArchiveGeneration({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), env = process.env } = {}) {
  root = path.resolve(root);
  const settings = await readSettings(root);
  const dataDir = path.resolve(root, env.WARDROBE_DATA_DIR || settings.WARDROBE_DATA_DIR || "data");
  return withArchiveWriteLease(dataDir, async () => {
    const setting = (name, fallback = "") => name === "WARDROBE_DATA_DIR" ? settings.WARDROBE_DATA_DIR || fallback : env[name] || fallback;
    await prepareArchiveDirectory({ root, dataDir, setting });
    return { provenanceGeneration: await readGeneration(dataDir) };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await captureArchiveGeneration({ root: process.cwd() })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
