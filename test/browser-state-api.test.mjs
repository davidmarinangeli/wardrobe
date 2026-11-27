import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { browserStateApi } from "../scripts/browser-state-api.mjs";
import { atomicJson } from "../scripts/import-job-api.mjs";
import { variantApi } from "../scripts/variant-api.mjs";

async function pluginMiddleware(plugin, root) {
  let middleware;
  await plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  assert.ok(middleware);
  return middleware;
}

async function request(middleware, url, method = "GET", value) {
  const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
  req.url = url;
  req.method = method;
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, content) { this.headers[name.toLowerCase()] = content; },
    end(body = Buffer.alloc(0)) { this.body = body; },
  };
  await middleware(req, response, () => { response.statusCode = 404; response.end(); });
  return { status: response.statusCode, value: JSON.parse(Buffer.from(response.body || "{}").toString("utf8")) };
}

test("browser preference writes are atomic memberships and seal stale legacy seeds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-browser-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await pluginMiddleware(browserStateApi({ env: { WARDROBE_DATA_DIR: "." } }), root);

  const emptyMigration = await request(middleware, "/api/browser-state/migrate", "POST", { values: {} });
  assert.equal(emptyMigration.value.state.migratedFields.includes("modelTier"), false);
  const standard = await request(middleware, "/api/browser-state/update", "POST", { field: "modelTier", value: "standard" });
  assert.equal(standard.value.state.migratedFields.includes("modelTier"), true);
  const seeded = await request(middleware, "/api/browser-state/migrate", "POST", { values: { modelTier: "premium", onboardingDismissed: true } });
  assert.equal(seeded.value.state.modelTier, "standard", "a later browser cannot overwrite a server preference");
  assert.equal(seeded.value.state.onboardingDismissed, true, "a submitted legacy key is still migrated once");
  await request(middleware, "/api/browser-state/update", "POST", { field: "onboardingDismissed", value: false });
  const stale = await request(middleware, "/api/browser-state/migrate", "POST", { values: { onboardingDismissed: true } });
  assert.equal(stale.value.state.onboardingDismissed, false);

  await Promise.all([
    request(middleware, "/api/browser-state/update", "POST", { field: "declutterKeptIds", operation: "membership", value: "kept-a", present: true }),
    request(middleware, "/api/browser-state/update", "POST", { field: "declutterKeptIds", operation: "membership", value: "kept-b", present: true }),
    request(middleware, "/api/browser-state/update", "POST", { field: "wornToday", operation: "membership", value: "outfit-a", day: "2026-10-08", present: true }),
    request(middleware, "/api/browser-state/update", "POST", { field: "wornToday", operation: "membership", value: "outfit-b", day: "2026-10-08", present: true }),
  ]);
  const state = await request(middleware, "/api/browser-state");
  assert.deepEqual(new Set(state.value.declutterKeptIds), new Set(["kept-a", "kept-b"]));
  assert.deepEqual(new Set(state.value.wornToday.ids), new Set(["outfit-a", "outfit-b"]));

  const wearSignal = { itemIds: ["shirt-a"], name: "Fixture outfit" };
  const duplicateWear = await Promise.all([
    request(middleware, "/api/browser-state/update", "POST", { field: "wornToday", operation: "membership", value: "outfit-c", day: "2026-10-08", present: true, signal: wearSignal }),
    request(middleware, "/api/browser-state/update", "POST", { field: "wornToday", operation: "membership", value: "outfit-c", day: "2026-10-08", present: true, signal: wearSignal }),
  ]);
  assert.deepEqual(duplicateWear.map((result) => result.value.added).sort(), [false, true]);
  const preferenceStore = JSON.parse(await readFile(path.join(root, "preferences.json"), "utf8"));
  assert.equal(preferenceStore.signals.filter((signal) => signal.type === "outfit_worn" && signal.name === "Fixture outfit").length, 1);

  const generation = state.value.archiveGeneration;
  const sealed = await request(middleware, "/api/browser-state/seal-legacy-migration", "POST", {});
  assert.equal(sealed.value.state.archiveGeneration, generation + 1);
  const afterSeal = await request(middleware, "/api/browser-state/migrate", "POST", { values: { modelTier: "premium", declutterKeptIds: ["stale"] } });
  assert.equal(afterSeal.value.state.modelTier, "standard");
  assert.deepEqual(new Set(afterSeal.value.state.declutterKeptIds), new Set(["kept-a", "kept-b"]));
});

