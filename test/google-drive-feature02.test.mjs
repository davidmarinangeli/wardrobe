import assert from "node:assert/strict";
import { randomBytes as secureRandomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createServer as createTcpServer } from "node:net";
import { build, createServer, preview } from "vite";
import { createGoogleDriveService, GOOGLE_DRIVE_REQUIRED_SCOPES } from "../scripts/google-drive-auth.mjs";
import { createBoundedDriveClient } from "../scripts/google-drive-client.mjs";
import { googleDriveApi } from "../scripts/google-drive-api.mjs";
import { buildArchiveInventory, resolveArchiveFile } from "../scripts/archive-store.mjs";

const roots = new Set();
const FOLDER_ID = "folder_12345";
const OTHER_ID = "other_12345";
const CHILD_ID = "child_12345";

async function tempRoot(prefix = "wardrobe-drive-") {
  const dir = await mkdtemp(path.join("/private/tmp", prefix));
  roots.add(dir);
  return dir;
}

async function unusedPort() {
  const socketServer = createTcpServer();
  await new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socketServer.address();
  await new Promise((resolve) => socketServer.close(resolve));
  return port;
}

afterEach(async () => {
  await Promise.all([...roots].map((dir) => rm(dir, { recursive: true, force: true })));
  roots.clear();
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function rootMetadata(overrides = {}) {
  return {
    id: FOLDER_ID,
    name: "Wardrobe backup",
    mimeType: "application/vnd.google-apps.folder",
    trashed: false,
    capabilities: { canListChildren: true, canAddChildren: true, canEdit: true },
    parents: [],
    ...overrides,
  };
}

function fileMetadata(id = CHILD_ID, overrides = {}) {
  return {
    id,
    name: "coat.png",
    mimeType: "image/png",
    parents: [FOLDER_ID],
    trashed: false,
    size: "4",
    capabilities: { canDownload: true, canModifyContent: true, canEdit: true, canDelete: true, canListChildren: true, canAddChildren: true },
    ...overrides,
  };
}

function env(overrides = {}) {
  return {
    GOOGLE_DRIVE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_DRIVE_CLIENT_SECRET: "test-secret-not-real",
    GOOGLE_DRIVE_REDIRECT_URI: "http://localhost:5173/api/google-drive/oauth/callback",
    GOOGLE_DRIVE_FOLDER_ID: FOLDER_ID,
    WARDROBE_DATA_DIR: "data",
    ...overrides,
  };
}

function createGoogleMock(options = {}) {
  const calls = [];
  let refreshes = 0;
  let drive401s = options.drive401s || 0;
  let driveFailure = null;
  let userinfo401s = options.userinfo401s || 0;
  let listingPage = 0;
  let refreshWaitResolve;
  let releaseRefresh;
  let nextListingGate = null;
  const refreshStarted = new Promise((resolve) => { refreshWaitResolve = resolve; });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    calls.push({ url: url.toString(), method: init.method || "GET", headers, body: init.body });
    if (url.href === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(init.body);
      if (body.get("grant_type") === "refresh_token") {
        refreshes += 1;
        if (options.deferRefresh) {
          refreshWaitResolve();
          await new Promise((resolve) => { releaseRefresh = resolve; });
        }
        if (options.refreshFailure) return jsonResponse({ error: options.refreshFailure }, options.refreshStatus || 400);
        if (options.refreshResponse) return jsonResponse(options.refreshResponse);
        return jsonResponse({ access_token: `access-token-refreshed-${refreshes}`, refresh_token: "refresh-token-12345", expires_in: 3600, scope: GOOGLE_DRIVE_REQUIRED_SCOPES.join(" ") });
      }
      if (options.exchangeResponse) return jsonResponse(options.exchangeResponse);
      return jsonResponse({ access_token: "access-token-12345", refresh_token: "refresh-token-12345", expires_in: 3600, scope: GOOGLE_DRIVE_REQUIRED_SCOPES.join(" ") });
    }
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      if (userinfo401s > 0) { userinfo401s -= 1; return jsonResponse({ error: "temporary" }, 401); }
      if (options.userinfoResponse) return jsonResponse(options.userinfoResponse.body, options.userinfoResponse.status || 200);
      return jsonResponse({ sub: "google-account-123", email: "person@example.test", name: "Person Example" });
    }
    if (url.origin === "https://www.googleapis.com" && url.pathname === `/drive/v3/files/${FOLDER_ID}`) {
      if (headers.get("authorization")?.startsWith("Bearer access-token") !== true) return jsonResponse({ error: "unauthorized" }, 401);
      if (options.folderResponse) return jsonResponse(options.folderResponse, options.folderStatus || 200);
      return jsonResponse(rootMetadata());
    }
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/drive/v3/files") {
      if (nextListingGate) {
        const gate = nextListingGate;
        nextListingGate = null;
        gate.markStarted();
        const outcome = await gate.pending;
        if (outcome?.status) return jsonResponse({ error: { message: "late private provider failure" } }, outcome.status);
      }
      if (driveFailure) return jsonResponse({ error: { message: "private-provider-detail", errors: [{ reason: driveFailure }] } }, 403);
      if (drive401s > 0) { drive401s -= 1; return jsonResponse({ error: "temporary" }, 401); }
      if (options.incompleteListing) return jsonResponse({ incompleteSearch: true, files: [] });
      if (options.malformedListing) return jsonResponse({ incompleteSearch: false, files: "malformed" });
      if (options.paginated && !url.searchParams.has("pageToken")) {
        listingPage += 1;
        return jsonResponse({ incompleteSearch: false, files: [], nextPageToken: "page-2" });
      }
      if (options.paginated) {
        listingPage += 1;
        return jsonResponse({ incompleteSearch: false, files: [fileMetadata("child_a12345", { name: "same.png" }), fileMetadata("child_b12345", { name: "same.png" })] });
      }
      return jsonResponse({ incompleteSearch: false, files: [] });
    }
    if (url.origin === "https://www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
      const id = url.pathname.split("/").at(-1);
      if (id === OTHER_ID) return jsonResponse(rootMetadata({ id: OTHER_ID, name: "Other", parents: ["outside_12345"] }));
      return jsonResponse(fileMetadata(id));
    }
    return jsonResponse({ error: "unexpected request" }, 404);
  };
  return {
    fetchImpl,
    calls,
    setExchangeResponse(response) { options.exchangeResponse = response; },
    setRefreshResponse(response) { options.refreshResponse = response; },
    setDrive401s(count) { drive401s = count; },
    setDriveFailure(reason) { driveFailure = reason; },
    setIncompleteListing(value) { options.incompleteListing = value; },
    setMalformedListing(value) { options.malformedListing = value; },
    setUserinfo401s(count) { userinfo401s = count; },
    setUserinfoResponse(response) { options.userinfoResponse = response; },
    setFolderResponse(response, status = 200) { options.folderResponse = response; options.folderStatus = status; },
    setRefreshFailure(error, status) { options.refreshFailure = error; options.refreshStatus = status; },
    clearRefreshFailure() { options.refreshFailure = null; options.refreshStatus = null; },
    deferNextListing() {
      let markStarted;
      let release;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      nextListingGate = { markStarted, pending };
      return { started, release: (outcome) => release(outcome) };
    },
    waitForRefresh() { return refreshStarted; },
    releaseRefresh() { releaseRefresh?.(); },
    get refreshes() { return refreshes; },
    get listingPage() { return listingPage; },
  };
}

