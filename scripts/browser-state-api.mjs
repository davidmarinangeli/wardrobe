import { mkdir, readFile } from "node:fs/promises";
import { createArchiveRequestHandler } from "./archive-coordinator.mjs";
import path from "node:path";
import { atomicJson } from "./import-job-api.mjs";
import { recordSignalStrict } from "./preferences-api.mjs";
import { mutateLibrary } from "../shared/wardrobe-library.mjs";

const VERSION = 1;
const MIGRATED_FIELDS = ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"];
const MEMBERSHIP_FIELDS = new Set(["declutterKeptIds", "dismissedNudges"]);
const MODEL_TIERS = new Set(["standard", "premium", "openrouter"]);

export function browserStateFile(dataDir) { return path.join(dataDir, "browser-state.json"); }

export function defaultBrowserState() {
  return {
    version: VERSION,
    archiveGeneration: 1,
    revision: 0,
    migrationSealed: false,
    migratedFields: [],
    declutterKeptIds: [],
    dismissedNudges: [],
    modelTier: "standard",
    onboardingDismissed: false,
    wornToday: { day: "", ids: [] },
  };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION
    || !Number.isInteger(value.archiveGeneration) || value.archiveGeneration < 1
    || (value.revision !== undefined && (!Number.isInteger(value.revision) || value.revision < 0))
    || typeof value.migrationSealed !== "boolean" || !Array.isArray(value.migratedFields)
    || !Array.isArray(value.declutterKeptIds) || !value.declutterKeptIds.every((id) => typeof id === "string")
    || !Array.isArray(value.dismissedNudges) || !value.dismissedNudges.every((id) => typeof id === "string")
    || !MODEL_TIERS.has(value.modelTier) || typeof value.onboardingDismissed !== "boolean"
    || !value.wornToday || typeof value.wornToday.day !== "string" || !Array.isArray(value.wornToday.ids)
    || !value.wornToday.ids.every((id) => typeof id === "string")) {
    throw new Error("Browser preference state is invalid; it was left untouched");
  }
  if (value.migratedFields.some((field) => !MIGRATED_FIELDS.includes(field))) throw new Error("Browser preference migration marker is invalid");
    return { ...defaultBrowserState(), ...value, revision: value.revision || 0, migratedFields: [...new Set(value.migratedFields)] };
}

export async function readBrowserState(dataDir) {
  try { return validateState(JSON.parse(await readFile(browserStateFile(dataDir), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return defaultBrowserState(); throw error; }
}

const queues = new Map();
function serialize(file, operation) {
  const previous = queues.get(file) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(file, tail);
  return result.finally(() => { if (queues.get(file) === tail) queues.delete(file); });
}

async function mutateBrowserState(dataDir, mutation, persist = atomicJson) {
  const file = browserStateFile(dataDir);
  return serialize(file, async () => {
    await mkdir(dataDir, { recursive: true });
    const state = await readBrowserState(dataDir);
    const changed = await mutation(structuredClone(state));
    const candidate = validateState({ ...changed, revision: state.revision || 0 });
    if (JSON.stringify(candidate) === JSON.stringify(state)) return state;
    const next = validateState({ ...candidate, revision: (state.revision || 0) + 1 });
    await persist(file, next);
    return next;
  });
}

function safeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))];
}

function normalizeLegacyEdit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const edit = {};
  if (typeof value.name === "string") edit.name = value.name.trim().slice(0, 120);
  if (typeof value.part === "string") edit.part = value.part;
  if (typeof value.color === "string" || value.color === null) edit.color = value.color;
  if (typeof value.secondaryColor === "string" || value.secondaryColor === null) edit.secondaryColor = value.secondaryColor;
  if (Array.isArray(value.tags)) edit.tags = value.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 24);
  return Object.keys(edit).length ? edit : null;
}

