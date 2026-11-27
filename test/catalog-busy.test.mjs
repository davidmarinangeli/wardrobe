import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apiPlugins } from "../scripts/api-plugins.mjs";
import { drainArchiveWriters } from "../scripts/archive-coordinator.mjs";
import { inspectArchiveCatalogs } from "../scripts/archive-store.mjs";
import { CatalogBusyError, readFileWithRetry, renameWithRetry } from "../scripts/fs-durability.mjs";
import { startServer } from "../scripts/server.mjs";
import { mutateLibrary } from "../shared/wardrobe-library.mjs";

const windowsOnly = process.platform === "win32" ? false : "a rename over an open file fails only on Windows";
const NO_WAIT = { delays: [1, 1, 1], sleep: async () => {} };

function failure(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

test("renameWithRetry rides out a short sharing violation on Windows", async () => {
  let calls = 0;
  const renameImpl = async (from, to) => {
    calls += 1;
    assert.deepEqual([from, to], ["a.tmp", "library.json"]);
    if (calls <= 2) throw failure("EPERM");
  };
  await renameWithRetry("a.tmp", "library.json", { platform: "win32", renameImpl, ...NO_WAIT });
  assert.equal(calls, 3);
});

test("renameWithRetry reports a file that stays in use as catalog_busy (503)", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    let calls = 0;
    const error = await renameWithRetry("a.tmp", path.join("data", "library.json"), {
      platform: "win32",
      renameImpl: async () => { calls += 1; throw failure(code); },
      ...NO_WAIT,
    }).then(() => null, (caught) => caught);
    assert.ok(error instanceof CatalogBusyError, code);
    assert.equal(error.code, "catalog_busy");
    assert.equal(error.status, 503);
    assert.match(error.message, /library\.json is in use/);
    assert.doesNotMatch(error.message, /another program/, "Wardrobe itself may be the holder");
    assert.equal(error.cause.code, code);
    assert.equal(calls, NO_WAIT.delays.length + 1);
  }
});

test("renameWithRetry never retries off Windows or on other errors", async () => {
  for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"], ["win32", "EXDEV"]]) {
    let calls = 0;
    const original = failure(code);
    const error = await renameWithRetry("a.tmp", "library.json", {
      platform,
      renameImpl: async () => { calls += 1; throw original; },
      ...NO_WAIT,
    }).then(() => null, (caught) => caught);
    assert.equal(error, original, `${platform}/${code} is rethrown unchanged`);
    assert.equal(calls, 1);
  }
});

test("readFileWithRetry shares the retry and the busy error", async () => {
  let calls = 0;
  const value = await readFileWithRetry("library.json", "utf8", {
    platform: "win32",
    readFileImpl: async (file, encoding) => {
      calls += 1;
      if (calls === 1) throw failure("EBUSY");
      return `${file}:${encoding}`;
    },
    ...NO_WAIT,
  });
  assert.equal(value, "library.json:utf8");
  const busy = await readFileWithRetry("library.json", "utf8", { platform: "win32", readFileImpl: async () => { throw failure("EBUSY"); }, ...NO_WAIT })
    .then(() => null, (caught) => caught);
  assert.equal(busy.code, "catalog_busy");
});

test("a catalog that cannot be read because it is in use is busy, not invalid", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-busy-preflight-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "library.json"), "[]\n");
  await writeFile(path.join(dataDir, "outfits.json"), "[]\n");
  const readFileImpl = async (file, encoding) => {
    if (path.basename(file) === "library.json") throw failure("EBUSY");
    return readFile(file, encoding);
  };
  const preflight = await inspectArchiveCatalogs(dataDir, { platform: "win32", readFileImpl, ...NO_WAIT });
  assert.deepEqual(preflight, { valid: false, invalidCatalogs: [], busyCatalogs: ["library.json"] });

  const warnings = [];
  t.mock.method(console, "warn", (line) => { warnings.push(line); });
  const { reportSkippedArchiveStartup } = await import("../scripts/archive-store.mjs");
  reportSkippedArchiveStartup("variant startup migrations", preflight);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /library\.json is in use/);
  assert.doesNotMatch(warnings[0], /repair/);
});

// ---------------------------------------------------------------------------
// Windows: a real handle on library.json, as an editor, a backup tool or a
// Wardrobe request reading the catalog would hold it.

const INDEX_HTML = "<!doctype html><html><head><title>stub</title></head><body></body></html>\n";

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AI_PROVIDER|OPENAI_|OPENROUTER_|GEMINI_|MINIMAX_|GOOGLE_DRIVE_|WARDROBE_)/.test(key)) delete env[key];
  }
  return env;
}

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-busy-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "data", "imported"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), INDEX_HTML);
  // Legacy records, so the first start has real migrations to write.
  await writeFile(path.join(root, "data", "library.json"), `${JSON.stringify([
    { id: "shirt", name: "Shirt", part: "upperbody", image: "/api/import/library/shirt.png", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "jeans", name: "Jeans", part: "lowerbody", image: "imported/jeans.png", createdAt: "2026-01-01T00:00:00.000Z" },
  ], null, 2)}\n`);
  return root;
}

