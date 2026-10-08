import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { variantApi } from "../scripts/variant-api.mjs";

function makeRequest(url, method, payload, options = {}) {
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => { markBodyStarted = resolve; });
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  const chunks = (async function* () {
    if (!body) return;
    markBodyStarted();
    if (options.gate) await options.gate;
    yield body;
  })();
  const request = Readable.from(chunks);
  request.url = url;
  request.method = method;
  return { request, bodyStarted };
}

async function invoke(handler, url, method, payload, options) {
  const { request, bodyStarted } = makeRequest(url, method, payload, options);
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
  };
  await handler(request, response, () => { response.statusCode = 404; });
  return { ...response, value: JSON.parse(response.body || "null"), bodyStarted };
}

test("bulk tags validate atomically and item edits return the latest tags", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-overview-tags-"));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const initial = [
    { schemaVersion: 2, id: "item-1", name: "First", part: "upperbody", color: "#112233", tags: ["remove-me", "keep"], defaultVariantId: "item-1-v1", variants: [{ id: "item-1-v1", name: "Standard", tags: ["variant-tag"], image: "/first.png" }] },
    { schemaVersion: 2, id: "item-2", name: "Second", part: "lowerbody", color: "#445566", tags: ["keep"], variants: [{ id: "item-2-v1", name: "Standard", tags: ["other-variant-tag"], image: "/second.png" }] },
    { schemaVersion: 2, id: "item-full", name: "Full", part: "upperbody", color: "#778899", tags: Array.from({ length: 24 }, (_, index) => `tag-${index}`), variants: [{ id: "item-full-v1", name: "Standard", image: "/full.png" }] },
  ];
  await writeFile(path.join(dataDir, "library.json"), `${JSON.stringify(initial)}\n`);
  const plugin = variantApi({ env: { WARDROBE_DATA_DIR: dataDir } });
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(next) { handler = next; } } });
  t.after(() => rm(root, { recursive: true, force: true }));

  const baseline = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
  const endpoint = "/api/wardrobe/items/bulk-tags";
  const existingTag = await invoke(handler, endpoint, "PATCH", { itemIds: ["item-1", "item-2"], addTags: [" KEEP "] });
  assert.equal(existingTag.statusCode, 200);
  assert.deepEqual(existingTag.value.items, baseline.slice(0, 2), "adding an existing tag leaves every field unchanged");
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8")), baseline);
  const mixed = await invoke(handler, endpoint, "PATCH", { itemIds: ["item-1", "item-2"], addTags: [" REMOVE-ME "] });
  assert.deepEqual(mixed.value.items[0], baseline[0], "the item that already has the tag stays unchanged");
  assert.deepEqual(mixed.value.items[1].tags, ["keep", "remove-me"]);
  await invoke(handler, endpoint, "PATCH", { itemIds: ["item-2"], removeTags: ["remove-me"] });

  const add = await invoke(handler, endpoint, "PATCH", { itemIds: ["item-1", "item-2"], addTags: ["linen", "Blue"], removeTags: ["keep"] });
  assert.equal(add.statusCode, 200);
  assert.deepEqual(add.value.items.map((item) => item.tags), [["remove-me", "linen", "blue"], ["linen", "blue"]]);
  assert.deepEqual(add.value.items[0].variants[0].tags, ["variant-tag"]);
  const repeated = await invoke(handler, endpoint, "PATCH", { itemIds: ["item-1", "item-2"], addTags: ["linen", "Blue"] });
  assert.deepEqual(repeated.value.items[0].tags, ["remove-me", "linen", "blue"]);

  const beforeInvalid = await readFile(path.join(dataDir, "library.json"), "utf8");
  for (const [payload, expectedStatus] of [
    [{ itemIds: ["item-1", "missing"], addTags: ["new"] }, 404],
    [{ itemIds: ["item-1"], addTags: ["same"], removeTags: ["same"] }, 400],
    [{ itemIds: ["item-full"], addTags: ["overflow"] }, 400],
    [{ itemIds: ["item-1", "item-1"], addTags: ["duplicate"] }, 400],
    [null, 400],
  ]) {
    const result = await invoke(handler, endpoint, "PATCH", payload);
    assert.equal(result.statusCode, expectedStatus);
    assert.equal(await readFile(path.join(dataDir, "library.json"), "utf8"), beforeInvalid, "invalid operations do not partly write");
  }

  let releaseBody;
  const gatedBody = new Promise((resolve) => { releaseBody = resolve; });
  const gated = makeRequest("/api/wardrobe/items/item-1", "PATCH", { name: "Renamed" }, { gate: gatedBody });
  const editResponse = {
    statusCode: 200,
    setHeader() {},
    end(value) { this.body = value; },
  };
  const editPromise = handler(gated.request, editResponse, () => {});
  await gated.bodyStarted;
  await invoke(handler, endpoint, "PATCH", { itemIds: ["item-1"], removeTags: ["remove-me"] });
  releaseBody();
  await editPromise;
  const edited = JSON.parse(editResponse.body);
  const stored = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8")).find((item) => item.id === "item-1");
  assert.deepEqual(edited.tags, ["linen", "blue"]);
  assert.deepEqual(stored.tags, edited.tags);
});
