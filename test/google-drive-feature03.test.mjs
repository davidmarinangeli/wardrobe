import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createGoogleDriveSyncWorker } from "../scripts/google-drive-sync.mjs";
import { buildArchiveInventory } from "../scripts/archive-store.mjs";

const temporaryRoots = new Set();
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_ID = "root_00001";
const COMMIT_NAME = "wardrobe-archive-commit.json";
const INVENTORY_NAME = ".wardrobe-inventory.json";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temporaryRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wardrobe-feature03-"));
  temporaryRoots.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryRoots.clear();
});

function makeDrive(rootId = ROOT_ID) {
  const nodes = new Map();
  const sessions = new Map();
  let sequence = 1;
  let lostChunkAck = false;
  let expireQuery = false;
  let listingError = null;
  const counters = { createFolder: 0, createFile: 0, updateFile: 0, copyFile: 0, deleteFile: 0, chunks: 0, starts: 0, maxChunkBytes: 0 };
  const makeId = () => `drive_${String(sequence++).padStart(6, "0")}`;
  const root = {
    id: rootId, name: "Wardrobe archive", mimeType: FOLDER_MIME, parents: [], trashed: false,
    capabilities: { canListChildren: true, canAddChildren: true, canEdit: true, canDelete: true },
  };
  nodes.set(root.id, { ...root, appProperties: undefined });

  function metadata(node) {
    const value = { ...node };
    delete value.content;
    return value;
  }

  function addFile({ id = makeId(), name, mimeType = "application/octet-stream", parentId = rootId, bytes, appProperties }) {
    const content = Buffer.from(bytes || []);
    const node = {
      id, name, mimeType, parents: [parentId], trashed: false,
      size: String(content.length), sha256Checksum: digest(content), appProperties: appProperties ? { ...appProperties } : undefined,
      capabilities: { canDownload: true, canModifyContent: true, canEdit: true, canDelete: true, canListChildren: true, canAddChildren: true },
      content,
    };
    nodes.set(id, node);
    return node;
  }

  function addFolder({ id = makeId(), name, parentId = rootId, appProperties }) {
    const node = {
      id, name, mimeType: FOLDER_MIME, parents: [parentId], trashed: false,
      appProperties: appProperties ? { ...appProperties } : undefined,
      capabilities: { canDownload: false, canModifyContent: false, canEdit: true, canDelete: true, canListChildren: true, canAddChildren: true },
    };
    nodes.set(id, node);
    return node;
  }

  const notFound = () => Object.assign(new Error("not found"), { status: 404, code: "file_not_found" });
  const client = {
    async verifyRoot() { return metadata(nodes.get(rootId)); },
    async listChildren(parentId = rootId) {
      if (listingError) throw listingError;
      if (!nodes.has(parentId)) throw notFound();
      return [...nodes.values()].filter((node) => !node.trashed && node.parents?.includes(parentId)).map(metadata);
    },
    async getMetadata(id) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      return metadata(node);
    },
    async readFile(id) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      if (node.mimeType === FOLDER_MIME) throw new Error("folder has no content");
      return Buffer.from(node.content);
    },
    async hashFile(id) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      return { size: node.content.length, sha256: digest(node.content) };
    },
    async downloadFile(id, write) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      const bytes = Buffer.from(node.content);
      for (let offset = 0; offset < bytes.length; offset += 8192) await write(bytes.subarray(offset, offset + 8192));
      return { size: bytes.length, sha256: digest(bytes) };
    },
    async generateId() { return makeId(); },
    async createFolder({ id = makeId(), name, parentId = rootId, appProperties }) {
      counters.createFolder += 1;
      if (nodes.has(id)) return metadata(nodes.get(id));
      return metadata(addFolder({ id, name, parentId, appProperties }));
    },
    async createFile({ id = makeId(), name, mimeType, bytes, parentId = rootId, appProperties }) {
      counters.createFile += 1;
      if (nodes.has(id)) return metadata(nodes.get(id));
      return metadata(addFile({ id, name, mimeType, bytes, parentId, appProperties }));
    },
    async updateFile({ fileId, name, mimeType, bytes, appProperties }) {
      counters.updateFile += 1;
      const node = nodes.get(fileId);
      if (!node || node.trashed) throw notFound();
      if (name !== undefined) node.name = name;
      if (mimeType !== undefined) node.mimeType = mimeType;
      if (bytes !== undefined) {
        node.content = Buffer.from(bytes);
        node.size = String(node.content.length);
        node.sha256Checksum = digest(node.content);
      }
      if (appProperties !== undefined) node.appProperties = { ...appProperties };
      return metadata(node);
    },
    async copyFile({ fileId, id = makeId(), name, parentId = rootId, appProperties }) {
      counters.copyFile += 1;
      const source = nodes.get(fileId);
      if (!source || source.trashed) throw notFound();
      if (nodes.has(id)) return metadata(nodes.get(id));
      return metadata(addFile({ id, name, mimeType: source.mimeType, parentId, bytes: source.content, appProperties }));
    },
    async deleteFile(id) {
      counters.deleteFile += 1;
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      if (node.mimeType === FOLDER_MIME && [...nodes.values()].some((child) => !child.trashed && child.parents?.includes(id))) {
        throw new Error("folder is not empty");
      }
      node.trashed = true;
    },
    async startResumableUpload({ name, mimeType, size, parentId, id, fileId, appProperties }) {
      counters.starts += 1;
      const uploadId = makeId();
      const sessionUrl = `https://www.googleapis.com/upload/drive/v3/files${fileId ? `/${encodeURIComponent(fileId)}` : ""}?uploadType=resumable&supportsAllDrives=true&fields=id&upload_id=${uploadId}&session_crd=fake`;
      sessions.set(uploadId, { name, mimeType, size, parentId, id: fileId || id, fileId: fileId || null, appProperties, bytes: Buffer.alloc(0) });
      return { sessionUrl };
    },
    async queryResumableUpload({ sessionUrl }) {
      const uploadId = new URL(sessionUrl).searchParams.get("upload_id");
      const session = sessions.get(uploadId);
      if (expireQuery) {
        expireQuery = false;
        sessions.delete(uploadId);
        throw Object.assign(new Error("expired"), { code: "resumable_session_expired", status: 410 });
      }
      if (!session) throw Object.assign(new Error("expired"), { code: "resumable_session_expired", status: 410 });
      if (session.bytes.length >= session.size) {
        const node = finalizeSession(session);
        return { complete: true, offset: session.size, metadata: metadata(node) };
      }
      return { complete: false, offset: session.bytes.length };
    },
    async uploadResumableChunk({ sessionUrl, offset, bytes }) {
      counters.chunks += 1;
      const uploadId = new URL(sessionUrl).searchParams.get("upload_id");
      const session = sessions.get(uploadId);
      if (!session) throw Object.assign(new Error("expired"), { code: "resumable_session_expired", status: 410 });
      if (offset !== session.bytes.length) throw new Error("bad fake offset");
      counters.maxChunkBytes = Math.max(counters.maxChunkBytes, bytes.length);
      session.bytes = Buffer.concat([session.bytes, Buffer.from(bytes)]);
      if (lostChunkAck) { lostChunkAck = false; throw Object.assign(new Error("lost upload acknowledgement"), { code: "google_unavailable", retryable: true }); }
      if (session.bytes.length >= session.size) {
        const node = finalizeSession(session);
        return { complete: true, offset: session.size, metadata: metadata(node) };
      }
      return { complete: false, offset: session.bytes.length };
    },
  };

  function finalizeSession(session) {
    let node;
    if (session.fileId) {
      node = nodes.get(session.fileId);
      if (!node) throw notFound();
      node.name = session.name;
      node.mimeType = session.mimeType;
      node.parents = [session.parentId];
      node.content = Buffer.from(session.bytes);
      node.size = String(node.content.length);
      node.sha256Checksum = digest(node.content);
      node.appProperties = session.appProperties ? { ...session.appProperties } : undefined;
    } else {
      node = nodes.get(session.id);
      if (!node) node = addFile({ id: session.id, name: session.name, mimeType: session.mimeType, parentId: session.parentId, bytes: session.bytes, appProperties: session.appProperties });
      else {
        node.content = Buffer.from(session.bytes);
        node.size = String(node.content.length);
        node.sha256Checksum = digest(node.content);
        node.appProperties = session.appProperties ? { ...session.appProperties } : undefined;
      }
    }
    sessions.delete([...sessions.entries()].find(([, value]) => value === session)?.[0]);
    return node;
  }

  return {
    client, nodes, counters, addFile, addFolder,
    loseNextChunkAck() { lostChunkAck = true; },
    expireNextSessionQuery() { expireQuery = true; },
    failListings(error = Object.assign(new Error("provider private detail"), { status: 403, code: "folder_read_denied" })) { listingError = error; },
    allowListings() { listingError = null; },
    children(parentId = rootId) { return [...nodes.values()].filter((node) => !node.trashed && node.parents?.includes(parentId)); },
    async cloneToRoot(newRootId) {
      const copied = makeDrive(newRootId);
      const sourceChildren = [...nodes.values()].filter((node) => !node.trashed && node.parents?.includes(rootId));
      const copyTree = async (node, parentId) => {
        const newId = await copied.client.generateId();
        if (node.mimeType === FOLDER_MIME) {
          const folder = copied.addFolder({ id: newId, name: node.name, parentId });
          for (const child of [...nodes.values()].filter((entry) => !entry.trashed && entry.parents?.includes(node.id))) await copyTree(child, folder.id);
          return folder;
        }
        return copied.addFile({ id: newId, name: node.name, mimeType: node.mimeType, parentId, bytes: node.content });
      };
      for (const child of sourceChildren) await copyTree(child, newRootId);
      return copied;
    },
  };
}