async function startQuiet(t, root) {
  const server = await startServer({ root, port: 0, host: "127.0.0.1", env: cleanEnv(), log: () => {} });
  t.after(() => server.close());
  return server;
}

async function identity(file) {
  const info = await stat(file, { bigint: true });
  return `${info.dev}:${info.ino}:${info.mtimeNs}`;
}

function request(server, pathname, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: server.port, path: pathname, method,
      headers: { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}`, ...(payload ? { "content-type": "application/json" } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("the server starts on stable data while library.json is held open, and rewrites nothing", { skip: windowsOnly }, async (t) => {
  const root = await makeRoot(t);
  const library = path.join(root, "data", "library.json");
  // First start: migrations write. Second start with the same data: nothing to write.
  const first = await startQuiet(t, root);
  await first.close();
  const before = await identity(library);

  const handle = await open(library, "r");
  t.after(() => handle.close().catch(() => {}));
  const second = await startQuiet(t, root);
  await second.close();
  assert.equal(await identity(library), before, "a stable library must not be replaced at startup");

  // Vite runs every configResolved hook at once (Promise.all), so the startup
  // writes race each other's reads; with stable data there are none to race.
  const env = { ...cleanEnv(), WARDROBE_DATA_DIR: path.join(root, "data") };
  const config = { root, publicDir: path.join(root, "public"), build: { outDir: path.join(root, "dist") }, command: "serve", mode: "development", env: {} };
  const plugins = apiPlugins({ env });
  await Promise.all(plugins.map((plugin) => (typeof plugin.configResolved === "function" ? plugin.configResolved(config) : null)));
  await drainArchiveWriters();
  assert.equal(await identity(library), before);
  assert.deepEqual((await readdir(path.join(root, "data"))).filter((name) => name.endsWith(".tmp")), []);
});

test("startup migrations that must write wait for the next start instead of failing", { skip: windowsOnly }, async (t) => {
  const root = await makeRoot(t);
  const library = path.join(root, "data", "library.json");
  const legacy = await readFile(library, "utf8");
  const handle = await open(library, "r");
  t.after(() => handle.close().catch(() => {}));
  const warnings = [];
  t.mock.method(console, "warn", (line) => { warnings.push(String(line)); });
  const server = await startQuiet(t, root);
  // The readers normalize on load, so the API works on the unmigrated file.
  const items = await request(server, "/api/import/wardrobe");
  assert.equal(items.status, 200);
  assert.deepEqual(items.json.map((item) => item.id).sort(), ["jeans", "shirt"]);
  await server.close();
  assert.equal(await readFile(library, "utf8"), legacy);
  assert.ok(warnings.some((line) => /library\.json is in use/.test(line)), warnings.join("\n"));
  assert.ok(!warnings.some((line) => /need repair/.test(line)), warnings.join("\n"));

  await handle.close();
  const later = await startQuiet(t, root);
  await later.close();
  assert.notEqual(await readFile(library, "utf8"), legacy, "the next start migrates");
});

test("a library edit while library.json is held open answers 503 with the reason, then succeeds", { skip: windowsOnly }, async (t) => {
  const root = await makeRoot(t);
  const library = path.join(root, "data", "library.json");
  const server = await startQuiet(t, root);
  const handle = await open(library, "r");
  let released = false;
  t.after(() => (released ? null : handle.close().catch(() => {})));

  const busy = await request(server, "/api/wardrobe/items/shirt", { method: "PATCH", body: { name: "Oxford shirt" } });
  assert.equal(busy.status, 503, busy.text);
  assert.match(busy.json.error, /library\.json is in use; try again/);

  // The server stays up and the mutation path works again once the handle closes.
  assert.equal((await request(server, "/api/health")).status, 200);
  await handle.close();
  released = true;
  const saved = await request(server, "/api/wardrobe/items/shirt", { method: "PATCH", body: { name: "Oxford shirt" } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.name, "Oxford shirt");
  assert.equal(JSON.parse(await readFile(library, "utf8")).find((item) => item.id === "shirt").name, "Oxford shirt");
});

test("mutateLibrary reports a held library.json as catalog_busy and leaves no temporary file", { skip: windowsOnly }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-busy-mutate-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const library = path.join(dataDir, "library.json");
  await writeFile(library, "[]\n");
  const handle = await open(library, "r");
  try {
    const error = await mutateLibrary(dataDir, (records) => [...records, { id: "new" }]).then(() => null, (caught) => caught);
    assert.equal(error?.code, "catalog_busy");
    assert.equal(error.status, 503);
  } finally {
    await handle.close();
  }
  assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(await mutateLibrary(dataDir, (records) => [...records, { id: "new" }]), [{ id: "new" }]);
});