test("no-op browser-state migrations and memberships do not write or bump revision", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-browser-noop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await pluginMiddleware(browserStateApi({ env: { WARDROBE_DATA_DIR: "." } }), root);
  const stateFile = path.join(root, "browser-state.json");

  const emptyMigration = await request(middleware, "/api/browser-state/migrate", "POST", { values: {} });
  assert.equal(emptyMigration.value.state.revision, 0);
  await assert.rejects(readFile(stateFile), { code: "ENOENT" }, "empty bootstrap should not create browser-state.json");

  const initial = await request(middleware, "/api/browser-state/update", "POST", { field: "modelTier", value: "standard" });
  assert.equal(initial.value.state.revision, 1, "adding the authoritative migration marker is a real change");
  const bytesAfterChange = await readFile(stateFile);
  const sameScalar = await request(middleware, "/api/browser-state/update", "POST", { field: "modelTier", value: "standard" });
  assert.equal(sameScalar.value.state.revision, 1);
  assert.deepEqual(await readFile(stateFile), bytesAfterChange);
  const repeatedFieldMigration = await request(middleware, "/api/browser-state/migrate", "POST", { values: { modelTier: "standard" } });
  assert.equal(repeatedFieldMigration.value.state.revision, 1, "a field already marked authoritative is not migrated again");
  assert.deepEqual(await readFile(stateFile), bytesAfterChange);

  const firstAdd = await request(middleware, "/api/browser-state/update", "POST", { field: "declutterKeptIds", operation: "membership", value: "kept-a", present: true });
  assert.equal(firstAdd.value.state.revision, 2);
  const bytesAfterAdd = await readFile(stateFile);
  const duplicateAdd = await request(middleware, "/api/browser-state/update", "POST", { field: "declutterKeptIds", operation: "membership", value: "kept-a", present: true });
  assert.equal(duplicateAdd.value.state.revision, 2);
  assert.deepEqual(await readFile(stateFile), bytesAfterAdd);

  const absentRemove = await request(middleware, "/api/browser-state/update", "POST", { field: "declutterKeptIds", operation: "membership", value: "missing", present: false });
  assert.equal(absentRemove.value.state.revision, 2);
  assert.deepEqual(await readFile(stateFile), bytesAfterAdd);
  const repeatedMigration = await request(middleware, "/api/browser-state/migrate", "POST", { values: {} });
  assert.equal(repeatedMigration.value.state.revision, 2);
  assert.deepEqual(await readFile(stateFile), bytesAfterAdd);
});

test("wear checkmark waits for durable, idempotent history and can retry after either write fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-wear-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await pluginMiddleware(browserStateApi({ env: { WARDROBE_DATA_DIR: "." } }), root);
  const input = { field: "wornToday", operation: "membership", value: "outfit-a", day: "2026-10-08", present: true, signal: { itemIds: ["item-a"], name: "Fixture outfit" } };

  await mkdir(path.join(root, "preferences.json"));
  const historyWriteFailure = await request(middleware, "/api/browser-state/update", "POST", input);
  assert.equal(historyWriteFailure.status, 500);
  const afterHistoryFailure = await request(middleware, "/api/browser-state");
  assert.deepEqual(afterHistoryFailure.value.wornToday.ids, [], "the checkmark remains unset if history was not durable");
  await rm(path.join(root, "preferences.json"), { recursive: true, force: true });

  const saved = await request(middleware, "/api/browser-state/update", "POST", input);
  assert.equal(saved.status, 200);
  assert.equal(saved.value.added, true);
  assert.deepEqual(saved.value.state.wornToday.ids, ["outfit-a"]);
  const history = JSON.parse(await readFile(path.join(root, "preferences.json"), "utf8"));
  assert.equal(history.signals.filter((signal) => signal.idempotencyKey === "worn:2026-10-08:outfit-a").length, 1);

  const corruptRoot = await mkdtemp(path.join(os.tmpdir(), "wardrobe-wear-corrupt-"));
  t.after(() => rm(corruptRoot, { recursive: true, force: true }));
  await writeFile(path.join(corruptRoot, "preferences.json"), "{broken json");
  const corruptMiddleware = await pluginMiddleware(browserStateApi({ env: { WARDROBE_DATA_DIR: "." } }), corruptRoot);
  const corruptAttempt = await request(corruptMiddleware, "/api/browser-state/update", "POST", { ...input, value: "outfit-b" });
  assert.equal(corruptAttempt.status, 500);
  assert.equal(await readFile(path.join(corruptRoot, "preferences.json"), "utf8"), "{broken json");
  assert.deepEqual((await request(corruptMiddleware, "/api/browser-state")).value.wornToday.ids, []);
});

