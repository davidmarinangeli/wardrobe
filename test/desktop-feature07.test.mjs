// Desktop Feature 07: the server behind `tailscale serve`. A phone in the
// tailnet opens https://<machine>.<tailnet>.ts.net; Tailscale forwards to
// 127.0.0.1 and either keeps that name in `Host` or names it in
// `X-Forwarded-Host`. Both shapes must pass the host allow-list (when the
// shell passes --allowed-hosts <name>) and the same-origin checks, and nothing
// else may.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forwardedHost, isForwardedSameOriginRequest, isSameOriginRequest } from "../scripts/same-origin.mjs";
import { isSameOriginRequest as reexported } from "../scripts/import-job-api.mjs";
import { startServer } from "../scripts/server.mjs";
import { GOOGLE_DRIVE_REMOTE_CONNECT_NOTICE, isRemoteHostname } from "../src/google-drive-storage.js";

const TAILNET_NAME = "wardrobe-mac.tail1234.ts.net";
const PHONE_ORIGIN = `https://${TAILNET_NAME}`;
const INDEX_HTML = "<!doctype html><html><body>stub</body></html>\n";

const req = (headers) => ({ headers });

test("same-origin: the Host shape (tailscale serve keeps the public name in Host)", () => {
  assert.equal(isSameOriginRequest(req({ origin: PHONE_ORIGIN, host: TAILNET_NAME })), true);
  assert.equal(isSameOriginRequest(req({ origin: PHONE_ORIGIN, host: `${TAILNET_NAME}:443` })), true, "an explicit default port is the same host");
  assert.equal(isSameOriginRequest(req({ origin: PHONE_ORIGIN, host: TAILNET_NAME.toUpperCase() })), true, "host names are case-insensitive");
  assert.equal(isSameOriginRequest(req({ origin: PHONE_ORIGIN, host: `${TAILNET_NAME}:8443` })), false, "another port is another origin");
  assert.equal(reexported, isSameOriginRequest, "import-job-api re-exports the same function");
});

