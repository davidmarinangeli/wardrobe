import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api.js";

const LEGACY_KEYS = {
  itemEdits: "open-wardrobe-edits-v1",
  deletedIds: "open-wardrobe-deleted-v1",
  colorProfile: "open-wardrobe-color-profile-v1",
  declutterKeptIds: "open-wardrobe-declutter-kept-v1",
  dismissedNudges: "open-wardrobe-nudges-dismissed-v1",
  modelTier: "wardrobe:modeled-tier",
  onboardingDismissed: "open-wardrobe-onboarding-dismissed-v1",
  wornToday: "open-wardrobe-worn-today-v1",
};

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function isValidLegacyValue(field, value) {
  if (field === "modelTier") return ["standard", "premium", "openrouter"].includes(value);
  if (field === "onboardingDismissed") return typeof value === "boolean";
  if (field === "deletedIds" || field === "declutterKeptIds" || field === "dismissedNudges") {
    return Array.isArray(value) && value.every((id) => typeof id === "string");
  }
  if (field === "colorProfile") return isRecord(value);
  if (field === "wornToday") {
    return isRecord(value) && /^\d{4}-\d{2}-\d{2}$/.test(value.day)
      && Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string");
  }
  if (field === "itemEdits") {
    if (!isRecord(value)) return false;
    return Object.values(value).every((edit) => {
      if (!isRecord(edit)) return false;
      const supported = ["name", "part", "color", "secondaryColor", "tags"].filter((key) => Object.hasOwn(edit, key));
      if (!supported.length) return false;
      return supported.every((key) => key === "tags"
        ? Array.isArray(edit.tags) && edit.tags.every((tag) => typeof tag === "string")
        : key === "color" || key === "secondaryColor"
          ? typeof edit[key] === "string" || edit[key] === null
          : typeof edit[key] === "string");
    });
  }
  return false;
}

function readLegacyValues(storage = typeof window !== "undefined" ? window.localStorage : null) {
  const values = {};
  const submittedFields = [];
  if (!storage) return { values, submittedFields };
  for (const [field, key] of Object.entries(LEGACY_KEYS)) {
    try {
      const raw = storage.getItem(key);
      if (raw == null) continue;
      const value = field === "modelTier"
        ? raw
        : field === "onboardingDismissed"
          ? raw === "1" ? true : raw === "0" ? false : undefined
          : JSON.parse(raw);
      if (value === undefined || !isValidLegacyValue(field, value)) continue;
      values[field] = value;
      submittedFields.push(field);
    } catch {
      // A malformed legacy value is not usable migration input. Keep the raw
      // browser entry until the server acknowledges its one-time migration.
    }
  }
  return { values, submittedFields };
}