async function authorize(service) {
  const { authorizationUrl, nonce } = await service.startOAuth();
  const authorization = new URL(authorizationUrl);
  const result = await service.handleOAuthCallback({ state: authorization.searchParams.get("state"), nonce, code: "one-time-code" });
  return { result, nonce, state: authorization.searchParams.get("state"), authorization };
}

async function expireNowAt(file, now) {
  const state = JSON.parse(await readFile(file, "utf8"));
  state.expiresAt = now + 1;
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
}

describe("Google Drive OAuth and private state", () => {
  it("keeps incomplete startup local and does not create private state", async () => {
    const root = await tempRoot();
    const service = createGoogleDriveService({ root, env: { GOOGLE_DRIVE_CLIENT_ID: "partial" }, fetchImpl: async () => { throw new Error("network must stay idle"); } });
    assert.deepEqual(await service.getStatus(), {
      configured: false,
      state: "configuration_incomplete",
      connected: false,
      backupEnabled: false,
      reconnectRequired: false,
      account: null,
      folder: null,
      targetFingerprint: null,
      connectionGeneration: null,
      connectedAt: null,
      verifiedAt: null,
      error: { code: "configuration_incomplete", message: "Completa la configurazione Google Drive per collegare un account.", retryable: false },
      lastAuthError: null,
    });
    await assert.rejects(stat(path.join(root, "data", ".google-drive")), { code: "ENOENT" });
  });

  it("uses offline OAuth, state, cookie binding, PKCE, and atomic restrictive persistence", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
    const started = await service.startOAuth();
    const authUrl = new URL(started.authorizationUrl);
    assert.equal(authUrl.origin, "https://accounts.google.com");
    assert.equal(authUrl.searchParams.get("access_type"), "offline");
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authUrl.searchParams.get("prompt"), "consent select_account");
    const tokenCount = () => mock.calls.filter((call) => call.url === "https://oauth2.googleapis.com/token").length;
    await assert.rejects(service.handleOAuthCallback({ state: authUrl.searchParams.get("state"), nonce: "wrong-cookie", code: "code" }), { code: "oauth_state_invalid" });
    assert.equal(tokenCount(), 0);
    await assert.rejects(service.handleOAuthCallback({ state: authUrl.searchParams.get("state"), nonce: started.nonce, code: "code" }), { code: "oauth_state_invalid" }, "state is consumed after mismatch");

    const linked = await authorize(service);
    const privateDir = path.join(root, "data", ".google-drive");
    const statePath = path.join(privateDir, "connection.json");
    assert.equal((await stat(privateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.refreshToken, "refresh-token-12345");
    assert.equal(persisted.folder.id, FOLDER_ID);
    assert.equal(linked.result.target.folderId, FOLDER_ID);
    assert.equal(linked.result.target.connectionGeneration, persisted.connectionGeneration);
    const status = await service.getStatus();
    assert.equal(status.state, "connected");
    assert.equal(status.backupEnabled, false);
    assert.equal(JSON.stringify(status).includes("refresh-token-12345"), false);
    assert.equal(JSON.stringify(status).includes("access-token-12345"), false);

    const oldBytes = await readFile(statePath);
    mock.setExchangeResponse({ access_token: "candidate-access-token", expires_in: 3600, scope: GOOGLE_DRIVE_REQUIRED_SCOPES.join(" ") });
    const failedAttempt = await service.startOAuth();
    const failedUrl = new URL(failedAttempt.authorizationUrl);
    await assert.rejects(service.handleOAuthCallback({ state: failedUrl.searchParams.get("state"), nonce: failedAttempt.nonce, code: "code" }), { code: "oauth_refresh_missing" });
    assert.deepEqual(await readFile(statePath), oldBytes, "failed candidate leaves the current connection byte-for-byte intact");
    assert.equal((await service.getStatus()).state, "connected");
    assert.equal((await service.getStatus()).lastAuthError.code, "oauth_refresh_missing");
  });

  it("normalizes canonical OIDC userinfo scopes on exchange, refresh, and saved state", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const canonicalScopes = "openid https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
    mock.setExchangeResponse({ access_token: "access-token-12345", refresh_token: "refresh-token-12345", expires_in: 3600, scope: canonicalScopes });
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl, now: () => 1_800_000_000_000 });
    await authorize(service);
    const connectionFile = path.join(root, "data", ".google-drive", "connection.json");
    let saved = JSON.parse(await readFile(connectionFile, "utf8"));
    assert.deepEqual(saved.scopes, ["openid", "https://www.googleapis.com/auth/drive", "email", "profile"]);

    await expireNowAt(connectionFile, 1_800_000_000_000);
    mock.setRefreshResponse({ access_token: "access-token-refreshed-12345", refresh_token: "refresh-token-12345", expires_in: 3600, scope: canonicalScopes });
    await service.verifyConnection();
    saved = JSON.parse(await readFile(connectionFile, "utf8"));
    assert.deepEqual(saved.scopes, ["openid", "https://www.googleapis.com/auth/drive", "email", "profile"]);
  });

  it("reports corrupted private state safely and preserves the file", async () => {
    const root = await tempRoot();
    const file = path.join(root, "data", ".google-drive", "connection.json");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "not-json-token-marker", { mode: 0o600 });
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: async () => { throw new Error("offline"); } });
    const status = await service.getStatus();
    assert.equal(status.state, "private_state_invalid");
    assert.equal(status.connected, false);
    assert.equal(JSON.stringify(status).includes("token-marker"), false);
    assert.equal(await readFile(file, "utf8"), "not-json-token-marker");
  });

  it("rejects a private-data symlink that resolves into a public or build tree", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "public", "secrets"), { recursive: true });
    await symlink(path.join(root, "public", "secrets"), path.join(root, "linked-data"));
    const service = createGoogleDriveService({ root, env: env({ WARDROBE_DATA_DIR: "linked-data" }), fetchImpl: async () => { throw new Error("network must stay idle"); } });
    assert.equal((await service.getStatus()).state, "configuration_invalid");
    await assert.rejects(service.startOAuth(), { code: "configuration_invalid" });
  });

  it("resolves multiple missing private path segments through an ancestor symlink", async () => {
    const root = await tempRoot();
    const publicDir = path.join(root, "public");
    await mkdir(publicDir, { recursive: true });
    await symlink(publicDir, path.join(root, "public-alias"));
    const service = createGoogleDriveService({
      root,
      env: { WARDROBE_DATA_DIR: "public-alias/deep/nested/data" },
      publicDir,
      buildOutDir: path.join(root, "dist"),
      fetchImpl: async () => { throw new Error("Google is not used by status"); },
    });
    const status = await service.getStatus();
    assert.equal(status.state, "configuration_invalid");
  });

  it("rejects missing-cookie, expired-state, and partial-consent callbacks before identity lookup", async () => {
    const root = await tempRoot();
    let clock = 2_000_000_000_000;
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl, now: () => clock });
    const missing = await service.startOAuth();
    const missingState = new URL(missing.authorizationUrl).searchParams.get("state");
    await assert.rejects(service.handleOAuthCallback({ state: missingState, code: "code" }), { code: "oauth_state_invalid" });
    assert.equal(mock.calls.filter((call) => call.url === "https://oauth2.googleapis.com/token").length, 0);

    const expired = await service.startOAuth();
    const expiredState = new URL(expired.authorizationUrl).searchParams.get("state");
    clock += 10 * 60 * 1000 + 1;
    await assert.rejects(service.handleOAuthCallback({ state: expiredState, nonce: expired.nonce, code: "code" }), { code: "oauth_state_invalid" });
    assert.equal(mock.calls.filter((call) => call.url === "https://oauth2.googleapis.com/token").length, 0);

    mock.setExchangeResponse({ access_token: "candidate-access-token", refresh_token: "candidate-refresh-token", expires_in: 3600, scope: "openid email profile" });
    const partial = await service.startOAuth();
    const partialState = new URL(partial.authorizationUrl).searchParams.get("state");
    await assert.rejects(service.handleOAuthCallback({ state: partialState, nonce: partial.nonce, code: "code" }), { code: "oauth_scope_insufficient" });
    assert.equal(mock.calls.some((call) => call.url === "https://www.googleapis.com/oauth2/v3/userinfo"), false);
  });

  it("rejects old target handles after a folder change and after disconnect", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
    const { result } = await authorize(service);
    const before = await service.getClient(result.target);
    const changed = createGoogleDriveService({ root, env: env({ GOOGLE_DRIVE_FOLDER_ID: "folder_67890" }), fetchImpl: mock.fetchImpl });
    assert.equal((await changed.getStatus()).state, "target_changed");
    await assert.rejects(changed.getTarget(), { code: "target_changed" });
    await service.disconnect();
    await assert.rejects(before.listChildren(), { code: "stale_connection" });
  });

  it("shares proactive refresh and retries one temporary 401", async () => {
    const root = await tempRoot();
    let clock = 2_000_000_000_000;
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl, now: () => clock });
    const { result } = await authorize(service);
    mock.setDrive401s(1);
    // Persist an expiry inside the proactive refresh window using a token result
    // returned by the refresh endpoint; the first concurrent calls share it.
    const stateFile = path.join(root, "data", ".google-drive", "connection.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.expiresAt = clock + 20_000;
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    const client = await service.getClient(result.target);
    await Promise.all([client.listChildren(), client.listChildren()]);
    assert.equal(mock.refreshes, 2, "one proactive refresh and one forced refresh after the single 401");
    assert.equal((await service.getStatus()).state, "connected");
    clock += 1000;
  });

  it("marks invalid_grant for reconnect and recovers from retryable refresh outages", async () => {
    const root = await tempRoot();
    let clock = 2_000_000_000_000;
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl, now: () => clock });
    const { result } = await authorize(service);
    const stateFile = path.join(root, "data", ".google-drive", "connection.json");
    const client = await service.getClient(result.target);

    await expireNowAt(stateFile, clock);
    mock.setRefreshFailure("invalid_grant", 400);
    await assert.rejects(client.listChildren(), { code: "reconnect_required" });
    assert.equal((await service.getStatus()).state, "reconnect_required");
    let saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(saved.refreshToken, "refresh-token-12345");
    assert.equal(saved.reconnectRequired, true);

    const outageRoot = await tempRoot();
    const outageMock = createGoogleMock();
    const outageService = createGoogleDriveService({ root: outageRoot, env: env(), fetchImpl: outageMock.fetchImpl, now: () => clock });
    const outageTarget = (await authorize(outageService)).result.target;
    const outageFile = path.join(outageService.privateDir, "connection.json");
    await expireNowAt(outageFile, clock);
    outageMock.setRefreshFailure("rate_limited", 429);
    const outageClient = await outageService.getClient(outageTarget);
    await assert.rejects(outageClient.listChildren(), { code: "google_unavailable", retryable: true });
    assert.equal((await outageService.getStatus()).state, "unavailable");
    saved = JSON.parse(await readFile(outageFile, "utf8"));
    assert.equal(saved.refreshToken, "refresh-token-12345");
    outageMock.clearRefreshFailure();
    await outageClient.listChildren();
    assert.equal((await outageService.getStatus()).state, "connected");

    await expireNowAt(outageFile, clock);
    outageMock.setRefreshFailure("backend_error", 503);
    await assert.rejects(outageClient.listChildren(), { code: "google_unavailable", retryable: true });
    assert.equal((await outageService.getStatus()).state, "unavailable");
    saved = JSON.parse(await readFile(outageFile, "utf8"));
    assert.equal(saved.refreshToken, "refresh-token-12345");
  });

  it("does not resurrect an in-flight refresh after disconnect and relink", async () => {
    const root = await tempRoot();
    let clock = 2_000_000_000_000;
    const mock = createGoogleMock({ deferRefresh: true });
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl, now: () => clock });
    const first = (await authorize(service)).result;
    const file = path.join(service.privateDir, "connection.json");
    await expireNowAt(file, clock);
    const oldClient = await service.getClient(first.target);
    const pending = oldClient.listChildren();
    await mock.waitForRefresh();
    await service.disconnect();
    const second = (await authorize(service)).result;
    mock.releaseRefresh();
    await assert.rejects(pending, { code: "stale_connection" });
    assert.notEqual(second.target.connectionGeneration, first.target.connectionGeneration);
    assert.equal((await service.getStatus()).state, "connected");
    assert.equal(JSON.parse(await readFile(file, "utf8")).connectionGeneration, second.target.connectionGeneration);
    await assert.rejects(oldClient.listChildren(), { code: "stale_connection" });
  });

  it("does not let an old transient refresh failure contaminate a relinked account", async () => {
    const root = await tempRoot();
    const clock = 2_000_000_000_000;
    const mock = createGoogleMock({ deferRefresh: true });
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl, now: () => clock });
    const first = (await authorize(service)).result;
    const file = path.join(service.privateDir, "connection.json");
    await expireNowAt(file, clock);
    const oldClient = await service.getClient(first.target);
    const pending = oldClient.listChildren();
    await mock.waitForRefresh();

    await service.disconnect();
    mock.setUserinfoResponse({ body: { sub: "google-account-678", email: "second@example.test", name: "Second Account" } });
    const second = (await authorize(service)).result;
    mock.setRefreshFailure("temporarily_unavailable", 503);
    mock.releaseRefresh();

    await assert.rejects(pending, { code: "stale_connection" });
    const status = await service.getStatus();
    assert.equal(status.state, "connected");
    assert.equal(status.connected, true);
    assert.equal(status.account.id, "google-account-678");
    assert.equal(status.error, null);
    assert.equal(status.lastAuthError, null);
    assert.equal(JSON.parse(await readFile(file, "utf8")).connectionGeneration, second.target.connectionGeneration);
  });

  it("discards a Drive listing response that completes after disconnect and relink", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
    const first = (await authorize(service)).result;
    const oldClient = await service.getClient(first.target);
    const gate = mock.deferNextListing();
    const pending = oldClient.listChildren();
    await gate.started;

    await service.disconnect();
    mock.setUserinfoResponse({ body: { sub: "google-account-678", email: "second@example.test", name: "Second Account" } });
    const second = (await authorize(service)).result;
    gate.release();

    await assert.rejects(pending, { code: "stale_connection" });
    const status = await service.getStatus();
    assert.equal(status.state, "connected");
    assert.equal(status.connected, true);
    assert.equal(status.account.id, "google-account-678");
    assert.equal(status.error, null);
    assert.equal(status.connectionGeneration, second.target.connectionGeneration);
  });

  it("discards an old Drive listing error after disconnect and relink", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
    const first = (await authorize(service)).result;
    const oldClient = await service.getClient(first.target);
    const gate = mock.deferNextListing();
    const pending = oldClient.listChildren();
    await gate.started;

    await service.disconnect();
    mock.setUserinfoResponse({ body: { sub: "google-account-679", email: "third@example.test", name: "Third Account" } });
    const second = (await authorize(service)).result;
    gate.release({ status: 503 });

    await assert.rejects(pending, { code: "stale_connection" });
    const status = await service.getStatus();
    assert.equal(status.state, "connected");
    assert.equal(status.account.id, "google-account-679");
    assert.equal(status.error, null);
    assert.equal(status.connectionGeneration, second.target.connectionGeneration);
  });

  it("retries a userinfo 401 during explicit connection verification", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
    await authorize(service);
    mock.setUserinfo401s(1);
    const result = await service.verifyConnection();
    assert.equal(result.state, "connected");
    assert.equal(mock.refreshes, 1);
  });

  it("treats Drive quota and rate-limit 403s as retryable outages, not access denial", async () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]) {
      const root = await tempRoot(`wardrobe-drive-${reason}-`);
      const mock = createGoogleMock();
      const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
      await authorize(service);
      mock.setDriveFailure(reason);

      await assert.rejects(service.verifyConnection(), (error) => error.code === "google_unavailable" && error.retryable === true);
      const status = await service.getStatus();
      assert.equal(status.state, "unavailable");
      assert.equal(status.connected, false, "a failed saved-connection verification is not healthy-connected");
      assert.equal(status.error.retryable, true);
      assert.equal(JSON.stringify(status).includes("private-provider-detail"), false);
    }
  });

  it("reports revoked root capabilities and incomplete verification listings as unhealthy", async () => {
    const permissionRoot = await tempRoot();
    const permissionMock = createGoogleMock();
    const permissionService = createGoogleDriveService({ root: permissionRoot, env: env(), fetchImpl: permissionMock.fetchImpl });
    await authorize(permissionService);
    const savedFile = path.join(permissionService.privateDir, "connection.json");
    const savedGeneration = JSON.parse(await readFile(savedFile, "utf8")).connectionGeneration;
    permissionMock.setFolderResponse(rootMetadata({ capabilities: { canListChildren: true, canAddChildren: false } }));
    await assert.rejects(permissionService.verifyConnection(), { code: "folder_write_denied" });
    const denied = await permissionService.getStatus();
    assert.equal(denied.state, "folder_access_denied");
    assert.equal(denied.connected, false);
    assert.equal(denied.error.code, "folder_access_denied");
    assert.equal(denied.connectionGeneration, savedGeneration, "the saved connection is retained for recovery");

    const listingRoot = await tempRoot();
    const listingMock = createGoogleMock();
    const listingService = createGoogleDriveService({ root: listingRoot, env: env(), fetchImpl: listingMock.fetchImpl });
    await authorize(listingService);
    listingMock.setIncompleteListing(true);
    await assert.rejects(listingService.verifyConnection(), { code: "incomplete_drive_listing" });
    const incomplete = await listingService.getStatus();
    assert.equal(incomplete.state, "unavailable");
    assert.equal(incomplete.connected, false);
    assert.equal(incomplete.error.code, "incomplete_drive_listing");

    const malformedRoot = await tempRoot();
    const malformedMock = createGoogleMock();
    const malformedService = createGoogleDriveService({ root: malformedRoot, env: env(), fetchImpl: malformedMock.fetchImpl });
    await authorize(malformedService);
    malformedMock.setMalformedListing(true);
    await assert.rejects(malformedService.verifyConnection(), { code: "malformed_drive_listing" });
    const malformed = await malformedService.getStatus();
    assert.equal(malformed.state, "unavailable");
    assert.equal(malformed.connected, false);
    assert.equal(malformed.error.code, "malformed_drive_listing");
  });

  it("keeps a saved target unhealthy when its folder moves to a different shared drive", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
    await authorize(service);
    const savedFile = path.join(service.privateDir, "connection.json");
    const original = JSON.parse(await readFile(savedFile, "utf8"));
    mock.setFolderResponse(rootMetadata({ driveId: "drive_changed_12345" }));

    await assert.rejects(service.verifyConnection(), { code: "target_changed" });
    const status = await service.getStatus();
    assert.equal(status.state, "target_changed");
    assert.equal(status.connected, false);
    assert.equal(status.connectionGeneration, original.connectionGeneration);
    assert.equal(JSON.parse(await readFile(savedFile, "utf8")).folder.driveId, original.folder.driveId);
    assert.equal(mock.calls.filter((call) => call.url.includes("/drive/v3/files?")).length, 1, "only the initial OAuth root listing ran; mismatched root blocks fresh content listing");
  });

  it("keeps the saved connection after account or folder verification fails", async () => {
    const root = await tempRoot();
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
    await authorize(service);
    const stateFile = path.join(root, "data", ".google-drive", "connection.json");
    const original = await readFile(stateFile);

    mock.setUserinfoResponse({ body: { email: "person@example.test", name: "No subject" } });
    const invalidIdentity = await service.startOAuth();
    await assert.rejects(service.handleOAuthCallback({ state: new URL(invalidIdentity.authorizationUrl).searchParams.get("state"), nonce: invalidIdentity.nonce, code: "code" }), { code: "google_unavailable" });
    assert.deepEqual(await readFile(stateFile), original);

    mock.setUserinfoResponse(null);
    mock.setFolderResponse({ error: { message: "private upstream details" } }, 403);
    const inaccessible = await service.startOAuth();
    await assert.rejects(service.handleOAuthCallback({ state: new URL(inaccessible.authorizationUrl).searchParams.get("state"), nonce: inaccessible.nonce, code: "code" }), { code: "folder_access_denied" });
    assert.deepEqual(await readFile(stateFile), original);
    const savedStatus = await service.getStatus();
    assert.equal(savedStatus.state, "connected");
    assert.equal(savedStatus.error, null);
    assert.equal(savedStatus.lastAuthError.code, "folder_access_denied");
    assert.equal(JSON.stringify(savedStatus).includes("private upstream details"), false);
  });

  it("preserves the old connection if atomic persistence fails", async () => {
    const root = await tempRoot();
    let failTemporaryName = false;
    const random = (size) => {
      if (failTemporaryName && size === 8) throw new Error("simulated local disk failure");
      return secureRandomBytes(size);
    };
    const mock = createGoogleMock();
    const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl, randomBytes: random });
    await authorize(service);
    const stateFile = path.join(root, "data", ".google-drive", "connection.json");
    const original = await readFile(stateFile);
    const attempt = await service.startOAuth();
    failTemporaryName = true;
    await assert.rejects(service.handleOAuthCallback({ state: new URL(attempt.authorizationUrl).searchParams.get("state"), nonce: attempt.nonce, code: "code" }), { code: "persistence_failed" });
    assert.deepEqual(await readFile(stateFile), original);
    assert.equal((await service.getStatus()).state, "connected");
  });

  it("keeps private control files outside the archive inventory and asset resolver", async () => {
    const root = await tempRoot();
    const dataDir = path.join(root, "data");
    const secret = path.join(dataDir, ".google-drive", "connection.json");
    await mkdir(path.dirname(secret), { recursive: true });
    await writeFile(secret, "inventory-private-marker");
    const inventory = await buildArchiveInventory(dataDir);
    assert.equal(inventory.files.some((entry) => entry.path.includes("google-drive") || entry.path.includes("connection")), false);
    await assert.rejects(resolveArchiveFile(dataDir, ".google-drive/connection.json"), { status: 404 });
  });
});

