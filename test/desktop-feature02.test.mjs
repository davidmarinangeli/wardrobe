// Desktop app Feature 02: managed configuration and data locations.
// Every test runs in temporary directories with mocked AI; nothing here reads
// or writes the real data/, the real .env or the OS keychain.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sharp from "sharp";
import { configureTransformersCache, chooseChromaKey } from "../scripts/import-job-api.mjs";
import { wardrobeSetupApi, parseEnvContent } from "../scripts/setup-api.mjs";
import { importDataFolder, IMPORT_DATA_EXIT, runImportDataCli } from "../scripts/data-import.mjs";
import {
  isManagedConfig, isManagedConfigValue, MANAGED_CONFIG_MESSAGE, resolveCacheDir, resolveDrapesDir, resolveTransformersCacheDir,
} from "../scripts/runtime-config.mjs";
import { PINNED_ENV_KEYS, startServer } from "../scripts/server.mjs";
import { DRAPE_SETS } from "../shared/draping.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.join(repoRoot, "scripts", "server.mjs");
const INDEX_HTML = "<!doctype html><html><head><title>stub</title></head><body><div id=\"root\"></div></body></html>\n";

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AI_PROVIDER|OPENAI_|OPENROUTER_|GEMINI_|MINIMAX_|GOOGLE_DRIVE_|WARDROBE_)/.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// A stand-in for a read-only install: the built frontend and public/, no data/.
async function makeInstallRoot(t) {
  const root = await tempDir(t, "wardrobe-f02-root-");
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), INDEX_HTML);
  await writeFile(path.join(root, "dist", "assets", "app.js"), "console.log('wardrobe');\n");
  await writeFile(path.join(root, "public", "icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "wardrobe", version: "9.9.9" }));
  return root;
}

async function treeSnapshot(dir) {
  const entries = {};
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isDirectory()) { entries[`${relative}/`] = "dir"; await visit(full); }
      else entries[relative] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  };
  await visit(dir);
  return entries;
}

async function start(t, root, options = {}) {
  const server = await startServer({ port: 0, root, log: () => {}, ...options });
  t.after(() => server.close());
  return server;
}