test("same-origin: the X-Forwarded-Host shape (Host rewritten to the local address)", () => {
  const forwarded = (value, origin = PHONE_ORIGIN) => req({ origin, host: "127.0.0.1:5173", "x-forwarded-host": value });
  assert.equal(isSameOriginRequest(forwarded(TAILNET_NAME)), true);
  assert.equal(isSameOriginRequest(forwarded(`${TAILNET_NAME}, proxy.internal`)), true, "the first value is the client's host");
  assert.equal(isSameOriginRequest(forwarded([TAILNET_NAME, "other.example"])), true, "a repeated header uses its first value");
  assert.equal(isSameOriginRequest(forwarded(`proxy.internal, ${TAILNET_NAME}`)), false, "only the first value counts");
  assert.equal(isSameOriginRequest(forwarded("other.tail1234.ts.net")), false);
  assert.equal(isSameOriginRequest(forwarded(TAILNET_NAME, "https://evil.example")), false, "the Origin must still match");
  assert.equal(isSameOriginRequest(forwarded(`evil.example@${TAILNET_NAME}`)), false, "only a bare host[:port] is compared");
  assert.equal(isSameOriginRequest(forwarded(`${TAILNET_NAME}/path`)), false);
  assert.equal(isSameOriginRequest(forwarded("")), false);
  // The local page keeps working with the header present or absent.
  assert.equal(isSameOriginRequest(req({ origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173", "x-forwarded-host": TAILNET_NAME })), true);
});

test("same-origin: nothing is relaxed to any origin", () => {
  assert.equal(isSameOriginRequest(req({ host: TAILNET_NAME, "x-forwarded-host": TAILNET_NAME })), false, "no Origin");
  assert.equal(isSameOriginRequest(req({ origin: "null", host: TAILNET_NAME, "x-forwarded-host": TAILNET_NAME })), false);
  assert.equal(isSameOriginRequest(req({ origin: `file://${TAILNET_NAME}`, host: TAILNET_NAME })), false, "only http(s) origins");
  assert.equal(isSameOriginRequest(req({ origin: PHONE_ORIGIN })), false, "no Host and no X-Forwarded-Host");
  assert.equal(isSameOriginRequest(req({ origin: "http://localhost:4173", host: "localhost:5173" })), false);
});

test("forwarded same-origin requires X-Forwarded-Host", () => {
  assert.equal(isForwardedSameOriginRequest(req({ origin: PHONE_ORIGIN, host: "127.0.0.1:5173", "x-forwarded-host": TAILNET_NAME })), true);
  assert.equal(isForwardedSameOriginRequest(req({ origin: PHONE_ORIGIN, host: TAILNET_NAME })), false, "Host alone is not a proxy");
  assert.equal(isForwardedSameOriginRequest(req({ origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173" })), false);
  assert.equal(forwardedHost(req({ "x-forwarded-host": `  ${TAILNET_NAME} , b` })), TAILNET_NAME);
  assert.equal(forwardedHost(req({})), "");
});

// --- Through the standalone server -------------------------------------------

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AI_PROVIDER|OPENAI_|OPENROUTER_|GEMINI_|MINIMAX_|GOOGLE_DRIVE_|WARDROBE_)/.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-f07-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), INDEX_HTML);
  return root;
}

async function start(t, root, { env = {}, allowedHosts } = {}) {
  const server = await startServer({ port: 0, root, env: cleanEnv(env), allowedHosts, log: () => {} });
  t.after(() => server.close());
  return server;
}

function request(server, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port: server.port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

/** The two header shapes `tailscale serve` may forward for a phone's request. */
function phoneHeaders(server, shape) {
  const common = { origin: PHONE_ORIGIN, "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.7" };
  return shape === "host"
    ? { ...common, host: TAILNET_NAME, "x-forwarded-host": TAILNET_NAME }
    : { ...common, host: `127.0.0.1:${server.port}`, "x-forwarded-host": TAILNET_NAME };
}

test("the tailnet name is refused until the shell passes it in the allowed hosts", async (t) => {
  const root = await makeRoot(t);
  const closed = await start(t, root);
  const refused = await request(closed, "/api/health", { headers: { host: TAILNET_NAME } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "host_not_allowed");

  const open = await start(t, root, { allowedHosts: [TAILNET_NAME] });
  const health = await request(open, "/api/health", { headers: { host: TAILNET_NAME } });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  const app = await request(open, "/", { headers: { host: TAILNET_NAME } });
  assert.equal(app.status, 200);
  assert.match(app.text, /stub/);
  const otherMachine = await request(open, "/api/health", { headers: { host: "other.tail1234.ts.net" } });
  assert.equal(otherMachine.status, 403, "only the exact name, not the whole tailnet");
});

for (const shape of ["host", "x-forwarded-host"]) {
  test(`a phone can switch TEST/PROD through the proxy (${shape} shape)`, async (t) => {
    const root = await makeRoot(t);
    const server = await start(t, root, { allowedHosts: [TAILNET_NAME] });
    const switched = await request(server, "/api/import/mode", { method: "POST", headers: phoneHeaders(server, shape), body: { mode: "test" } });
    assert.equal(switched.status, 200, switched.text);
    assert.equal(switched.json.mode, "test");
    // The desktop sees the same change: the mode is stored server-side.
    const desktop = await request(server, "/api/import/mode", { headers: { host: `localhost:${server.port}` } });
    assert.equal(desktop.json.mode, "test");

    const crossSite = await request(server, "/api/import/mode", {
      method: "POST",
      headers: { ...phoneHeaders(server, shape), origin: "https://evil.example" },
      body: { mode: "prod" },
    });
    assert.equal(crossSite.status, 403);
  });
}

test("from the phone, managed configuration still answers 409 and writes nothing", async (t) => {
  const root = await makeRoot(t);
  const server = await start(t, root, { env: { WARDROBE_MANAGED_CONFIG: "1" }, allowedHosts: [TAILNET_NAME] });
  for (const shape of ["host", "x-forwarded-host"]) {
    const response = await request(server, "/api/setup/config", {
      method: "POST",
      headers: phoneHeaders(server, shape),
      body: { provider: "openai", values: { OPENAI_API_KEY: "sk-from-the-phone" } },
    });
    assert.equal(response.status, 409, `${shape}: ${response.text}`);
    assert.equal(response.json.managedBy, "desktop");
  }
  await assert.rejects(stat(path.join(root, ".env")), { code: "ENOENT" });
  const providers = await request(server, "/api/setup/providers", { headers: { host: TAILNET_NAME } });
  assert.equal(providers.json.managed, true);
});

test("Google Drive: Archive controls work through the proxy, OAuth start does not", async (t) => {
  const root = await makeRoot(t);
  const server = await start(t, root, {
    allowedHosts: [TAILNET_NAME],
    env: {
      GOOGLE_DRIVE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_DRIVE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_DRIVE_REDIRECT_URI: "http://localhost:5173/api/google-drive/oauth/callback",
      GOOGLE_DRIVE_FOLDER_ID: "folder_ABCDE12345",
    },
  });
  const proxied = phoneHeaders(server, "x-forwarded-host");

  const disconnect = await request(server, "/api/google-drive/disconnect", { method: "POST", headers: proxied, body: {} });
  assert.equal(disconnect.status, 200, disconnect.text);

  const oauth = await request(server, "/api/google-drive/oauth/start", { method: "POST", headers: proxied, body: {} });
  assert.equal(oauth.status, 403);
  assert.equal(oauth.json.error.code, "cross_origin_request");

  // Without a proxy header, a non-callback origin is still refused (unchanged).
  const direct = await request(server, "/api/google-drive/disconnect", {
    method: "POST",
    headers: { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
    body: {},
  });
  assert.equal(direct.status, 403);
  assert.equal(direct.json.error.code, "cross_origin_request");

  const crossSite = await request(server, "/api/google-drive/disconnect", { method: "POST", headers: { ...proxied, origin: "https://evil.example" }, body: {} });
  assert.equal(crossSite.status, 403);

  const status = await request(server, "/api/google-drive/status", { headers: { host: TAILNET_NAME } });
  assert.equal(status.status, 200);
  assert.equal(JSON.stringify(status.json).includes("test-client-secret"), false);
  // Nothing under the data folder holds the secret either.
  const library = await readFile(path.join(root, "data", "library.json"), "utf8").catch(() => "");
  assert.equal(library.includes("test-client-secret"), false);
});

test("web app guard: Connect Google Drive is offered only on this computer", () => {
  for (const local of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "localhost."]) assert.equal(isRemoteHostname(local), false, local);
  for (const remote of [TAILNET_NAME, "100.101.102.103", "192.168.1.20", "wardrobe.local", ""]) assert.equal(isRemoteHostname(remote), true, remote);
  assert.match(GOOGLE_DRIVE_REMOTE_CONNECT_NOTICE, /computer/);
});
