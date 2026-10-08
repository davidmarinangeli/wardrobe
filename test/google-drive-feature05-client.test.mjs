import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleDriveStorageController } from "../src/google-drive-storage.js";

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return structuredClone(value); } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function driveStatus(overrides = {}) {
  return {
    configured: true,
    state: "connected",
    connected: true,
    backupEnabled: false,
    reconnectRequired: false,
    account: { id: "private-account-id-123", email: "person@example.test", name: "Person" },
    folder: { id: "private-folder-id-123", driveId: null, name: "Wardrobe archive", readable: true, writable: true },
    targetFingerprint: "private-fingerprint",
    connectionGeneration: "private-connection-generation",
    syncState: "disabled",
    syncCurrentFiles: 0,
    syncTotalFiles: 0,
    syncCurrentBytes: 0,
    syncTotalBytes: 0,
    pendingChanges: false,
    syncPaused: false,
    syncError: null,
    retryAt: null,
    lastCompletedBackup: null,
    maintenance: { active: false, error: null },
    archiveGeneration: 7,
    ...overrides,
  };
}

function archiveStatus(overrides = {}) {
  return { maintenance: { active: false, error: null }, archiveGeneration: 7, restore: null, ...overrides };
}

function testController(request) {
  return createGoogleDriveStorageController({
    request,
    navigate() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {},
    getWindow: () => null,
  });
}

