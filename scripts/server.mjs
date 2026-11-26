#!/usr/bin/env node
/**
 * Standalone Wardrobe server: the built frontend from `dist/` plus every API
 * plugin from `scripts/api-plugins.mjs`, without Vite.
 *
 *   node scripts/server.mjs [--port 5173] [--host 127.0.0.1] [--root <dir>]
 *     [--data-dir <dir>] [--cache-dir <dir>] [--dist <dir>]
 *     [--allowed-hosts a.example,.ts.net] [--watch-stdin auto|on|off]
 *
 * Prints `wardrobe-server listening on http://<host>:<port>` and then `READY`
 * on its own line once it accepts requests. SIGINT, SIGTERM, SIGHUP (and SIGBREAK on
 * Windows) or the end of stdin shut it down gracefully.
 */
import { fstatSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import connect from "connect";
import sirv from "sirv";
import { apiPlugins } from "./api-plugins.mjs";
import { drainArchiveWriters } from "./archive-coordinator.mjs";
import { ALLOWED_HOSTS_ENV, createHostAllowlist, parseAllowedHosts } from "./host-allowlist.mjs";

export const DEFAULT_PORT = 5173;
export const DEFAULT_HOST = "127.0.0.1";
export const READY_LINE = "READY";
export const SHUTDOWN_TIMEOUT_MS = 10_000;

// Undefined once esbuild turns this module into CommonJS (Feature 03): the
// bundle always receives --root, and defines WARDROBE_VERSION.
const moduleFile = typeof import.meta?.url === "string" ? fileURLToPath(import.meta.url) : null;
const scriptRoot = moduleFile ? path.resolve(path.dirname(moduleFile), "..") : null;

function readVersion(root) {
  // eslint-disable-next-line no-undef
  if (typeof WARDROBE_VERSION === "string" && WARDROBE_VERSION) return WARDROBE_VERSION;
  for (const dir of [scriptRoot, root]) {
    if (!dir) continue;
    try {
      const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
      if (typeof version === "string" && version) return version;
    } catch { /* try the next location */ }
  }
  return "0.0.0";
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function hookFunction(plugin, name) {
  const hook = plugin?.[name];
  if (typeof hook === "function") return hook;
  if (hook && typeof hook.handler === "function") return hook.handler;
  return null;
}

function appliesToServe(plugin, config) {
  if (!plugin || plugin.apply === "build") return false;
  if (typeof plugin.apply === "function") return Boolean(plugin.apply(config, { command: "serve", mode: config.mode, isPreview: true }));
  return true;
}

function listen(httpServer, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off("listening", onListening);
      if (error.code === "EADDRINUSE") reject(Object.assign(new Error(`Port ${port} is already in use on ${host}`), { code: "EADDRINUSE" }));
      else reject(error);
    };
    const onListening = () => { httpServer.off("error", onError); resolve(); };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });
}

function formatUrl(host, port) {
  const display = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${display}:${port}`;
}

/**
 * Resolves every option to its final value. Flags (the `options` passed in)
 * win over environment variables, which win over defaults.
 */
export function resolveServerOptions(options = {}, env = process.env) {
  const root = path.resolve(options.root || scriptRoot || process.cwd());
  const dataDir = path.resolve(root, options.dataDir || env.WARDROBE_DATA_DIR || "data");
  const cacheDir = path.resolve(root, options.cacheDir || env.WARDROBE_CACHE_DIR || ".cache");
  const dist = path.resolve(root, options.dist || "dist");
  const port = options.port === undefined || options.port === null || options.port === "" ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${options.port}`);
  const host = String(options.host || DEFAULT_HOST);
  const allowedHosts = parseAllowedHosts(options.allowedHosts || [], env[ALLOWED_HOSTS_ENV] || "");
  return { root, dataDir, cacheDir, dist, port, host, allowedHosts };
}

/**
 * Starts the server and resolves once it listens. The returned handle exposes
 * the bound `port`, the `url`, the shared plugin `env` (mutate it in place to
 * change settings at runtime), and `close()` for a graceful shutdown.
 */