async function prepareArchive(root, media = Buffer.from("coat-image")) {
  const dataDir = path.join(root, "data");
  await mkdir(path.join(dataDir, "imported", "originals"), { recursive: true });
  await writeFile(path.join(dataDir, "library.json"), "[]\n");
  await writeFile(path.join(dataDir, "imported", "originals", "coat.png"), media);
  return dataDir;
}

function setup(dataDir, drive, rootId = ROOT_ID, workerOptions = {}) {
  let target = {
    targetFingerprint: digest(Buffer.from(`target:${rootId}`)),
    connectionGeneration: "12345678123456781234567812345678",
    accountId: "account_12345",
    folderId: rootId,
    driveId: null,
  };
  const service = {
    privateDir: path.join(dataDir, ".google-drive"),
    async getTarget() { return { ...target }; },
    async getClient() { return drive.client; },
  };
  return {
    service,
    worker: createGoogleDriveSyncWorker({ service, dataDir, pollIntervalMs: 60_000, ...workerOptions }),
    changeTarget(patch) { target = { ...target, ...patch }; },
  };
}

async function waitForCompleted(worker, expectedFingerprint = null) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const status = await worker.getSafeStatus();
    const state = JSON.parse(await readFile(path.join(worker.privateDir, "sync-state.json"), "utf8"));
    let writerFree = false;
    try { await access(path.join(worker.privateDir, "sync.lock")); }
    catch { writerFree = true; }
    if (writerFree && status.syncState === "idle" && !status.pendingChanges && status.lastCompletedBackup) {
      if (!expectedFingerprint || state?.lastCompleted?.fingerprint === expectedFingerprint) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Sync did not complete: ${JSON.stringify(await worker.getSafeStatus())}`);
}

async function choose(worker, choice = "use-local") {
  const preview = await worker.preview();
  const result = await worker.commitArchiveChoice({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice });
  assert.equal(result.backupEnabled, true);
  return preview;
}

function stateFile(dataDir) { return path.join(dataDir, ".google-drive", "sync-state.json"); }
async function readSyncState(worker) { return JSON.parse(await readFile(path.join(worker.privateDir, "sync-state.json"), "utf8")); }

async function writeCatalogAtomically(dataDir, text) {
  const destination = path.join(dataDir, "library.json");
  const temporary = `${destination}.test-tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, destination);
}