test("a poll already in flight cannot overwrite state after a newer explicit action starts", async () => {
  const delayedStatus = deferred();
  let statusReads = 0;
  const controller = testController(async (url) => {
    if (url.endsWith("/api/google-drive/status")) {
      statusReads += 1;
      return statusReads === 1 ? delayedStatus.promise : response(driveStatus());
    }
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    if (url.endsWith("/api/google-drive/oauth/start")) return response({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture" });
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  const stalePoll = controller.start();
  assert.equal(await controller.startOAuth(), true);
  delayedStatus.resolve(response(driveStatus({ state: "disconnected", connected: false, account: null, folder: null })));
  await stalePoll;

  assert.equal(controller.getSnapshot().status, null, "the poll began before the explicit action and has lost its lifecycle claim");
  controller.stop();
});

test("a preview returned after the controller stops is explicitly canceled and never restored in client state", async () => {
  const delayedPreview = deferred();
  const previewStarted = deferred();
  const calls = [];
  const controller = testController(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/google-drive/status")) return response(driveStatus());
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    if (url.endsWith("/api/google-drive/archive/activation/preview")) { previewStarted.resolve(); return delayedPreview.promise; }
    if (url.endsWith("/api/google-drive/archive/activation/choice")) return response({ status: "cancelled" });
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  const pending = controller.openPreview("activation");
  await previewStarted.promise;
  controller.stop();
  delayedPreview.resolve(response({
    actionToken: "private-action-token",
    operation: "activation",
    decision: "initialize",
    choices: ["initialize", "cancel"],
    local: { valid: true, populated: false, files: 0, bytes: 0, fingerprint: "private-local-fingerprint" },
    remote: { valid: true, empty: true, populated: false, files: 0, bytes: 0, fingerprint: "private-remote-fingerprint" },
  }));
  await pending;

  const cancellation = calls.find((call) => call.url.endsWith("/api/google-drive/archive/activation/choice"));
  assert.ok(cancellation, "the late server preview receives an explicit cancel choice");
  assert.deepEqual(JSON.parse(cancellation.options.body), { actionToken: "private-action-token", choice: "cancel" });
  assert.equal(controller.getSnapshot().preview, null);
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private-action-token|private-fingerprint|private-account-id|private-folder-id/);
});

test("closing a settings preview waits for server cancellation acknowledgment", async () => {
  const delayedCancel = deferred();
  let cancelBody;
  const controller = testController(async (url, options = {}) => {
    if (url.endsWith("/api/google-drive/status")) return response(driveStatus());
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    if (url.endsWith("/api/google-drive/archive/activation/preview")) return response({
      actionToken: "opaque-token",
      decision: "local_to_empty",
      choices: ["use-local", "cancel"],
      local: { valid: true, populated: true, files: 3, bytes: 900 },
      remote: { valid: true, empty: true, populated: false, files: 0, bytes: 0 },
    });
    if (url.endsWith("/api/google-drive/archive/activation/choice")) {
      cancelBody = JSON.parse(options.body);
      return delayedCancel.promise;
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  assert.equal(await controller.openPreview("activation"), true);
  const close = controller.requestClose();
  assert.equal(controller.getSnapshot().preview.decision, "local_to_empty");
  assert.equal(controller.getSnapshot().busy, "cancel-preview");
  let closed = false;
  void close.then((allowed) => { closed = allowed; });
  await Promise.resolve();
  assert.equal(closed, false, "settings remains open until the server has released the preview");
  assert.deepEqual(cancelBody, { actionToken: "opaque-token", choice: "cancel" });
  delayedCancel.resolve(response({ status: "cancelled" }));
  assert.equal(await close, true);
  assert.equal(controller.getSnapshot().preview, null);
  assert.equal(controller.getSnapshot().busy, null);
  controller.stop();
});

test("failed preview cancellation keeps the preview open and allows a later acknowledged retry", async () => {
  let cancellationAttempts = 0;
  const controller = testController(async (url, options = {}) => {
    if (url.endsWith("/api/google-drive/status")) return response(driveStatus());
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    if (url.endsWith("/api/google-drive/archive/activation/preview")) return response({
      actionToken: "retryable-preview-token", decision: "initialize", choices: ["initialize", "cancel"],
      local: { valid: true, populated: false, files: 0, bytes: 0 }, remote: { valid: true, empty: true, populated: false, files: 0, bytes: 0 },
    });
    if (url.endsWith("/api/google-drive/archive/activation/choice")) {
      cancellationAttempts += 1;
      assert.deepEqual(JSON.parse(options.body), { actionToken: "retryable-preview-token", choice: "cancel" });
      return cancellationAttempts === 1
        ? response({ error: { code: "google_unavailable" } }, 503)
        : response({ status: "cancelled" });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  await controller.openPreview("activation");
  assert.equal(await controller.requestClose(), false);
  assert.equal(controller.getSnapshot().preview.decision, "initialize", "a failed acknowledgment cannot drop the worker-pausing preview");
  assert.equal(controller.getSnapshot().busy, null);
  assert.match(controller.getSnapshot().actionError, /Drive non è raggiungibile/i);
  assert.equal(await controller.requestClose(), true);
  assert.equal(controller.getSnapshot().preview, null);
  assert.equal(cancellationAttempts, 2);
  controller.stop();
});

test("an incomplete remote read stays an explicit unavailable error, never an empty archive", async () => {
  const controller = testController(async (url) => {
    if (url.endsWith("/api/google-drive/status")) return response(driveStatus());
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    if (url.endsWith("/api/google-drive/archive/activation/preview")) return response({
      actionToken: "opaque-token",
      decision: "unavailable",
      choices: ["cancel"],
      local: { valid: false, populated: false, files: 0, bytes: 0 },
      remote: { valid: false, empty: false, populated: false, files: 0, bytes: 0, error: "folder_read_denied" },
    });
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  await controller.openPreview("activation");
  const view = controller.getSnapshot();
  assert.equal(view.preview.decision, "unavailable");
  assert.equal(view.preview.remote.valid, false);
  assert.equal(view.preview.remote.empty, false);
  assert.match(view.preview.remote.error, /lettura/i);
  assert.deepEqual(view.preview.choices, ["cancel"]);
  assert.doesNotMatch(JSON.stringify(view), /opaque-token|private-account-id|private-folder-id|targetFingerprint/);
  await controller.choose("cancel");
  controller.stop();
});

test("storage status is available without AI configuration and does not imply an archive is connected", async () => {
  const calls = [];
  const controller = testController(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/google-drive/status")) return response({ configured: false, state: "disconnected", connected: false, backupEnabled: false });
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  assert.equal(controller.getSnapshot().status.configured, false);
  assert.equal(controller.getSnapshot().status.backupEnabled, false);
  assert.equal(await controller.openPreview("activation"), false, "activation still requires an explicitly connected and verified folder");
  assert.equal(calls.some(({ url }) => url.includes("/api/import/")), false, "storage entry reads no AI setup or provider route");
  assert.equal(calls.some(({ url }) => url.includes("oauth/start")), false, "status does not start OAuth implicitly");
  controller.stop();
});

test("activation uses only choices advertised by each complete decision preview", async () => {
  const cases = [
    { decision: "local_to_empty", choices: ["use-local", "cancel"], choose: "use-local" },
    { decision: "drive_to_empty", choices: ["use-drive", "cancel"], choose: "use-drive" },
    { decision: "initialize", choices: ["initialize", "cancel"], choose: "initialize" },
    { decision: "equivalent", choices: ["equivalent", "cancel"], choose: "equivalent" },
    { decision: "different", choices: ["use-local", "use-drive", "cancel"], choose: "use-local" },
    { decision: "local_invalid", choices: ["use-drive", "cancel"], choose: "use-drive", rejected: "use-local" },
    { decision: "unavailable", choices: ["cancel"], choose: "cancel", rejected: "use-drive" },
  ];

  for (const scenario of cases) {
    let submittedChoice = null;
    const controller = testController(async (url, options = {}) => {
      if (url.endsWith("/api/google-drive/status")) return response(driveStatus());
      if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
      if (url.endsWith("/api/google-drive/archive/activation/preview")) return response({
        actionToken: "private-choice-token",
        decision: scenario.decision,
        choices: scenario.choices,
        local: { valid: scenario.decision !== "local_invalid", populated: true, files: 2, bytes: 128 },
        remote: { valid: scenario.decision !== "unavailable", empty: false, populated: true, files: 3, bytes: 256, error: scenario.decision === "unavailable" ? "folder_read_denied" : null },
      });
      if (url.endsWith("/api/google-drive/archive/activation/choice")) {
        submittedChoice = JSON.parse(options.body).choice;
        return response(submittedChoice === "use-drive" ? { status: "running", operationId: "private-operation-id" } : { status: "complete" });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    });

    await controller.start();
    assert.equal(await controller.openPreview("activation"), true, scenario.decision);
    assert.deepEqual(controller.getSnapshot().preview.choices, scenario.choices, scenario.decision);
    if (scenario.rejected) {
      assert.equal(await controller.choose(scenario.rejected), false, `${scenario.decision} must reject ${scenario.rejected}`);
      assert.equal(submittedChoice, null, "an unadvertised action never reaches the server");
      assert.equal(controller.getSnapshot().preview.decision, scenario.decision, "rejected local clicks preserve the current safe preview");
    }
    assert.equal(await controller.choose(scenario.choose), true, scenario.decision);
    assert.equal(submittedChoice, scenario.choose, scenario.decision);
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private-choice-token|private-operation-id/);
    controller.stop();
  }
});

test("rejected activation evidence clears consent and asks for a fresh preview", async () => {
  let cancelled = false;
  const controller = testController(async (url, options = {}) => {
    if (url.endsWith("/api/google-drive/status")) return response(driveStatus());
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    if (url.endsWith("/api/google-drive/archive/activation/preview")) return response({
      actionToken: "stale-action-token", decision: "local_to_empty", choices: ["use-local", "cancel"],
      local: { valid: true, populated: true, files: 1, bytes: 12 }, remote: { valid: true, empty: true, files: 0, bytes: 0 },
    });
    if (url.endsWith("/api/google-drive/archive/activation/choice")) {
      const body = JSON.parse(options.body);
      if (body.choice === "cancel") { cancelled = true; return response({ status: "cancelled" }); }
      return response({ error: { code: "sync_conflict" } }, 409);
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  await controller.openPreview("activation");
  assert.equal(await controller.choose("use-local"), false);
  assert.equal(cancelled, true, "the now-stale preview is released on the server");
  assert.equal(controller.getSnapshot().preview, null);
  assert.match(controller.getSnapshot().actionError, /scaduta|cambiati|nuova anteprima/i);
  controller.stop();
});

test("manual restore reports maintenance and progress, refreshes the new generation, and preserves local-only mode", async () => {
  let archive = archiveStatus();
  let refreshes = 0;
  const controller = createGoogleDriveStorageController({
    request: async (url, options = {}) => {
      if (url.endsWith("/api/google-drive/status")) return response(driveStatus({ backupEnabled: false, syncState: "disabled", archiveGeneration: archive.archiveGeneration }));
      if (url.endsWith("/api/google-drive/archive/status")) return response(archive);
      if (url.endsWith("/api/google-drive/archive/restore/preview")) return response({
        actionToken: "private-manual-restore-token", operation: "restore", decision: "different", choices: ["use-drive", "cancel"],
        local: { valid: true, populated: true, files: 7, bytes: 700 },
        remote: { valid: true, populated: true, empty: false, files: 6, bytes: 600 },
      });
      if (url.endsWith("/api/google-drive/archive/restore/confirm")) return response({ status: "running", operationId: "private-restore-operation" }, 202);
      throw new Error(`Unexpected fixture request: ${url}`);
    },
    navigate() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {},
    getWindow: () => null,
    onArchiveChanged: () => { refreshes += 1; },
  });

  await controller.start();
  await controller.openPreview("restore");
  assert.equal(await controller.choose("use-drive"), true);
  await new Promise((resolve) => setImmediate(resolve));
  archive = archiveStatus({
    archiveGeneration: 7,
    maintenance: { active: true, error: null },
    restore: { operationId: "private-restore-operation", stage: "replacing", progress: 54, startedAt: "2026-10-08T08:00:00.000Z" },
  });
  await controller.poll();
  assert.equal(controller.getSnapshot().restoreOperation.stage, "replacing");
  assert.equal(controller.getSnapshot().restoreOperation.progress, 54);
  assert.equal(controller.getSnapshot().status.maintenance.active, true);
  assert.equal(controller.getSnapshot().status.backupEnabled, false);
  assert.equal(refreshes, 0, "archive reload waits until the maintenance fence is released");

  archive = archiveStatus({
    archiveGeneration: 8,
    restore: { operationId: "private-restore-operation", stage: "complete", progress: 100, startedAt: "2026-10-08T08:00:00.000Z" },
  });
  await controller.poll();
  assert.equal(controller.getSnapshot().restoreOperation.stage, "complete");
  assert.equal(controller.getSnapshot().status.maintenance.active, false);
  assert.equal(controller.getSnapshot().status.backupEnabled, false, "manual restore leaves local-only mode selected");
  assert.equal(refreshes, 1, "the restored generation triggers one App archive refresh");
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private-manual-restore-token|private-restore-operation/);
  controller.stop();
});

test("failed status reads preserve the last acknowledged mode and restore polling ignores an older operation", async () => {
  let failStatus = false;
  let operationAccepted = false;
  let archive = archiveStatus();
  const controller = testController(async (url, options = {}) => {
    if (url.endsWith("/api/google-drive/status")) {
      if (failStatus) return response({ error: { code: "google_unavailable" } }, 503);
      return response(driveStatus({ backupEnabled: operationAccepted, syncState: operationAccepted ? "syncing" : "idle" }));
    }
    if (url.endsWith("/api/google-drive/archive/status")) return response(archive);
    if (url.endsWith("/api/google-drive/archive/restore/preview")) return response({
      actionToken: "manual-restore-token", operation: "restore", decision: "different", choices: ["use-drive", "cancel"],
      local: { valid: true, populated: true, files: 4, bytes: 1_200 },
      remote: { valid: true, populated: true, empty: false, files: 3, bytes: 900 },
    });
    if (url.endsWith("/api/google-drive/archive/restore/confirm")) {
      const body = JSON.parse(options.body);
      if (body.choice === "use-drive") {
        operationAccepted = true;
        return response({ status: "running", operationId: "opaque-operation-current" }, 202);
      }
      return response({ status: "cancelled" });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  assert.equal(await controller.openPreview("restore"), true);
  await controller.choose("use-drive");
  assert.equal(controller.getSnapshot().restoreOperation.stage, "running");
  await new Promise((resolve) => setImmediate(resolve));

  archive = archiveStatus({ restore: { operationId: "older-operation", stage: "complete", progress: 100 }, archiveGeneration: 8 });
  await controller.poll();
  assert.equal(controller.getSnapshot().restoreOperation.stage, "running", "a terminal result for a different operation cannot finish this restore");
  assert.equal(controller.getSnapshot().status.archiveGeneration, 8);

  failStatus = true;
  await controller.poll();
  assert.equal(controller.getSnapshot().status.backupEnabled, true, "a failed GET does not make Drive look disconnected or disabled");
  assert.ok(controller.getSnapshot().statusError);
  controller.stop();
});

test("a new operation replaces a tracked terminal restore without accepting stale older results", async () => {
  let restore = null;
  let archiveGeneration = 7;
  const controller = testController(async (url) => {
    if (url.endsWith("/api/google-drive/status")) return response(driveStatus({ archiveGeneration }));
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus({
      archiveGeneration,
      maintenance: { active: restore?.stage === "replacing", error: null },
      restore,
    }));
    if (url.endsWith("/api/google-drive/archive/restore/preview")) return response({
      actionToken: "restore-preview-token", operation: "restore", decision: "different", choices: ["use-drive", "cancel"],
      local: { valid: true, populated: true, files: 1, bytes: 10 }, remote: { valid: true, populated: true, files: 1, bytes: 20 },
    });
    if (url.endsWith("/api/google-drive/archive/restore/confirm")) return response({ status: "running", operationId: "restore-operation-one" }, 202);
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  await controller.start();
  await controller.openPreview("restore");
  await controller.choose("use-drive");
  await new Promise((resolve) => setImmediate(resolve));
  restore = { operationId: "restore-operation-one", stage: "complete", progress: 100 };
  archiveGeneration = 8;
  await controller.poll();
  assert.equal(controller.getSnapshot().restoreOperation.stage, "complete");

  restore = { operationId: "restore-operation-two", stage: "replacing", progress: 30 };
  await controller.poll();
  assert.equal(controller.getSnapshot().restoreOperation.stage, "replacing", "a new server operation supersedes the previously terminal one");
  assert.equal(controller.getSnapshot().restoreOperation.progress, 30);

  restore = { operationId: "restore-operation-two", stage: "failed", progress: 42, error: "archive_invalid" };
  await controller.poll();
  assert.equal(controller.getSnapshot().restoreOperation.stage, "failed");
  assert.match(controller.getSnapshot().restoreOperation.error, /incompleto|verifica/i);
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /restore-operation-one|restore-operation-two/);
  controller.stop();
});

test("an action after an obsolete poll queues a fresh serialized read", async () => {
  const oldStatus = deferred();
  const firstStatusStarted = deferred();
  const freshStatusStarted = deferred();
  let statusReads = 0;
  const controller = testController(async (url) => {
    if (url.endsWith("/api/google-drive/status")) {
      statusReads += 1;
      if (statusReads === 1) { firstStatusStarted.resolve(); return oldStatus.promise; }
      freshStatusStarted.resolve();
      return response(driveStatus({ backupEnabled: false, syncState: "disabled" }));
    }
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    if (url.endsWith("/api/google-drive/archive/disable")) return response({ status: "disabled" });
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  const initialPoll = controller.start();
  await firstStatusStarted.promise;
  assert.equal(await controller.disable(), true);
  oldStatus.resolve(response(driveStatus({ backupEnabled: true, syncState: "syncing" })));
  await initialPoll;
  await freshStatusStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statusReads, 2, "the post-disable read waits for the obsolete poll to settle");
  assert.equal(controller.getSnapshot().status.backupEnabled, false, "the stale enabled response cannot survive a successful disable");
  controller.stop();
});

test("StrictMode stop and restart reads fresh status after the prior lifecycle drains", async () => {
  const oldStatus = deferred();
  const firstStatusStarted = deferred();
  let statusReads = 0;
  const controller = testController(async (url) => {
    if (url.endsWith("/api/google-drive/status")) {
      statusReads += 1;
      if (statusReads === 1) { firstStatusStarted.resolve(); return oldStatus.promise; }
      return response(driveStatus({ state: "connected", connected: true }));
    }
    if (url.endsWith("/api/google-drive/archive/status")) return response(archiveStatus());
    throw new Error(`Unexpected fixture request: ${url}`);
  });

  const firstStart = controller.start();
  await firstStatusStarted.promise;
  controller.stop();
  const restarted = controller.start();
  assert.equal(statusReads, 1, "the new lifecycle waits for the first requests to settle");
  oldStatus.resolve(response(driveStatus({ state: "disconnected", connected: false, account: null, folder: null })));
  await Promise.all([firstStart, restarted]);
  assert.equal(statusReads, 2);
  assert.equal(controller.getSnapshot().status.connected, true, "the restarted lifecycle publishes its own snapshot");
  controller.stop();
});
