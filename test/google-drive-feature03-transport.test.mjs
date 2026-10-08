import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createGoogleDriveService, GOOGLE_DRIVE_REQUIRED_SCOPES } from "../scripts/google-drive-auth.mjs";

const roots = new Set();
const ROOT_ID = "folder_12345";
const SESSION_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session_12345";

async function tempRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wardrobe-drive-transport-"));
  roots.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...roots].map((directory) => rm(directory, { recursive: true, force: true })));
  roots.clear();
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function env() {
  return {
    GOOGLE_DRIVE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_DRIVE_CLIENT_SECRET: "test-secret-not-real",
    GOOGLE_DRIVE_REDIRECT_URI: "http://localhost:5173/api/google-drive/oauth/callback",
    GOOGLE_DRIVE_FOLDER_ID: ROOT_ID,
    WARDROBE_DATA_DIR: "data",
  };
}

function responseWithRoot() {
  return json({
    id: ROOT_ID, name: "Test archive", mimeType: "application/vnd.google-apps.folder", trashed: false,
    capabilities: { canListChildren: true, canAddChildren: true, canEdit: true }, parents: [],
  });
}

function createTransportMock() {
  const calls = [];
  let nextLocation = SESSION_URL;
  let nextUploadResponse = null;
  let createdFile = null;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), method: init.method || "GET", redirect: init.redirect, headers: new Headers(init.headers), body: init.body });
    if (url.href === "https://oauth2.googleapis.com/token") {
      const request = new URLSearchParams(init.body);
      if (request.get("grant_type") === "refresh_token") {
        return json({ access_token: "access-token-refreshed-12345", refresh_token: "refresh-token-12345", expires_in: 3600, scope: GOOGLE_DRIVE_REQUIRED_SCOPES.join(" ") });
      }
      return json({ access_token: "access-token-12345", refresh_token: "refresh-token-12345", expires_in: 3600, scope: GOOGLE_DRIVE_REQUIRED_SCOPES.join(" ") });
    }
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") return json({ sub: "account_12345", email: "person@example.test", name: "Test User" });
    if (url.href === `https://www.googleapis.com/drive/v3/files/${ROOT_ID}?supportsAllDrives=true&fields=id%2Cname%2CmimeType%2Cparents%2Ctrashed%2Ccapabilities%2CdriveId%2Csize%2CmodifiedTime%2Cversion%2Cmd5Checksum%2Csha256Checksum%2CappProperties%2CwebViewLink` || url.pathname === `/drive/v3/files/${ROOT_ID}`) return responseWithRoot();
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/drive/v3/files/file_12345" && createdFile) return json(createdFile);
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/drive/v3/files") return json({ incompleteSearch: false, files: [] });
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/upload/drive/v3/files"
        && init.method === "POST" && url.searchParams.get("uploadType") === "multipart") {
      const body = Buffer.from(init.body);
      const jsonStart = body.indexOf(Buffer.from("\r\n\r\n")) + 4;
      const jsonEnd = body.indexOf(Buffer.from("\r\n"), jsonStart);
      const metadata = JSON.parse(body.subarray(jsonStart, jsonEnd).toString("utf8"));
      createdFile = {
        id: "file_12345", name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents,
        trashed: false, size: "0", capabilities: { canDownload: true, canModifyContent: true, canEdit: true, canDelete: true },
      };
      return json(createdFile);
    }
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/upload/drive/v3/files" && init.method === "POST") {
      const location = nextLocation;
      nextLocation = SESSION_URL;
      return new Response(null, { status: 200, headers: { Location: location } });
    }
    if (url.href === SESSION_URL && init.method === "PUT") {
      if (nextUploadResponse) {
        const response = nextUploadResponse;
        nextUploadResponse = null;
        return response;
      }
      return new Response(null, { status: 308, headers: { Range: "bytes=0-49" } });
    }
    return json({ error: "unexpected request" }, 404);
  };
  return {
    fetchImpl,
    calls,
    setNextLocation(value) { nextLocation = value; },
    setNextUploadResponse(response) { nextUploadResponse = response; },
  };
}