describe("bounded Google Drive folder client", () => {
  it("reads every listing page, including an empty page, without collapsing duplicate names", async () => {
    const mock = createGoogleMock({ paginated: true });
    const requests = [];
    const request = async (input) => {
      requests.push(input);
      const url = new URL(input.url);
      if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
      if (url.pathname.endsWith("/files")) {
        if (!input.query.pageToken) return { data: { incompleteSearch: false, files: [], nextPageToken: "next" } };
        return { data: { incompleteSearch: false, files: [fileMetadata("child_a12345", { name: "same.png" }), fileMetadata("child_b12345", { name: "same.png" })] } };
      }
      throw new Error("unexpected request");
    };
    const client = createBoundedDriveClient({ folderId: FOLDER_ID, request });
    const files = await client.listChildren();
    assert.equal(files.length, 2);
    assert.equal(files[0].name, files[1].name);
    const listingRequests = requests.filter((entry) => new URL(entry.url).pathname.endsWith("/files"));
    assert.equal(listingRequests.length, 2);
    assert.equal(listingRequests[1].query.pageToken, "next");
    assert.equal(listingRequests[0].query.q, `'${FOLDER_ID}' in parents and trashed = false`);
    assert.equal(listingRequests[0].query.supportsAllDrives, "true");
    assert.equal(mock.listingPage, 0);
  });

  it("rejects incomplete listings and refuses an outside ancestry before reading content", async () => {
    const incomplete = createBoundedDriveClient({
      folderId: FOLDER_ID,
      request: async ({ url }) => new URL(url).pathname.endsWith(`/files/${FOLDER_ID}`)
        ? { data: rootMetadata() }
        : { data: { incompleteSearch: true, files: [] } },
    });
    await assert.rejects(incomplete.listChildren(), { code: "incomplete_drive_listing" });

    const calls = [];
    const outside = createBoundedDriveClient({
      folderId: FOLDER_ID,
      request: async (input) => {
        calls.push(input);
        const url = new URL(input.url);
        if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
        if (url.pathname.endsWith(`/files/${OTHER_ID}`)) return { data: fileMetadata(OTHER_ID, { parents: ["outside_12345"], mimeType: "application/vnd.google-apps.folder" }) };
        if (url.pathname.endsWith("/files/child_12345")) return { data: fileMetadata(CHILD_ID, { parents: [OTHER_ID] }) };
        if (url.searchParams.get("alt") === "media") return { bytes: Buffer.from("secret") };
        return { data: rootMetadata({ id: "outside_12345", parents: [] }) };
      },
    });
    await assert.rejects(outside.readFile(CHILD_ID), { code: "drive_parent_ambiguous" });
    assert.equal(calls.some((input) => input.responseType === "bytes"), false);
  });

  it("places multipart uploads only in the verified parent", async () => {
    const requests = [];
    const client = createBoundedDriveClient({
      folderId: FOLDER_ID,
      request: async (input) => {
        requests.push(input);
        const url = new URL(input.url);
        if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
        if (url.pathname.endsWith("/files") && input.method === "POST") {
          return { data: fileMetadata("created_12345", { name: "new.png", parents: [FOLDER_ID] }) };
        }
        if (url.pathname.endsWith("/files/created_12345")) return { data: fileMetadata("created_12345", { name: "new.png", parents: [FOLDER_ID] }) };
        throw new Error("unexpected request");
      },
    });
    const created = await client.createFile({ name: "new.png", mimeType: "image/png", bytes: Buffer.from("png") });
    assert.equal(created.parents[0], FOLDER_ID);
    const upload = requests.find((entry) => entry.method === "POST");
    assert.match(upload.url, /upload\/drive\/v3\/files$/);
    assert.match(upload.headers["Content-Type"], /^multipart\/related; boundary=/);
    assert.equal(requests[0].query.supportsAllDrives, "true");
    assert.match(requests[0].query.fields, /sha256Checksum/);
  });

  it("requires a readable and writable real root, and rejects shortcuts", async () => {
    for (const [metadata, code] of [
      [rootMetadata({ capabilities: { canListChildren: false, canAddChildren: true } }), "folder_read_denied"],
      [rootMetadata({ capabilities: { canListChildren: true, canAddChildren: false } }), "folder_write_denied"],
      [rootMetadata({ mimeType: "application/vnd.google-apps.shortcut" }), "shortcut_not_supported"],
    ]) {
      const client = createBoundedDriveClient({ folderId: FOLDER_ID, request: async ({ url }) => ({ data: new URL(url).pathname.endsWith(`/files/${FOLDER_ID}`) ? metadata : { incompleteSearch: false, files: [] } }) });
      await assert.rejects(client.verifyRoot(), { code });
    }
  });

  it("rejects a fresh root whose shared-drive identity differs from the saved target", async () => {
    const mutations = [];
    const client = createBoundedDriveClient({
      folderId: FOLDER_ID,
      expectedDriveId: "drive_old_12345",
      request: async (input) => {
        const url = new URL(input.url);
        if (url.pathname.endsWith(`/files/${CHILD_ID}`)) return { data: fileMetadata(CHILD_ID, { driveId: "drive_old_12345" }) };
        if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata({ driveId: "drive_new_12345" }) };
        if (input.method === "PATCH") mutations.push(input);
        throw new Error("unexpected request");
      },
    });
    await assert.rejects(client.updateFile({ fileId: CHILD_ID, bytes: Buffer.from("new") }), { code: "target_changed" });
    assert.deepEqual(mutations, []);
  });

  it("validates ancestry before every outside create, update, or delete", async () => {
    const mutations = [];
    const request = async (input) => {
      const url = new URL(input.url);
      if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
      if (url.pathname.endsWith(`/files/${CHILD_ID}`)) return { data: fileMetadata(CHILD_ID, { parents: [OTHER_ID] }) };
      if (url.pathname.endsWith(`/files/${OTHER_ID}`)) return { data: rootMetadata({ id: OTHER_ID, name: "Outside", parents: ["outside_12345"] }) };
      if (url.pathname.endsWith("/files/outside_12345")) return { data: rootMetadata({ id: "outside_12345", name: "Outside parent", parents: [] }) };
      mutations.push(input.method);
      return { data: fileMetadata("created_12345") };
    };
    const client = createBoundedDriveClient({ folderId: FOLDER_ID, request });
    await assert.rejects(client.createFile({ name: "evil.png", mimeType: "image/png", bytes: Buffer.from("x"), parentId: OTHER_ID }), { code: "drive_parent_ambiguous" });
    await assert.rejects(client.updateFile({ fileId: CHILD_ID, bytes: Buffer.from("x") }), { code: "drive_parent_ambiguous" });
    await assert.rejects(client.deleteFile(CHILD_ID), { code: "drive_parent_ambiguous" });
    assert.deepEqual(mutations, []);
  });

  it("rejects malformed, repeated, shortcut, and failed later listing pages", async () => {
    const listingResult = async (page) => {
      const client = createBoundedDriveClient({
        folderId: FOLDER_ID,
        request: async (input) => {
          const url = new URL(input.url);
          if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
          return page(input);
        },
      });
      return client.listChildren();
    };
    await assert.rejects(listingResult(async () => ({ data: { incompleteSearch: false, files: "not-an-array" } })), { code: "malformed_drive_listing" });
    await assert.rejects(listingResult(async () => ({ data: { incompleteSearch: false, files: [fileMetadata(CHILD_ID, { mimeType: "application/vnd.google-apps.shortcut" })] } })), { code: "shortcut_not_supported" });
    await assert.rejects(listingResult(async (input) => input.query.pageToken
      ? { data: { incompleteSearch: false, files: [], nextPageToken: "repeat" } }
      : { data: { incompleteSearch: false, files: [], nextPageToken: "repeat" } }), { code: "repeated_page_token" });
    let pageCount = 0;
    await assert.rejects(listingResult(async (input) => {
      pageCount += 1;
      if (input.query.pageToken) throw Object.assign(new Error("second-page failure"), { code: "network_failure" });
      return { data: { incompleteSearch: false, files: [fileMetadata()], nextPageToken: "continue" } };
    }), { code: "network_failure" });
    assert.equal(pageCount, 2, "the second page is fetched and its failure rejects the whole listing");
  });

  it("enforces per-file permissions and detects a moved file during update", async () => {
    let mediaReads = 0;
    let mutationCalls = 0;
    let moveOnUpdate = false;
    const request = async (input) => {
      const url = new URL(input.url);
      if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
      if (url.pathname.endsWith(`/files/${CHILD_ID}`)) {
        if (input.method === "PATCH") {
          mutationCalls += 1;
          return { data: fileMetadata(CHILD_ID, { parents: moveOnUpdate ? [OTHER_ID] : [FOLDER_ID] }) };
        }
        return { data: fileMetadata(CHILD_ID, { capabilities: { canDownload: false, canModifyContent: false, canEdit: false, canDelete: false } }) };
      }
      if (url.searchParams.get("alt") === "media") { mediaReads += 1; return { bytes: Buffer.from("data") }; }
      if (input.method === "DELETE") { mutationCalls += 1; return { status: 204, data: null }; }
      throw new Error("unexpected request");
    };
    const client = createBoundedDriveClient({ folderId: FOLDER_ID, request });
    await assert.rejects(client.readFile(CHILD_ID), { code: "file_read_denied" });
    await assert.rejects(client.updateFile({ fileId: CHILD_ID, bytes: Buffer.from("x") }), { code: "file_write_denied" });
    await assert.rejects(client.deleteFile(CHILD_ID), { code: "file_delete_denied" });
    assert.equal(mediaReads, 0);
    assert.equal(mutationCalls, 0);

    moveOnUpdate = true;
    const movable = createBoundedDriveClient({ folderId: FOLDER_ID, request: async (input) => {
      const url = new URL(input.url);
      if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
      if (url.pathname.endsWith(`/files/${CHILD_ID}`) && input.method === "PATCH") return { data: fileMetadata(CHILD_ID, { parents: [OTHER_ID] }) };
      if (url.pathname.endsWith(`/files/${CHILD_ID}`)) return { data: fileMetadata(CHILD_ID) };
      throw new Error("unexpected request");
    } });
    await assert.rejects(movable.updateFile({ fileId: CHILD_ID, bytes: Buffer.from("x") }), { code: "updated_file_moved" });
  });

  it("refuses content replacement for Google-native documents even with a binary MIME override", async () => {
    const mutations = [];
    const nativeId = "google_doc_12345";
    const client = createBoundedDriveClient({
      folderId: FOLDER_ID,
      request: async (input) => {
        const url = new URL(input.url);
        if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
        if (url.pathname.endsWith(`/files/${nativeId}`)) {
          if (input.method === "PATCH") mutations.push(input);
          return { data: fileMetadata(nativeId, { mimeType: "application/vnd.google-apps.document" }) };
        }
        throw new Error("unexpected request");
      },
    });
    await assert.rejects(client.updateFile({ fileId: nativeId, bytes: Buffer.from("binary"), mimeType: "image/png" }), { code: "google_document_not_supported" });
    assert.deepEqual(mutations, []);
  });

  it("deletes an authorized in-root file", async () => {
    const methods = [];
    const client = createBoundedDriveClient({ folderId: FOLDER_ID, request: async (input) => {
      const url = new URL(input.url);
      if (url.pathname.endsWith(`/files/${FOLDER_ID}`)) return { data: rootMetadata() };
      if (url.pathname.endsWith(`/files/${CHILD_ID}`) && input.method === "DELETE") { methods.push(input.method); return { status: 204, data: null }; }
      if (url.pathname.endsWith(`/files/${CHILD_ID}`)) return { data: fileMetadata(CHILD_ID) };
      throw new Error("unexpected request");
    } });
    assert.deepEqual(await client.deleteFile(CHILD_ID), { id: CHILD_ID, deleted: true });
    assert.deepEqual(methods, ["DELETE"]);
  });
});

