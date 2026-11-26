import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sharp from "sharp";
import { apiPlugins } from "../scripts/api-plugins.mjs";
import { fsyncDirectory } from "../scripts/fs-durability.mjs";
import { drainArchiveWriters, withArchiveWriteLease } from "../scripts/archive-coordinator.mjs";
import { createHostAllowlist, hostnameFromHostHeader, isHostAllowed, parseAllowedHosts } from "../scripts/host-allowlist.mjs";
import { READY_LINE, resolveServerOptions, startServer } from "../scripts/server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.join(repoRoot, "scripts", "server.mjs");
const packageVersion = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version;
const INDEX_HTML = "<!doctype html><html><head><title>stub</title></head><body><div id=\"root\">wardrobe stub</div></body></html>\n";

// Only the settings the server derives itself; AI keys stay unset so nothing
// can reach a provider.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AI_PROVIDER|OPENAI_|OPENROUTER_|GEMINI_|MINIMAX_|GOOGLE_DRIVE_|WARDROBE_)/.test(key)) delete env[key];
  }
  return env;
}

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-server-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), INDEX_HTML);
  await writeFile(path.join(root, "dist", "assets", "app.js"), "console.log('wardrobe');\n");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "#c33" } }).png().toFile(path.join(root, "dist", "pixel.png"));
  return root;
}

async function start(t, root, options = {}) {
  const server = await startServer({ port: 0, root, env: cleanEnv(), log: () => {}, ...options });
  t.after(() => server.close());
  return server;
}