async function connectedService(root, mock) {
  const service = createGoogleDriveService({ root, env: env(), fetchImpl: mock.fetchImpl });
  const started = await service.startOAuth();
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  const result = await service.handleOAuthCallback({ state, nonce: started.nonce, code: "one-time-code" });
  return { service, target: result.target };
}

describe("bounded Google Drive resumable transport", () => {
  it("accepts a blank 200 session-init response and handles a blank 308 with Range", async () => {
    const root = await tempRoot();
    const mock = createTransportMock();
    const { service, target } = await connectedService(root, mock);
    const client = await service.getClient(target);
    const started = await client.startResumableUpload({
      name: "archive.json", mimeType: "application/json", size: 100, parentId: ROOT_ID, id: "generated_12345",
    });
    assert.equal(started.sessionUrl, SESSION_URL);
    const probe = await client.queryResumableUpload({ sessionUrl: started.sessionUrl, total: 100, parentId: ROOT_ID });
    assert.deepEqual(probe, { complete: false, offset: 50 });
    assert.equal(mock.calls.find((call) => call.url === SESSION_URL).method, "PUT");
  });

  it("rejects foreign session URLs and does not follow upload redirects", async () => {
    const root = await tempRoot();
    const mock = createTransportMock();
    const { service, target } = await connectedService(root, mock);
    const client = await service.getClient(target);
    mock.setNextLocation("https://attacker.example/upload?upload_id=session_12345");
    await assert.rejects(client.startResumableUpload({
      name: "archive.json", mimeType: "application/json", size: 100, parentId: ROOT_ID, id: "generated_12345",
    }), { code: "invalid_upload_session" });
    assert.equal(mock.calls.some((call) => call.url.startsWith("https://attacker.example/")), false);

    const started = await client.startResumableUpload({
      name: "archive.json", mimeType: "application/json", size: 100, parentId: ROOT_ID, id: "generated_12345",
    });
    mock.setNextUploadResponse(new Response(null, { status: 302, headers: { Location: "https://attacker.example/" } }));
    await assert.rejects(client.queryResumableUpload({ sessionUrl: started.sessionUrl, total: 100, parentId: ROOT_ID }), { code: "google_unavailable" });
    const request = mock.calls.find((call) => call.url === SESSION_URL && call.method === "PUT");
    assert.equal(request.redirect, "error");
    assert.equal(mock.calls.some((call) => call.url.startsWith("https://attacker.example/")), false);
  });

  it("enforces appProperties key/value limits in UTF-8 bytes before any request", async () => {
    const root = await tempRoot();
    const mock = createTransportMock();
    const { service, target } = await connectedService(root, mock);
    const client = await service.getClient(target);
    const key = "wardrobePath";
    const exact = "x".repeat(124 - Buffer.byteLength(key, "utf8"));
    const created = await client.createFile({
      id: "file_12345", name: "archive.json", mimeType: "application/json", bytes: Buffer.from("{}"),
      parentId: ROOT_ID, appProperties: { [key]: exact },
    });
    assert.equal(created.id, "file_12345");
    const upload = mock.calls.find((call) => call.method === "POST" && call.url.includes("uploadType=multipart"));
    assert.ok(Buffer.from(upload.body).includes(Buffer.from(exact)));

    const beforeInvalid = mock.calls.length;
    await assert.rejects(client.createFile({
      name: "archive.json", mimeType: "application/json", bytes: Buffer.from("{}"), parentId: ROOT_ID,
      appProperties: { [key]: `${exact}x` },
    }), { code: "invalid_app_properties" });
    await assert.rejects(client.createFile({
      name: "archive.json", mimeType: "application/json", bytes: Buffer.from("{}"), parentId: ROOT_ID,
      appProperties: { [key]: "☃".repeat(40) },
    }), { code: "invalid_app_properties" });
    assert.equal(mock.calls.length, beforeInvalid, "oversized ASCII and multibyte properties fail before the Drive request");
  });
});