describe("Vite private-file guard", () => {
  async function start(server) {
    if (typeof server.listen === "function") await server.listen();
    else if (!server.httpServer.address()) {
      await new Promise((resolve, reject) => {
        server.httpServer.once("error", reject);
        server.httpServer.listen(resolve);
      });
    }
    const address = server.httpServer.address();
    return `http://127.0.0.1:${address.port}`;
  }

  it("blocks private bytes through dev root, encoded, raw, /@fs/, and symlink paths", async () => {
    const root = await tempRoot("wardrobe-vite-dev-");
    const externalRoot = await tempRoot("wardrobe-vite-old-external-");
    const port = await unusedPort();
    const privateDir = path.join(root, "data", ".google-drive");
    const oldPrivateDir = path.join(root, "old-data", ".google-drive");
    const externalPrivateDir = path.join(externalRoot, ".google-drive");
    const publicDir = path.join(root, "public");
    await mkdir(privateDir, { recursive: true });
    await mkdir(oldPrivateDir, { recursive: true });
    await mkdir(externalPrivateDir, { recursive: true });
    await mkdir(path.join(publicDir, ".google-drive"), { recursive: true });
    await writeFile(path.join(privateDir, "connection.json"), "known-private-marker");
    await writeFile(path.join(oldPrivateDir, "connection.json"), "old-private-marker");
    await writeFile(path.join(externalPrivateDir, "connection.json"), "external-old-private-marker");
    await writeFile(path.join(publicDir, ".google-drive", "stale.json"), "direct-public-old-private-marker");
    await symlink(path.join(privateDir, "connection.json"), path.join(root, "public", "connection-alias.json"));
    await symlink(path.join(root, "data"), path.join(root, "public", "data-alias"));
    await symlink(path.join(oldPrivateDir, "connection.json"), path.join(publicDir, "old-root-connection.json"));
    await symlink(path.join(externalPrivateDir, "connection.json"), path.join(publicDir, "old-external-connection.json"));
    const server = await createServer({
      configFile: false,
      root,
      appType: "custom",
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data" } })],
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    try {
      const base = await start(server);
      const fsPath = `/@fs/${path.join(privateDir, "connection.json").slice(1)}`;
      const targets = [
        "/data/.google-drive/connection.json",
        "/old-data/.google-drive/connection.json?raw",
        "/.google-drive/stale.json",
        "/data/%2Egoogle-drive/connection.json?raw",
        "/data/.google-drive/connection.json?import&raw",
        fsPath,
        "/connection-alias.json?raw",
        "/old-root-connection.json?raw",
        "/old-external-connection.json?raw",
        "/data-alias/.google-drive/connection.json?raw",
        "/_ipx/f_webp/data/.google-drive/connection.json",
        "//connection-alias.json?raw",
      ];
      for (const target of targets) {
        const response = await fetch(`${base}${target}`, { redirect: "manual" });
        assert.notEqual(response.status, 200, `private URL was exposed: ${target}`);
        const body = await response.text();
        for (const marker of ["known-private-marker", "old-private-marker", "external-old-private-marker", "direct-public-old-private-marker"]) {
          assert.equal(body.includes(marker), false, `private bytes were exposed through ${target}`);
        }
      }
    } finally { await server.close(); }
  });

  it("serves OAuth only as a same-origin control flow and strips callback credentials", async () => {
    const root = await tempRoot("wardrobe-vite-oauth-");
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const mock = createGoogleMock();
    const server = await createServer({
      configFile: false,
      root,
      appType: "custom",
      plugins: [googleDriveApi({ env: env({ GOOGLE_DRIVE_REDIRECT_URI: `${origin}/api/google-drive/oauth/callback` }), fetchImpl: mock.fetchImpl })],
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    try {
      const base = await start(server);
      const rejected = await fetch(`${base}/api/google-drive/oauth/start`, { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" });
      assert.equal(rejected.status, 403);
      assert.equal((await rejected.json()).error.code, "cross_origin_request");

      const started = await fetch(`${base}/api/google-drive/oauth/start`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(started.status, 200);
      const startBody = await started.json();
      const authUrl = new URL(startBody.authorizationUrl);
      const nonceCookie = started.headers.get("set-cookie").split(";", 1)[0];
      const callback = new URL("/api/google-drive/oauth/callback", origin);
      callback.searchParams.set("state", authUrl.searchParams.get("state"));
      callback.searchParams.set("code", "sensitive-code-value");
      const completed = await fetch(callback, { headers: { Cookie: nonceCookie }, redirect: "manual" });
      assert.equal(completed.status, 303);
      assert.equal(completed.headers.get("cache-control"), "no-store");
      assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
      assert.match(completed.headers.get("set-cookie"), /Max-Age=0/);
      const location = completed.headers.get("location");
      assert.equal(location, `${origin}/?googleDrive=connected`);
      assert.equal(location.includes("sensitive-code-value"), false);
      assert.equal(location.includes(authUrl.searchParams.get("state")), false);
      assert.equal(location.includes("access-token"), false);
      const status = await fetch(`${base}/api/google-drive/status`);
      assert.equal((await status.json()).state, "connected");
      const exchange = mock.calls.find((call) => call.url === "https://oauth2.googleapis.com/token");
      assert.equal(new URLSearchParams(exchange.body).get("code"), "sensitive-code-value", "the code is exchanged server-side only");
    } finally { await server.close(); }
  });

  it("protects a publicDir reached through an ancestor alias into a reserved state path", async () => {
    const root = await tempRoot("wardrobe-vite-ancestor-public-");
    const externalRoot = await tempRoot("wardrobe-vite-ancestor-state-");
    const port = await unusedPort();
    const reservedParent = path.join(externalRoot, ".google-drive");
    const publicTarget = path.join(reservedParent, "subdir");
    const publicAlias = path.join(root, "ancestor-alias");
    const publicDir = path.join(publicAlias, "subdir");
    await mkdir(publicTarget, { recursive: true });
    await writeFile(path.join(publicTarget, "connection.json"), "ancestor-alias-private-marker");
    await symlink(reservedParent, publicAlias);
    assert.equal((await stat(publicDir)).isDirectory(), true, "the publicDir leaf is a regular directory below an aliased ancestor");

    const env = { WARDROBE_DATA_DIR: "data-new" };
    const server = await createServer({
      configFile: false,
      root,
      publicDir,
      appType: "custom",
      plugins: [googleDriveApi({ env })],
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    try {
      const base = await start(server);
      const status = await fetch(`${base}/api/google-drive/status`);
      assert.equal((await status.json()).state, "configuration_invalid", "development remains available while unsafe public placement is reported");
      const response = await fetch(`${base}/connection.json`, { redirect: "manual" });
      assert.notEqual(response.status, 200);
      assert.equal((await response.text()).includes("ancestor-alias-private-marker"), false);
    } finally { await server.close(); }

    await assert.rejects(build({
      configFile: false,
      root,
      publicDir,
      plugins: [googleDriveApi({ env })],
      build: { outDir: "dist-ancestor-private", emptyOutDir: true },
    }), /cannot be stored under Vite publicDir or build.outDir/);
    await assert.rejects(readFile(path.join(root, "dist-ancestor-private", "connection.json")), { code: "ENOENT" });
  });

  it("blocks private bytes in preview and rejects public symlink copies during build", async () => {
    const root = await tempRoot("wardrobe-vite-preview-");
    const previewPort = await unusedPort();
    const privateDir = path.join(root, "data", ".google-drive");
    const oldPrivateDir = path.join(root, "old-data", ".google-drive");
    const externalRoot = await tempRoot("wardrobe-vite-preview-external-");
    const externalPrivateDir = path.join(externalRoot, ".google-drive");
    await mkdir(privateDir, { recursive: true });
    await mkdir(oldPrivateDir, { recursive: true });
    await mkdir(externalPrivateDir, { recursive: true });
    await mkdir(path.join(root, "public"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html><html><body>ok</body></html>");
    await writeFile(path.join(privateDir, "connection.json"), "preview-private-marker");
    await writeFile(path.join(oldPrivateDir, "connection.json"), "preview-old-private-marker");
    await writeFile(path.join(externalPrivateDir, "connection.json"), "preview-external-old-private-marker");
    await build({
      configFile: false,
      root,
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data" } })],
      build: { outDir: "dist", emptyOutDir: true },
    });
    const builtPrivateDir = path.join(root, "dist", ".google-drive");
    await mkdir(builtPrivateDir, { recursive: true });
    await writeFile(path.join(builtPrivateDir, "stale.json"), "preview-direct-output-private-marker");
    await symlink(path.join(oldPrivateDir, "connection.json"), path.join(root, "dist", "old-root-connection.json"));
    await symlink(path.join(externalPrivateDir, "connection.json"), path.join(root, "dist", "old-external-connection.json"));
    const server = await preview({
      configFile: false,
      root,
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data", GOOGLE_DRIVE_CLIENT_ID: "partial" } })],
      preview: { host: "127.0.0.1", port: previewPort, strictPort: true },
    });
    try {
      const base = await start(server);
      const response = await fetch(`${base}/data/.google-drive/connection.json`);
      assert.notEqual(response.status, 200);
      assert.equal((await response.text()).includes("preview-private-marker"), false);
      for (const target of ["/.google-drive/stale.json", "/old-root-connection.json", "/old-external-connection.json"]) {
        const stale = await fetch(`${base}${target}`, { redirect: "manual" });
        assert.notEqual(stale.status, 200, `stale private output was served: ${target}`);
        const body = await stale.text();
        assert.equal(body.includes("preview-direct-output-private-marker"), false);
        assert.equal(body.includes("preview-old-private-marker"), false);
        assert.equal(body.includes("preview-external-old-private-marker"), false);
      }
    } finally { await server.close(); }

    const publicDir = path.join(root, "public");
    const publicPrivateDir = path.join(publicDir, ".google-drive");
    await mkdir(publicPrivateDir, { recursive: true });
    await writeFile(path.join(publicPrivateDir, "stale.json"), "old-public-private-marker");
    await assert.rejects(build({
      configFile: false,
      root,
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data" } })],
      build: { outDir: "dist-stale-direct", emptyOutDir: true },
    }), /cannot be copied from publicDir/);
    await assert.rejects(readFile(path.join(root, "dist-stale-direct", ".google-drive", "stale.json")), { code: "ENOENT" });
    await rm(publicPrivateDir, { recursive: true, force: true });

    await symlink(path.join(oldPrivateDir, "connection.json"), path.join(publicDir, "old-root-connection.json"));
    await assert.rejects(build({
      configFile: false,
      root,
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data" } })],
      build: { outDir: "dist-stale-root-alias", emptyOutDir: true },
    }), /private state .*publicDir/);
    await assert.rejects(readFile(path.join(root, "dist-stale-root-alias", "old-root-connection.json")), { code: "ENOENT" });
    await rm(path.join(publicDir, "old-root-connection.json"), { force: true });

    await symlink(path.join(externalPrivateDir, "connection.json"), path.join(publicDir, "old-external-connection.json"));
    await assert.rejects(build({
      configFile: false,
      root,
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data" } })],
      build: { outDir: "dist-stale-external-alias", emptyOutDir: true },
    }), /private state .*publicDir/);
    await assert.rejects(readFile(path.join(root, "dist-stale-external-alias", "old-external-connection.json")), { code: "ENOENT" });
    await rm(path.join(publicDir, "old-external-connection.json"), { force: true });

    const externalDirectory = path.join(root, "external-assets");
    await mkdir(externalDirectory, { recursive: true });
    await symlink(privateDir, path.join(externalDirectory, "nested-private"));
    await symlink(externalDirectory, path.join(root, "public", "outer-assets"));
    await assert.rejects(build({
      configFile: false,
      root,
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data" } })],
      build: { outDir: "dist", emptyOutDir: true },
    }), /private state .*publicDir/);

    await rm(path.join(externalDirectory, "nested-private"), { force: true });
    await symlink(path.join(root, "public", "outer-assets"), path.join(externalDirectory, "cycle"));
    await assert.rejects(build({
      configFile: false,
      root,
      plugins: [googleDriveApi({ env: { WARDROBE_DATA_DIR: "data" } })],
      build: { outDir: "dist", emptyOutDir: true },
    }), /cycle under publicDir/);
  });
});