test("a failed checkmark write retries the deduplicated history append before acknowledging", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-wear-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let failOnce = true;
  const middleware = await pluginMiddleware(browserStateApi({
    env: { WARDROBE_DATA_DIR: "." },
    persistBrowserState: async (file, value) => {
      if (failOnce) { failOnce = false; throw new Error("simulated browser-state write failure"); }
      return atomicJson(file, value);
    },
  }), root);
  const input = { field: "wornToday", operation: "membership", value: "outfit-a", day: "2026-10-08", present: true, signal: { itemIds: ["item-a"], name: "Fixture outfit" } };

  const failedCheckmark = await request(middleware, "/api/browser-state/update", "POST", input);
  assert.equal(failedCheckmark.status, 500);
  const persistedAfterFailure = JSON.parse(await readFile(path.join(root, "preferences.json"), "utf8"));
  assert.equal(persistedAfterFailure.signals.filter((signal) => signal.idempotencyKey === "worn:2026-10-08:outfit-a").length, 1);
  assert.deepEqual((await request(middleware, "/api/browser-state")).value.wornToday.ids, []);

  const retry = await request(middleware, "/api/browser-state/update", "POST", input);
  assert.equal(retry.status, 200);
  assert.equal(retry.value.added, true);
  assert.deepEqual(retry.value.state.wornToday.ids, ["outfit-a"]);
  const persistedAfterRetry = JSON.parse(await readFile(path.join(root, "preferences.json"), "utf8"));
  assert.equal(persistedAfterRetry.signals.filter((signal) => signal.idempotencyKey === "worn:2026-10-08:outfit-a").length, 1);
});

test("authoritative item PATCH and DELETE prevent a later browser from replaying stale edits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-item-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "imported"), { recursive: true });
  await writeFile(path.join(root, "library.json"), JSON.stringify([
    { id: "item-a", name: "Before", part: "upperbody", color: "#112233", tags: [], variants: [] },
    { id: "item-b", name: "To delete", part: "upperbody", color: "#112233", tags: [], variants: [] },
  ]));
  const browserMiddleware = await pluginMiddleware(browserStateApi({ env: { WARDROBE_DATA_DIR: "." } }), root);
  const wardrobeMiddleware = await pluginMiddleware(variantApi({ env: { WARDROBE_DATA_DIR: "." } }), root);
  await request(browserMiddleware, "/api/browser-state/migrate", "POST", { values: {} });

  const patched = await request(wardrobeMiddleware, "/api/wardrobe/items/item-a", "PATCH", { name: "Backend edit" });
  assert.equal(patched.status, 200, JSON.stringify(patched.value));
  const deleted = await request(wardrobeMiddleware, "/api/wardrobe/items/item-b", "DELETE");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.value));
  const afterLegacy = await request(browserMiddleware, "/api/browser-state/migrate", "POST", {
    values: { itemEdits: { "item-a": { name: "Stale browser edit" } }, deletedIds: ["item-a"] },
  });
  assert.ok(afterLegacy.value.state.migratedFields.includes("itemEdits"));
  assert.ok(afterLegacy.value.state.migratedFields.includes("deletedIds"));
  const records = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"));
  assert.deepEqual(records.map((record) => [record.id, record.name]), [["item-a", "Backend edit"]]);
});
