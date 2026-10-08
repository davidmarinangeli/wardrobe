import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, truncate, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readdir } from "node:fs/promises";
import { build, createServer } from "vite";
import sharp from "sharp";
import { buildArchiveInventory, inspectArchiveCatalogs, prepareArchiveDirectory, readReferenceBytes, validateArchive } from "../scripts/archive-store.mjs";
import { migrateDataDirectory } from "../scripts/wardrobe-data.mjs";
import { archiveMaintenanceStatus, createArchiveAdmissionMiddleware, withArchiveMaintenance, withArchiveWriteLease } from "../scripts/archive-coordinator.mjs";
import { createGoogleDriveArchiveManager, recoverArchiveRestore } from "../scripts/archive-restore.mjs";
import { googleDriveApi } from "../scripts/google-drive-api.mjs";
import { outfitsApi } from "../scripts/outfits-api.mjs";
import { createGoogleDriveSyncWorker } from "../scripts/google-drive-sync.mjs";
import { variantApi } from "../scripts/variant-api.mjs";
import { cheatSheetsApi } from "../scripts/cheat-sheets-api.mjs";
import { wardrobeSetupApi } from "../scripts/setup-api.mjs";
import { wardrobeImportApi } from "../scripts/import-job-api.mjs";
import { inspoApi } from "../scripts/inspo-api.mjs";
import { wishlistApi } from "../scripts/wishlist-api.mjs";
import { suggestionsApi } from "../scripts/suggestions-api.mjs";
import { mirrorApi } from "../scripts/mirror-api.mjs";
import { responsiveImageApi } from "../scripts/responsive-image-api.mjs";
import { preferencesApi } from "../scripts/preferences-api.mjs";
import { colorProfileApi } from "../scripts/color-profile-api.mjs";
import { browserStateApi } from "../scripts/browser-state-api.mjs";
import { createBrowserStateClient } from "../src/browser-state.js";
import { archiveImageSource } from "../src/archive-image-source.js";
import { makeDrive } from "./google-drive-feature04-drive.mjs";

const roots = new Set();
const liveWorkers = new Set();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const root = path.resolve(".");

async function tempRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wardrobe-feature04-"));
  roots.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...liveWorkers].map((worker) => worker.stop()));
  liveWorkers.clear();
  await Promise.all([...roots].map((directory) => rm(directory, { recursive: true, force: true })));
  roots.clear();
});

async function seedArchive(directory, { id = null, generation = 1, preferences = { version: 1, signals: [] } } = {}) {
  await mkdir(directory, { recursive: true });
  const catalogs = {
    "library.json": id ? [{ id }] : [],
    "outfits.json": [],
    "inspo.json": [],
    "wishlist.json": [],
    "cheat-sheets.json": [],
    "preferences.json": preferences,
    "color-profile.json": null,
    "browser-state.json": {
      version: 1, archiveGeneration: generation, revision: 1, migrationSealed: true,
      migratedFields: ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"],
      declutterKeptIds: [], dismissedNudges: [], modelTier: "standard", onboardingDismissed: false,
      wornToday: { day: "", ids: [] },
    },
    "archive-metadata.json": { schemaVersion: 1, archiveGeneration: generation, referenceSources: {} },
    "ai-mode.json": { mode: "prod" },
  };
  for (const [name, value] of Object.entries(catalogs)) await writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`);
  return catalogs;
}

function target() {
  return {
    targetFingerprint: sha("target"), connectionGeneration: randomUUID(), accountId: "account-123",
    folderId: "folder_12345", driveId: null,
  };
}

function realWorker(dataDir, drive, rootId = "root_00001", { now = Date.now } = {}) {
  let currentTarget = {
    targetFingerprint: sha(Buffer.from(`target:${rootId}`)),
    connectionGeneration: "12345678123456781234567812345678",
    accountId: "account_12345", folderId: rootId, driveId: null,
  };
  const service = {
    privateDir: path.join(dataDir, ".google-drive"),
    async getTarget() { return { ...currentTarget }; },
    async getClient() { return drive.client; },
  };
  const worker = createGoogleDriveSyncWorker({ service, dataDir, pollIntervalMs: 60_000, now });
  liveWorkers.add(worker);
  return {
    worker, service, manager: createGoogleDriveArchiveManager({ dataDir, service, worker, now }),
    changeTarget(patch) { currentTarget = { ...currentTarget, ...patch }; },
  };
}

async function finishOperation(manager, expected = "complete") {
  let lastState = null;
  for (let i = 0; i < 2_000; i += 1) {
    const state = lastState = await manager.status();
    if (state.restore?.stage === expected) return state.restore;
    if (state.restore?.stage === "failed" || state.restore?.stage === "recovery_required") throw new Error(`Restore ended ${state.restore.stage}: ${state.restore.error}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Restore did not reach ${expected}; last status: ${JSON.stringify(lastState)}`);
}

async function waitForBackup(worker) {
  for (let i = 0; i < 2_000; i += 1) {
    const status = await worker.getSafeStatus();
    if (status.syncState === "idle" && !status.pendingChanges && status.lastCompletedBackup) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Drive backup did not complete: ${JSON.stringify(await worker.getSafeStatus())}`);
}

async function requestPlugin(plugin, url, method = "GET", value) {
  let middleware;
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  assert.ok(middleware);
  const request = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
  request.url = url;
  request.method = method;
  request.headers = { origin: "http://localhost" };
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, content) { this.headers[name.toLowerCase()] = content; },
    end(value = "") { this.body = Buffer.isBuffer(value) ? value : Buffer.from(value); },
  };
  await middleware(request, response, () => { response.statusCode = 404; response.end(); });
  return { status: response.statusCode, value: JSON.parse(response.body.toString("utf8")) };
}

async function seedCompleteArchive(directory, { generation = 1, itemId = "item-source" } = {}) {
  await seedArchive(directory, { id: itemId, generation });
  const imagePaths = [
    "imported/item.png", "outfits-assets/outfit.png", "outfit-images/look.png",
    "inspo-assets/inspo.png", "wishlist-assets/wish.png", "cheat-sheets-assets/card.png",
    "originals/source.png", "model-reference.png", "model-reference-face.png",
  ];
  for (const [index, relative] of imagePaths.entries()) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), Buffer.from(`original image bytes ${relative} ${index}`));
  }
  const library = [{ id: itemId, image: "imported/item.png", original: "originals/source.png" }];
  await writeFile(path.join(directory, "library.json"), `${JSON.stringify(library)}\n`);
  await writeFile(path.join(directory, "preferences.json"), `${JSON.stringify({
    version: 1, signals: [{ type: "item_removed", at: "2026-09-01T10:00:00.000Z", history: ["removed-id"] }],
  })}\n`);
  return imagePaths;
}