function request(server, pathname, { method = "GET", body, headers = {} } = {}) {
  const host = `localhost:${server.port}`;
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const sameOrigin = method === "GET" || method === "HEAD" ? {} : { origin: `http://${host}`, "content-type": "application/json" };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, path: pathname, method, headers: { host, ...sameOrigin, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buffer.toString("utf8")); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, buffer, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const png = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const dataUrl = (bytes, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// ─── Settings resolvers ────────────────────────────────────────────────────

test("cache directory resolvers: default under root, absolute values kept, drapes and transformers inside", () => {
  const root = path.resolve(os.tmpdir(), "wardrobe-f02-resolve");
  const outside = path.resolve(os.tmpdir(), "elsewhere", "cache");
  const settingFrom = (values) => (name, fallback = "") => values[name] || fallback;
  assert.equal(resolveCacheDir({ root, setting: settingFrom({}) }), path.join(root, ".cache"));
  assert.equal(resolveCacheDir({ root, setting: settingFrom({ WARDROBE_CACHE_DIR: "tmp-cache" }) }), path.join(root, "tmp-cache"));
  assert.equal(resolveCacheDir({ root, setting: settingFrom({ WARDROBE_CACHE_DIR: outside }) }), outside);
  assert.equal(resolveDrapesDir({ root, cacheDir: outside }), path.join(outside, "drapes"));
  assert.equal(resolveDrapesDir({ root, setting: settingFrom({}) }), path.join(root, ".cache", "drapes"));
  assert.equal(resolveTransformersCacheDir({ root, cacheDir: outside }), path.join(outside, "transformers"));

  for (const on of ["1", "true", "TRUE", " true "]) assert.equal(isManagedConfigValue(on), true, on);
  for (const off of [undefined, "", "0", "false", "yes", "managed"]) assert.equal(isManagedConfigValue(off), false, String(off));
  assert.equal(isManagedConfig(settingFrom({ WARDROBE_MANAGED_CONFIG: "1" })), true);
  assert.deepEqual(PINNED_ENV_KEYS.slice().sort(), ["WARDROBE_ALLOWED_HOSTS", "WARDROBE_CACHE_DIR", "WARDROBE_DATA_DIR", "WARDROBE_MANAGED_CONFIG"]);
});

test("the background-removal model cache points at <cacheDir>/transformers", () => {
  const fake = { env: { cacheDir: "./node_modules/@huggingface/transformers/.cache" } };
  const cacheDir = path.resolve(os.tmpdir(), "wardrobe-f02-cache");
  assert.equal(configureTransformersCache(fake, cacheDir), path.join(cacheDir, "transformers"));
  assert.equal(fake.env.cacheDir, path.join(cacheDir, "transformers"));
});

test(".env parsing matches node --env-file", () => {
  assert.deepEqual(parseEnvContent("A=1\n# comment\nB=\"two words\"\nexport C=3\n"), { A: "1", B: "two words", C: "3" });
  assert.deepEqual(parseEnvContent(""), {});
});

// ─── No runtime writes under root ──────────────────────────────────────────

test("with absolute data and cache directories, an import, a reference upload and a drape analysis leave root untouched", async (t) => {
  const root = await makeInstallRoot(t);
  const dataDir = path.join(await tempDir(t, "wardrobe-f02-data-"), "data");
  const cacheDir = path.join(await tempDir(t, "wardrobe-f02-cache-"), "cache");
  const before = await treeSnapshot(root);

  const detection = {
    name: "Fixture shirt", part: "upperbody", color: "#336699", secondaryColor: null,
    tags: ["fixture"], worn: true, rotationDegrees: 0,
    boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
  };
  const chromaKey = chooseChromaKey(detection.color);
  const generated = await sharp({ create: { width: 96, height: 96, channels: 3, background: chromaKey } })
    .composite([{ input: await png(60, 72, "#eeeeee"), left: 18, top: 12 }])
    .png().toBuffer();
  const drapeWinner = DRAPE_SETS.sisterDeep.candidates[0].id;
  let phase = "import";
  const aiCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    aiCalls.push(String(url));
    if (String(url).endsWith("/responses")) {
      return Response.json({ output_text: JSON.stringify(phase === "import" ? { items: [detection] } : { verdict: drapeWinner, explanation: "Fixture" }) });
    }
    if (String(url).endsWith("/images/edits")) return Response.json({ data: [{ b64_json: generated.toString("base64") }] });
    throw new Error(`Unexpected mocked AI request: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const server = await start(t, root, {
    dataDir,
    cacheDir,
    env: cleanEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: "fixture-only-key", OPENAI_API_BASE_URL: "http://mock.invalid/v1" }),
  });
  assert.equal(server.dataDir, dataDir);
  assert.equal(server.cacheDir, cacheDir);
  const health = await request(server, "/api/health");
  assert.equal(health.json.cacheDir, cacheDir);
  assert.equal(health.json.dataDir, dataDir);
  assert.equal(health.json.managed, false);

  // Reference upload (full-body and face).
  const model = await png(72, 96, "#b08060");
  for (const kind of ["full", "face"]) {
    const uploaded = await request(server, "/api/setup/reference", { method: "POST", body: { kind, imageDataUrl: dataUrl(model) } });
    assert.equal(uploaded.status, 200, uploaded.buffer.toString());
  }
  assert.ok(await exists(path.join(dataDir, "model-reference.png")));
  assert.ok(await exists(path.join(dataDir, "model-reference-face.png")));

  // A complete mocked import: detection, crop approval, garment generation, approval.
  const source = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#b09070" } }).jpeg().toBuffer();
  const started = await request(server, "/api/import/jobs", { method: "POST", body: { filename: "look.jpg", imageDataUrl: dataUrl(source, "image/jpeg") } });
  assert.equal(started.status, 202, started.buffer.toString());
  const jobId = started.json.jobs[0].id;
  const crop = await request(server, `/api/import/jobs/${jobId}/stages/crop/approve`, { method: "POST", body: {} });
  assert.equal(crop.status, 200, crop.buffer.toString());
  let job;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    job = await request(server, `/api/import/jobs/${jobId}`);
    if (job.status !== 200 || ["review", "failed"].includes(job.json.stages.garment.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.json?.stages?.garment?.status, "review", job.buffer.toString());
  const approved = await request(server, `/api/import/jobs/${jobId}/stages/garment/approve`, { method: "POST", body: {} });
  assert.equal(approved.status, 200, approved.buffer.toString());
  const library = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
  assert.equal(library.length, 1);

  // Drapes: the portrait lands in <cacheDir>/drapes and is served at /drapes/*.
  phase = "drapes";
  const drapes = await request(server, "/api/color-profile/drapes");
  assert.equal(drapes.status, 200, drapes.buffer.toString());
  assert.equal(drapes.json.subject.url, "/drapes/subject.webp");
  const portrait = await request(server, "/drapes/subject.webp");
  assert.equal(portrait.status, 200);
  assert.equal(portrait.headers["content-type"], "image/webp");
  assert.deepEqual(portrait.buffer, await readFile(path.join(cacheDir, "drapes", "subject.webp")));
  assert.equal((await request(server, "/drapes/subject.json")).status, 404, "the manifest is not served");
  assert.equal((await request(server, "/drapes/../package.json")).status, 404);
  const analyzed = await request(server, "/api/color-profile/drapes/analyze", { method: "POST", body: { setId: "sisterDeep", fabricIndex: 0 } });
  assert.equal(analyzed.status, 200, analyzed.buffer.toString());
  assert.equal(analyzed.json.winnerId, drapeWinner);
  assert.ok(aiCalls.every((url) => url.startsWith("http://mock.invalid/")), "only the mocked provider was called");

  await server.close();
  assert.deepEqual(await treeSnapshot(root), before, "nothing was written under root");
  assert.ok(!(await exists(path.join(root, ".cache"))));
  assert.ok(!(await exists(path.join(root, "data"))));
  assert.ok(!(await exists(path.join(root, "public", "drapes"))));
});

// ─── Managed configuration ─────────────────────────────────────────────────

test("WARDROBE_MANAGED_CONFIG: config writes are refused, providers and health say managed, references and AI mode still work", async (t) => {
  const root = await makeInstallRoot(t);
  const dataDir = path.join(await tempDir(t, "wardrobe-f02-managed-"), "data");
  const server = await start(t, root, {
    dataDir,
    cacheDir: path.join(path.dirname(dataDir), "cache"),
    env: cleanEnv({ WARDROBE_MANAGED_CONFIG: "1", AI_PROVIDER: "gemini", GEMINI_API_KEY_TEST: "fixture-test-key" }),
  });
  assert.equal(server.managed, true);

  const refused = await request(server, "/api/setup/config", { method: "POST", body: { provider: "openai", values: { OPENAI_API_KEY: "sk-fixture" } } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { error: MANAGED_CONFIG_MESSAGE, managedBy: "desktop" });
  assert.equal(refused.json.error, "Configuration is managed by the Wardrobe desktop app");
  assert.ok(!(await exists(path.join(root, ".env"))), ".env is not created");

  const providers = await request(server, "/api/setup/providers");
  assert.equal(providers.status, 200);
  assert.equal(providers.json.managed, true);
  assert.equal(providers.json.provider, "gemini");
  assert.equal(providers.json.configured.gemini, true);
  assert.ok(!providers.buffer.toString().includes("fixture-test-key"), "keys never leave the server");
  assert.equal((await request(server, "/api/health")).json.managed, true);

  const reference = await request(server, "/api/setup/reference", { method: "POST", body: { kind: "full", imageDataUrl: dataUrl(await png(20, 30, "#a07050")) } });
  assert.equal(reference.status, 200, reference.buffer.toString());
  assert.ok(await exists(path.join(dataDir, "model-reference.png")));

  const mode = await request(server, "/api/import/mode", { method: "POST", body: { mode: "test" } });
  assert.equal(mode.status, 200, mode.buffer.toString());
  assert.equal(mode.json.mode, "test");
  assert.equal((await request(server, "/api/import/mode")).json.mode, "test");
  const prod = await request(server, "/api/import/mode", { method: "POST", body: { mode: "prod" } });
  assert.equal(prod.json.mode, "prod");

  // Cross-origin writes are still rejected first.
  const crossOrigin = await request(server, "/api/setup/config", { method: "POST", body: { provider: "openai" }, headers: { origin: "https://evil.example" } });
  assert.equal(crossOrigin.status, 403);
  await server.close();
  assert.ok(!(await exists(path.join(root, ".env"))));
});

test("without managed mode, providers and health report managed: false", async (t) => {
  const root = await makeInstallRoot(t);
  const server = await start(t, root, { dataDir: path.join(root, "..", path.basename(root) + "-data"), env: cleanEnv() });
  t.after(() => rm(path.join(root, "..", path.basename(root) + "-data"), { recursive: true, force: true }));
  assert.equal((await request(server, "/api/setup/providers")).json.managed, false);
  assert.equal((await request(server, "/api/health")).json.managed, false);
});

// ─── .env reload under the standalone server ───────────────────────────────

test("standalone server: saving a key reloads .env in place, with no restart, and never moves pinned settings", async (t) => {
  const root = await makeInstallRoot(t);
  const dataDir = path.join(await tempDir(t, "wardrobe-f02-reload-"), "data");
  await writeFile(path.join(root, ".env"), "# hand-written\nWARDROBE_DATA_DIR=hijacked\nWARDROBE_MANAGED_CONFIG=1\nOPENAI_VISION_MODEL=gpt-fixture-vision\nOPENROUTER_API_KEY=\n");
  // Plugins fall back to process.env, which may hold a developer's real keys:
  // MiniMax is the provider least likely to be configured on this machine.
  if (process.env.MINIMAX_API_KEY) { t.skip("MINIMAX_API_KEY is set in this shell"); return; }
  const previousKey = process.env.MINIMAX_API_KEY;
  const server = await start(t, root, { dataDir, env: cleanEnv({ AI_PROVIDER: "minimax", OPENROUTER_API_KEY: "sk-from-environment" }) });

  const before = await request(server, "/api/setup/providers");
  assert.equal(before.json.configured.minimax, false);
  assert.equal(before.json.configured.openrouter, true);
  assert.equal((await request(server, "/api/import/config")).json.hasApiKey, false);

  const saved = await request(server, "/api/setup/config", { method: "POST", body: { provider: "minimax", values: { MINIMAX_API_KEY: "sk-fixture-reload" } } });
  assert.equal(saved.status, 200, saved.buffer.toString());
  assert.deepEqual(saved.json, { saved: true, restarting: false });

  const after = await request(server, "/api/setup/providers");
  assert.equal(after.json.provider, "minimax");
  assert.equal(after.json.configured.minimax, true);
  assert.equal(after.json.configured.openrouter, true, "a blank key in .env does not wipe the one from the environment");
  assert.equal(server.env.OPENROUTER_API_KEY, "sk-from-environment");
  assert.equal(after.json.managed, false,"WARDROBE_MANAGED_CONFIG from .env does not switch modes at runtime");
  assert.equal((await request(server, "/api/import/config")).json.hasApiKey, true);

  const envFile = await readFile(path.join(root, ".env"), "utf8");
  assert.match(envFile, /^# hand-written$/m);
  assert.match(envFile, /^MINIMAX_API_KEY=sk-fixture-reload$/m);
  assert.match(envFile, /^AI_PROVIDER=minimax$/m);
  assert.equal(server.env.MINIMAX_API_KEY, "sk-fixture-reload");
  assert.equal(server.env.OPENAI_VISION_MODEL, "gpt-fixture-vision");
  assert.equal(server.env.WARDROBE_DATA_DIR, dataDir, "the data directory stays where the server started");
  assert.equal(process.env.MINIMAX_API_KEY, previousKey, "an explicit env object keeps process.env untouched");
  assert.equal((await request(server, "/api/health")).json.dataDir, dataDir);
});

test("under Vite (no reload hook) the setup API still reports a restart", async (t) => {
  const root = await tempDir(t, "wardrobe-f02-vite-");
  const plugin = wardrobeSetupApi({ env: { WARDROBE_DATA_DIR: "data" } });
  await plugin.configResolved({ root });
  let middleware;
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  const req = Readable.from([Buffer.from(JSON.stringify({ provider: "openai", values: { OPENAI_API_KEY: "sk-vite" } }))]);
  Object.assign(req, { url: "/api/setup/config", method: "POST", headers: { origin: "http://localhost:5173", host: "localhost:5173" } });
  const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body) { this.body = body; } };
  await middleware(req, res, () => { res.statusCode = 404; res.end(); });
  assert.equal(res.statusCode, 200, String(res.body));
  assert.deepEqual(JSON.parse(String(res.body)), { saved: true, restarting: true });
  assert.match(await readFile(path.join(root, ".env"), "utf8"), /^OPENAI_API_KEY=sk-vite$/m);
});

// ─── import-data ───────────────────────────────────────────────────────────

async function makeArchiveFixture(dir) {
  await mkdir(path.join(dir, "imported", "nested"), { recursive: true });
  const item = await png(12, 12, "#2468ac");
  const nested = await png(8, 8, "#ac6824");
  const reference = await png(20, 30, "#806040");
  await writeFile(path.join(dir, "imported", "item.png"), item);
  await writeFile(path.join(dir, "imported", "nested", "detail.png"), nested);
  await writeFile(path.join(dir, "model-reference.png"), reference);
  await writeFile(path.join(dir, "library.json"), `${JSON.stringify([
    { id: "import-fixture-1", name: "Fixture shirt", image: "imported/item.png", thumbnail: "imported/nested/detail.png" },
  ], null, 2)}\n`);
  await writeFile(path.join(dir, "archive-metadata.json"), `${JSON.stringify({ schemaVersion: 1, archiveGeneration: 1, referenceSources: {} })}\n`);
  // Secrets and control files that must never travel.
  await writeFile(path.join(dir, ".env"), "OPENAI_API_KEY=sk-must-not-travel\n");
  await mkdir(path.join(dir, ".google-drive", "archive-coordination"), { recursive: true });
  await writeFile(path.join(dir, ".google-drive", "connection.json"), "{\"refreshToken\":\"must-not-travel\"}");
  await mkdir(path.join(dir, "jobs", "job-1"), { recursive: true });
  await writeFile(path.join(dir, "jobs", "job-1", "job.json"), "{}");
  await writeFile(path.join(dir, "library.json.bak"), "[]");
  await writeFile(path.join(dir, "library.json.lock"), "");
  await writeFile(path.join(dir, "imported", "item.png.tmp"), item);
  await writeFile(path.join(dir, "imported", ".hidden.png"), item);
  await mkdir(path.join(dir, "backup-2025"), { recursive: true });
  await writeFile(path.join(dir, "backup-2025", "library.json"), "[]");
  const files = ["archive-metadata.json", "imported/item.png", "imported/nested/detail.png", "library.json", "model-reference.png"];
  let bytes = 0;
  for (const file of files) bytes += (await stat(path.join(dir, ...file.split("/")))).size;
  return { files, bytes };
}

function capture() {
  let text = "";
  return { stream: { write(chunk, callback) { text += chunk; callback?.(); return true; } }, get text() { return text; } };
}

test("import-data copies a valid archive, and only the archive", async (t) => {
  const base = await tempDir(t, "wardrobe-f02-import-");
  const from = path.join(base, "clone-data");
  const to = path.join(base, "app", "data");
  const expected = await makeArchiveFixture(from);

  const stdout = capture();
  const stderr = capture();
  const code = await runImportDataCli(["--from", from, "--to", to], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(code, IMPORT_DATA_EXIT.ok, stderr.text);
  const summary = JSON.parse(stdout.text);
  assert.equal(summary.files, expected.files.length);
  assert.equal(summary.bytes, expected.bytes);
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.to, to);
  assert.equal(summary.backup, null);

  const copied = Object.keys(await treeSnapshot(to)).filter((entry) => !entry.endsWith("/")).sort();
  assert.deepEqual(copied, expected.files.slice().sort());
  for (const file of expected.files) {
    assert.deepEqual(await readFile(path.join(to, ...file.split("/"))), await readFile(path.join(from, ...file.split("/"))), file);
  }
  for (const secret of [".env", ".google-drive", "jobs", "library.json.bak", "library.json.lock", "backup-2025", "imported/item.png.tmp", "imported/.hidden.png"]) {
    assert.ok(!(await exists(path.join(to, ...secret.split("/")))), `${secret} did not travel`);
  }
  // No staging folder is left next to the target.
  assert.deepEqual((await readdir(path.dirname(to))).sort(), ["data"]);
});

test("import-data refuses an invalid or incomplete archive with exit code 2 and a report on stderr", async (t) => {
  const base = await tempDir(t, "wardrobe-f02-invalid-");
  const to = path.join(base, "target");

  const missingMedia = path.join(base, "missing-media");
  await makeArchiveFixture(missingMedia);
  await rm(path.join(missingMedia, "imported", "item.png"));
  let stderr = capture();
  assert.equal(await runImportDataCli(["--from", missingMedia, "--to", to], { stdout: capture().stream, stderr: stderr.stream }), IMPORT_DATA_EXIT.invalid);
  let report = JSON.parse(stderr.text).error;
  assert.equal(report.code, "archive_invalid");
  assert.ok(report.errors.some((line) => line.includes("imported/item.png")), JSON.stringify(report.errors));

  const corrupt = path.join(base, "corrupt");
  await makeArchiveFixture(corrupt);
  await writeFile(path.join(corrupt, "library.json"), "{ not json");
  stderr = capture();
  assert.equal(await runImportDataCli(["--from", corrupt, "--to", to], { stdout: capture().stream, stderr: stderr.stream }), IMPORT_DATA_EXIT.invalid);
  assert.equal(JSON.parse(stderr.text).error.code, "archive_invalid");

  const notWardrobe = path.join(base, "not-a-wardrobe");
  await mkdir(notWardrobe, { recursive: true });
  await writeFile(path.join(notWardrobe, "notes.txt"), "hello");
  stderr = capture();
  assert.equal(await runImportDataCli(["--from", notWardrobe, "--to", to], { stdout: capture().stream, stderr: stderr.stream }), IMPORT_DATA_EXIT.invalid);
  assert.match(JSON.parse(stderr.text).error.errors[0], /No library\.json/);

  stderr = capture();
  assert.equal(await runImportDataCli(["--from", path.join(base, "absent"), "--to", to], { stdout: capture().stream, stderr: stderr.stream }), IMPORT_DATA_EXIT.invalid);
  assert.equal(JSON.parse(stderr.text).error.code, "source_missing");

  stderr = capture();
  assert.equal(await runImportDataCli(["--from", missingMedia], { stdout: capture().stream, stderr: stderr.stream }), IMPORT_DATA_EXIT.invalid);
  assert.match(stderr.text, /--from and --to are required/);
  assert.ok(!(await exists(to)), "nothing was created for a refused import");
});

test("import-data refuses a populated target without --replace and moves it aside with --replace", async (t) => {
  const base = await tempDir(t, "wardrobe-f02-replace-");
  const from = path.join(base, "clone-data");
  const to = path.join(base, "data");
  await makeArchiveFixture(from);
  await mkdir(to, { recursive: true });
  await writeFile(path.join(to, "library.json"), "[{\"id\":\"existing\"}]\n");
  await writeFile(path.join(to, "keep.txt"), "old");

  const stderr = capture();
  assert.equal(await runImportDataCli(["--from", from, "--to", to], { stdout: capture().stream, stderr: stderr.stream }), IMPORT_DATA_EXIT.targetPopulated);
  assert.equal(JSON.parse(stderr.text).error.code, "target_populated");
  assert.equal(await readFile(path.join(to, "library.json"), "utf8"), "[{\"id\":\"existing\"}]\n", "the target is untouched");

  const summary = await importDataFolder({ from, to, replace: true, now: () => new Date("2026-11-26T15:30:12.345Z") });
  assert.equal(summary.backup, `${to}.before-import-20261126T153012Z`);
  assert.equal(await readFile(path.join(summary.backup, "library.json"), "utf8"), "[{\"id\":\"existing\"}]\n");
  assert.equal(await readFile(path.join(summary.backup, "keep.txt"), "utf8"), "old");
  assert.equal(JSON.parse(await readFile(path.join(to, "library.json"), "utf8"))[0].id, "import-fixture-1");
  assert.ok(!(await exists(path.join(to, "keep.txt"))));
});

test("import-data moves a target without a wardrobe aside with a warning, and fills a missing or empty one directly", async (t) => {
  const base = await tempDir(t, "wardrobe-f02-skeleton-");
  const from = path.join(base, "clone-data");
  await makeArchiveFixture(from);

  // What a server leaves behind after one start: metadata, empty folders.
  const skeleton = path.join(base, "skeleton");
  await mkdir(path.join(skeleton, "imported"), { recursive: true });
  await writeFile(path.join(skeleton, "archive-metadata.json"), "{}");
  const moved = await importDataFolder({ from, to: skeleton, now: () => new Date("2026-01-02T03:04:05Z") });
  assert.equal(moved.backup, `${skeleton}.before-import-20260102T030405Z`);
  assert.equal(moved.warnings.length, 1);
  assert.match(moved.warnings[0], /no wardrobe/);
  assert.equal(await readFile(path.join(moved.backup, "archive-metadata.json"), "utf8"), "{}");

  const empty = path.join(base, "empty");
  await mkdir(empty);
  const direct = await importDataFolder({ from, to: empty });
  assert.equal(direct.backup, null);
  assert.ok(await exists(path.join(empty, "library.json")));

  await assert.rejects(importDataFolder({ from, to: path.join(from, "inside") }), /neither inside the other/);
});

test("server.mjs import-data runs as a subcommand and exits with the documented codes", async (t) => {
  const base = await tempDir(t, "wardrobe-f02-cli-");
  const from = path.join(base, "clone-data");
  const to = path.join(base, "data");
  await makeArchiveFixture(from);
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverScript, "import-data", ...args], { cwd: base, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  const first = await run(["--from", from, "--to", to]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).files, 5);
  const again = await run(["--from", from, "--to", to]);
  assert.equal(again.code, 3);
  assert.equal(JSON.parse(again.stderr).error.code, "target_populated");
  const replaced = await run(["--from", from, "--to", to, "--replace"]);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.ok(JSON.parse(replaced.stdout).backup.startsWith(`${to}.before-import-`));
  const usage = await run(["--from", from, "--bogus"]);
  assert.equal(usage.code, 2);
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /import-data --from <dir> --to <dataDir>/);
});