async function migrateLegacyValues(dataDir, state, input) {
  const legacy = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const done = new Set(state.migratedFields);
  if (state.migrationSealed) return { ...state, migratedFields: MIGRATED_FIELDS };
  if (!done.has("itemEdits") && Object.hasOwn(legacy, "itemEdits")) {
    const edits = legacy.itemEdits && typeof legacy.itemEdits === "object" && !Array.isArray(legacy.itemEdits) ? legacy.itemEdits : {};
    await mutateLibrary(dataDir, (records) => records.map((record) => {
      const edit = normalizeLegacyEdit(edits[record.id]);
      return edit ? { ...record, ...edit } : record;
    }));
    done.add("itemEdits");
  }
  if (!done.has("deletedIds") && Object.hasOwn(legacy, "deletedIds")) {
    const ids = new Set(safeIds(legacy.deletedIds));
    if (ids.size) await mutateLibrary(dataDir, (records) => records.filter((record) => !ids.has(record.id)));
    done.add("deletedIds");
  }
  if (!done.has("colorProfile") && Object.hasOwn(legacy, "colorProfile")) {
    const profileFile = path.join(dataDir, "color-profile.json");
    let profileExists = true;
    try { await readFile(profileFile); }
    catch (error) { if (error.code === "ENOENT") profileExists = false; else throw error; }
    if (!profileExists && legacy.colorProfile && typeof legacy.colorProfile === "object" && !Array.isArray(legacy.colorProfile)) {
      await atomicJson(profileFile, legacy.colorProfile);
    }
    done.add("colorProfile");
  }
  const next = { ...state, migratedFields: [...done] };
  if (!done.has("declutterKeptIds") && Object.hasOwn(legacy, "declutterKeptIds")) { next.declutterKeptIds = safeIds(legacy.declutterKeptIds); done.add("declutterKeptIds"); }
  if (!done.has("dismissedNudges") && Object.hasOwn(legacy, "dismissedNudges")) { next.dismissedNudges = safeIds(legacy.dismissedNudges); done.add("dismissedNudges"); }
  if (!done.has("modelTier") && Object.hasOwn(legacy, "modelTier")) { if (MODEL_TIERS.has(legacy.modelTier)) next.modelTier = legacy.modelTier; done.add("modelTier"); }
  if (!done.has("onboardingDismissed") && Object.hasOwn(legacy, "onboardingDismissed")) { if (typeof legacy.onboardingDismissed === "boolean") next.onboardingDismissed = legacy.onboardingDismissed; done.add("onboardingDismissed"); }
  if (!done.has("wornToday") && Object.hasOwn(legacy, "wornToday")) {
    const worn = legacy.wornToday;
    if (worn && typeof worn === "object" && /^\d{4}-\d{2}-\d{2}$/.test(worn.day)) next.wornToday = { day: worn.day, ids: safeIds(worn.ids) };
    done.add("wornToday");
  }
  next.migratedFields = [...done];
  return next;
}

export async function sealLegacyBrowserMigration(dataDir) {
  return mutateBrowserState(dataDir, (state) => ({
    ...state,
    migrationSealed: true,
    migratedFields: MIGRATED_FIELDS,
    archiveGeneration: state.archiveGeneration + 1,
  }));
}

