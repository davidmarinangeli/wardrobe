// Storage and HTTP for the behaviour-derived taste profile. The derivation
// itself is pure and lives in preferences.mjs.
//
// Local-first like the rest of data/: this file never leaves the machine.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "./import-job-api.mjs";
import { SIGNAL_TYPES, derivePreferences } from "./preferences.mjs";

const PREFERENCES_VERSION = 1;
// Signals are cheap and small, but the log is append-only and read on every
// suggestion call, so it is capped. Oldest go first — they are also the ones
// decay has already reduced to near-nothing.
const MAX_SIGNALS = 2000;

export function preferencesFile(dataDir) {
  return path.join(dataDir, "preferences.json");
}

export async function readPreferencesStore(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(preferencesFile(dataDir), "utf8"));
    return { version: PREFERENCES_VERSION, signals: Array.isArray(parsed.signals) ? parsed.signals : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { version: PREFERENCES_VERSION, signals: [] };
    // A corrupt profile must never take down a feature the user asked for —
    // personalization degrades to "no preferences yet".
    return { version: PREFERENCES_VERSION, signals: [] };
  }
}

export function normalizeSignal(input) {
  if (!input || !SIGNAL_TYPES.has(input.type)) return null;
  const signal = { type: input.type, at: new Date().toISOString() };

  if (Array.isArray(input.itemIds)) {
    signal.itemIds = input.itemIds.filter((id) => typeof id === "string").slice(0, 12);
  }
  for (const field of ["itemId", "pinId", "part", "category", "color", "source", "name"]) {
    if (typeof input[field] === "string" && input[field]) signal[field] = input[field].slice(0, 120);
  }
  if (Array.isArray(input.colors)) {
    signal.colors = input.colors.filter((color) => typeof color === "string").slice(0, 6);
  }
  return signal;
}

// Appending is read-modify-write, so two signals arriving together (tapping ♥
// on one card and ✕ on the next, or a detection run recording several items)
// would both read the same base state and the last write would silently drop
// the other. Serializing appends through one promise chain per data directory
// makes every signal survive. Losing one is not an abstract risk: the first
// version of this dropped a `passed` — the single most valuable signal here,
// because it is the only honest negative the app can collect.
const writeQueues = new Map();

function enqueueWrite(dataDir, task) {
  const previous = writeQueues.get(dataDir) || Promise.resolve();
  const next = previous.then(task, task);
  // Keep the chain alive but never let a rejection leak into the next caller.
  writeQueues.set(dataDir, next.catch(() => {}));
  return next;
}

/**
 * Appends one signal. Never throws into a caller's request path: recording a
 * preference is always secondary to the action the user actually asked for, so
 * a failure here must not fail their save.
 */
export async function recordSignal(dataDir, input) {
  const signal = normalizeSignal(input);
  if (!signal) return null;

  return enqueueWrite(dataDir, async () => {
    try {
      const store = await readPreferencesStore(dataDir);
      const signals = [...store.signals, signal].slice(-MAX_SIGNALS);
      await atomicJson(preferencesFile(dataDir), { version: PREFERENCES_VERSION, signals });
      return signal;
    } catch {
      return null;
    }
  });
}

async function readJsonArray(dataDir, file) {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, file), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The derived profile, ready to inject into a prompt. Never throws. */
export async function loadDerivedPreferences(dataDir) {
  try {
    const [store, items, outfits] = await Promise.all([
      readPreferencesStore(dataDir),
      readJsonArray(dataDir, "library.json"),
      readJsonArray(dataDir, "outfits.json"),
    ]);
    return derivePreferences(store.signals, { items, outfits });
  } catch {
    return null;
  }
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

export function preferencesApi(options = {}) {
  let dataDir;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/preferences")) return next();

    try {
      if (url.pathname === "/api/preferences" && req.method === "GET") {
        const store = await readPreferencesStore(dataDir);
        const profile = await loadDerivedPreferences(dataDir);
        return json(res, 200, { signalCount: store.signals.length, profile });
      }

      if (url.pathname === "/api/preferences/signal" && req.method === "POST") {
        const input = await body(req);
        const signal = await recordSignal(dataDir, input);
        if (!signal) return json(res, 400, { error: "Unknown signal type" });
        return json(res, 201, signal);
      }

      // Deliberate: there is no endpoint that records "the user ignored this".
      // Without impression tracking that is not a signal, it is an assumption.

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-preferences-api",
    apply: "serve",
    async configResolved(config) {
      dataDir = path.resolve(config.root, setting("WARDROBE_DATA_DIR", "data"));
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