function request(server, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, path: pathname, method, headers: { host: `localhost:${server.port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, buffer, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("the plugin registry keeps the Vite order and the react slot", async () => {
  const marker = { name: "react-marker" };
  const withReact = apiPlugins({ env: {}, react: marker }).map((plugin) => plugin.name);
  assert.deepEqual(withReact, [
    "wardrobe-google-drive-api",
    "react-marker",
    "wardrobe-responsive-images",
    "wardrobe-import-job-api",
    ...withReact.slice(4),
  ]);
  assert.equal(withReact.length, 15);
  const standalone = apiPlugins({ env: {} }).map((plugin) => plugin.name);
  assert.deepEqual(standalone, withReact.filter((name) => name !== "react-marker"));

  // loadEnv reads .env files from the working directory: point it at an empty
  // temporary directory so the real .env is never read.
  const { default: viteConfig } = await import("../vite.config.mjs");
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-vite-env-"));
  const previousCwd = process.cwd();
  let resolved;
  try {
    process.chdir(emptyDir);
    resolved = viteConfig({ mode: "test", command: "serve" });
  } finally {
    process.chdir(previousCwd);
    await rm(emptyDir, { recursive: true, force: true });
  }
  const vitePlugins = resolved.plugins.flat(Infinity).map((plugin) => plugin.name);
  assert.equal(vitePlugins[0], "wardrobe-google-drive-api");
  assert.ok(vitePlugins.some((name) => /react/.test(name)), "the react plugin is still registered");
  assert.deepEqual(vitePlugins.filter((name) => standalone.includes(name)), standalone);
});

test("server options: flags win over environment variables, which win over defaults", () => {
  const root = path.resolve(os.tmpdir(), "wardrobe-opts");
  const defaults = resolveServerOptions({ root }, {});
  assert.equal(defaults.port, 5173);
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.dataDir, path.join(root, "data"));
  assert.equal(defaults.cacheDir, path.join(root, ".cache"));
  assert.equal(defaults.dist, path.join(root, "dist"));
  assert.deepEqual(defaults.allowedHosts, []);

  const env = { WARDROBE_DATA_DIR: "env-data", WARDROBE_CACHE_DIR: "env-cache", WARDROBE_ALLOWED_HOSTS: "a.example, .ts.net" };
  const fromEnv = resolveServerOptions({ root }, env);
  assert.equal(fromEnv.dataDir, path.join(root, "env-data"));
  assert.equal(fromEnv.cacheDir, path.join(root, "env-cache"));
  assert.deepEqual(fromEnv.allowedHosts, ["a.example", ".ts.net"]);

  const flags = resolveServerOptions({ root, port: "0", dataDir: "flag-data", cacheDir: path.join(root, "abs-cache"), dist: "web", allowedHosts: ["B.example"] }, env);
  assert.equal(flags.port, 0);
  assert.equal(flags.dataDir, path.join(root, "flag-data"));
  assert.equal(flags.cacheDir, path.join(root, "abs-cache"));
  assert.equal(flags.dist, path.join(root, "web"));
  assert.deepEqual(flags.allowedHosts, ["b.example", "a.example", ".ts.net"]);
  assert.throws(() => resolveServerOptions({ root, port: "70000" }, {}), /Invalid --port/);
});

test("host allow-list accepts loopback names, IP literals and listed hosts only", () => {
  assert.equal(hostnameFromHostHeader("LocalHost:5173"), "localhost");
  assert.equal(hostnameFromHostHeader("[::1]:5173"), "[::1]");
  assert.equal(hostnameFromHostHeader("mac.tail1234.ts.net."), "mac.tail1234.ts.net");
  assert.equal(hostnameFromHostHeader("evil.example:abc"), "");
  assert.equal(hostnameFromHostHeader("a b"), "");

  for (const host of ["localhost", "localhost:5173", "127.0.0.1:5173", "[::1]:5173", "app.localhost", "192.168.1.20:5173"]) {
    assert.equal(isHostAllowed(host, []), true, host);
  }
  for (const host of [undefined, "", "evil.example", "localhost.evil.example", "127.0.0.1.nip.io", "ts.net"]) {
    assert.equal(isHostAllowed(host, parseAllowedHosts(".ts.net")), false, String(host));
  }
  const list = parseAllowedHosts("terminal.local,.ts.net");
  assert.equal(isHostAllowed("terminal.local:5173", list), true);
  assert.equal(isHostAllowed("mac.tail1234.ts.net", list), true);
  assert.equal(isHostAllowed("other.local", list), false);

  let nextCalled = false;
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  createHostAllowlist({ allowedHosts: [] })({ headers: { host: "evil.example" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.host, "evil.example");
});

test("the standalone server serves health, the SPA, the APIs, images and 404s", async (t) => {
  const root = await makeRoot(t);
  const server = await start(t, root);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const health = await request(server, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(health.json).sort(), ["cacheDir", "dataDir", "managed", "ok", "pid", "uptime", "version"]);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.version, packageVersion);
  assert.equal(health.json.dataDir, path.join(root, "data"));
  assert.equal(health.json.cacheDir, path.join(root, ".cache"));
  assert.equal(health.json.managed, false);
  assert.equal(health.json.pid, process.pid);
  assert.ok(Number.isInteger(health.json.uptime) && health.json.uptime >= 0);
  assert.equal((await request(server, "/api/health", { method: "POST", headers: { origin: server.url } })).status, 405);

  const html = await request(server, "/");
  assert.equal(html.status, 200);
  assert.match(html.headers["content-type"], /text\/html/);
  assert.equal(html.text, INDEX_HTML);
  assert.ok(html.headers.etag, "static responses carry an ETag");
  const spaRoute = await request(server, "/outfits/some-id");
  assert.equal(spaRoute.status, 200);
  assert.equal(spaRoute.text, INDEX_HTML);
  const asset = await request(server, "/assets/app.js");
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /javascript/);

  const library = await request(server, "/api/import/wardrobe");
  assert.equal(library.status, 200);
  assert.deepEqual(library.json, []);
  assert.equal((await request(server, "/api/google-drive/status")).status, 200);
  const providers = await request(server, "/api/setup/providers");
  assert.equal(providers.status, 200);
  assert.equal(typeof providers.json.provider, "string");

  const image = await request(server, "/_ipx/w_8/pixel.png");
  assert.equal(image.status, 200);
  assert.match(image.headers["content-type"], /^image\//);
  assert.equal((await sharp(image.buffer).metadata()).width, 8);

  const unknownApi = await request(server, "/api/does-not-exist");
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.json.error.code, "not_found");
  assert.equal((await request(server, "/missing-file.js")).status, 404);
});

test("the host allow-list guards every route of the running server", async (t) => {
  const root = await makeRoot(t);
  const plain = await start(t, root);
  for (const pathname of ["/", "/api/health", "/api/import/wardrobe", "/_ipx/w_8/pixel.png", "/assets/app.js"]) {
    const rejected = await request(plain, pathname, { headers: { host: "evil.example" } });
    assert.equal(rejected.status, 403, pathname);
    assert.equal(rejected.json.error.code, "host_not_allowed");
    assert.equal(rejected.json.error.host, "evil.example");
  }
  assert.equal((await request(plain, "/api/health", { headers: { host: "mac.tail1234.ts.net" } })).status, 403);
  assert.equal((await request(plain, "/api/health", { headers: { host: `127.0.0.1:${plain.port}` } })).status, 200);

  const tailnet = await start(t, root, { allowedHosts: [".ts.net"] });
  assert.equal((await request(tailnet, "/api/health", { headers: { host: "mac.tail1234.ts.net" } })).status, 200);
  assert.equal((await request(tailnet, "/", { headers: { host: "mac.tail1234.ts.net" } })).text, INDEX_HTML);
  assert.equal((await request(tailnet, "/api/health", { headers: { host: "evil.example" } })).status, 403);

  const fromEnv = await start(t, root, { env: { ...cleanEnv(), WARDROBE_ALLOWED_HOSTS: "terminal.local" } });
  assert.equal((await request(fromEnv, "/api/health", { headers: { host: "terminal.local:5173" } })).status, 200);
});

test("state-changing requests still need a same-origin Origin header", async (t) => {
  const root = await makeRoot(t);
  const server = await start(t, root);
  const body = { provider: "openai", values: { OPENAI_API_KEY: "sk-test-not-real" } };
  const crossOrigin = await request(server, "/api/setup/config", { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body });
  assert.equal(crossOrigin.status, 403);
  const noOrigin = await request(server, "/api/setup/config", { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(noOrigin.status, 403);
  await assert.rejects(stat(path.join(root, ".env")), { code: "ENOENT" });
});

test("startup fails clearly without a built frontend or on a busy port", async (t) => {
  const root = await makeRoot(t);
  await assert.rejects(startServer({ port: 0, root, dist: path.join(root, "missing-dist"), env: cleanEnv(), log: () => {} }), /npm run build/);
  const first = await start(t, root);
  await assert.rejects(startServer({ port: first.port, root, env: cleanEnv(), log: () => {} }), { code: "EADDRINUSE" });
});

test("directory fsync works on every platform and still reports missing directories", async (t) => {
  const root = await makeRoot(t);
  await fsyncDirectory(path.join(root, "data"));
  await assert.rejects(fsyncDirectory(path.join(root, "does-not-exist")), { code: "ENOENT" });
});

test("shutdown drains archive writer leases that are still running", async (t) => {
  const root = await makeRoot(t);
  const dataDir = path.join(root, "data");
  let finished = false;
  const writer = withArchiveWriteLease(dataDir, async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await drainArchiveWriters();
  assert.equal(finished, true);
  await writer;
  await drainArchiveWriters();
});

function spawnServer(root, extraArgs = []) {
  const child = spawn(process.execPath, [serverScript, "--port", "0", "--root", root, ...extraArgs], {
    cwd: root,
    env: cleanEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not print READY\nstdout:${stdout}\nstderr:${stderr}`)), 30_000);
    child.stdout.on("data", () => {
      const lines = stdout.split(/\r?\n/);
      if (!lines.includes(READY_LINE)) return;
      clearTimeout(timer);
      const match = stdout.match(/^wardrobe-server listening on http:\/\/127\.0\.0\.1:(\d+)$/m);
      resolve(Number(match?.[1]));
    });
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`server exited early with ${code}\n${stderr}`)); });
  });
  return { child, ready, exited, output: () => ({ stdout, stderr }) };
}

