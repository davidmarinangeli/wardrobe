#!/usr/bin/env node

import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareArchiveDirectory, preserveOriginal } from "./archive-store.mjs";
import { withArchiveWriteLease } from "./archive-coordinator.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".gif", ".avif", ".bmp", ".heic", ".heif"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "data", "dist"]);
const ARCHIVE_SETTINGS = new Set(["WARDROBE_DATA_DIR", "WARDROBE_MODEL_REFERENCE", "WARDROBE_FACE_REFERENCE"]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: node scripts/capture-import-sources.mjs --input <folder-or-image> --output <manifest.json> [--repo <wardrobe-root>]");
      process.exit(0);
    }
    if (!["--input", "--output", "--repo"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.input || !options.output) throw new Error("Both --input and --output are required");
  return options;
}

async function findImages(inputRoot) {
  const inputInfo = await lstat(inputRoot);
  if (inputInfo.isSymbolicLink()) throw new Error("Source input must not be a symbolic link");
  if (inputInfo.isFile()) {
    if (!IMAGE_EXTENSIONS.has(path.extname(inputRoot).toLowerCase())) throw new Error("Source file has an unsupported image extension");
    return [inputRoot];
  }
  const found = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolute);
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(absolute);
      }
    }
  }
  await walk(inputRoot);
  return found;
}

async function readArchiveSettings(root, env) {
  const settings = Object.fromEntries([...ARCHIVE_SETTINGS].map((name) => [name, env[name] || ""]));
  let envText = "";
  try { envText = await readFile(path.join(root, ".env"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*(WARDROBE_DATA_DIR|WARDROBE_MODEL_REFERENCE|WARDROBE_FACE_REFERENCE)\s*=\s*(.*?)\s*$/);
    if (!match || settings[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    settings[match[1]] = value;
  }
  return settings;
}

async function archiveGeneration(dataDir) {
  let generation = 0;
  for (const name of ["archive-metadata.json", "browser-state.json"]) {
    try {
      const value = JSON.parse(await readFile(path.join(dataDir, name), "utf8"));
      if (Number.isSafeInteger(value?.archiveGeneration) && value.archiveGeneration > generation) generation = value.archiveGeneration;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
  return generation;
}

async function captureImportSourcesInsideLease({ inputDir, outputFile, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), env = process.env }) {
  const inputRoot = path.resolve(inputDir);
  const inputInfo = await lstat(inputRoot);
  if (inputInfo.isSymbolicLink() || (!inputInfo.isDirectory() && !inputInfo.isFile())) throw new Error("Source input must be a real directory or image file");
  const settings = await readArchiveSettings(root, env);
  const dataDir = path.resolve(root, settings.WARDROBE_DATA_DIR || "data");
  const setting = (name, fallback = "") => settings[name] || fallback;
  await prepareArchiveDirectory({ root, dataDir, setting });
  const provenanceGeneration = await archiveGeneration(dataDir);
  const files = await findImages(inputRoot);
  if (!files.length) throw new Error("No supported image files found in the source folder");

  const sources = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const source = await preserveOriginal({ dataDir, bytes, filename: path.basename(file) });
    sources.push({
      sourceRef: inputInfo.isDirectory() ? path.relative(inputRoot, file).split(path.sep).join("/") : path.basename(file),
      path: source.path,
      size: source.size,
      sha256: source.sha256,
      mime: source.mime,
      filename: source.filename,
    });
  }
  const manifest = { version: 1, provenanceGeneration, sources };
  const output = path.resolve(outputFile);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  return { output, count: sources.length, sources };
}

export async function captureImportSources(options) {
  const root = path.resolve(options?.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const env = options?.env || process.env;
  const settings = await readArchiveSettings(root, env);
  const dataDir = path.resolve(root, settings.WARDROBE_DATA_DIR || "data");
  return withArchiveWriteLease(dataDir, () => captureImportSourcesInsideLease({ ...options, root, env }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await captureImportSources({ inputDir: args.input, outputFile: args.output, root: args.repo || process.cwd() });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
