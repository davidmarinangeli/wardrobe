import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserStateClient } from "../src/browser-state.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function eventTarget() {
  const listeners = new Map();
  const target = {
    document: { visibilityState: "visible", addEventListener(name, handler) { listeners.set(`document:${name}`, handler); } },
    addEventListener(name, handler) { listeners.set(name, handler); },
    emit(name) { listeners.get(name)?.(); },
  };
  return target;
}

function state(overrides = {}) {
  return {
    version: 1,
    archiveGeneration: 1,
    revision: 1,
    migratedFields: [],
    migrationSealed: false,
    declutterKeptIds: [],
    dismissedNudges: [],
    modelTier: "standard",
    onboardingDismissed: false,
    wornToday: { day: "", ids: [] },
    ...overrides,
  };
}

test("browser state refreshes on focus, gates writes, and publishes a restored generation", async () => {
  const target = eventTarget();
  const refreshResponse = deferred();
  const calls = [];
  let updateResponse;
  const client = createBrowserStateClient({
    getWindow: () => target,
    request: async (url, options = {}) => {
      calls.push([url, options.method || "GET"]);
      if (url.endsWith("/migrate")) return { state: state({ revision: 2 }) };
      if (url === "/api/browser-state") return refreshResponse.promise;
      if (url.endsWith("/update")) return updateResponse;
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const start = client.ensureReady();
  assert.equal(client.getSnapshot().status, "loading");
  assert.equal(client.getSnapshot().state, null);
  await start;
  assert.equal(client.getSnapshot().state.revision, 2);

  target.emit("focus");
  assert.equal(client.getSnapshot().refreshing, true);
  const pendingUpdate = client.update("/api/browser-state/update", { field: "modelTier", value: "premium" });
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ["/api/browser-state", "GET"], "preference updates wait for the focus refresh");

  const restored = state({ archiveGeneration: 2, revision: 9, modelTier: "premium", declutterKeptIds: ["kept-a"] });
  updateResponse = { state: { ...restored, revision: 10, onboardingDismissed: true } };
  refreshResponse.resolve(restored);
  const result = await pendingUpdate;
  assert.equal(result.state.revision, 10);
  assert.equal(client.getSnapshot().state.archiveGeneration, 2);
  assert.equal(client.getSnapshot().state.modelTier, "premium");
  assert.equal(client.getSnapshot().state.onboardingDismissed, true);
});

test("a failed refresh blocks stale state until a later refresh succeeds", async () => {
  const target = eventTarget();
  let reads = 0;
  const client = createBrowserStateClient({
    getWindow: () => target,
    request: async (url) => {
      if (url.endsWith("/migrate")) return { state: state() };
      if (url === "/api/browser-state") {
        reads += 1;
        if (reads === 1) throw new Error("temporary offline");
        return state({ revision: 4, dismissedNudges: ["few-items"] });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await client.ensureReady();
  await assert.rejects(client.refresh(), /temporary offline/);
  assert.equal(client.getSnapshot().error.message, "temporary offline");
  assert.equal(client.getSnapshot().refreshing, false);
  const fresh = await client.ensureReady();
  assert.equal(fresh.revision, 4);
  assert.deepEqual(fresh.dismissedNudges, ["few-items"]);
  assert.equal(client.getSnapshot().error, null);
});

test("out-of-order updates keep the highest revision and return the accepted snapshot", async () => {
  const responses = new Map();
  const client = createBrowserStateClient({
    request: async (url, options = {}) => {
      if (url.endsWith("/migrate")) return { state: state({ revision: 1 }) };
      if (url.endsWith("/update")) {
        const body = JSON.parse(options.body);
        return responses.get(body.value).promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await client.ensureReady();
  const olderResponse = deferred();
  const newerResponse = deferred();
  responses.set("older", olderResponse);
  responses.set("newer", newerResponse);

  const older = client.update("/api/browser-state/update", { field: "onboardingDismissed", value: "older" });
  const newer = client.update("/api/browser-state/update", { field: "onboardingDismissed", value: "newer" });
  await new Promise((resolve) => setImmediate(resolve));

  newerResponse.resolve({ state: state({ revision: 3, onboardingDismissed: true }) });
  await newer;
  olderResponse.resolve({ state: state({ revision: 2, onboardingDismissed: false }) });
  const olderResult = await older;

  assert.equal(client.getSnapshot().state.revision, 3);
  assert.equal(client.getSnapshot().state.onboardingDismissed, true);
  assert.equal(olderResult.state.revision, 3, "callers also receive the accepted snapshot");
});

test("a focus GET cannot overwrite a newer POST response", async () => {
  const target = eventTarget();
  const postResponse = deferred();
  const getResponse = deferred();
  let postStarted;
  const started = new Promise((resolve) => { postStarted = resolve; });
  const client = createBrowserStateClient({
    getWindow: () => target,
    request: async (url, options = {}) => {
      if (url.endsWith("/migrate")) return { state: state({ revision: 1 }) };
      if (url === "/api/browser-state") return getResponse.promise;
      if (url.endsWith("/update")) { postStarted(); return postResponse.promise; }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await client.ensureReady();

  const post = client.update("/api/browser-state/update", { field: "onboardingDismissed", value: true });
  await started;
  target.emit("focus");
  postResponse.resolve({ state: state({ revision: 3, onboardingDismissed: true }) });
  await post;
  getResponse.resolve(state({ revision: 2, onboardingDismissed: false }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.getSnapshot().state.revision, 3);
  assert.equal(client.getSnapshot().state.onboardingDismissed, true);
  assert.equal(client.getSnapshot().refreshing, false);
  assert.equal(client.getSnapshot().error, null);
});

test("an older archive generation cannot replace a restored snapshot", async () => {
  const bootstrapResponse = deferred();
  const updateResponse = deferred();
  let bootstrapCount = 0;
  const client = createBrowserStateClient({
    request: async (url) => {
      if (url.endsWith("/migrate")) {
        bootstrapCount += 1;
        return bootstrapCount === 1 ? { state: state({ revision: 50 }) } : bootstrapResponse.promise;
      }
      if (url.endsWith("/update")) return updateResponse.promise;
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await client.ensureReady();

  const pendingUpdate = client.update("/api/browser-state/update", { field: "modelTier", value: "premium" });
  await new Promise((resolve) => setImmediate(resolve));
  const pendingBootstrap = client.bootstrap();
  updateResponse.resolve({ state: state({ archiveGeneration: 2, revision: 1, modelTier: "premium" }) });
  await pendingUpdate;
  bootstrapResponse.resolve({ state: state({ archiveGeneration: 1, revision: 999, modelTier: "standard" }) });
  await pendingBootstrap;

  assert.equal(client.getSnapshot().state.archiveGeneration, 2);
  assert.equal(client.getSnapshot().state.revision, 1);
  assert.equal(client.getSnapshot().state.modelTier, "premium");
  assert.equal(client.getSnapshot().status, "ready");
  assert.equal(client.getSnapshot().error, null);
});