export async function markBrowserStateFields(dataDir, fields) {
  const recognized = [...new Set(fields)].filter((field) => MIGRATED_FIELDS.includes(field));
  if (!recognized.length) return readBrowserState(dataDir);
  return mutateBrowserState(dataDir, (state) => ({
    ...state,
    migratedFields: [...new Set([...state.migratedFields, ...recognized])],
  }));
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

export function browserStateApi(options = {}) {
  let dataDir;
  const persistBrowserState = options.persistBrowserState || atomicJson;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/browser-state")) return next();
    try {
      if (url.pathname === "/api/browser-state" && req.method === "GET") return json(res, 200, await readBrowserState(dataDir));
      if (url.pathname === "/api/browser-state/migrate" && req.method === "POST") {
        const input = await readBody(req);
        const state = await mutateBrowserState(dataDir, (current) => migrateLegacyValues(dataDir, current, input.values), persistBrowserState);
        return json(res, 200, { saved: true, state });
      }
      if (url.pathname === "/api/browser-state/seal-legacy-migration" && req.method === "POST") {
        const state = await mutateBrowserState(dataDir, (current) => ({
          ...current,
          migrationSealed: true,
          migratedFields: MIGRATED_FIELDS,
          archiveGeneration: current.archiveGeneration + 1,
        }), persistBrowserState);
        return json(res, 200, { saved: true, state });
      }
      if (url.pathname === "/api/browser-state/update" && req.method === "POST") {
        const input = await readBody(req);
        if (input.field === "wornToday" && input.operation === "membership") {
          if (typeof input.value !== "string" || input.value.length > 200 || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)
            || (input.present !== undefined && typeof input.present !== "boolean")) {
            throw Object.assign(new Error("Wear checkmark update is invalid"), { status: 400 });
          }
          let added = false;
          const state = await mutateBrowserState(dataDir, (current) => {
            const ids = new Set(current.wornToday.day === input.day ? current.wornToday.ids : []);
            added = input.present !== false && !ids.has(input.value);
            if (input.present === false) ids.delete(input.value);
            else ids.add(input.value);
            if (added && Array.isArray(input.signal?.itemIds) && input.signal.itemIds.length) {
              return recordSignalStrict(dataDir, {
                ...(input.signal && typeof input.signal === "object" ? input.signal : {}),
                type: "outfit_worn",
                source: "outfits",
              }, `worn:${input.day}:${input.value}`).then(() => ({
                ...current,
                wornToday: { day: input.day, ids: [...ids] },
                migratedFields: [...new Set([...current.migratedFields, "wornToday"])],
              }));
            }
            return { ...current, wornToday: { day: input.day, ids: [...ids] }, migratedFields: [...new Set([...current.migratedFields, "wornToday"])] };
          }, persistBrowserState);
          return json(res, 200, { saved: true, state, added });
        }
        const state = await mutateBrowserState(dataDir, (current) => {
          if (MEMBERSHIP_FIELDS.has(input.field) && input.operation === "membership") {
            if (typeof input.value !== "string" || input.value.length > 200 || typeof input.present !== "boolean") throw Object.assign(new Error("Membership update is invalid"), { status: 400 });
            const values = new Set(current[input.field]);
            if (input.present) values.add(input.value); else values.delete(input.value);
            return { ...current, [input.field]: [...values], migratedFields: [...new Set([...current.migratedFields, input.field])] };
          }
          if (input.field === "modelTier" && MODEL_TIERS.has(input.value)) return { ...current, modelTier: input.value, migratedFields: [...new Set([...current.migratedFields, "modelTier"])] };
          if (input.field === "onboardingDismissed" && typeof input.value === "boolean") return { ...current, onboardingDismissed: input.value, migratedFields: [...new Set([...current.migratedFields, "onboardingDismissed"])] };
          if (input.field === "wornToday" && input.value && /^\d{4}-\d{2}-\d{2}$/.test(input.value.day) && Array.isArray(input.value.ids)) {
            return { ...current, wornToday: { day: input.value.day, ids: safeIds(input.value.ids) }, migratedFields: [...new Set([...current.migratedFields, "wornToday"])] };
          }
          throw Object.assign(new Error("Browser preference update is invalid"), { status: 400 });
        }, persistBrowserState);
        return json(res, 200, { saved: true, state });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error.status || 500;
      return json(res, status, { error: status === 500 ? "Internal server error" : error.message, ...(status === 500 && process.env.NODE_ENV === "development" ? { detail: error.message } : {}) });
    }
  }
  return {
    name: "wardrobe-browser-state-api",
    apply: "serve",
    configResolved(config) { dataDir = path.resolve(config.root, setting("WARDROBE_DATA_DIR", "data")); },
    configureServer(server) { server.middlewares.use(createArchiveRequestHandler(dataDir, handler)); },
    configurePreviewServer(server) { server.middlewares.use(createArchiveRequestHandler(dataDir, handler)); },
  };
}