export function createBrowserStateClient({ request = api, getWindow = () => typeof window === "undefined" ? null : window } = {}) {
  let snapshot = { status: "idle", state: null, error: null, refreshing: false };
  let readyPromise = null;
  let refreshPromise = null;
  let requestSequence = 0;
  let latestStartedRequestId = 0;
  let pendingStatusRequestId = null;
  let listenersInstalled = false;
  const subscribers = new Set();

  function publish(next) {
    snapshot = next;
    for (const subscriber of subscribers) subscriber();
  }

  function subscribe(subscriber) {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  function getSnapshot() { return snapshot; }

  function compareStateVersion(left, right) {
    if (!right) return 1;
    const leftGeneration = Number.isInteger(left?.archiveGeneration) ? left.archiveGeneration : 0;
    const rightGeneration = Number.isInteger(right.archiveGeneration) ? right.archiveGeneration : 0;
    if (leftGeneration !== rightGeneration) return leftGeneration < rightGeneration ? -1 : 1;
    const leftRevision = Number.isInteger(left?.revision) ? left.revision : 0;
    const rightRevision = Number.isInteger(right.revision) ? right.revision : 0;
    return leftRevision === rightRevision ? 0 : leftRevision < rightRevision ? -1 : 1;
  }

  function acceptState(state, requestId) {
    const current = snapshot.state;
    const comparison = compareStateVersion(state, current);
    if (comparison < 0) {
      // A stale focus/bootstrap response can finish its request, but it must not
      // restore old preferences or overwrite the status from a newer request.
      if (requestId === latestStartedRequestId && pendingStatusRequestId === requestId && snapshot.refreshing) {
        publish({ ...snapshot, refreshing: false });
        pendingStatusRequestId = null;
      }
      return current;
    }

    if (comparison > 0 || !current) publish({ ...snapshot, state });
    if (requestId === latestStartedRequestId) {
      publish({ status: "ready", state: snapshot.state, error: null, refreshing: false });
      pendingStatusRequestId = null;
    }
    return snapshot.state;
  }

  function acceptError(error, requestId) {
    if (requestId !== latestStartedRequestId) return;
    publish({ status: snapshot.state ? "ready" : "error", state: snapshot.state, error, refreshing: false });
    pendingStatusRequestId = null;
  }

  function beginRequest() {
    requestSequence += 1;
    latestStartedRequestId = requestSequence;
    return requestSequence;
  }

  function installRefreshListeners() {
    if (listenersInstalled) return;
    const target = getWindow();
    if (!target?.addEventListener) return;
    const refreshIfVisible = () => {
      if (target.document?.visibilityState === "hidden") return;
      void (snapshot.state ? refresh() : ensureReady()).catch(() => {});
    };
    target.addEventListener("focus", refreshIfVisible);
    target.document?.addEventListener?.("visibilitychange", refreshIfVisible);
    // Browsers do not receive storage events for the server archive. Polling
    // its sealed revision/generation lets another open tab notice a restore
    // even when it stays focused the whole time.
    target.setInterval?.(refreshIfVisible, 15_000);
    listenersInstalled = true;
  }

  async function runBootstrap() {
    installRefreshListeners();
    const target = getWindow();
    const requestId = beginRequest();
    pendingStatusRequestId = requestId;
    if (snapshot.state) publish({ ...snapshot, error: null, refreshing: true });
    else publish({ status: "loading", state: null, error: null, refreshing: false });
    try {
      const { values, submittedFields } = readLegacyValues(target?.localStorage);
      const result = await request("/api/browser-state/migrate", {
        method: "POST",
        body: JSON.stringify({ values }),
      });
      const state = result.state;
      const acceptedState = acceptState(state, requestId);
      // Only clear keys that the server acknowledged. A malformed or unsubmitted
      // legacy value can still be recovered by a later migration attempt.
      const acknowledged = new Set(acceptedState?.migratedFields || []);
      const fieldsToClear = acceptedState?.migrationSealed
        ? Object.keys(LEGACY_KEYS)
        : submittedFields.filter((field) => acknowledged.has(field));
      for (const field of fieldsToClear) {
        try { target?.localStorage?.removeItem(LEGACY_KEYS[field]); } catch { /* storage can be unavailable */ }
      }
      return acceptedState;
    } catch (error) {
      acceptError(error, requestId);
      throw error;
    }
  }

  function ensureReady() {
    installRefreshListeners();
    if (snapshot.status === "ready" && !snapshot.refreshing && !snapshot.error) return Promise.resolve(snapshot.state);
    if (snapshot.status === "ready" && snapshot.refreshing && refreshPromise) return refreshPromise;
    if (snapshot.status === "ready" && snapshot.error) return refresh();
    if (readyPromise) return readyPromise;
    readyPromise = runBootstrap().catch((error) => {
      readyPromise = null;
      throw error;
    });
    return readyPromise;
  }

  function forceBootstrap() {
    readyPromise = null;
    const task = runBootstrap();
    readyPromise = task.catch((error) => {
      readyPromise = null;
      throw error;
    });
    return readyPromise;
  }

  function refresh() {
    if (snapshot.status !== "ready" || !snapshot.state) return ensureReady();
    if (refreshPromise) return refreshPromise;
    const requestId = beginRequest();
    pendingStatusRequestId = requestId;
    publish({ ...snapshot, error: null, refreshing: true });
    refreshPromise = request("/api/browser-state", { cache: "no-store" })
      .then((state) => acceptState(state, requestId))
      .catch((error) => {
        acceptError(error, requestId);
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  async function update(path, body) {
    await ensureReady();
    if (refreshPromise) await refreshPromise;
    const requestId = beginRequest();
    try {
      const result = await request(path, { method: "POST", body: JSON.stringify(body) });
      if (!result.state) return result;
      const acceptedState = acceptState(result.state, requestId);
      return acceptedState === result.state ? result : { ...result, state: acceptedState };
    } catch (error) {
      acceptError(error, requestId);
      throw error;
    }
  }

  return { subscribe, getSnapshot, ensureReady, bootstrap: forceBootstrap, refresh, update };
}

const browserStateClient = createBrowserStateClient();

export function useBrowserState() {
  const snapshot = useSyncExternalStore(browserStateClient.subscribe, browserStateClient.getSnapshot, browserStateClient.getSnapshot);
  useEffect(() => { void browserStateClient.ensureReady().catch(() => {}); }, []);
  return {
    ...snapshot,
    ready: snapshot.status === "ready" && !snapshot.refreshing && !snapshot.error,
  };
}

export async function bootstrapBrowserState() { return browserStateClient.bootstrap(); }
export async function ensureBrowserStateReady() { return browserStateClient.ensureReady(); }
export async function refreshBrowserState() { return browserStateClient.refresh(); }
export async function loadBrowserState() { return browserStateClient.ensureReady(); }

export async function updateBrowserState(field, value) {
  const result = await browserStateClient.update("/api/browser-state/update", { field, value });
  return result.state;
}

export async function updateBrowserSet(field, value, present = true) {
  const result = await browserStateClient.update("/api/browser-state/update", { field, operation: "membership", value, present });
  return result.state;
}

export async function updateWornTodayMembership(id, day, present = true, signal = {}) {
  const result = await browserStateClient.update("/api/browser-state/update", { field: "wornToday", operation: "membership", value: id, day, present, signal });
  return { state: result.state, added: result.added === true };
}

export async function sealBrowserStateMigration() {
  const result = await api("/api/browser-state/seal-legacy-migration", { method: "POST", body: "{}" });
  return result.state;
}