export async function startServer(options = {}) {
  const baseEnv = options.env || process.env;
  const resolved = resolveServerOptions(options, baseEnv);
  const { root, dataDir, cacheDir, dist, host, allowedHosts } = resolved;
  const log = options.log || ((line) => process.stderr.write(`${line}\n`));

  try { await access(path.join(dist, "index.html")); }
  catch { throw new Error(`Built frontend not found at ${path.join(dist, "index.html")}. Run \`npm run build\` first or pass --dist.`); }

  // One settings object shared by every plugin, like Vite's loadEnv result.
  const env = { ...baseEnv, WARDROBE_DATA_DIR: dataDir, WARDROBE_CACHE_DIR: cacheDir };
  const version = readVersion(root);
  const startedAt = Date.now();

  const app = connect();
  const httpServer = http.createServer(app);
  const plugins = (options.plugins || apiPlugins({ env }));
  const config = {
    root,
    publicDir: path.join(root, "public"),
    build: { outDir: dist },
    command: "serve",
    mode: "production",
    isProduction: true,
    base: "/",
    env: {},
  };
  const active = plugins.filter((plugin) => appliesToServe(plugin, config));

  async function closeHttpServer() {
    if (!httpServer.listening) return;
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections?.();
    });
  }

  // The object plugins receive in configurePreviewServer. googleDriveApi wraps
  // close() so its sync worker drains before the HTTP server stops, and hooks
  // httpServer "close" as a second stop signal.
  const previewServer = {
    config,
    middlewares: app,
    httpServer,
    resolvedUrls: null,
    async close() { await closeHttpServer(); },
    printUrls() {},
    bindCLIShortcuts() {},
  };

  app.use(createHostAllowlist({ allowedHosts }));
  app.use("/api/health", (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: { code: "method_not_allowed" } });
    return json(res, 200, {
      ok: true,
      version,
      dataDir,
      cacheDir,
      managed: false,
      pid: process.pid,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  for (const plugin of active) {
    const hook = hookFunction(plugin, "configResolved");
    if (hook) await hook.call(plugin, config);
  }
  const postHooks = [];
  for (const plugin of active) {
    const hook = hookFunction(plugin, "configurePreviewServer");
    if (!hook) continue;
    const post = await hook.call(plugin, previewServer);
    if (typeof post === "function") postHooks.push(post);
  }
  for (const post of postHooks) await post();

  app.use(sirv(dist, {
    single: true,
    etag: true,
    dev: false,
    // API and image routes never fall back to index.html.
    ignores: ["^/api(/|$)", "^/_ipx(/|$)"],
  }));
  app.use((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname.startsWith("/api/") || pathname === "/api") return json(res, 404, { error: { code: "not_found", message: "Not found" } });
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  });
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    log(`wardrobe-server error on ${req.method} ${req.url}: ${error?.stack || error}`);
    if (res.headersSent) { res.destroy(); return; }
    json(res, Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500, { error: { code: "internal_error", message: "Internal server error" } });
  });

  try {
    await listen(httpServer, resolved.port, host);
  } catch (error) {
    await previewServer.close().catch(() => {});
    throw error;
  }
  const port = httpServer.address().port;

  let closing = null;
  return {
    ...resolved,
    port,
    url: formatUrl(host, port),
    version,
    env,
    app,
    httpServer,
    plugins: active,
    close() {
      closing ||= (async () => {
        await previewServer.close();
        await drainArchiveWriters();
      })();
      return closing;
    },
  };
}

const HELP = `Usage: node scripts/server.mjs [options]

  --port <n>             Port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)
  --host <addr>          Address to bind (default ${DEFAULT_HOST})
  --root <dir>           Project root plugins resolve paths against (default: repo root)
  --data-dir <dir>       Wardrobe data directory (default WARDROBE_DATA_DIR or <root>/data)
  --cache-dir <dir>      Cache directory (default WARDROBE_CACHE_DIR or <root>/.cache)
  --dist <dir>           Built frontend directory (default <root>/dist)
  --allowed-hosts <list> Extra Host names, comma separated; ".suffix" allows subdomains.
                         Merged with ${ALLOWED_HOSTS_ENV}.
  --watch-stdin <mode>   auto (default: when stdin is a pipe), on, off.
                         When on, the end of stdin shuts the server down.
  -h, --help             Show this help
`;

function stdinIsPipe() {
  try {
    const type = fstatSync(0).mode & 0o170000;
    return type === 0o010000 || type === 0o140000; // FIFO (pipes on every OS) or socket (Node child_process on POSIX)
  } catch { return false; }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        root: { type: "string" },
        "data-dir": { type: "string" },
        "cache-dir": { type: "string" },
        dist: { type: "string" },
        "allowed-hosts": { type: "string", multiple: true },
        "watch-stdin": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    return 2;
  }
  const flags = parsed.values;
  if (flags.help) { process.stdout.write(HELP); return 0; }
  const watchStdin = flags["watch-stdin"] || "auto";
  if (!["auto", "on", "off"].includes(watchStdin)) {
    process.stderr.write(`Invalid --watch-stdin: ${watchStdin} (expected auto, on or off)\n`);
    return 2;
  }

  let server;
  try {
    server = await startServer({
      port: flags.port,
      host: flags.host,
      root: flags.root,
      dataDir: flags["data-dir"],
      cacheDir: flags["cache-dir"],
      dist: flags.dist,
      allowedHosts: flags["allowed-hosts"] || [],
    });
  } catch (error) {
    process.stderr.write(`wardrobe-server failed to start: ${error?.message || error}\n`);
    return 1;
  }

  process.stdout.write(`wardrobe-server listening on ${server.url}\n${READY_LINE}\n`);

  return new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = (reason) => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`wardrobe-server shutting down (${reason})\n`);
      const timer = setTimeout(() => {
        process.stderr.write(`wardrobe-server forced exit after ${SHUTDOWN_TIMEOUT_MS / 1000} s\n`);
        resolve(1);
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
      server.close().then(
        () => { clearTimeout(timer); resolve(0); },
        (error) => { clearTimeout(timer); process.stderr.write(`wardrobe-server shutdown error: ${error?.stack || error}\n`); resolve(1); },
      );
    };
    // SIGHUP also fires on Windows when the console window closes (Windows
    // kills the process about 10 s later), so it is handled everywhere.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]) {
      process.once(signal, () => shutdown(signal));
    }
    if (watchStdin === "on" || (watchStdin === "auto" && stdinIsPipe())) {
      process.stdin.on("data", () => {});
      process.stdin.once("end", () => shutdown("stdin closed"));
      process.stdin.once("close", () => shutdown("stdin closed"));
      process.stdin.once("error", () => shutdown("stdin error"));
      process.stdin.resume();
    }
  });
}

function invokedDirectly() {
  if (!moduleFile) return true; // bundled entry point
  const entry = process.argv[1];
  if (!entry) return false;
  const same = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  try { return same(path.resolve(entry), moduleFile); }
  catch { return false; }
}

if (invokedDirectly()) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`wardrobe-server crashed: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