async function seedCrashArchive(directory, itemId, generation = 1, mode = "test") {
  await mkdir(directory, { recursive: true });
  const catalogs = {
    "library.json": [{ id: itemId }],
    "archive-metadata.json": { schemaVersion: 1, archiveGeneration: generation, referenceSources: {} },
    "browser-state.json": {
      version: 1, archiveGeneration: generation, revision: 1, migrationSealed: true,
      migratedFields: ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"],
      declutterKeptIds: [], dismissedNudges: [], modelTier: "standard", onboardingDismissed: false,
      wornToday: { day: "", ids: [] },
    },
    "ai-mode.json": { mode },
  };
  for (const [name, value] of Object.entries(catalogs)) await writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`);
}

function serializedDrive(drive, rootId = "root_00001") {
  return [...drive.nodes.values()].filter((node) => node.id !== rootId && !node.trashed).map((node) => ({
    id: node.id, name: node.name, mimeType: node.mimeType, parentId: node.parents?.[0] || rootId,
    bytes: node.content?.toString("base64") || "", appProperties: node.appProperties || null,
  }));
}

function hydrateDrive(nodes, rootId = "root_00001") {
  const drive = makeDrive(rootId);
  for (const node of nodes.sort((a, b) => Number(a.parentId !== rootId) - Number(b.parentId !== rootId))) {
    const args = { id: node.id, name: node.name, parentId: node.parentId, appProperties: node.appProperties || undefined };
    if (node.mimeType === "application/vnd.google-apps.folder") drive.addFolder(args);
    else drive.addFile({ ...args, mimeType: node.mimeType, bytes: Buffer.from(node.bytes, "base64") });
  }
  return drive;
}

async function rawRootCopy(drive, rootId) {
  const copied = await drive.cloneToRoot(rootId);
  const pointer = copied.children(rootId).find((node) => node.name === "wardrobe-archive-commit.json");
  const snapshot = copied.children(rootId).find((node) => node.name.startsWith("wardrobe-snapshot-"));
  if (pointer) await copied.client.deleteFile(pointer.id);
  if (snapshot) {
    for (const child of copied.children(snapshot.id)) copied.nodes.get(child.id).parents = [rootId];
    await copied.client.deleteFile(snapshot.id);
  }
  return copied;
}

function fakeWorker({ dataDir, remoteDir, localValid = true, localPopulated = true, enabled = true, paused = false, remoteValid = true, remotePopulated = true } = {}) {
  const currentTarget = target();
  const events = [];
  const captures = {};
  let remoteInventoryPromise = buildArchiveInventory(remoteDir);
  const worker = {
    async getSafeStatus() { return { backupEnabled: enabled, syncPaused: paused }; },
    async pauseAndDrain() { events.push("pauseAndDrain"); paused = true; },
    async preview() {
      events.push("readSelectedSource");
      const [localInventory, remoteInventory] = await Promise.all([buildArchiveInventory(dataDir), remoteInventoryPromise]);
      return {
        evidenceId: randomUUID(),
        local: { inventory: localInventory, fingerprint: sha(JSON.stringify(localInventory)), valid: localValid, populated: localPopulated },
        remote: {
          valid: remoteValid, empty: !remotePopulated, exists: true, populated: remotePopulated, inventory: remoteInventory,
          fingerprint: sha(JSON.stringify(remoteInventory)), descriptorFingerprint: sha("descriptor"),
          snapshotName: "wardrobe-snapshot-0123456789abcdefabcd-1-12345678", snapshotId: "snapshot-id-1",
          directory: remoteDir, files: [],
        },
      };
    },
    async cancelPreview() { events.push("cancelPreview"); },
    async resume() { events.push("resume"); paused = false; },
    async commitArchiveChoice(args) {
      captures.commit = { ...args, maintenance: await archiveMaintenanceStatus(dataDir) };
      enabled = true; paused = false; return { backupEnabled: enabled };
    },
    async authorizeRestore(args) {
      captures.authorization = args;
      return { restoreAuthorizationId: randomUUID(), target: currentTarget };
    },
    async invalidateAfterRestore() { return { epoch: 7 }; },
    async completeRestore(args) { captures.complete = args; },
    async bindRestoreIncoming(args) { captures.incoming = args; },
    async verifyRestoreJournal(args) { captures.verifyJournal = args; },
    async finishRestore(args) { captures.finish = args; enabled = true; paused = false; },
    async recoverOrphanRestoreAuthorization() { return true; },
    get events() { return events; },
    get captures() { return captures; },
    get mode() { return { enabled, paused }; },
  };
  return { worker, service: { async getTarget() { return currentTarget; } }, currentTarget };
}

async function createManager(dataDir, remoteDir, options = {}) {
  const fake = fakeWorker({ dataDir, remoteDir, ...options });
  const manager = createGoogleDriveArchiveManager({ dataDir, service: fake.service, worker: fake.worker, onRename: options.onRename, onJournalSave: options.onJournalSave });
  return { ...fake, manager };
}

describe("Google Drive feature 04 archive replacement", { concurrency: false }, () => {
  it("pauses before selected-source reads, serializes previews, and safely resumes on cancel", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const remoteDir = path.join(rootDir, "remote");
    await seedArchive(dataDir);
    await seedArchive(remoteDir, { id: "remote-item" });
    const { manager, worker } = await createManager(dataDir, remoteDir);

    const preview = await manager.preview("activation");
    assert.deepEqual(worker.events.slice(0, 2), ["pauseAndDrain", "readSelectedSource"]);
    assert.equal(preview.decision, "different");
    await assert.rejects(manager.preview("restore"), { code: "archive_maintenance" });
    assert.deepEqual(await manager.choose({ actionToken: preview.actionToken, choice: "cancel", operation: "activation" }), { status: "cancelled" });
    assert.deepEqual(worker.events.slice(-2), ["cancelPreview", "resume"]);
    assert.equal(worker.mode.paused, false);
  });

  it("drains a real async API handler after HTTP abort before archive maintenance", async (t) => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const plugin = inspoApi({ env: { WARDROBE_DATA_DIR: "data" } });
    await plugin.configResolved({ root: rootDir });
    let handler;
    plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
    const admission = createArchiveAdmissionMiddleware(dataDir);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#4488aa" } }).png().toBuffer();
    const oldFetch = global.fetch;
    let releaseFetch;
    let fetchStarted;
    const fetchStartedPromise = new Promise((resolve) => { fetchStarted = resolve; });
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    t.after(() => { global.fetch = oldFetch; });
    global.fetch = async () => {
      fetchStarted();
      await fetchGate;
      return { ok: true, headers: { get() { return "image/png"; } }, async arrayBuffer() { return png; } };
    };

    const req = Readable.from([Buffer.from(JSON.stringify({ url: "https://images.example.test/look.png" }))]);
    req.url = "/api/inspo";
    req.method = "POST";
    req.headers = { origin: "http://localhost" };
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = function setHeader(name, value) { this.headers[name.toLowerCase()] = value; };
    res.end = function end(value = "") {
      this.body = Buffer.isBuffer(value) ? value : Buffer.from(value);
      this.headersSent = true;
      this.writableEnded = true;
      this.emit("finish");
    };
    let handlerPromise;
    admission(req, res, () => { handlerPromise = handler(req, res, () => {}); });
    await fetchStartedPromise;
    res.emit("close");

    let maintenanceEntered = false;
    const maintenance = withArchiveMaintenance(dataDir, async () => { maintenanceEntered = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(maintenanceEntered, false, "an aborted client cannot release the handler's real async writer promise");
    await assert.rejects(readFile(path.join(dataDir, "inspo.json")), { code: "ENOENT" });

    releaseFetch();
    await handlerPromise;
    await maintenance;
    assert.equal(maintenanceEntered, true);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "inspo.json"), "utf8")).length, 1);
  });

  it("keeps defaults empty, publishes only under maintenance, and rejects expired consent", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const remoteDir = path.join(rootDir, "remote");
    await seedArchive(dataDir);
    await seedArchive(remoteDir);
    const fake = fakeWorker({ dataDir, remoteDir, localPopulated: false, remotePopulated: false });
    let now = 1_000;
    const manager = createGoogleDriveArchiveManager({ dataDir, service: fake.service, worker: fake.worker, now: () => now });
    const preview = await manager.preview("activation");
    assert.equal(preview.decision, "initialize");
    now += 600_001;
    await assert.rejects(manager.choose({ actionToken: preview.actionToken, choice: "initialize", operation: "activation" }), { code: "sync_conflict" });
    assert.ok(fake.worker.events.includes("cancelPreview"));
    assert.ok(fake.worker.events.includes("resume"));
    const freshPreview = await manager.preview("activation");
    const result = await manager.choose({ actionToken: freshPreview.actionToken, choice: "initialize", operation: "activation" });
    assert.equal(result.status, "complete");
    assert.equal(fake.worker.captures.commit.maintenance.active, true);
  });

  it("repairs malformed local catalogs with a total manual replacement and advances past both generations", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const remoteDir = path.join(rootDir, "remote");
    await seedArchive(dataDir, { generation: 12 });
    await writeFile(path.join(dataDir, "library.json"), "{corrupt local catalog\n");
    await writeFile(path.join(dataDir, "wishlist.json"), JSON.stringify([{ id: "local-only" }]));
    await seedArchive(remoteDir, { id: "drive-item", generation: 21 });
    await unlink(path.join(remoteDir, "wishlist.json"));
    await mkdir(path.join(remoteDir, "imported"), { recursive: true });
    const media = Buffer.from("portable-image-bytes");
    await writeFile(path.join(remoteDir, "imported", "same-path.png"), media);
    const { manager, worker } = await createManager(dataDir, remoteDir, { localValid: false });

    const preview = await manager.preview("restore");
    assert.equal(preview.decision, "local_invalid");
    assert.deepEqual(preview.choices, ["use-drive", "cancel"]);
    const chosen = await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
    assert.equal(chosen.status, "running");
    await finishOperation(manager);
    assert.equal(worker.captures.authorization.activate, false, "manual restore must preserve the selected mode");
    assert.equal(worker.captures.complete.keepPaused, true);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"))[0].id, "drive-item");
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "archive-metadata.json"), "utf8")).archiveGeneration, 22);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "browser-state.json"), "utf8")).archiveGeneration, 22);
    assert.deepEqual(await readFile(path.join(dataDir, "imported", "same-path.png")), media);
    await assert.rejects(readFile(path.join(dataDir, "wishlist.json")), { code: "ENOENT" }, "local-only domains are removed");
  });

  it("starts all archive writer plugins with malformed local data and repairs it through the Drive API", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const remoteDir = path.join(rootDir, "remote");
    await seedArchive(dataDir, { generation: 12 });
    const corruptLibrary = Buffer.from("{broken local library\n");
    await writeFile(path.join(dataDir, "library.json"), corruptLibrary);
    await seedArchive(remoteDir, { id: "drive-item", generation: 21 });

    const fake = fakeWorker({ dataDir, remoteDir, localValid: false });
    fake.worker.start = () => {};
    fake.worker.stop = async () => {};
    liveWorkers.add(fake.worker);
    fake.service.privateDir = path.join(dataDir, ".google-drive");
    fake.service.callbackOrigin = "http://localhost";
    fake.service.getStatus = async () => ({ state: "connected" });
    const env = { WARDROBE_DATA_DIR: "data" };
    const drivePlugin = googleDriveApi({ env, service: fake.service, syncWorker: fake.worker });
    const server = await createServer({
      root: rootDir,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
      plugins: [
        drivePlugin,
        responsiveImageApi(),
        wardrobeImportApi({ env }),
        outfitsApi({ env }),
        inspoApi({ env }),
        wishlistApi({ env }),
        suggestionsApi({ env }),
        mirrorApi({ env }),
        wardrobeSetupApi({ env }),
        preferencesApi({ env }),
        colorProfileApi({ env }),
        variantApi({ env }),
        cheatSheetsApi({ env }),
        browserStateApi({ env }),
      ],
    });
    try {
      assert.deepEqual(await readFile(path.join(dataDir, "library.json")), corruptLibrary, "startup keeps malformed user bytes intact");
      assert.equal(await lstat(path.join(dataDir, "imported")).then(() => true, () => false), false, "variant startup skips its lazy asset directory");
      assert.equal(await lstat(path.join(dataDir, "cheat-sheets-assets")).then(() => true, () => false), false, "cheat-sheet restart recovery is skipped");

      const preview = await requestPlugin(drivePlugin, "/api/google-drive/archive/restore/preview", "POST", {});
      assert.equal(preview.status, 200);
      assert.equal(preview.value.decision, "local_invalid");
      const confirm = await requestPlugin(drivePlugin, "/api/google-drive/archive/restore/confirm", "POST", {
        actionToken: preview.value.actionToken,
        choice: "use-drive",
      });
      assert.equal(confirm.status, 202);
      let restored = null;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const status = await requestPlugin(drivePlugin, "/api/google-drive/archive/status");
        if (status.value.restore?.stage === "complete") { restored = status.value.restore; break; }
        if (["failed", "recovery_required"].includes(status.value.restore?.stage)) {
          throw new Error(`API restore ended ${status.value.restore.stage}: ${status.value.restore.error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(restored, "manual restore completes through the Google Drive API after actual Vite startup");
      assert.equal(JSON.parse(await readFile(path.join(dataDir, "library.json")))[0].id, "drive-item");
    } finally {
      await server.close();
    }
  });

  it("skips startup migration without normalizing a JSON-valid but malformed user catalog", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    await seedArchive(dataDir);
    const invalidLibrary = Buffer.from('[{"id":"legacy-item","variants":17}]\n');
    await writeFile(path.join(dataDir, "library.json"), invalidLibrary);
    assert.deepEqual(await inspectArchiveCatalogs(dataDir), { valid: false, invalidCatalogs: ["library.json"] });

    const migration = await migrateDataDirectory(dataDir);
    assert.equal(migration.skipped, true);
    assert.deepEqual(await readFile(path.join(dataDir, "library.json")), invalidLibrary);
  });

  it("treats a gate removed between contention lstat and read as an ordinary retry", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    await seedArchive(dataDir);
    const writes = await Promise.all(Array.from({ length: 32 }, (_, index) => withArchiveWriteLease(dataDir, async () => {
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      return index;
    })));
    assert.deepEqual(writes.sort((a, b) => a - b), Array.from({ length: 32 }, (_, index) => index));
    assert.equal(await lstat(path.join(dataDir, ".google-drive", "archive-coordination", "gate.lock")).then(() => true, () => false), false);
  });

  it("rolls back byte-for-byte when a replacement rename fails", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const remoteDir = path.join(rootDir, "remote");
    const old = await seedArchive(dataDir, { id: "local-item", generation: 2 });
    await seedArchive(remoteDir, { id: "drive-item", generation: 3 });
    const original = await readFile(path.join(dataDir, "library.json"));
    let failOnce = true;
    const { manager } = await createManager(dataDir, remoteDir, {
      onRename(label) { if (failOnce && label === "old:library.json:after") { failOnce = false; throw new Error("simulated process interruption"); } },
    });
    const preview = await manager.preview("restore");
    assert.equal((await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" })).status, "running");
    await finishOperation(manager, "failed");
    assert.deepEqual(await readFile(path.join(dataDir, "library.json")), original);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "archive-metadata.json"), "utf8")).archiveGeneration, old["archive-metadata.json"].archiveGeneration);
  });

  it("does not create private controls, recover journals, or change archive bytes during Vite build", async () => {
    const temporary = await tempRoot();
    const dataDir = path.join(temporary, "data");
    await mkdir(dataDir, { recursive: true });
    const archiveBytes = Buffer.from("{invalid-but-must-remain-unread-during-build\n");
    await writeFile(path.join(dataDir, "library.json"), archiveBytes);
    await build({
      configFile: false, envFile: false, root, logLevel: "silent",
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: dataDir } })],
      build: { outDir: path.join(temporary, "dist"), emptyOutDir: true },
    });
    assert.deepEqual(await readFile(path.join(dataDir, "library.json")), archiveBytes);
    await assert.rejects(lstat(path.join(dataDir, ".google-drive")), { code: "ENOENT" });
  });

  it("rejects oversized sparse restore and coordination controls before reading them and preserves the files", async () => {
    const temporary = await tempRoot();
    const dataDir = path.join(temporary, "data");
    const journal = path.join(dataDir, ".google-drive", "restore", "restore-journal.json");
    const maintenance = path.join(dataDir, ".google-drive", "archive-coordination", "maintenance.json");
    const gateDataDir = path.join(temporary, "oversized-gate");
    const gate = path.join(gateDataDir, ".google-drive", "archive-coordination", "gate.lock");
    await mkdir(path.dirname(journal), { recursive: true });
    await mkdir(path.dirname(maintenance), { recursive: true });
    await mkdir(path.dirname(gate), { recursive: true });
    await writeFile(journal, "x");
    await truncate(journal, 4 * 1024 * 1024 + 1);
    await writeFile(maintenance, "x");
    await truncate(maintenance, 16 * 1024 + 1);
    await writeFile(gate, "x");
    await truncate(gate, 16 * 1024 + 1);

    await assert.rejects(recoverArchiveRestore({ dataDir }), { code: "archive_control_invalid" });
    assert.equal((await lstat(journal)).size, 4 * 1024 * 1024 + 1, "invalid journal remains available for diagnosis");
    assert.deepEqual(await archiveMaintenanceStatus(dataDir), { active: true, error: "archive_control_invalid" });
    assert.equal((await lstat(maintenance)).size, 16 * 1024 + 1, "invalid maintenance record remains available for diagnosis");
    await assert.rejects(withArchiveWriteLease(gateDataDir, () => {}), { code: "archive_control_invalid" });
    assert.equal((await lstat(gate)).size, 16 * 1024 + 1, "oversized gate remains available for diagnosis");
  });

  it("uses real Drive evidence for default-empty preferences, populated history, and 403 handling", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    await seedArchive(dataDir, { generation: 4 });
    const drive = makeDrive();
    const { manager, worker } = realWorker(dataDir, drive);

    const defaults = await manager.preview("activation");
    assert.equal(defaults.local.populated, false, "sealed migration defaults and revision bumps are empty");
    assert.equal(defaults.decision, "initialize");
    assert.equal((await manager.choose({ actionToken: defaults.actionToken, choice: "initialize", operation: "activation" })).status, "complete");
    assert.equal((await worker.getSafeStatus()).backupEnabled, true);

    await writeFile(path.join(dataDir, "preferences.json"), `${JSON.stringify({ version: 1, signals: [
      { type: "item_removed", at: "2026-09-01T10:00:00.000Z", history: ["removed-garment-id"] },
    ] })}\n`);
    const history = await manager.preview("activation");
    assert.equal(history.local.populated, true, "signals history is user data even when its referenced item was removed");
    assert.equal(history.decision, "local_to_empty");
    await manager.choose({ actionToken: history.actionToken, choice: "cancel", operation: "activation" });

    drive.failListings(Object.assign(new Error("permission denied"), { status: 403, code: "folder_read_denied" }));
    const denied = await manager.preview("activation");
    assert.equal(denied.remote.valid, false);
    assert.equal(denied.remote.empty, false, "403 cannot be interpreted as an empty archive");
    assert.deepEqual(denied.choices, ["cancel"]);
    await manager.choose({ actionToken: denied.actionToken, choice: "cancel", operation: "activation" });
  });

  it("changes same-path media cache keys by generation and rejects stale browser-state replies", async () => {
    const oldUrl = archiveImageSource("outfit-images/look.png", 7);
    const newUrl = archiveImageSource("outfit-images/look.png", 8);
    assert.equal(oldUrl, "/api/archive/assets/outfit-images/look.png?archiveGeneration=7");
    assert.equal(newUrl, "/api/archive/assets/outfit-images/look.png?archiveGeneration=8");
    assert.notEqual(oldUrl, newUrl, "same-path restored bytes receive a different browser and IPX cache key");
    assert.equal(archiveImageSource("/api/import/library/item.png?variant=front", 12), "/api/import/library/item.png?variant=front&archiveGeneration=12");
    assert.equal(archiveImageSource("/outfit-images/look.png", 12), "/api/archive/assets/outfit-images/look.png?archiveGeneration=12", "public-style aliases use a generation-keyed archive route instead of losing the key in IPX normalization");
    assert.equal(archiveImageSource("/public/brand-mark.svg", 12), "/public/brand-mark.svg");

    let releaseOldReply;
    const laterState = { archiveGeneration: 3, revision: 1, migrationSealed: true, migratedFields: [] };
    const windowMock = {
      addEventListener() {},
      setInterval() { return 1; },
      document: { visibilityState: "visible", addEventListener() {} },
    };
    let migrationCalls = 0;
    const client = createBrowserStateClient({
      getWindow: () => windowMock,
      request: (url) => {
        if (url === "/api/browser-state/migrate") {
          migrationCalls += 1;
          return Promise.resolve({ state: { ...laterState, archiveGeneration: migrationCalls === 1 ? 1 : 3 } });
        }
        return new Promise((resolve) => { releaseOldReply = () => resolve({ archiveGeneration: 2, revision: 99 }); });
      },
    });
    await client.ensureReady();
    const oldReply = client.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await client.bootstrap();
    releaseOldReply();
    await oldReply;
    assert.equal(client.getSnapshot().state.archiveGeneration, 3);
    assert.equal(client.getSnapshot().state.revision, 1);
  });

  it("rejects checksum-correct malformed domain schemas before publication or restore", async () => {
    const malformed = [
      ["library.json", [{ id: "bad-library", variants: 17 }]],
      ["library.json", [{ id: "bad-library-asset", variants: [{ id: "variant", cutout: { image: true } }] }]],
      ["outfits.json", [{ id: "bad-outfit", pieces: "bad" }]],
      ["inspo.json", [{ id: "bad-inspo", colors: { red: true } }]],
      ["wishlist.json", [{ id: "bad-wishlist", cropImage: true }]],
      ["cheat-sheets.json", [{ id: "bad-sheet", pieces: [{ itemId: "item" }], bands: "bad" }]],
      ["cheat-sheets.json", [{ id: "bad-sheet-settings", settings: { pieceScales: { item: 2 } } }]],
    ];

    for (const [catalog, invalidValue] of malformed) {
      const rootDir = await tempRoot();
      const dataDir = path.join(rootDir, "data");
      const remoteDir = path.join(rootDir, "remote");
      await seedArchive(dataDir, { id: "keep-local" });
      const original = await readFile(path.join(dataDir, "library.json"));
      await seedArchive(remoteDir, { id: "remote-item" });
      await writeFile(path.join(remoteDir, catalog), `${JSON.stringify(invalidValue)}\n`);
      const inventory = await buildArchiveInventory(remoteDir);
      const entry = inventory.files.find((file) => file.path === catalog);
      assert.equal(entry.sha256, sha(await readFile(path.join(remoteDir, catalog))), `${catalog} inventory checksum matches its malformed bytes`);
      assert.equal((await validateArchive(remoteDir, inventory)).valid, false, `${catalog} schema validation rejects the correctly checksummed archive`);

      const { manager } = await createManager(dataDir, remoteDir);
      const preview = await manager.preview("restore");
      await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
      await assert.rejects(finishOperation(manager), /Restore ended failed/, `${catalog} cannot replace the local archive`);
      assert.deepEqual(await readFile(path.join(dataDir, "library.json")), original, `${catalog} failure preserves old local bytes`);
    }
  });

  it("keeps restore evidence pinned past the preview TTL after authorization is active", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const drive = makeDrive();
    await seedCrashArchive(sourceDir, "drive-version", 1, "prod");
    let clock = 1_000;
    const source = realWorker(sourceDir, drive, "root_00001", { now: () => clock });
    const first = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: first.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);

    const dataDir = path.join(rootDir, "restore");
    await seedCrashArchive(dataDir, "old-version", 1);
    let releaseJournal;
    let journalEntered;
    const journalWaiting = new Promise((resolve) => { journalEntered = resolve; });
    const journalGate = new Promise((resolve) => { releaseJournal = resolve; });
    let pausedAtJournal = false;
    const base = realWorker(dataDir, drive, "root_00001", { now: () => clock });
    const manager = createGoogleDriveArchiveManager({
      dataDir, service: base.service, worker: base.worker, now: () => clock,
      async onJournalSave() {
        if (pausedAtJournal) return;
        pausedAtJournal = true;
        journalEntered();
        await journalGate;
      },
    });
    const preview = await manager.preview("restore");
    await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
    await journalWaiting;
    clock += 700_001;
    releaseJournal();
    await finishOperation(manager);
    const status = await base.worker.getSafeStatus();
    assert.equal(status.backupEnabled, false, "manual restore still preserves the prior disabled mode after a long pause");
    assert.equal(status.syncPaused, true);
  });

  it("holds maintenance behind the actual delayed modeled-image pipeline after its API returns 202", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const importedDir = path.join(dataDir, "imported");
    await mkdir(importedDir, { recursive: true });
    const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: "#13a2e0" } }).png().toBuffer();
    await writeFile(path.join(dataDir, "model-reference.png"), png);
    await writeFile(path.join(importedDir, "coat.png"), png);
    await writeFile(path.join(dataDir, "library.json"), `${JSON.stringify([{
      id: "coat-1", name: "Coat", part: "upperbody", color: "#13a2e0", image: "imported/coat.png", thumbnail: "imported/coat.png",
      variants: [{ id: "front", name: "Front", approvalStatus: "approved", image: "imported/coat.png", cutout: { image: "imported/coat.png", status: "current" }, assetRevision: 1 }],
      defaultVariantId: "front",
    }])}\n`);

    let releaseProvider;
    let providerStarted;
    const providerWaiting = new Promise((resolve) => { providerStarted = resolve; });
    const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
    const env = {
      WARDROBE_DATA_DIR: dataDir,
      WARDROBE_MODEL_REFERENCE: "data/model-reference.png",
      AI_PROVIDER: "openai", OPENAI_API_KEY: "fake-local-test-key",
      OPENAI_API_BASE_URL: "https://local-provider.invalid/v1",
      OPENAI_MODELED_MODEL: "gpt-image-1", OPENAI_MODELED_QUALITY: "medium",
    };
    const plugin = variantApi({ env });
    await plugin.configResolved({ root: rootDir });
    let route;
    plugin.configureServer({ middlewares: { use(handler) { route = handler; } } });
    const admission = createArchiveAdmissionMiddleware(dataDir);
    let maintenanceEntered = false;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        if (String(url) !== "https://local-provider.invalid/v1/images/edits") throw new Error("Unexpected network request in fake provider test");
        providerStarted();
        await providerGate;
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      const req = Readable.from([Buffer.from("{}")]);
      req.method = "POST";
      req.url = "/api/wardrobe/items/coat-1/variants/front/modeled";
      req.headers = { "content-type": "application/json" };
      const res = new EventEmitter();
      res.headersSent = false;
      res.writableEnded = false;
      res.statusCode = 200;
      res.headers = {};
      res.setHeader = (name, value) => { res.headers[name] = value; };
      res.end = (body = "") => {
        res.body = String(body);
        res.headersSent = true;
        res.writableEnded = true;
        queueMicrotask(() => res.emit("finish"));
      };
      const responseFinished = new Promise((resolve) => res.once("finish", resolve));
      admission(req, res, () => { void route(req, res, () => res.end("not found")); });
      await responseFinished;
      assert.equal(res.statusCode, 202, res.body);
      await providerWaiting;
      const maintenance = withArchiveMaintenance(dataDir, async () => {
        maintenanceEntered = true;
        const records = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
        assert.equal(records[0].variants[0].modeledStatus, "approved", "post-response pipeline writes finish before maintenance can enter");
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(maintenanceEntered, false, "maintenance waits on the real provider request and its subsequent archive writes");
      releaseProvider();
      await maintenance;
      assert.equal(maintenanceEntered, true);
    } finally {
      releaseProvider();
      globalThis.fetch = originalFetch;
    }
  });

  it("drains a separate CLI process lease and rejects new writers while a replacement is waiting", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const imagesDir = path.join(rootDir, "images");
    const manifest = path.join(rootDir, "manifest.pipe");
    await mkdir(dataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await writeFile(path.join(dataDir, "archive-metadata.json"), JSON.stringify({ schemaVersion: 1, archiveGeneration: 4, referenceSources: {} }));
    execFileSync("mkfifo", [manifest]);
    const child = spawn(process.execPath, [
      path.join(root, "scripts/apply-prepared-outfits.mjs"),
      "--manifest", manifest, "--images", imagesDir, "--repo", rootDir,
    ], { cwd: root, env: { ...process.env, WARDROBE_DATA_DIR: "data" }, stdio: ["ignore", "pipe", "pipe"] });
    let childOutput = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
    const leaseDir = path.join(dataDir, ".google-drive", "archive-coordination", "leases");
    let leaseFound = false;
    for (let i = 0; i < 300 && !leaseFound; i += 1) {
      const leases = await readdir(leaseDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
      for (const name of leases) {
        const record = JSON.parse(await readFile(path.join(leaseDir, name), "utf8"));
        if (record.pid === child.pid) leaseFound = true;
      }
      if (!leaseFound) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(leaseFound, true, "CLI acquired a process-safe archive lease before reading its manifest");

    let maintenanceEntered = false;
    const maintenance = withArchiveMaintenance(dataDir, async () => { maintenanceEntered = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(maintenanceEntered, false, "maintenance waits for the live CLI writer lease");
    await assert.rejects(withArchiveWriteLease(dataDir, async () => {}), { code: "archive_maintenance" });
    await writeFile(manifest, "{}");
    const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.equal(exit.code, 1);
    assert.match(childOutput, /Prepared outfits are stale/);
    await maintenance;
    assert.equal(maintenanceEntered, true);
  });

  it("restores a real Drive snapshot as a total replacement with every catalog, reference, and media byte", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const localDir = path.join(rootDir, "local");
    const mediaPaths = await seedCompleteArchive(sourceDir, { generation: 14 });
    const drive = makeDrive();
    const source = realWorker(sourceDir, drive);
    const initial = await source.manager.preview("activation");
    assert.equal(initial.decision, "local_to_empty");
    assert.equal((await source.manager.choose({ actionToken: initial.actionToken, choice: "use-local", operation: "activation" })).status, "complete");
    await waitForBackup(source.worker);

    await seedArchive(localDir, { id: "will-be-replaced", generation: 2 });
    await writeFile(path.join(localDir, "wishlist.json"), JSON.stringify([{ id: "local-only" }]) + "\n");
    await mkdir(path.join(localDir, "wishlist-assets"), { recursive: true });
    await writeFile(path.join(localDir, "wishlist-assets", "extra.png"), Buffer.from("remove this local-only asset"));
    const local = realWorker(localDir, drive, "root_00001");
    const preview = await local.manager.preview("activation");
    assert.equal(preview.decision, "different");
    const chosen = await local.manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "activation" });
    assert.equal(chosen.status, "running");
    await finishOperation(local.manager);

    const restored = JSON.parse(await readFile(path.join(localDir, "library.json"), "utf8"));
    assert.equal(restored[0].id, "item-source");
    assert.deepEqual(JSON.parse(await readFile(path.join(localDir, "preferences.json"), "utf8")).signals[0].history, ["removed-id"]);
    for (const relative of mediaPaths) {
      assert.deepEqual(await readFile(path.join(localDir, relative)), await readFile(path.join(sourceDir, relative)), relative);
    }
    await assert.rejects(readFile(path.join(localDir, "wishlist-assets", "extra.png")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(path.join(localDir, "wishlist.json"), "utf8")), []);
    const metadata = JSON.parse(await readFile(path.join(localDir, "archive-metadata.json"), "utf8"));
    const state = JSON.parse(await readFile(path.join(localDir, "browser-state.json"), "utf8"));
    assert.equal(metadata.archiveGeneration, 15);
    assert.equal(state.archiveGeneration, 15);
    assert.equal(state.migrationSealed, true);
    assert.deepEqual(state.migratedFields, ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"]);
    assert.equal((await local.worker.getSafeStatus()).backupEnabled, true, "activation via use-drive enables backup");
  });

  it("preserves disabled mode for manual restore and rejects local/remote/target-stale activation evidence", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const drive = makeDrive();
    await seedArchive(sourceDir, { id: "remote-record" });
    const source = realWorker(sourceDir, drive);
    const first = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: first.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);

    const disabledDir = path.join(rootDir, "disabled");
    await seedArchive(disabledDir);
    const disabled = realWorker(disabledDir, drive);
    const manual = await disabled.manager.preview("restore");
    assert.equal(manual.decision, "drive_to_empty");
    await disabled.manager.choose({ actionToken: manual.actionToken, choice: "use-drive", operation: "restore" });
    await finishOperation(disabled.manager);
    const status = await disabled.worker.getSafeStatus();
    assert.equal(status.backupEnabled, false);
    assert.equal(status.syncPaused, true);

    const localStaleDir = path.join(rootDir, "local-stale");
    await seedArchive(localStaleDir, { id: "local-record" });
    const localStale = realWorker(localStaleDir, drive);
    const localEvidence = await localStale.manager.preview("activation");
    await writeFile(path.join(localStaleDir, "library.json"), JSON.stringify([{ id: "edited-after-preview" }]) + "\n");
    await assert.rejects(localStale.manager.choose({ actionToken: localEvidence.actionToken, choice: "use-local", operation: "activation" }), { code: "snapshot_changed" });

    const targetStaleDir = path.join(rootDir, "target-stale");
    await seedArchive(targetStaleDir, { id: "target-record" });
    const targetStale = realWorker(targetStaleDir, drive);
    const targetEvidence = await targetStale.manager.preview("activation");
    targetStale.changeTarget({ folderId: "root_00002" });
    await assert.rejects(targetStale.manager.choose({ actionToken: targetEvidence.actionToken, choice: "use-local", operation: "activation" }), { code: "target_changed" });

    const remoteStaleDir = path.join(rootDir, "remote-stale");
    await seedArchive(remoteStaleDir);
    const remoteStale = realWorker(remoteStaleDir, drive);
    const remoteEvidence = await remoteStale.manager.preview("restore");
    const remoteFile = drive.children().find((node) => node.name === "wardrobe-archive-commit.json");
    drive.nodes.get(remoteFile.id).content = Buffer.from("{}");
    await assert.rejects(remoteStale.manager.choose({ actionToken: remoteEvidence.actionToken, choice: "use-drive", operation: "restore" }), (error) => ["sync_conflict", "archive_invalid"].includes(error.code));
  });

  it("offers exact Drive replacement for manual equivalent and valid empty snapshots", async () => {
    const rootDir = await tempRoot();

    const equivalentDrive = makeDrive();
    const equivalentSourceDir = path.join(rootDir, "equivalent-source");
    const equivalentLocalDir = path.join(rootDir, "equivalent-local");
    await seedArchive(equivalentSourceDir, { id: "same-record", generation: 4 });
    await seedArchive(equivalentLocalDir, { id: "same-record", generation: 4 });
    const equivalentSource = realWorker(equivalentSourceDir, equivalentDrive);
    const sourcePreview = await equivalentSource.manager.preview("activation");
    await equivalentSource.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(equivalentSource.worker);

    const equivalentLocal = realWorker(equivalentLocalDir, equivalentDrive);
    const equivalentPreview = await equivalentLocal.manager.preview("restore");
    assert.equal(equivalentPreview.decision, "equivalent");
    assert.deepEqual(equivalentPreview.choices, ["use-drive", "cancel"]);
    await equivalentLocal.manager.choose({ actionToken: equivalentPreview.actionToken, choice: "use-drive", operation: "restore" });
    await finishOperation(equivalentLocal.manager);
    assert.equal((await equivalentLocal.worker.getSafeStatus()).backupEnabled, false, "manual equivalent restore preserves the disabled choice");

    const emptyDrive = makeDrive();
    const emptySourceDir = path.join(rootDir, "empty-source");
    const populatedLocalDir = path.join(rootDir, "empty-local");
    await seedArchive(emptySourceDir, { generation: 7 });
    const emptySource = realWorker(emptySourceDir, emptyDrive);
    const emptyPreview = await emptySource.manager.preview("activation");
    assert.equal(emptyPreview.decision, "initialize");
    await emptySource.manager.choose({ actionToken: emptyPreview.actionToken, choice: "initialize", operation: "activation" });
    await waitForBackup(emptySource.worker);

    await seedArchive(populatedLocalDir, { id: "remove-this-record", generation: 2 });
    await mkdir(path.join(populatedLocalDir, "imported"), { recursive: true });
    await writeFile(path.join(populatedLocalDir, "imported", "remove-this.png"), Buffer.from("old local media"));
    const emptyLocal = realWorker(populatedLocalDir, emptyDrive);
    const validEmptyPreview = await emptyLocal.manager.preview("restore");
    assert.equal(validEmptyPreview.decision, "local_to_empty");
    assert.deepEqual(validEmptyPreview.choices, ["use-drive", "cancel"]);
    await emptyLocal.manager.choose({ actionToken: validEmptyPreview.actionToken, choice: "use-drive", operation: "restore" });
    await finishOperation(emptyLocal.manager);
    assert.deepEqual(JSON.parse(await readFile(path.join(populatedLocalDir, "library.json"), "utf8")), []);
    await assert.rejects(readFile(path.join(populatedLocalDir, "imported", "remove-this.png")), { code: "ENOENT" });
    assert.equal((await emptyLocal.worker.getSafeStatus()).backupEnabled, false, "valid empty manual restore still preserves the disabled choice");
  });

  it("keeps a late admitted writer's bytes when restore drains it after preview", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const drive = makeDrive();
    await seedArchive(sourceDir, { id: "drive-record" });
    const source = realWorker(sourceDir, drive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);

    const dataDir = path.join(rootDir, "late-writer");
    await seedArchive(dataDir, { id: "before-writer" });
    const local = realWorker(dataDir, drive);
    let admitWriter;
    let releaseWriter;
    const admitted = new Promise((resolve) => { admitWriter = resolve; });
    const gate = new Promise((resolve) => { releaseWriter = resolve; });
    const writer = withArchiveWriteLease(dataDir, async () => {
      admitWriter();
      await gate;
      await writeFile(path.join(dataDir, "library.json"), JSON.stringify([{ id: "late-user-data" }]) + "\n");
    });
    await admitted;

    const preview = await local.manager.preview("restore");
    await local.manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
    releaseWriter();
    await writer;
    const failed = await finishOperation(local.manager, "failed");
    assert.equal(failed.error, "snapshot_changed");
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"))[0].id, "late-user-data");
    assert.equal((await local.worker.getSafeStatus()).backupEnabled, false);
  });

  it("never rolls back a durable committed archive when post-finish cleanup fails", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const dataDir = path.join(rootDir, "committed-cleanup-failure");
    const drive = makeDrive();
    await seedArchive(sourceDir, { id: "selected-drive-record", generation: 8 });
    const source = realWorker(sourceDir, drive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);

    await seedArchive(dataDir, { id: "old-local-record", generation: 2 });
    const local = realWorker(dataDir, drive);
    const restoreDir = path.join(dataDir, ".google-drive", "restore");
    let committedDurable = false;
    let injectCleanupFailure = true;
    const manager = createGoogleDriveArchiveManager({
      dataDir, service: local.service, worker: local.worker,
      onJournalSave(label, journal) { if (label === "journal:after" && journal.phase === "committed") committedDurable = true; },
      onDurability(kind, file) {
        if (committedDurable && injectCleanupFailure && kind === "directory" && file === restoreDir) {
          injectCleanupFailure = false;
          throw new Error("injected post-commit cleanup failure");
        }
      },
    });
    const preview = await manager.preview("activation");
    await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "activation" });
    const operation = await finishOperation(manager);
    assert.equal(operation.stage, "complete", "a valid durable commit is finalized after cleanup retry");
    assert.equal(injectCleanupFailure, false, "cleanup fault injection actually ran after worker finalization");
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"))[0].id, "selected-drive-record");
    assert.equal((await local.worker.getSafeStatus()).backupEnabled, true, "explicit activation remains enabled after post-commit cleanup error");
    await assert.rejects(lstat(path.join(restoreDir, "restore-journal.json")), { code: "ENOENT" });
  });

  it("rejects a committed journal whose self-consistent incoming bytes differ from the durable restore attestation", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const dataDir = path.join(rootDir, "proof-binding");
    const drive = makeDrive();
    await seedCrashArchive(sourceDir, "selected-drive-record", 8);
    const source = realWorker(sourceDir, drive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);
    await seedCrashArchive(dataDir, "old-local-record", 2);

    const driveNodes = JSON.stringify(serializedDrive(drive));
    const driveModule = pathToFileURL(path.resolve("test/google-drive-feature04-drive.mjs")).href;
    const workerModule = pathToFileURL(path.resolve("scripts/google-drive-sync.mjs")).href;
    const restoreModule = pathToFileURL(path.resolve("scripts/archive-restore.mjs")).href;
    const childSource = `
      import { createHash } from "node:crypto";
      const [dataDir, driveNodes, driveModule, workerModule, restoreModule] = process.argv.slice(1);
      const { makeDrive } = await import(driveModule);
      const { createGoogleDriveSyncWorker } = await import(workerModule);
      const { createGoogleDriveArchiveManager } = await import(restoreModule);
      const drive = makeDrive();
      for (const node of JSON.parse(driveNodes)) {
        const args = { id: node.id, name: node.name, parentId: node.parentId, appProperties: node.appProperties || undefined };
        if (node.mimeType === "application/vnd.google-apps.folder") drive.addFolder(args);
        else drive.addFile({ ...args, mimeType: node.mimeType, bytes: Buffer.from(node.bytes, "base64") });
      }
      const service = {
        privateDir: dataDir + "/.google-drive",
        async getTarget() { return { targetFingerprint: createHash("sha256").update(Buffer.from("target:root_00001")).digest("hex"), connectionGeneration: "12345678123456781234567812345678", accountId: "account_12345", folderId: "root_00001", driveId: null }; },
        async getClient() { return drive.client; },
      };
      const worker = createGoogleDriveSyncWorker({ service, dataDir, pollIntervalMs: 60000 });
      const manager = createGoogleDriveArchiveManager({ dataDir, service, worker, onJournalSave(label, journal) {
        if (label === "journal:after" && journal.phase === "committed") {
          process.stderr.write("injected committed proof boundary\\n");
          process.exit(73);
        }
      } });
      const preview = await manager.preview("activation");
      await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "activation" });
      for (let i = 0; i < 500; i += 1) {
        const state = await manager.status();
        if (["complete", "failed", "recovery_required"].includes(state.restore?.stage)) process.exit(76);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.exit(75);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource, dataDir,
      driveNodes, driveModule, workerModule, restoreModule], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 73, child.stderr || child.stdout);
    assert.match(child.stderr, /injected committed proof boundary/);

    const journalFile = path.join(dataDir, ".google-drive", "restore", "restore-journal.json");
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    const malicious = Buffer.from(JSON.stringify([{ id: "unconsented-replacement" }]) + "\n");
    await writeFile(path.join(dataDir, "library.json"), malicious);
    const entry = { path: "library.json", size: malicious.length, sha256: sha(malicious) };
    const incomingEntry = journal.incomingInventory.files.find((file) => file.path === "library.json");
    Object.assign(incomingEntry, { size: entry.size, sha256: entry.sha256 });
    const operation = journal.operations.find((item) => item.path === "library.json");
    operation.next = { ...entry };
    journal.stagedFingerprint = sha(Buffer.from(JSON.stringify(journal.incomingInventory)));
    await writeFile(journalFile, JSON.stringify(journal, null, 2) + "\n");
    const journalReadback = JSON.parse(await readFile(journalFile, "utf8"));
    assert.deepEqual(journalReadback.operations.find((item) => item.path === "library.json").next, entry);

    const recovery = realWorker(dataDir, hydrateDrive(JSON.parse(driveNodes)));
    await assert.rejects(recoverArchiveRestore({ dataDir, worker: recovery.worker }), { code: "sync_conflict" });
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"))[0].id, "unconsented-replacement");
    assert.ok(await lstat(journalFile), "mismatched journal stays preserved for diagnosis");
    const privateState = JSON.parse(await readFile(path.join(dataDir, ".google-drive", "sync-state.json"), "utf8"));
    assert.equal(privateState.restoreAuthorization.active, true);
    assert.equal(privateState.restoreAuthorization.completedFingerprint !== undefined, true);
    assert.equal(privateState.paused, true, "the mismatched committed archive stays fenced from outbound publication");
  });

  it("rejects rollback journals that rewrite the selected old mode and raw rollback bytes", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const dataDir = path.join(rootDir, "rollback-proof-binding");
    const drive = makeDrive();
    await seedCrashArchive(sourceDir, "selected-drive-record", 8);
    const source = realWorker(sourceDir, drive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);
    await seedCrashArchive(dataDir, "old-local-record", 2);

    const driveNodes = JSON.stringify(serializedDrive(drive));
    const driveModule = pathToFileURL(path.resolve("test/google-drive-feature04-drive.mjs")).href;
    const workerModule = pathToFileURL(path.resolve("scripts/google-drive-sync.mjs")).href;
    const restoreModule = pathToFileURL(path.resolve("scripts/archive-restore.mjs")).href;
    const childSource = `
      import { createHash } from "node:crypto";
      const [dataDir, driveNodes, driveModule, workerModule, restoreModule] = process.argv.slice(1);
      const { makeDrive } = await import(driveModule);
      const { createGoogleDriveSyncWorker } = await import(workerModule);
      const { createGoogleDriveArchiveManager } = await import(restoreModule);
      const drive = makeDrive();
      for (const node of JSON.parse(driveNodes)) {
        const args = { id: node.id, name: node.name, parentId: node.parentId, appProperties: node.appProperties || undefined };
        if (node.mimeType === "application/vnd.google-apps.folder") drive.addFolder(args);
        else drive.addFile({ ...args, mimeType: node.mimeType, bytes: Buffer.from(node.bytes, "base64") });
      }
      const service = {
        privateDir: dataDir + "/.google-drive",
        async getTarget() { return { targetFingerprint: createHash("sha256").update(Buffer.from("target:root_00001")).digest("hex"), connectionGeneration: "12345678123456781234567812345678", accountId: "account_12345", folderId: "root_00001", driveId: null }; },
        async getClient() { return drive.client; },
      };
      const worker = createGoogleDriveSyncWorker({ service, dataDir, pollIntervalMs: 60000 });
      const manager = createGoogleDriveArchiveManager({ dataDir, service, worker, onRename(label) {
        if (label === "old:library.json:after") {
          process.stderr.write("injected rollback proof boundary\\n");
          process.exit(73);
        }
      } });
      const preview = await manager.preview("restore");
      await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
      for (let i = 0; i < 500; i += 1) {
        const state = await manager.status();
        if (["complete", "failed", "recovery_required"].includes(state.restore?.stage)) process.exit(76);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.exit(75);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource, dataDir,
      driveNodes, driveModule, workerModule, restoreModule], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 73, child.stderr || child.stdout);
    assert.match(child.stderr, /injected rollback proof boundary/);

    const journalFile = path.join(dataDir, ".google-drive", "restore", "restore-journal.json");
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    journal.previousMode = { enabled: true, paused: false };
    const altered = Buffer.from(JSON.stringify([{ id: "unconsented-rollback" }]) + "\n");
    await writeFile(path.join(journal.rollbackDirectory, "library.json"), altered);
    const previousEntry = journal.previousInventory.files.find((file) => file.path === "library.json");
    Object.assign(previousEntry, { size: altered.length, sha256: sha(altered) });
    journal.operations.find((item) => item.path === "library.json").old = { ...previousEntry };
    journal.previousFingerprint = sha(Buffer.from(JSON.stringify(journal.previousInventory)));
    const changedIncoming = Buffer.from(JSON.stringify([{ id: "unconsented-incoming" }]) + "\n");
    const incomingEntry = journal.incomingInventory.files.find((file) => file.path === "library.json");
    Object.assign(incomingEntry, { size: changedIncoming.length, sha256: sha(changedIncoming) });
    journal.operations.find((item) => item.path === "library.json").next = { ...incomingEntry };
    journal.stagedFingerprint = sha(Buffer.from(JSON.stringify(journal.incomingInventory)));
    await writeFile(journalFile, JSON.stringify(journal, null, 2) + "\n");

    const recovery = realWorker(dataDir, hydrateDrive(JSON.parse(driveNodes)));
    await assert.rejects(recoverArchiveRestore({ dataDir, worker: recovery.worker }), { code: "sync_conflict" });
    await assert.rejects(readFile(path.join(dataDir, "library.json")), { code: "ENOENT" }, "failed proof validation happens before rollback mutation");
    assert.equal(JSON.parse(await readFile(path.join(journal.rollbackDirectory, "library.json"), "utf8"))[0].id, "unconsented-rollback");
    const privateState = JSON.parse(await readFile(path.join(dataDir, ".google-drive", "sync-state.json"), "utf8"));
    assert.equal(privateState.restoreAuthorization.active, true);
    assert.equal(privateState.enabled, false, "journal previousMode cannot enable a disabled worker");
    assert.equal(privateState.paused, true);
  });

  it("invalidates a manual restore preview when the actual HTTP disable route changes the mode", async () => {
    const rootDir = await tempRoot();
    const localDir = path.join(rootDir, "local");
    const sourceDir = path.join(rootDir, "source");
    const sourceDrive = makeDrive();
    await seedArchive(sourceDir, { id: "selected-drive-record" });
    const source = realWorker(sourceDir, sourceDrive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);

    const localDrive = makeDrive();
    await seedArchive(localDir, { id: "local-record" });
    const local = realWorker(localDir, localDrive);
    const activation = await local.manager.preview("activation");
    await local.manager.choose({ actionToken: activation.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(local.worker);
    local.service.getClient = async () => sourceDrive.client;
    const manual = await local.manager.preview("restore");
    assert.equal(manual.decision, "different");

    local.service.callbackOrigin = "http://localhost";
    local.service.getStatus = async () => ({ state: "connected", error: null });
    const plugin = googleDriveApi({ env: { WARDROBE_DATA_DIR: localDir }, service: local.service, syncWorker: local.worker });
    await plugin.configResolved({ root: rootDir, publicDir: path.join(rootDir, "public"), build: { outDir: "dist" }, command: "serve" });
    const disabled = await requestPlugin(plugin, "/api/google-drive/archive/disable", "POST", {});
    assert.equal(disabled.status, 200);
    assert.equal(disabled.value.backupEnabled, false);
    await assert.rejects(local.manager.choose({ actionToken: manual.actionToken, choice: "use-drive", operation: "restore" }), { code: "sync_conflict" });
    const status = await local.worker.getSafeStatus();
    assert.equal(status.backupEnabled, false, "stale preview cannot turn Drive back on");
  });

  it("retains active restore evidence during worker stop and releases it on orphan recovery", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const dataDir = path.join(rootDir, "restore");
    const drive = makeDrive();
    await seedArchive(sourceDir, { id: "drive-record" });
    await seedArchive(dataDir, { id: "local-record" });
    const source = realWorker(sourceDir, drive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);

    const local = realWorker(dataDir, drive);
    await local.worker.pauseAndDrain();
    const preview = await local.worker.preview({ allowInvalidLocal: true });
    const authorization = await local.worker.authorizeRestore({
      evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "use-drive", activate: false,
    });
    const controlFile = path.join(dataDir, ".google-drive", "sync-control.json");
    const controlBeforeDisable = JSON.parse(await readFile(controlFile, "utf8"));
    await assert.rejects(local.worker.disable(), { code: "sync_conflict" });
    assert.deepEqual(JSON.parse(await readFile(controlFile, "utf8")), controlBeforeDisable, "rejected disable does not leave a pause fence behind");
    await local.worker.stop();
    assert.equal(JSON.parse(await readFile(path.join(dataDir, ".google-drive", "sync-state.json"), "utf8")).restoreAuthorization.active, true);
    for (const directory of [preview.local.directory, preview.remote.directory]) assert.ok(await lstat(directory), "active proof retains its staged evidence");

    assert.equal(await local.worker.recoverOrphanRestoreAuthorization({ transactionId: authorization.transactionId }), true);
    for (const directory of [preview.local.directory, preview.remote.directory]) await assert.rejects(lstat(directory), { code: "ENOENT" });
  });

  it("rolls back a crashed raw-root manual copy and keeps its journal for worker-bound recovery", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const dataDir = path.join(rootDir, "restore");
    const sourceDrive = makeDrive();
    await seedCrashArchive(sourceDir, "drive-record", 4);
    const source = realWorker(sourceDir, sourceDrive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);

    const rootId = "manualcopy_12345";
    const driveName = "Wardrobe / Summer\\ Collection";
    const rawDrive = await rawRootCopy(sourceDrive, rootId);
    rawDrive.nodes.get(rootId).name = driveName;
    await seedCrashArchive(dataDir, "local-record", 2);
    const driveModule = pathToFileURL(path.resolve("test/google-drive-feature04-drive.mjs")).href;
    const workerModule = pathToFileURL(path.resolve("scripts/google-drive-sync.mjs")).href;
    const restoreModule = pathToFileURL(path.resolve("scripts/archive-restore.mjs")).href;
    const childSource = `
      import { createHash } from "node:crypto";
      const [dataDir, driveNodes, rootId, rootName, driveModule, workerModule, restoreModule] = process.argv.slice(1);
      const { makeDrive } = await import(driveModule);
      const { createGoogleDriveSyncWorker } = await import(workerModule);
      const { createGoogleDriveArchiveManager } = await import(restoreModule);
      const drive = makeDrive(rootId);
      drive.nodes.get(rootId).name = rootName;
      for (const node of JSON.parse(driveNodes)) {
        const args = { id: node.id, name: node.name, parentId: node.parentId, appProperties: node.appProperties || undefined };
        if (node.mimeType === "application/vnd.google-apps.folder") drive.addFolder(args);
        else drive.addFile({ ...args, mimeType: node.mimeType, bytes: Buffer.from(node.bytes, "base64") });
      }
      const service = {
        privateDir: dataDir + "/.google-drive",
        async getTarget() { return { targetFingerprint: createHash("sha256").update(Buffer.from("target:" + rootId)).digest("hex"), connectionGeneration: "12345678123456781234567812345678", accountId: "account_12345", folderId: rootId, driveId: null }; },
        async getClient() { return drive.client; },
      };
      const worker = createGoogleDriveSyncWorker({ service, dataDir, pollIntervalMs: 60000 });
      const manager = createGoogleDriveArchiveManager({ dataDir, service, worker, onRename(label) {
        if (label === "old:library.json:after") { process.stderr.write("injected raw-root crash\\n"); process.exit(73); }
      } });
      const preview = await manager.preview("restore");
      await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
      for (let i = 0; i < 500; i += 1) {
        const state = await manager.status();
        if (["complete", "failed", "recovery_required"].includes(state.restore?.stage)) process.exit(75);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.exit(75);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource, dataDir,
      JSON.stringify(serializedDrive(rawDrive, rootId)), rootId, driveName, driveModule, workerModule, restoreModule], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 73, child.stderr || child.stdout);
    assert.match(child.stderr, /injected raw-root crash/);
    const journalFile = path.join(dataDir, ".google-drive", "restore", "restore-journal.json");
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(journal.snapshotName, "Wardrobe / Summer\\ Collection");
    await assert.rejects(recoverArchiveRestore({ dataDir }), { code: "archive_maintenance" }, "CLI recovery without the worker preserves the committed consent and journal");
    await assert.rejects(readFile(path.join(dataDir, "library.json")), { code: "ENOENT" }, "the injected boundary follows the old-file rename");

    const recovery = realWorker(dataDir, hydrateDrive(serializedDrive(rawDrive, rootId), rootId), rootId);
    const plugin = googleDriveApi({ env: { WARDROBE_DATA_DIR: path.relative(rootDir, dataDir) }, service: recovery.service, syncWorker: recovery.worker });
    await plugin.configResolved({ root: rootDir, publicDir: path.join(rootDir, "public"), build: { outDir: "dist" }, command: "serve" });
    const recoveredInventory = await buildArchiveInventory(dataDir);
    assert.equal((await validateArchive(dataDir, recoveredInventory)).valid, true);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"))[0].id, "local-record");
    await assert.rejects(lstat(journalFile), { code: "ENOENT" });
  });

  it("rolls back a raw-root manual copy with a bounded human snapshot name", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const dataDir = path.join(rootDir, "raw-root-rollback");
    const rootId = "manualcopy_23456";
    const sourceDrive = makeDrive();
    await seedCrashArchive(sourceDir, "drive-version", 4, "prod");
    const source = realWorker(sourceDir, sourceDrive);
    const sourcePreview = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: sourcePreview.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);
    const rawDrive = await rawRootCopy(sourceDrive, rootId);

    await seedCrashArchive(dataDir, "local-version", 2);
    let failFirstSwap = true;
    const local = realWorker(dataDir, hydrateDrive(serializedDrive(rawDrive, rootId), rootId), rootId);
    const manager = createGoogleDriveArchiveManager({
      dataDir, service: local.service, worker: local.worker,
      onRename(label) {
        if (failFirstSwap && label === "old:library.json:after") {
          failFirstSwap = false;
          throw new Error("injected manual-copy replacement failure");
        }
      },
    });
    const preview = await manager.preview("restore");
    assert.equal(preview.decision, "different");
    await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
    const failed = await finishOperation(manager, "failed");
    assert.equal(failed.error, "remote_unavailable");
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"))[0].id, "local-version");
    await assert.rejects(lstat(path.join(dataDir, ".google-drive", "restore", "restore-journal.json")), { code: "ENOENT" });
  });

  it("blocks CLI backfill reviews prepared before the current archive generation", async () => {
    const run = (script, dataDir, args = []) => spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, WARDROBE_DATA_DIR: dataDir }, timeout: 20_000,
    });
    for (const script of ["backfill-garment-parts.mjs", "backfill-item-dates.mjs"]) {
      const dataDir = path.join(await tempRoot(), script.replaceAll(".", "-"));
      await seedArchive(dataDir, { generation: 1 });
      await writeFile(path.join(dataDir, "library.json"), JSON.stringify([{
        id: "dress", name: "Evening dress", part: "upperbody",
      }]) + "\n");
      await mkdir(path.join(dataDir, "imported"), { recursive: true });
      await writeFile(path.join(dataDir, "imported", "dress-garment.png"), Buffer.from("backfill timestamp fixture"));
      const report = run(script, dataDir);
      assert.equal(report.status, 0, script + " report failed: " + report.stderr);
      const reviewFile = path.join(dataDir, script === "backfill-garment-parts.mjs"
        ? "backfill-garment-parts.review.json" : "backfill-item-dates.review.json");
      assert.equal(JSON.parse(await readFile(reviewFile, "utf8")).provenanceGeneration, 1);
      const metadata = JSON.parse(await readFile(path.join(dataDir, "archive-metadata.json"), "utf8"));
      await writeFile(path.join(dataDir, "archive-metadata.json"), JSON.stringify({ ...metadata, archiveGeneration: 2 }) + "\n");
      const before = await readFile(path.join(dataDir, "library.json"));
      const apply = run(script, dataDir, ["--apply"]);
      assert.notEqual(apply.status, 0, script + " accepted a generation-1 review after restore");
      assert.match(apply.stderr + apply.stdout, /no archive-generation provenance|stale/i);
      assert.deepEqual(await readFile(path.join(dataDir, "library.json")), before);
    }
  });

  it("keeps canonical restored references ahead of stale external bootstrap settings", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const externalPath = path.join(rootDir, "old-model.png");
    const canonical = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#12a34a" } }).png().toBuffer();
    const staleExternal = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#1234ab" } }).png().toBuffer();
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "model-reference.png"), canonical);
    await writeFile(path.join(dataDir, "archive-metadata.json"), `${JSON.stringify({ schemaVersion: 1, archiveGeneration: 2, referenceSources: {} })}\n`);
    await writeFile(externalPath, staleExternal);
    const setting = (name, fallback = "") => name === "WARDROBE_MODEL_REFERENCE" ? externalPath : fallback;
    const reference = await readReferenceBytes({ root: rootDir, dataDir, setting });
    assert.deepEqual(reference.data, canonical);
    await prepareArchiveDirectory({ root: rootDir, dataDir, setting });
    assert.deepEqual(await readFile(path.join(dataDir, "model-reference.png")), canonical);
  });

  it("keeps restored canonical JPEG references and deliberate reference absence over stale external paths", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const externalPath = path.join(rootDir, "old-model.png");
    const restoredJpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#12a34a" } }).jpeg().toBuffer();
    const staleExternal = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#1234ab" } }).png().toBuffer();
    const setting = (name, fallback = "") => name === "WARDROBE_MODEL_REFERENCE" ? externalPath : fallback;
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "archive-metadata.json"), `${JSON.stringify({ schemaVersion: 1, archiveGeneration: 2, referenceSources: {} })}\n`);
    await writeFile(path.join(dataDir, "model-reference.jpg"), restoredJpeg);
    await writeFile(externalPath, staleExternal);

    assert.deepEqual((await readReferenceBytes({ root: rootDir, dataDir, setting })).data, restoredJpeg);
    await prepareArchiveDirectory({ root: rootDir, dataDir, setting });
    await assert.rejects(readFile(path.join(dataDir, "model-reference.png")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(dataDir, "originals")), { code: "ENOENT" });

    const withoutReferenceDir = path.join(rootDir, "without-reference");
    await mkdir(withoutReferenceDir, { recursive: true });
    await writeFile(path.join(withoutReferenceDir, "archive-metadata.json"), `${JSON.stringify({ schemaVersion: 1, archiveGeneration: 3, referenceSources: {} })}\n`);
    assert.equal(await readReferenceBytes({ root: rootDir, dataDir: withoutReferenceDir, setting }), null);
    await prepareArchiveDirectory({ root: rootDir, dataDir: withoutReferenceDir, setting });
    await assert.rejects(readFile(path.join(withoutReferenceDir, "model-reference.png")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(withoutReferenceDir, "originals")), { code: "ENOENT" });
  });

  it("aligns shared browser-state validation with the API's supported legacy revision and migration markers", async () => {
    const dataDir = path.join(await tempRoot(), "browser-state");
    await seedArchive(dataDir, { generation: 2 });
    const file = path.join(dataDir, "browser-state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    delete state.revision;
    await writeFile(file, JSON.stringify(state) + "\n");
    const inventory = await buildArchiveInventory(dataDir);
    assert.equal((await validateArchive(dataDir, inventory)).valid, true, "revisionless supported legacy state stays valid");
    const { readBrowserState } = await import("../scripts/browser-state-api.mjs");
    assert.equal((await readBrowserState(dataDir)).revision, 0);

    state.migratedFields = ["invalid-user-marker"];
    await writeFile(file, JSON.stringify(state) + "\n");
    assert.equal((await validateArchive(dataDir, await buildArchiveInventory(dataDir))).valid, false);
    await assert.rejects(readBrowserState(dataDir), /migration marker is invalid/);
  });

  it("exposes only a safe archive generation when metadata is malformed", async () => {
    const dataDir = path.join(await tempRoot(), "status");
    await seedArchive(dataDir);
    await writeFile(path.join(dataDir, "archive-metadata.json"), JSON.stringify({
      path: "/private/secret", token: "raw-private",
    }));
    const manager = createGoogleDriveArchiveManager({ dataDir, service: { async getTarget() { return target(); } }, worker: {} });
    const status = await manager.status();
    assert.equal(status.archiveGeneration, null);
    assert.equal(JSON.stringify(status).includes("/private/secret"), false);
    assert.equal(JSON.stringify(status).includes("raw-private"), false);
  });

  it("quarantines stale web review jobs before startup replay and rejects later approval", async () => {
    const rootDir = await tempRoot();
    const dataDir = path.join(rootDir, "data");
    const catalogs = await seedArchive(dataDir, { generation: 2 });
    const jobId = randomUUID();
    const jobDir = path.join(dataDir, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    const job = {
      id: jobId, status: "complete", provenanceGeneration: 1, metadata: { name: "Old review" },
      stages: {
        crop: { status: "approved", decision: "approved" },
        garment: { status: "approved", decision: "approved", attempts: 1, assetUrl: `/api/import/assets/${jobId}/garment-1.png` },
      },
      internal: { originalFile: "original.png", cropFile: "crop.png", sourceOriginal: "originals/old-source.png" },
    };
    await writeFile(path.join(jobDir, "garment-1.png"), Buffer.from("old generated asset"));
    await writeFile(path.join(jobDir, "job.json"), `${JSON.stringify(job)}\n`);

    const plugin = wardrobeImportApi({ env: { WARDROBE_DATA_DIR: "data" } });
    await plugin.configResolved({ root: rootDir });
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8")), catalogs["library.json"]);
    const quarantined = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
    assert.equal(quarantined.status, "stale");
    assert.equal(quarantined.staleReason, "archive_generation_changed");
    assert.equal(quarantined.stages.garment.status, "approved");

    const response = await requestPlugin(plugin, `/api/import/jobs/${jobId}/stages/garment/approve`, "POST", {});
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8")), catalogs["library.json"]);
  });

  it("recovers replacement and rollback crashes through Vite startup before migration writers run", async () => {
    const rootDir = await tempRoot();
    const sourceDir = path.join(rootDir, "source");
    const drive = makeDrive();
    await seedCrashArchive(sourceDir, "drive-version", 1, "prod");
    const source = realWorker(sourceDir, drive);
    const first = await source.manager.preview("activation");
    await source.manager.choose({ actionToken: first.actionToken, choice: "use-local", operation: "activation" });
    await waitForBackup(source.worker);
    const remoteNodes = JSON.stringify(serializedDrive(drive));

    const captureDir = path.join(rootDir, "capture-success");
    await seedCrashArchive(captureDir, "old-version", 1);
    const previousInventoryForCrash = await buildArchiveInventory(captureDir);
    const hookEvents = [];
    const durabilityEvents = [];
    let preparedJournalDurabilityCount = null;
    let preparedJournalId = null;
    const captureWorker = realWorker(captureDir, hydrateDrive(JSON.parse(remoteNodes)));
    const captureManager = createGoogleDriveArchiveManager({
      dataDir: captureDir, service: captureWorker.service, worker: captureWorker.worker,
      onDurability(kind, file) { durabilityEvents.push({ kind, file }); },
      onJournalSave(label, journal) {
        hookEvents.push("journal:" + journal.phase + ":" + journal.operationIndex + ":" + journal.operations.map((op) => op.status).join(","));
        if (label === "journal:before" && journal.phase === "prepared") {
          preparedJournalDurabilityCount = durabilityEvents.length;
          preparedJournalId = journal.id;
        }
      },
      onRename(label) { hookEvents.push(`rename:${label}`); },
    });
    const capturePreview = await captureManager.preview("restore");
    await captureManager.choose({ actionToken: capturePreview.actionToken, choice: "use-drive", operation: "restore" });
    await finishOperation(captureManager);
    const replacementInventoryForCrash = await buildArchiveInventory(captureDir);
    assert.ok(preparedJournalDurabilityCount > 0, "staging fsyncs precede the prepared journal write");
    const txPrefix = path.join(captureDir, ".google-drive", "restore", preparedJournalId) + path.sep;
    const stagedDurability = durabilityEvents.slice(0, preparedJournalDurabilityCount)
      .filter((event) => event.file.startsWith(txPrefix));
    assert.ok(stagedDurability.some((event) => event.kind === "file" && event.file.includes("rollback")), "rollback bytes are fsynced");
    assert.ok(stagedDurability.some((event) => event.kind === "file" && event.file.includes("incoming")), "incoming archive bytes are fsynced");
    assert.ok(durabilityEvents.slice(0, preparedJournalDurabilityCount).some((event) => event.kind === "directory" && event.file === path.join(captureDir, ".google-drive", "restore")), "transaction parent is fsynced before journal persistence");
    assert.ok(hookEvents.length >= 20, `expected all journal and rename boundaries, saw ${hookEvents.length}`);

    const rollbackCaptureDir = path.join(rootDir, "capture-rollback");
    await seedCrashArchive(rollbackCaptureDir, "old-version", 1);
    const rollbackEvents = [];
    let injectSwapFailure = true;
    const rollbackWorker = realWorker(rollbackCaptureDir, hydrateDrive(JSON.parse(remoteNodes)));
    const rollbackManager = createGoogleDriveArchiveManager({
      dataDir: rollbackCaptureDir, service: rollbackWorker.service, worker: rollbackWorker.worker,
      onJournalSave(_label, journal) { rollbackEvents.push(`journal:${journal.phase}:${journal.operationIndex}:${journal.operations.map((op) => op.status).join(",")}`); },
      onRename(label) {
        rollbackEvents.push(`rename:${label}`);
        if (injectSwapFailure && label === "new:ai-mode.json:after") {
          injectSwapFailure = false;
          throw new Error("injected replacement failure");
        }
      },
    });
    const rollbackPreview = await rollbackManager.preview("restore");
    await rollbackManager.choose({ actionToken: rollbackPreview.actionToken, choice: "use-drive", operation: "restore" });
    await finishOperation(rollbackManager, "failed");
    assert.ok(rollbackEvents.some((event) => event.includes("rollback:ai-mode.json:after")), `rollback rename hook was not exercised: ${JSON.stringify(rollbackEvents)}`);
    assert.ok(rollbackEvents.some((event) => event.includes("journal:rolling-back")), `rollback journal-save hook was not exercised: ${JSON.stringify(rollbackEvents)}`);

    const driveUrl = pathToFileURL(path.resolve("test/google-drive-feature04-drive.mjs")).href;
    const workerUrl = pathToFileURL(path.resolve("scripts/google-drive-sync.mjs")).href;
    const restoreUrl = pathToFileURL(path.resolve("scripts/archive-restore.mjs")).href;
    const childSource = `
    const [dataDir, driveNodes, crashAt, crashMode] = process.argv.slice(1);
      const { makeDrive } = await import(${JSON.stringify(driveUrl)});
      const { createGoogleDriveSyncWorker } = await import(${JSON.stringify(workerUrl)});
      const { createGoogleDriveArchiveManager } = await import(${JSON.stringify(restoreUrl)});
      const drive = makeDrive();
      for (const node of JSON.parse(driveNodes)) {
        const args = { id: node.id, name: node.name, parentId: node.parentId, appProperties: node.appProperties || undefined };
        if (node.mimeType === "application/vnd.google-apps.folder") drive.addFolder(args);
        else drive.addFile({ ...args, mimeType: node.mimeType, bytes: Buffer.from(node.bytes, "base64") });
      }
      const service = {
        privateDir: dataDir + "/.google-drive",
        async getTarget() { return { targetFingerprint: ${JSON.stringify(sha(Buffer.from("target:root_00001")))}, connectionGeneration: "12345678123456781234567812345678", accountId: "account_12345", folderId: "root_00001", driveId: null }; },
        async getClient() { return drive.client; },
      };
      const worker = createGoogleDriveSyncWorker({ service, dataDir, pollIntervalMs: 60000 });
      let count = 0;
      const crash = () => { count += 1; if (count === Number(crashAt)) { process.stderr.write("injected durable-boundary exit\\n"); process.exit(73); } };
      let injectSwapFailure = crashMode === "rollback";
      const manager = createGoogleDriveArchiveManager({ dataDir, service, worker, onJournalSave: crash, onRename(label) {
        crash();
        if (injectSwapFailure && label === "new:ai-mode.json:after") {
          injectSwapFailure = false;
          throw new Error("injected replacement failure");
        }
      } });
      const preview = await manager.preview("restore");
      await manager.choose({ actionToken: preview.actionToken, choice: "use-drive", operation: "restore" });
      for (let i = 0; i < 500; i += 1) {
        const state = await manager.status();
        if (["complete", "failed", "recovery_required"].includes(state.restore?.stage)) process.exit(74);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.exit(75);
    `;

    for (const scenario of [
      { name: "replace", events: hookEvents, mode: "replace", acceptableInventories: [previousInventoryForCrash, replacementInventoryForCrash] },
      { name: "rollback", events: rollbackEvents, mode: "rollback", acceptableInventories: [previousInventoryForCrash] },
    ]) {
      for (let boundary = 1; boundary <= scenario.events.length; boundary += 1) {
        const dataDir = path.join(rootDir, `crash-${scenario.name}-${boundary}`);
        await seedCrashArchive(dataDir, "old-version", 1);
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource, dataDir, remoteNodes, String(boundary), scenario.mode], {
          cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
        });
        assert.equal(child.status, 73, `${scenario.name} boundary ${boundary} (${scenario.events[boundary - 1]}): ${child.stderr || child.stdout}`);
        assert.match(child.stderr, /injected durable-boundary exit/);

        const recoveryDrive = hydrateDrive(JSON.parse(remoteNodes));
        const recovery = realWorker(dataDir, recoveryDrive);
        const relData = path.relative(rootDir, dataDir);
        const plugin = googleDriveApi({ env: { WARDROBE_DATA_DIR: relData }, service: recovery.service, syncWorker: recovery.worker });
        await plugin.configResolved({
          root: rootDir, publicDir: path.join(rootDir, "public"), build: { outDir: "dist" }, command: "serve",
        });
        const recoveredInventory = await buildArchiveInventory(dataDir);
        assert.ok(scenario.acceptableInventories.some((expected) => JSON.stringify(recoveredInventory) === JSON.stringify(expected)), `${scenario.name} boundary ${boundary} left a mixed archive`);
        await prepareArchiveDirectory({ root: rootDir, dataDir, setting: (name, fallback) => name === "WARDROBE_DATA_DIR" ? relData : fallback });
        const inventory = await buildArchiveInventory(dataDir);
        assert.equal((await validateArchive(dataDir, inventory)).valid, true, `${scenario.name} boundary ${boundary} left an invalid archive`);
        assert.ok(scenario.acceptableInventories.some((expected) => JSON.stringify(inventory) === JSON.stringify(expected)), `${scenario.name} boundary ${boundary} changed the archive before defaults completed`);
        assert.equal(await lstat(path.join(dataDir, ".google-drive", "restore", "restore-journal.json")).then(() => true, () => false), false);
        await withArchiveWriteLease(dataDir, async () => assert.equal((await archiveMaintenanceStatus(dataDir)).active, false));
      }
    }
  });
});
