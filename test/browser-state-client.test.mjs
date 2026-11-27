import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapBrowserState } from "../src/browser-state.js";

function makeStorage(initial) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    removeItem(key) { values.delete(key); },
    has(key) { return values.has(key); },
  };
}

test("browser bootstrap clears only valid legacy fields acknowledged by the backend", async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const storage = makeStorage({
    "wardrobe:modeled-tier": "premium",
    "open-wardrobe-deleted-v1": "{malformed json",
    "open-wardrobe-worn-today-v1": JSON.stringify({ day: "not-a-date", ids: ["old"] }),
  });
  globalThis.window = { localStorage: storage };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.values, { modelTier: "premium" });
    return { ok: true, async json() { return { state: { migratedFields: ["modelTier"], migrationSealed: false } }; } };
  };
  try {
    await bootstrapBrowserState();
    assert.equal(storage.has("wardrobe:modeled-tier"), false);
    assert.equal(storage.has("open-wardrobe-deleted-v1"), true);
    assert.equal(storage.has("open-wardrobe-worn-today-v1"), true);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test("failed browser migration leaves valid legacy values available for retry", async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const storage = makeStorage({ "open-wardrobe-onboarding-dismissed-v1": "1" });
  globalThis.window = { localStorage: storage };
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    await assert.rejects(bootstrapBrowserState(), /offline/);
    assert.equal(storage.has("open-wardrobe-onboarding-dismissed-v1"), true);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