async function expectGracefulExit(t, trigger) {
  const root = await makeRoot(t);
  const server = spawnServer(root);
  t.after(() => { if (server.child.exitCode === null) server.child.kill("SIGKILL"); });
  const port = await server.ready;
  assert.ok(port > 0);
  const health = await request({ port }, "/api/health");
  assert.equal(health.json.ok, true);
  assert.equal(health.json.pid, server.child.pid);
  const { stdout } = server.output();
  assert.deepEqual(stdout.split(/\r?\n/).slice(0, 2), [`wardrobe-server listening on http://127.0.0.1:${port}`, READY_LINE]);

  const started = Date.now();
  trigger(server.child);
  const result = await Promise.race([server.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
  assert.notEqual(result, "timeout", "the server must exit within 10 s");
  assert.equal(result.code, 0, server.output().stderr);
  assert.ok(Date.now() - started < 10_000);
}

test("closing stdin shuts the CLI down with exit code 0", async (t) => {
  await expectGracefulExit(t, (child) => child.stdin.end());
});

test("SIGTERM shuts the CLI down with exit code 0", { skip: process.platform === "win32" ? "Windows has no catchable SIGTERM; the stdin test covers it" : false }, async (t) => {
  await expectGracefulExit(t, (child) => child.kill("SIGTERM"));
});

test("the CLI rejects unknown flags and prints help", async () => {
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [serverScript, ...args], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("exit", (code) => resolve({ code, out }));
  });
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /--allowed-hosts/);
  const bad = await run(["--nope"]);
  assert.equal(bad.code, 2);
  const badStdin = await run(["--watch-stdin", "sometimes"]);
  assert.equal(badStdin.code, 2);
});