async function prepareGenerationSealedRestore(dataDir) {
  const metadataPath = path.join(dataDir, "archive-metadata.json");
  const browserStatePath = path.join(dataDir, "browser-state.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const browserState = JSON.parse(await readFile(browserStatePath, "utf8"));
  await writeFile(metadataPath, `${JSON.stringify({ ...metadata, archiveGeneration: 2 })}\n`);
  await writeFile(browserStatePath, `${JSON.stringify({
    ...browserState,
    archiveGeneration: 2,
    revision: Math.max(1, browserState.revision || 0),
    migrationSealed: true,
    migratedFields: ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"],
  })}\n`);
}

async function prepareRestoreFixture(root) {
  const dataDir = await prepareArchive(root);
  const metadata = { schemaVersion: 1, archiveGeneration: 1, referenceSources: {} };
  const browserState = {
    version: 1, archiveGeneration: 1, revision: 0, migrationSealed: false, migratedFields: [],
    declutterKeptIds: [], dismissedNudges: [], modelTier: "standard", onboardingDismissed: false,
    wornToday: { day: "", ids: [] },
  };
  await writeFile(path.join(dataDir, "archive-metadata.json"), `${JSON.stringify(metadata)}\n`);
  await writeFile(path.join(dataDir, "browser-state.json"), `${JSON.stringify(browserState)}\n`);
  return dataDir;
}

async function authorizeAndCompleteRestore(worker, dataDir, expectedName) {
  const preview = await worker.preview();
  assert.equal(preview.remote.valid, true, preview.remote.errorCode || "portable restore preview failed");
  assert.ok(preview.remote.exists);
  const authorization = await worker.authorizeRestore({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "use-drive" });
  const restore = await worker.invalidateAfterRestore({ target: authorization.target, restoreAuthorizationId: authorization.restoreAuthorizationId });
  const privateState = await readSyncState(worker);
  assert.equal(privateState.restoreAuthorization.snapshotName, expectedName);
  assert.equal(privateState.restoreAuthorization.snapshotId, preview.remote.snapshotId);
  await prepareGenerationSealedRestore(dataDir);
  const completed = await worker.completeRestore({ target: restore.target, epoch: restore.epoch, restoreAuthorizationId: restore.restoreAuthorizationId });
  assert.equal(completed.backupEnabled, true);
  assert.equal(completed.syncPaused, false);
  assert.equal((await readSyncState(worker)).lastCompleted.snapshotName, expectedName);
}

describe("persistent Google Drive archive sync", () => {
  it("stays passive while disabled and reports safe status without Drive writes", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    worker.start();
    await worker.runOnce();
    await worker.stop();
    assert.equal((await worker.getSafeStatus()).backupEnabled, false);
    assert.deepEqual(drive.counters, { createFolder: 0, createFile: 0, updateFile: 0, copyFile: 0, deleteFile: 0, chunks: 0, starts: 0, maxChunkBytes: 0 });
  });

  it("reads Drive through a frozen client like the real one", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { service, worker } = setup(dataDir, drive);
    service.getClient = async () => Object.freeze({ ...drive.client });
    const preview = await worker.preview();
    assert.equal(preview.remote.valid, true, preview.remote.errorCode);
    assert.equal(preview.remote.empty, true);
  });

  it("publishes a portable pointer only after nested media and inventory verify", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const preview = await choose(worker);
    const completed = await waitForCompleted(worker, preview.local.fingerprint);
    const rootFiles = drive.children(ROOT_ID);
    const pointer = rootFiles.find((item) => item.name === COMMIT_NAME);
    assert.ok(pointer);
    const descriptor = JSON.parse((await drive.client.readFile(pointer.id)).toString("utf8"));
    assert.equal(descriptor.snapshotFingerprint, preview.local.fingerprint);
    assert.equal(Object.keys(descriptor).some((key) => /id$/i.test(key)), false);
    const snapshot = rootFiles.find((item) => item.name === descriptor.snapshotName);
    assert.ok(snapshot);
    const imported = drive.children(snapshot.id).find((item) => item.name === "imported");
    const originals = drive.children(imported.id).find((item) => item.name === "originals");
    const media = drive.children(originals.id).find((item) => item.name === "coat.png");
    assert.equal(media.parents[0], originals.id);
    assert.equal(completed.lastCompletedBackup.fileCount, 2);
    assert.equal(drive.children(snapshot.id).filter((item) => item.name === INVENTORY_NAME).length, 1);
  });

  it("copies unchanged remote media on a small catalog edit and skips equivalent choices", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const first = await choose(worker);
    await waitForCompleted(worker, first.local.fingerprint);
    const beforeEquivalent = { ...drive.counters };
    const equivalent = await worker.preview();
    assert.equal(equivalent.remote.valid, true, equivalent.remote.errorCode || "remote preview failed");
    assert.equal(equivalent.remote.fingerprint, first.local.fingerprint);
    await worker.commitArchiveChoice({ evidenceId: equivalent.evidenceId, source: "feature04", confirmed: true, choice: "equivalent" });
    await waitForCompleted(worker, first.local.fingerprint);
    assert.deepEqual(drive.counters, beforeEquivalent, "an already equivalent archive transfers no bytes or metadata");

    const startsBeforeEdit = drive.counters.starts;
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"new-item\"}]\n");
    const oldSnapshot = (await worker.getSafeStatus()).lastCompletedBackup;
    await worker.runOnce();
    const status = await waitForCompleted(worker);
    assert.notEqual((await readSyncState(worker)).lastCompleted.fingerprint, first.local.fingerprint);
    assert.equal(drive.counters.copyFile, 1, "the existing image is copied within Drive");
    assert.equal(drive.counters.starts - startsBeforeEdit, 1, "only the changed catalog is uploaded");
    assert.equal(drive.children(ROOT_ID).filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1, "the previous completed snapshot is removed after publication");
    assert.ok(oldSnapshot);
  });

  it("keeps unknown foreign snapshot members and reports durable cleanup pending", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const first = await choose(worker);
    await waitForCompleted(worker, first.local.fingerprint);
    const oldSnapshot = drive.children().find((item) => item.name.startsWith("wardrobe-snapshot-"));
    const foreign = drive.addFile({ name: "foreign-not-archive.txt", parentId: oldSnapshot.id, bytes: Buffer.from("keep") });
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"replace-snapshot\"}]\n");
    await worker.runOnce();
    let status = await worker.getSafeStatus();
    for (let attempt = 0; attempt < 50 && status.syncState !== "cleanup_pending"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await worker.getSafeStatus();
    }
    assert.equal(status.syncState, "cleanup_pending");
    assert.equal((await drive.client.getMetadata(foreign.id)).id, foreign.id, "unknown remote data is preserved");
    assert.equal((await readSyncState(worker)).pendingCleanup.snapshotId, oldSnapshot.id);
  });

  it("previews and adopts a manually copied folder with new IDs and no app properties", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const original = makeDrive();
    const first = setup(dataDir, original);
    const firstPreview = await choose(first.worker);
    await waitForCompleted(first.worker, firstPreview.local.fingerprint);
    const copiedRootId = "copyroot_12345";
    const copiedDrive = await original.cloneToRoot(copiedRootId);
    const copied = setup(dataDir, copiedDrive, copiedRootId);
    const preview = await copied.worker.preview();
    assert.equal(preview.remote.valid, true, preview.remote.errorCode || "remote preview failed");
    assert.equal(preview.remote.fingerprint, firstPreview.local.fingerprint);
    assert.ok(preview.remote.snapshotId, "the server-only preview can retain private remote IDs for the later decision");
    for (const node of copiedDrive.nodes.values()) assert.equal(node.appProperties, undefined, "the copy is readable without Drive application properties");
    await copied.worker.commitArchiveChoice({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "equivalent" });
    await waitForCompleted(copied.worker, firstPreview.local.fingerprint);
    assert.equal(copiedDrive.counters.createFile, 0);
  });

  it("converts an adopted raw-root snapshot to one published folder and preserves unknown root files", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const inventory = await buildArchiveInventory(dataDir);
    const drive = makeDrive();
    drive.addFile({ name: "library.json", mimeType: "application/json", bytes: Buffer.from("[]\n") });
    const imported = drive.addFolder({ name: "imported" });
    const originals = drive.addFolder({ name: "originals", parentId: imported.id });
    drive.addFile({ name: "coat.png", mimeType: "image/png", parentId: originals.id, bytes: Buffer.from("coat-image") });
    drive.addFile({ name: INVENTORY_NAME, mimeType: "application/json", bytes: Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`) });
    const foreign = drive.addFile({ name: "foreign-root.dat", bytes: Buffer.from("preserve") });
    const configured = setup(dataDir, drive);
    const preview = await configured.worker.preview();
    assert.equal(preview.remote.valid, true, preview.remote.errorCode || "raw-root preview failed");
    await configured.worker.commitArchiveChoice({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "equivalent" });
    await waitForCompleted(configured.worker, preview.local.fingerprint);

    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"convert-raw-root\"}]\n");
    await configured.worker.runOnce();
    const status = await configured.worker.getSafeStatus();
    assert.equal(status.syncState, "cleanup_pending");
    assert.equal(drive.children().filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1);
    assert.equal(drive.children().filter((item) => item.name === INVENTORY_NAME).length, 0);
    assert.equal((await drive.client.getMetadata(foreign.id)).id, foreign.id);
    assert.equal((await readSyncState(configured.worker)).pendingCleanup.preserveUnknown, true);
  });

  it("does not classify Drive permission failures as an empty archive", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    drive.failListings();
    const { worker } = setup(dataDir, drive);
    const preview = await worker.preview();
    assert.equal(preview.remote.valid, false);
    assert.equal(preview.remote.empty, false);
    assert.equal(preview.remote.errorCode, "folder_read_denied");
    await assert.rejects(worker.commitArchiveChoice({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "initialize" }));
  });

  it("rejects malformed domain schemas without changing the previously committed pointer", async () => {
    const malformed = [
      ["library.json", [{ id: "bad-library", variants: 17 }]],
      ["outfits.json", [{ id: "bad-outfit", pieces: "bad" }]],
      ["inspo.json", [{ id: "bad-inspo", colors: { red: true } }]],
      ["wishlist.json", [{ id: "bad-wishlist", cropImage: true }]],
      ["cheat-sheets.json", [{ id: "bad-sheet", pieces: [{ itemId: "item" }], bands: "bad" }]],
    ];
    for (const [catalog, value] of malformed) {
      const root = await temporaryRoot();
      const dataDir = await prepareArchive(root);
      const drive = makeDrive();
      const { worker } = setup(dataDir, drive);
      const first = await choose(worker);
      await waitForCompleted(worker, first.local.fingerprint);
      const pointer = drive.children().find((item) => item.name === COMMIT_NAME);
      const pointerBytes = await drive.client.readFile(pointer.id);
      const previousFingerprint = (await readSyncState(worker)).lastCompleted.fingerprint;

      await writeFile(path.join(dataDir, catalog), `${JSON.stringify(value)}\n`);
      await assert.rejects(worker.runOnce(), { code: "archive_invalid" }, `${catalog} must fail structural validation`);
      assert.deepEqual(await drive.client.readFile(pointer.id), pointerBytes, `${catalog} cannot replace the committed pointer`);
      assert.equal((await readSyncState(worker)).lastCompleted.fingerprint, previousFingerprint);
      assert.equal((await worker.getSafeStatus()).syncError.code, "archive_invalid");
    }
  });

  it("preserves malformed private state and reports only a curated status", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    await mkdir(path.dirname(stateFile(dataDir)), { recursive: true });
    const malformed = Buffer.from("{\"refreshToken\":\"must-not-be-read-or-reset\"");
    await writeFile(stateFile(dataDir), malformed, { mode: 0o600 });
    const status = await worker.getSafeStatus();
    assert.equal(status.syncState, "error");
    assert.equal(status.syncError.code, "sync_state_invalid");
    assert.equal(JSON.stringify(status).includes("refreshToken"), false);
    await assert.rejects(worker.runOnce(), { code: "sync_state_invalid" });
    assert.deepEqual(await readFile(stateFile(dataDir)), malformed);
    assert.deepEqual(drive.counters, { createFolder: 0, createFile: 0, updateFile: 0, copyFile: 0, deleteFile: 0, chunks: 0, starts: 0, maxChunkBytes: 0 });
  });

  it("treats archive defaults as semantically empty and user preferences as populated", async () => {
    const emptyRoot = await temporaryRoot();
    const emptyData = path.join(emptyRoot, "data");
    await mkdir(emptyData, { recursive: true });
    await writeFile(path.join(emptyData, "library.json"), "[]\n");
    await writeFile(path.join(emptyData, "archive-metadata.json"), JSON.stringify({ schemaVersion: 1, archiveGeneration: 1, referenceSources: {} }));
    await writeFile(path.join(emptyData, "ai-mode.json"), JSON.stringify({ mode: "prod" }));
    await writeFile(path.join(emptyData, "browser-state.json"), JSON.stringify({
      version: 1, archiveGeneration: 1, revision: 0, migrationSealed: false, migratedFields: [],
      declutterKeptIds: [], dismissedNudges: [], modelTier: "standard", onboardingDismissed: false, wornToday: { day: "", ids: [] },
    }));
    const emptySetup = setup(emptyData, makeDrive());
    const emptyPreview = await emptySetup.worker.preview();
    await emptySetup.worker.commitArchiveChoice({ evidenceId: emptyPreview.evidenceId, source: "feature04", confirmed: true, choice: "initialize" });
    await waitForCompleted(emptySetup.worker, emptyPreview.local.fingerprint);

    const populatedRoot = await temporaryRoot();
    const populatedData = path.join(populatedRoot, "data");
    await mkdir(populatedData, { recursive: true });
    await writeFile(path.join(populatedData, "library.json"), "[]\n");
    await writeFile(path.join(populatedData, "archive-metadata.json"), JSON.stringify({ schemaVersion: 1, archiveGeneration: 1, referenceSources: {} }));
    await writeFile(path.join(populatedData, "browser-state.json"), JSON.stringify({
      version: 1, archiveGeneration: 1, revision: 1, migrationSealed: false, migratedFields: [],
      declutterKeptIds: ["item-123"], dismissedNudges: [], modelTier: "standard", onboardingDismissed: false, wornToday: { day: "", ids: [] },
    }));
    const populatedSetup = setup(populatedData, makeDrive());
    const populatedPreview = await populatedSetup.worker.preview();
    assert.equal(populatedPreview.local.populated, true);
    await assert.rejects(populatedSetup.worker.commitArchiveChoice({ evidenceId: populatedPreview.evidenceId, source: "feature04", confirmed: true, choice: "initialize" }), { code: "sync_conflict" });
  });

  it("restarts an expired resumable session under its persisted file identity", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    drive.expireNextSessionQuery();
    const { worker } = setup(dataDir, drive);
    const preview = await choose(worker);
    await waitForCompleted(worker, preview.local.fingerprint);
    assert.ok(drive.counters.starts >= 3, "an expired session was safely reinitialized");
    const snapshot = drive.children().find((item) => item.name.startsWith("wardrobe-snapshot-"));
    const catalog = drive.children(snapshot.id).find((item) => item.name === "library.json");
    assert.equal((await drive.client.readFile(catalog.id)).toString("utf8"), "[]\n");
  });

  it("uploads an original larger than 64 MiB in bounded resumable chunks", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    await writeFile(path.join(dataDir, "imported", "originals", "large.png"), Buffer.alloc(65 * 1024 * 1024, 7));
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const preview = await choose(worker);
    await waitForCompleted(worker, preview.local.fingerprint);
    assert.equal(drive.counters.maxChunkBytes, 8 * 1024 * 1024);
    assert.ok(drive.counters.chunks >= 11, "large source bytes crossed the resumable transport in separate chunks");
    assert.equal((await readSyncState(worker)).lastCompleted.totalBytes > 64 * 1024 * 1024, true);
  });

  it("fences a delayed upload acknowledgement after the Drive target generation changes", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const configured = setup(dataDir, drive);
    const first = await choose(configured.worker);
    await waitForCompleted(configured.worker, first.local.fingerprint);
    const oldFingerprint = (await readSyncState(configured.worker)).lastCompleted.fingerprint;
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"generation-test\"}]\n");

    const originalUpload = drive.client.uploadResumableChunk;
    let begin;
    let release;
    const started = new Promise((resolve) => { begin = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    drive.client.uploadResumableChunk = async (...args) => {
      begin();
      await gate;
      return originalUpload.apply(drive.client, args);
    };
    const pending = configured.worker.runOnce();
    await started;
    configured.changeTarget({ connectionGeneration: "abcdef12abcdef12abcdef12abcdef12" });
    release();
    await assert.rejects(pending, { code: "target_changed" });
    assert.equal((await readSyncState(configured.worker)).lastCompleted.fingerprint, oldFingerprint);
    assert.equal((await configured.worker.getSafeStatus()).syncError.code, "target_changed");
  });

  it("serializes concurrent writers and pause/drain fences a delayed transfer", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const configured = setup(dataDir, drive);
    const first = await choose(configured.worker);
    await waitForCompleted(configured.worker, first.local.fingerprint);
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"pause-test\"}]\n");
    const originalUpload = drive.client.uploadResumableChunk;
    let begin;
    let release;
    const started = new Promise((resolve) => { begin = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    drive.client.uploadResumableChunk = async (...args) => {
      begin();
      await gate;
      return originalUpload.apply(drive.client, args);
    };
    const inFlight = configured.worker.runOnce();
    await started;
    const secondWorker = createGoogleDriveSyncWorker({ service: configured.service, dataDir, pollIntervalMs: 60_000 });
    await assert.rejects(secondWorker.runOnce(), { code: "sync_lock_busy" });
    const draining = configured.worker.pauseAndDrain();
    release();
    await assert.rejects(inFlight, { code: "sync_paused" });
    const paused = await draining;
    assert.equal(paused.syncState, "paused");
    assert.equal(paused.backupEnabled, true);
    assert.ok((await readSyncState(configured.worker)).candidate.directory, "the durable stage survives a pause");
    await configured.worker.resume();
    await waitForCompleted(configured.worker);
  });

  it("recovers a lost final upload acknowledgement without duplicating the remote file", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    drive.loseNextChunkAck();
    const { worker } = setup(dataDir, drive);
    const preview = await choose(worker);
    const errorWaitStarted = Date.now();
    let persisted;
    let errorAndWriterReleased = false;
    while (Date.now() - errorWaitStarted < 20_000) {
      persisted = JSON.parse(await readFile(stateFile(dataDir), "utf8"));
      if (persisted.phase === "error") {
        try { await access(path.join(dataDir, ".google-drive", "sync.lock")); }
        catch (error) {
          assert.equal(error.code, "ENOENT");
          errorAndWriterReleased = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(errorAndWriterReleased, true, "the lost acknowledgement must be persisted and the uploader lock released before restart state is edited");
    assert.ok(persisted.candidate?.directory, "immutable candidate remains durable after the lost acknowledgement");
    persisted.retry.at = 0;
    await writeFile(stateFile(dataDir), JSON.stringify(persisted), { mode: 0o600 });
    const restarted = setup(dataDir, drive).worker;
    const status = await restarted.runOnce();
    assert.equal(status.syncState, "idle");
    assert.equal((await restarted.getSafeStatus()).lastCompletedBackup.fileCount, 2);
    assert.equal(drive.children().filter((item) => item.name === "coat.png").length, 0, "media is nested under the archive folder");
    const snapshot = drive.children().find((item) => item.name.startsWith("wardrobe-snapshot-"));
    const inventory = drive.children(snapshot.id).find((item) => item.name === INVENTORY_NAME);
    const declared = JSON.parse((await drive.client.readFile(inventory.id)).toString("utf8"));
    assert.equal(declared.files.length, 2);
    assert.equal(drive.counters.starts, 2, "catalog and media each received exactly one resumable session");
    assert.ok(preview.local.fingerprint);
  });

  it("finishes the frozen candidate when local data changes during transfer, then coalesces the newer archive", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const preview = await choose(worker);
    await waitForCompleted(worker, preview.local.fingerprint);

    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"version-one\"}]\n");
    const source = drive.client.uploadResumableChunk;
    let changed = false;
    drive.client.uploadResumableChunk = async (...args) => {
      const result = await source.apply(drive.client, args);
      if (!changed) {
        changed = true;
        await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"version-two\"}]\n");
      }
      return result;
    };
    await worker.runOnce();
    const firstCompleted = (await readSyncState(worker)).lastCompleted.fingerprint;
    const second = await worker.runOnce();
    assert.equal(second.syncState, "idle");
    assert.notEqual((await readSyncState(worker)).lastCompleted.fingerprint, firstCompleted);
    assert.equal(drive.children().filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1);
  });

  it("coalesces runOnce requests made after lock release but before the active run is cleared", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    let releaseGate;
    let announceGate;
    const gateReached = new Promise((resolve) => { announceGate = resolve; });
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let holdFirstRun = true;
    const { worker } = setup(dataDir, drive, ROOT_ID, {
      onRunLockReleased: async () => {
        if (!holdFirstRun) return;
        holdFirstRun = false;
        announceGate();
        await gate;
      },
    });

    await choose(worker);
    await gateReached;
    const stateAtGate = await readSyncState(worker);
    assert.equal(stateAtGate.phase, "idle", "the first scan has written its completed state");
    try {
      await access(path.join(dataDir, ".google-drive", "sync.lock"));
      assert.fail("the writer lock should be released while the run completion is gated");
    } catch (error) { assert.equal(error.code, "ENOENT"); }

    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"coalesced-after-lock-release\"}]\n");
    const editedFingerprint = digest(Buffer.from(JSON.stringify(await buildArchiveInventory(dataDir))));
    const requestedRun = worker.runOnce();
    let rerunFinished = false;
    requestedRun.then(() => { rerunFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rerunFinished, false, "the concurrent caller waits for its requested follow-up scan");
    releaseGate();
    await requestedRun;
    await waitForCompleted(worker, editedFingerprint);
    assert.equal((await readSyncState(worker)).lastCompleted.fingerprint, editedFingerprint);
  });

  it("keeps a pre-pointer candidate retryable when the pointer update fails", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker, service } = setup(dataDir, drive);
    const first = await choose(worker);
    await waitForCompleted(worker, first.local.fingerprint);
    const pointer = drive.children().find((item) => item.name === COMMIT_NAME);
    const previousPointer = await drive.client.readFile(pointer.id);
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"pointer-retry\"}]\n");
    const update = drive.client.updateFile;
    let failPointer = true;
    drive.client.updateFile = async (args) => {
      if (failPointer && args.fileId === pointer.id) {
        failPointer = false;
        throw Object.assign(new Error("private provider text"), { code: "google_unavailable", retryable: true });
      }
      return update(args);
    };
    await assert.rejects(worker.runOnce(), { code: "google_unavailable" });
    const failed = await readSyncState(worker);
    assert.ok(failed.candidate?.directory);
    assert.equal(failed.pendingCleanups.length, 0, "retirement begins only after pointer verification");
    assert.deepEqual(await drive.client.readFile(pointer.id), previousPointer);
    failed.retry.at = 0;
    await writeFile(stateFile(dataDir), JSON.stringify(failed));
    const restarted = createGoogleDriveSyncWorker({ service, dataDir });
    await restarted.runOnce();
    assert.equal((await readSyncState(restarted)).candidate, null);
    assert.notDeepEqual(await drive.client.readFile(pointer.id), previousPointer);
  });

  it("binds retirement to the exact same-fingerprint repair commit after pointer retry", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker, service } = setup(dataDir, drive);
    const preview = await choose(worker);
    await waitForCompleted(worker, preview.local.fingerprint);

    const oldSnapshot = drive.children().find((item) => item.name.startsWith("wardrobe-snapshot-"));
    const remoteCatalog = drive.children(oldSnapshot.id).find((item) => item.name === "library.json");
    remoteCatalog.content = Buffer.from("[{\"id\":\"external-corruption\"}]\n");
    remoteCatalog.size = String(remoteCatalog.content.length);
    remoteCatalog.sha256Checksum = digest(remoteCatalog.content);
    const originalState = await readSyncState(worker);
    originalState.lastVerifiedAt = 0;
    await writeFile(stateFile(dataDir), JSON.stringify(originalState));

    const pointer = drive.children().find((item) => item.name === COMMIT_NAME);
    const oldPointerBytes = await drive.client.readFile(pointer.id);
    const update = drive.client.updateFile;
    let failPointer = true;
    drive.client.updateFile = async (args) => {
      if (failPointer && args.fileId === pointer.id) {
        failPointer = false;
        throw Object.assign(new Error("lost pointer update"), { code: "google_unavailable", retryable: true });
      }
      return update(args);
    };
    await assert.rejects(worker.runOnce(), { code: "google_unavailable" });
    const failed = await readSyncState(worker);
    assert.equal(failed.lastCompleted.snapshotId, oldSnapshot.id);
    assert.equal(failed.candidate.fingerprint, preview.local.fingerprint, "repair keeps the local fingerprint unchanged");
    assert.equal(failed.pendingCleanups.length, 0, "the old selected folder has no retirement proof before pointer readback");
    assert.equal(drive.children().some((item) => item.id === oldSnapshot.id), true);
    assert.deepEqual(await drive.client.readFile(pointer.id), oldPointerBytes);

    failed.retry.at = 0;
    await writeFile(stateFile(dataDir), JSON.stringify(failed));
    const restarted = createGoogleDriveSyncWorker({ service, dataDir });
    await restarted.runOnce();
    const completed = await readSyncState(restarted);
    assert.equal(completed.candidate, null);
    assert.equal(completed.lastCompleted.fingerprint, preview.local.fingerprint);
    assert.notEqual(completed.lastCompleted.snapshotId, oldSnapshot.id);
    assert.equal(drive.children().some((item) => item.id === oldSnapshot.id), true,
      "the externally modified old folder is preserved as unverifiable residue");
    const newPointer = JSON.parse((await drive.client.readFile(pointer.id)).toString("utf8"));
    assert.equal(newPointer.snapshotName, completed.lastCompleted.snapshotName);
    assert.equal(newPointer.snapshotFingerprint, completed.lastCompleted.fingerprint);
    const retirement = completed.pendingCleanups.find((item) => item.snapshotId === oldSnapshot.id);
    assert.ok(retirement, "unverifiable old bytes remain pending cleanup");
    assert.equal(retirement.afterSnapshotId, completed.lastCompleted.snapshotId,
      "retirement is bound to the verified new snapshot, not just its unchanged fingerprint");
    assert.equal(retirement.afterSnapshotName, newPointer.snapshotName);
    assert.equal(retirement.afterDescriptorFingerprint, digest(await drive.client.readFile(pointer.id)));
  });

  it("keeps cleanup leftovers from blocking later local snapshots", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    await choose(worker);
    await waitForCompleted(worker);
    const old = drive.children().find((item) => item.name.startsWith("wardrobe-snapshot-"));
    drive.addFile({ name: "foreign.txt", parentId: old.id, bytes: Buffer.from("preserve me") });
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"first-edit\"}]\n");
    await worker.runOnce();
    const firstEdit = (await readSyncState(worker)).lastCompleted.fingerprint;
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"second-edit\"}]\n");
    await worker.runOnce();
    const state = await readSyncState(worker);
    assert.notEqual(state.lastCompleted.fingerprint, firstEdit);
    assert.ok(state.pendingCleanups.length >= 1);
    assert.equal(drive.children().filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 2,
      "the old incomplete folder may retain foreign residue while the current snapshot remains selectable");
  });

  it("retires a validated property-less manual copy after the next local change", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const original = makeDrive();
    const first = setup(dataDir, original);
    await choose(first.worker);
    await waitForCompleted(first.worker);
    const copiedDrive = await original.cloneToRoot("copyroot_12345");
    const copied = setup(dataDir, copiedDrive, "copyroot_12345");
    const preview = await copied.worker.preview();
    await copied.worker.commitArchiveChoice({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "equivalent" });
    await waitForCompleted(copied.worker);
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"adopted-edit-1\"}]\n");
    await copied.worker.runOnce();
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"adopted-edit-2\"}]\n");
    await copied.worker.runOnce();
    const state = await readSyncState(copied.worker);
    assert.notEqual(state.lastCompleted.fingerprint, preview.remote.fingerprint);
    assert.equal(copiedDrive.children("copyroot_12345").filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1);
  });

  it("treats a lost old-folder delete acknowledgement as completed after a full root listing", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    await choose(worker);
    await waitForCompleted(worker);
    const old = drive.children().find((item) => item.name.startsWith("wardrobe-snapshot-"));
    const remove = drive.client.deleteFile;
    let lost = false;
    drive.client.deleteFile = async (id) => {
      await remove(id);
      if (id === old.id && !lost) { lost = true; throw Object.assign(new Error("lost ack"), { code: "google_unavailable", retryable: true }); }
    };
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"delete-ack-1\"}]\n");
    await worker.runOnce();
    assert.ok(lost);
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"delete-ack-2\"}]\n");
    await worker.runOnce();
    assert.notEqual((await readSyncState(worker)).lastCompleted.fingerprint, null);
    assert.equal(drive.children().filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1);
  });

  it("keeps partial owned staging recoverable across disable and later explicit activation", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    drive.loseNextChunkAck();
    const { worker } = setup(dataDir, drive);
    await choose(worker);
    const started = Date.now();
    while (Date.now() - started < 2_000 && (await readSyncState(worker)).phase !== "error") await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok((await readSyncState(worker)).candidate?.folderId);
    await worker.disable();
    const preview = await worker.preview();
    assert.equal(preview.remote.valid, true, "an incomplete worker-owned stage is not treated as a foreign archive");
    assert.equal(preview.remote.empty, true);
    await worker.commitArchiveChoice({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "use-local" });
    await waitForCompleted(worker);
    assert.equal((await readSyncState(worker)).orphanCandidates.length, 0);
    assert.equal(drive.children().filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1);
  });

  it("never cleans a lost-ack candidate after disable when equivalent activation adopts its pointer", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const createFile = drive.client.createFile;
    let lostPointerAck = false;
    drive.client.createFile = async (args) => {
      const created = await createFile(args);
      if (!lostPointerAck && args.name === COMMIT_NAME) {
        lostPointerAck = true;
        throw Object.assign(new Error("pointer acknowledgement lost"), { code: "google_unavailable", retryable: true });
      }
      return created;
    };
    const initial = await choose(worker);
    const started = Date.now();
    while (Date.now() - started < 3_000 && (await readSyncState(worker)).phase !== "error") await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(lostPointerAck, true);
    let state = await readSyncState(worker);
    assert.equal(state.lastCompleted, null);
    assert.ok(state.candidate?.folderId);
    const selectedSnapshotId = state.candidate.folderId;
    const pointer = drive.children().find((item) => item.name === COMMIT_NAME);
    const selectedPointerBytes = await drive.client.readFile(pointer.id);
    const selectedCatalog = drive.children(selectedSnapshotId).find((item) => item.name === "library.json");
    const selectedCatalogBytes = await drive.client.readFile(selectedCatalog.id);
    const completedTransferCounts = { ...drive.counters };

    await worker.disable();
    state = await readSyncState(worker);
    assert.equal(state.candidate, null);
    assert.equal(state.orphanCandidates.length, 1);
    const adopted = await worker.preview();
    assert.equal(adopted.remote.snapshotId, selectedSnapshotId);
    await worker.commitArchiveChoice({ evidenceId: adopted.evidenceId, source: "feature04", confirmed: true, choice: "equivalent" });
    const adoptStarted = Date.now();
    while (Date.now() - adoptStarted < 3_000) {
      state = await readSyncState(worker);
      if (state.enabled && state.lastCompleted?.snapshotId === selectedSnapshotId
          && state.orphanCandidates.length === 0 && state.phase === "idle"
          && !drive.nodes.get(selectedSnapshotId)?.trashed) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    state = await readSyncState(worker);
    assert.equal(state.lastCompleted.snapshotId, selectedSnapshotId);
    assert.equal(state.orphanCandidates.length, 0, "explicit adoption retires the stale orphan-cleanup record");
    assert.equal(drive.nodes.get(selectedSnapshotId).trashed, false);
    assert.deepEqual(await drive.client.readFile(pointer.id), selectedPointerBytes);
    assert.deepEqual(await drive.client.readFile(selectedCatalog.id), selectedCatalogBytes);
    assert.equal(drive.counters.deleteFile, 0, "the adopted selected snapshot is never processed as a disposable orphan");
    assert.deepEqual(drive.counters, completedTransferCounts, "equivalent adoption performs no redundant remote transfers");
    const adoptedStatus = await worker.getSafeStatus();
    assert.equal(adoptedStatus.syncState, "idle");
    assert.equal(adoptedStatus.syncError, null);

    // Let any auto-scan queued by equivalent adoption settle before simulating
    // the application's atomic catalog publication.
    await worker.runOnce();
    await writeCatalogAtomically(dataDir, "[{\"id\":\"after-adopted-ack\"}]\n");
    const editedFingerprint = digest(Buffer.from(JSON.stringify(await buildArchiveInventory(dataDir))));
    await worker.runOnce();
    await waitForCompleted(worker, editedFingerprint);
    assert.equal((await readSyncState(worker)).lastCompleted.fingerprint, editedFingerprint);
    assert.equal(drive.children().filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1);
  });

  it("rebuilds frozen candidates when their root or cached nested folder is deleted", async () => {
    for (const deletion of ["nested", "root"]) {
      const root = await temporaryRoot();
      const dataDir = await prepareArchive(root);
      const drive = makeDrive();
      const { worker } = setup(dataDir, drive);
      await choose(worker);
      await waitForCompleted(worker);
      const priorCompletedId = (await readSyncState(worker)).lastCompleted.snapshotId;
      await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"folder-recovery\"}]\n");
      await writeFile(path.join(dataDir, "imported", "originals", "coat.png"), Buffer.from("changed coat payload"));

      const upload = drive.client.uploadResumableChunk;
      let interrupted = false;
      drive.client.uploadResumableChunk = async (args) => {
        const result = await upload(args);
        if (!interrupted && result.complete) {
          const state = await readSyncState(worker);
          const candidate = state.candidate;
          const originals = candidate.directories.find((item) => item.path === "imported/originals");
          assert.ok(originals, "the paused candidate persisted nested folder identity before transfer completion");
          interrupted = true;
          const trashTree = (id) => {
            const node = drive.nodes.get(id);
            if (!node) return;
            for (const child of drive.nodes.values()) {
              if (!child.trashed && child.parents?.includes(id)) trashTree(child.id);
            }
            node.trashed = true;
          };
          if (deletion === "root") trashTree(candidate.folderId);
          else {
            const child = drive.nodes.get(result.metadata.id);
            assert.equal(child.parents[0], originals.id);
            trashTree(originals.id);
          }
          throw Object.assign(new Error("lost completed folder transfer"), { code: "google_unavailable", retryable: true });
        }
        return result;
      };
      await assert.rejects(worker.runOnce(), { code: "google_unavailable" });
      await worker.pauseAndDrain();
      const failed = await readSyncState(worker);
      assert.ok(failed.candidate?.directory);
      const oldRootId = failed.candidate.folderId;
      const oldNestedId = failed.candidate.directories.find((item) => item.path === "imported/originals").id;
      assert.notEqual(failed.lastCompleted.snapshotId, null);

      drive.client.uploadResumableChunk = upload;
      const retry = await readSyncState(worker);
      retry.retry.at = 0;
      await writeFile(stateFile(dataDir), JSON.stringify(retry));
      await worker.resume();
      const expected = digest(Buffer.from(JSON.stringify(await buildArchiveInventory(dataDir))));
      await waitForCompleted(worker, expected);
      const completed = await readSyncState(worker);
      assert.equal(completed.candidate, null);
      assert.notEqual(completed.lastCompleted.snapshotId, priorCompletedId);
      if (deletion === "root") assert.notEqual(completed.lastCompleted.snapshotId, oldRootId);
      else assert.notEqual(completed.lastCompleted.directories.find((item) => item.path === "imported/originals").id, oldNestedId);
      assert.equal(drive.children().filter((item) => item.name.startsWith("wardrobe-snapshot-")).length, 1,
        "the selected previous backup remains valid until the rebuilt candidate is published");
    }
  });

  it("sweeps only unreferenced private stages after a valid state read", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const initial = await choose(worker);
    await waitForCompleted(worker, initial.local.fingerprint);
    await writeFile(path.join(dataDir, "imported", "originals", "coat.png"), Buffer.from("retryable coat"));
    const startUpload = drive.client.startResumableUpload;
    let failedUpload = false;
    drive.client.startResumableUpload = async (args) => {
      if (!failedUpload && args.name === "coat.png") {
        failedUpload = true;
        throw Object.assign(new Error("temporary upload outage"), { code: "google_unavailable", retryable: true });
      }
      return startUpload(args);
    };
    await assert.rejects(worker.runOnce(), { code: "google_unavailable" });
    await worker.pauseAndDrain();
    const state = await readSyncState(worker);
    const durableStage = state.candidate.directory;
    const snapshots = path.join(worker.privateDir, "snapshots");
    const abandoned = path.join(snapshots, "snapshot-12345678-1234-1234-1234-123456789abc");
    await mkdir(abandoned, { recursive: true });
    await worker.runOnce();
    await assert.rejects(access(abandoned), { code: "ENOENT" });
    await access(durableStage);

    const malformedBytes = Buffer.from("{\"private\":true");
    await writeFile(stateFile(dataDir), malformedBytes);
    const malformedOrphan = path.join(snapshots, "snapshot-abcdefab-cdef-abcd-efab-cdefabcdefab");
    await mkdir(malformedOrphan, { recursive: true });
    await assert.rejects(worker.runOnce(), { code: "sync_state_invalid" });
    assert.deepEqual(await readFile(stateFile(dataDir)), malformedBytes);
    await access(malformedOrphan);
  });

  it("repairs a remote byte edit into a fresh operation identity and keeps later snapshots flowing", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    await choose(worker);
    await waitForCompleted(worker);
    const state = await readSyncState(worker);
    const edited = drive.nodes.get(state.lastCompleted.files["imported/originals/coat.png"].id);
    edited.content = Buffer.from("external edit");
    edited.size = String(edited.content.length);
    edited.sha256Checksum = digest(edited.content);
    state.lastVerifiedAt = 1;
    await writeFile(stateFile(dataDir), JSON.stringify(state));
    await worker.runOnce();
    assert.equal((await readSyncState(worker)).lastCompleted.fingerprint, state.lastCompleted.fingerprint);
    await writeFile(path.join(dataDir, "library.json"), "[{\"id\":\"after-repair\"}]\n");
    await worker.runOnce();
    assert.notEqual((await readSyncState(worker)).lastCompleted.fingerprint, state.lastCompleted.fingerprint);
    const pointer = drive.children().find((item) => item.name === COMMIT_NAME);
    const descriptor = JSON.parse((await drive.client.readFile(pointer.id)).toString("utf8"));
    assert.equal(descriptor.snapshotFingerprint, (await readSyncState(worker)).lastCompleted.fingerprint);
  });

  it("expires preview evidence and removes transient local copies", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { service } = setup(dataDir, drive);
    let time = Date.now();
    const worker = createGoogleDriveSyncWorker({ service, dataDir, now: () => time });
    const preview = await worker.preview();
    await access(preview.local.directory);
    time += 11 * 60 * 1000;
    await assert.rejects(worker.commitArchiveChoice({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "use-local" }), { code: "sync_conflict" });
    await assert.rejects(access(preview.local.directory), { code: "ENOENT" });
    const retained = await worker.preview();
    await worker.stop();
    await assert.rejects(access(retained.local.directory), { code: "ENOENT" });
  });

  it("rejects malformed private status fields without echoing their contents", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const { worker, service } = setup(dataDir, drive);
    await choose(worker);
    await waitForCompleted(worker);
    const state = await readSyncState(worker);
    state.lastError = "private-token-marker";
    state.lastCompleted.completedAt = { privatePath: "/private/token-path-marker" };
    await writeFile(stateFile(dataDir), JSON.stringify(state));
    const restarted = createGoogleDriveSyncWorker({ service, dataDir });
    const status = await restarted.getSafeStatus();
    assert.equal(status.syncError.code, "sync_state_invalid", JSON.stringify({ status, state: await readSyncState(restarted) }));
    assert.equal(JSON.stringify(status).includes("private-token-marker"), false);
    assert.equal(JSON.stringify(status).includes("token-path-marker"), false);
  });

  it("bounds Drive custom-property bytes for long portable names", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const drive = makeDrive();
    const relative = `imported/originals/${"x".repeat(91)}.png`;
    await writeFile(path.join(dataDir, ...relative.split("/")), Buffer.from("long path media"));
    for (const method of ["createFolder", "createFile", "updateFile", "copyFile", "startResumableUpload"]) {
      const original = drive.client[method];
      drive.client[method] = async (args) => {
        for (const [key, value] of Object.entries(args.appProperties || {})) {
          assert.ok(Buffer.byteLength(key + value, "utf8") <= 124, `Drive appProperties ${key} must fit the 124-byte key+value limit`);
        }
        return original.call(drive.client, args);
      };
    }
    const { worker } = setup(dataDir, drive);
    await choose(worker);
    await waitForCompleted(worker);
    assert.ok((await readSyncState(worker)).lastCompleted.files[relative]);
  });

  it("requires explicit restore authorization and accepts only the generation-and-seal transform", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareArchive(root);
    const metadata = { schemaVersion: 1, archiveGeneration: 1, referenceSources: {} };
    const browserState = {
      version: 1, archiveGeneration: 1, revision: 0, migrationSealed: false, migratedFields: [],
      declutterKeptIds: [], dismissedNudges: [], modelTier: "standard", onboardingDismissed: false,
      wornToday: { day: "", ids: [] },
    };
    await writeFile(path.join(dataDir, "archive-metadata.json"), `${JSON.stringify(metadata)}\n`);
    await writeFile(path.join(dataDir, "browser-state.json"), `${JSON.stringify(browserState)}\n`);
    const drive = makeDrive();
    const { worker } = setup(dataDir, drive);
    const initial = await choose(worker);
    await waitForCompleted(worker, initial.local.fingerprint);
    await worker.disable();
    const beforeAuthorization = { ...drive.counters };
    const preview = await worker.preview();
    await assert.rejects(worker.invalidateAfterRestore({ target: preview.target }), { code: "sync_conflict" });
    const authorization = await worker.authorizeRestore({ evidenceId: preview.evidenceId, source: "feature04", confirmed: true, choice: "use-drive" });
    const restore = await worker.invalidateAfterRestore({ target: authorization.target, restoreAuthorizationId: authorization.restoreAuthorizationId });
    assert.equal((await worker.getSafeStatus()).backupEnabled, false, "an OAuth-only worker stays disabled during restore staging");
    assert.deepEqual(drive.counters, beforeAuthorization, "consent and invalidation perform no Drive writes");
    const migratedFields = ["itemEdits", "deletedIds", "colorProfile", "declutterKeptIds", "dismissedNudges", "modelTier", "onboardingDismissed", "wornToday"];
    await writeFile(path.join(dataDir, "archive-metadata.json"), `${JSON.stringify({ ...metadata, archiveGeneration: 2 })}\n`);
    await writeFile(path.join(dataDir, "browser-state.json"), `${JSON.stringify({ ...browserState, archiveGeneration: 2, revision: 1, migrationSealed: true, migratedFields })}\n`);
    const complete = await worker.completeRestore({ target: restore.target, epoch: restore.epoch, restoreAuthorizationId: restore.restoreAuthorizationId });
    assert.equal(complete.backupEnabled, true, "only the explicit restore capability authorizes activation");
    assert.equal(complete.syncPaused, false);
    await worker.runOnce();
    assert.equal((await readSyncState(worker)).lastCompleted.fingerprint, (await readSyncState(worker)).desiredFingerprint);
  });

  it("completes an explicitly chosen restore from a manually copied folder with a portable name", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareRestoreFixture(root);
    const original = makeDrive();
    const first = setup(dataDir, original);
    await choose(first.worker);
    await waitForCompleted(first.worker);
    const copyRootId = "portable_12345";
    const copied = await original.cloneToRoot(copyRootId);
    const pointer = copied.children(copyRootId).find((item) => item.name === COMMIT_NAME);
    const snapshot = copied.children(copyRootId).find((item) => item.name.startsWith("wardrobe-snapshot-"));
    snapshot.name = "Manually copied wardrobe";
    await copied.client.deleteFile(pointer.id);
    const imported = setup(dataDir, copied, copyRootId);
    await authorizeAndCompleteRestore(imported.worker, dataDir, "Manually copied wardrobe");
  });

  it("completes an explicitly chosen restore from a portable raw-root archive", async () => {
    const root = await temporaryRoot();
    const dataDir = await prepareRestoreFixture(root);
    const original = makeDrive();
    const first = setup(dataDir, original);
    await choose(first.worker);
    await waitForCompleted(first.worker);
    const copyRootId = "rawcopy_12345";
    const copied = await original.cloneToRoot(copyRootId);
    const pointer = copied.children(copyRootId).find((item) => item.name === COMMIT_NAME);
    const snapshot = copied.children(copyRootId).find((item) => item.name.startsWith("wardrobe-snapshot-"));
    await copied.client.deleteFile(pointer.id);
    for (const child of copied.children(snapshot.id)) copied.nodes.get(child.id).parents = [copyRootId];
    await copied.client.deleteFile(snapshot.id);
    const imported = setup(dataDir, copied, copyRootId);
    await authorizeAndCompleteRestore(imported.worker, dataDir, "Wardrobe archive");
  });
});
