import { createHash, randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createBoundedDriveClient } from "./google-drive-client.mjs";
import { hasGoogleDrivePrivatePathComponent } from "./google-drive-private-path.mjs";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const REQUIRED_SCOPES = Object.freeze([
  "openid",
  "https://www.googleapis.com/auth/drive",
  "email",
  "profile",
]);
const PRIVATE_DIRECTORY_NAME = ".google-drive";
const CONNECTION_FILE_NAME = "connection.json";
const PRIVATE_STATE_VERSION = 1;
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const MAX_PENDING_ATTEMPTS = 16;
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_WINDOW_MS = 60_000;
const SAFE_ERROR_MESSAGES = Object.freeze({
  configuration_incomplete: "Completa la configurazione Google Drive per collegare un account.",
  configuration_invalid: "La configurazione Google Drive non è valida.",
  private_state_invalid: "Lo stato privato Google Drive non è leggibile o non è valido.",
  target_changed: "La configurazione o la cartella Google Drive è cambiata. Ricollega l’account.",
  reconnect_required: "La sessione Google Drive è scaduta. Ricollega l’account.",
  oauth_state_invalid: "La richiesta Google Drive è scaduta o non corrisponde alla sessione.",
  oauth_denied: "L’autorizzazione Google Drive è stata annullata.",
  oauth_code_missing: "Google non ha restituito un codice di autorizzazione.",
  oauth_scope_insufficient: "Google non ha concesso tutti i permessi richiesti per la cartella.",
  oauth_refresh_missing: "Google non ha fornito un token offline. Riprova autorizzando nuovamente l’accesso.",
  google_unavailable: "Google Drive non è raggiungibile in questo momento.",
  google_permission_denied: "L’account non può accedere alla cartella Google Drive configurata.",
  google_authentication_failed: "Google Drive non ha accettato la sessione. Ricollega l’account.",
  account_mismatch: "L’account Google verificato non corrisponde alla connessione attiva.",
  folder_access_denied: "La cartella configurata non è accessibile o non consente le operazioni richieste.",
  folder_read_denied: "La cartella configurata non può essere elencata.",
  folder_write_denied: "La cartella configurata non consente di aggiungere file.",
  invalid_root_folder: "La destinazione configurata non è una cartella Drive valida.",
  shortcut_not_supported: "La destinazione configurata non può essere un collegamento Drive.",
  incomplete_drive_listing: "Google Drive non ha completato l’elenco della cartella.",
  malformed_drive_listing: "Google Drive ha restituito un elenco non valido.",
  stale_connection: "La connessione Google Drive è cambiata durante l’operazione. Riprova.",
  persistence_failed: "Non è stato possibile salvare in modo sicuro la connessione Google Drive.",
});

export class GoogleDriveError extends Error {
  constructor(code, message = SAFE_ERROR_MESSAGES[code] || "Operazione Google Drive non riuscita.", { status = 400, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "GoogleDriveError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function asSafeError(error) {
  const code = typeof error?.code === "string" && SAFE_ERROR_MESSAGES[error.code] ? error.code : "google_unavailable";
  return { code, message: SAFE_ERROR_MESSAGES[code], retryable: Boolean(error?.retryable || code === "google_unavailable" || code === "incomplete_drive_listing") };
}
function isoNow(now) { return new Date(now()).toISOString(); }
function validDriveId(value) { return typeof value === "string" && value.length >= 5 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value); }
function validToken(value) { return typeof value === "string" && value.length >= 8 && value.length <= 16_384 && !/[\0\r\n]/.test(value); }

function readConfig(env = {}, root = process.cwd(), options = {}) {
  const values = Object.fromEntries(["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_REDIRECT_URI", "GOOGLE_DRIVE_FOLDER_ID"]
    .map((key) => [key, typeof env?.[key] === "string" ? env[key].trim() : ""]));
  const present = Object.values(values).filter(Boolean).length;
  const dataDirectory = path.resolve(root, typeof env?.WARDROBE_DATA_DIR === "string" && env.WARDROBE_DATA_DIR.trim() ? env.WARDROBE_DATA_DIR : "data");
  const privateDir = path.join(dataDirectory, PRIVATE_DIRECTORY_NAME);
  const callback = values.GOOGLE_DRIVE_REDIRECT_URI;
  let redirectUrl = null;
  let configError = null;
  if (present && present !== 4) configError = "configuration_incomplete";
  if (present === 4) {
    try {
      if (!validDriveId(values.GOOGLE_DRIVE_FOLDER_ID)) throw new Error("folder");
      redirectUrl = new URL(callback);
      const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(redirectUrl.hostname.toLowerCase());
      if ((redirectUrl.protocol !== "https:" && !(redirectUrl.protocol === "http:" && loopback))
        || redirectUrl.username || redirectUrl.password || redirectUrl.search || redirectUrl.hash
        || redirectUrl.pathname !== "/api/google-drive/oauth/callback") throw new Error("callback");
      if (values.GOOGLE_DRIVE_CLIENT_ID.length > 512 || values.GOOGLE_DRIVE_CLIENT_SECRET.length > 1024
          || !values.GOOGLE_DRIVE_CLIENT_ID || !values.GOOGLE_DRIVE_CLIENT_SECRET) throw new Error("credentials");
    } catch {
      configError = "configuration_invalid";
      redirectUrl = null;
    }
  }
  if (!present) configError = null;
  const fingerprint = present === 4 && !configError
    ? hash(JSON.stringify({ clientId: values.GOOGLE_DRIVE_CLIENT_ID, clientSecret: values.GOOGLE_DRIVE_CLIENT_SECRET, redirectUri: callback, folderId: values.GOOGLE_DRIVE_FOLDER_ID }))
    : null;
  const publicDir = path.resolve(root, options.publicDir || "public");
  const buildOutDir = path.resolve(root, options.buildOutDir || "dist");
  if (options.privatePlacementInvalid || isInside(publicDir, privateDir) || isInside(buildOutDir, privateDir)) configError = "configuration_invalid";
  return {
    configured: present === 4 && !configError,
    configError,
    values,
    redirectUrl,
    fingerprint,
    root: path.resolve(root),
    dataDirectory,
    privateDir,
    connectionFile: path.join(privateDir, CONNECTION_FILE_NAME),
    publicDir,
    buildOutDir,
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function prospectiveRealPath(filePath) {
  let current = path.resolve(filePath);
  const suffix = [];
  while (true) {
    try { return path.resolve(await realpath(current), ...suffix); }
    catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function validateConnectionShape(value) {
  if (!isObject(value) || value.version !== PRIVATE_STATE_VERSION
      || typeof value.configFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.configFingerprint)
      || typeof value.connectionGeneration !== "string" || !/^[a-f0-9-]{32,40}$/i.test(value.connectionGeneration)
      || !isObject(value.account) || typeof value.account.id !== "string" || !value.account.id
      || typeof value.account.email !== "string" || typeof value.account.name !== "string"
      || !isObject(value.folder) || !validDriveId(value.folder.id)
      || typeof value.folder.name !== "string" || !(value.folder.driveId === null || validDriveId(value.folder.driveId))
      || value.folder.readable !== true || value.folder.writable !== true
      || !/^[a-f0-9]{64}$/.test(value.targetFingerprint)
      || !validToken(value.accessToken) || !validToken(value.refreshToken)
      || !Number.isFinite(value.expiresAt) || value.expiresAt < 0
      || !Array.isArray(value.scopes) || !hasRequiredScopes(value.scopes)
      || !validIso(value.connectedAt) || !validIso(value.verifiedAt)
      || typeof value.reconnectRequired !== "boolean") return false;
  return true;
}

function validateTargetFingerprint(value, config) {
  const targetFingerprint = hash(JSON.stringify({ clientId: config.values.GOOGLE_DRIVE_CLIENT_ID, accountId: value.account.id, folderId: value.folder.id, driveId: value.folder.driveId }));
  return targetFingerprint === value.targetFingerprint;
}

function validIso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

function parseScopes(value) {
  if (typeof value !== "string") return [];
  return normalizeScopes(value.split(/\s+/).filter(Boolean));
}

function normalizeScopes(scopes) {
  const aliases = new Map([
    ["https://www.googleapis.com/auth/userinfo.email", "email"],
    ["https://www.googleapis.com/auth/userinfo.profile", "profile"],
  ]);
  return [...new Set(scopes.map((scope) => aliases.get(scope) || scope))];
}

function hasRequiredScopes(scopes) {
  const normalized = new Set(normalizeScopes(scopes));
  return REQUIRED_SCOPES.every((scope) => normalized.has(scope));
}

function safeFolderMetadata(value) {
  const summaryIsVerified = isObject(value) && value.readable === true && value.writable === true;
  const metadataIsVerified = isObject(value) && value.mimeType === "application/vnd.google-apps.folder"
    && value.trashed !== true && value.capabilities?.canListChildren === true && value.capabilities?.canAddChildren === true;
  if (!isObject(value) || !validDriveId(value.id) || (!summaryIsVerified && !metadataIsVerified)) {
    throw new GoogleDriveError("folder_access_denied");
  }
  return {
    id: value.id,
    name: String(value.name || "").slice(0, 255),
    driveId: validDriveId(value.driveId) ? value.driveId : null,
    readable: true,
    writable: true,
  };
}

function timeoutSignal() { return AbortSignal.timeout(FETCH_TIMEOUT_MS); }

async function responseJson(response) {
  let value;
  try { value = await response.json(); }
  catch { value = null; }
  return value;
}

function googleError(response, payload, operation) {
  const status = response.status;
  const driveReasons = Array.isArray(payload?.error?.errors) ? payload.error.errors.map((item) => item?.reason) : [];
  const retryableDriveLimit = operation === "drive" && status === 403
    && driveReasons.some((reason) => ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(reason));
  if (retryableDriveLimit) return new GoogleDriveError("google_unavailable", undefined, { status, retryable: true });
  if (status === 401) return new GoogleDriveError("google_authentication_failed", undefined, { status: 401 });
  if (status === 403) return new GoogleDriveError("google_permission_denied", undefined, { status: 403 });
  if (status === 429 || status >= 500 || status === 408) return new GoogleDriveError("google_unavailable", undefined, { status, retryable: true });
  if ((operation === "token" || operation === "refresh") && payload?.error === "invalid_grant") return new GoogleDriveError("reconnect_required", undefined, { status: 401 });
  return new GoogleDriveError("google_unavailable", undefined, { status, retryable: false });
}

async function fetchWithTimeout(fetchImpl, url, init) {
  try { return await fetchImpl(url, { ...init, signal: timeoutSignal() }); }
  catch (error) { throw new GoogleDriveError("google_unavailable", undefined, { retryable: true, cause: error }); }
}

function configStatus(config) {
  if (config.configError) return config.configError;
  if (!Object.values(config.values).some(Boolean)) return "unconfigured";
  if (!config.configured) return "configuration_incomplete";
  return null;
}

/** Creates a local-only Google Drive connection service; construction performs no I/O. */
export function createGoogleDriveService({ root = process.cwd(), env = process.env, fetchImpl = globalThis.fetch, now = Date.now, randomBytes = nodeRandomBytes, publicDir, buildOutDir, privatePlacementInvalid = false } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const config = readConfig(env, root, { publicDir, buildOutDir, privatePlacementInvalid });
  const attempts = new Map();
  let lifecycleRevision = 0;
  let serialization = Promise.resolve();
  let refreshFlight = null;
  let runtimeError = null;
  let callbackError = null;
  let disconnectingCount = 0;

  function serialize(task) {
    const run = serialization.then(task, task);
    serialization = run.catch(() => {});
    return run;
  }

  function assertConfigured() {
    const status = configStatus(config);
    if (status === "configuration_incomplete") throw new GoogleDriveError(status);
    if (status === "configuration_invalid") throw new GoogleDriveError(status);
    if (status === "unconfigured") throw new GoogleDriveError("configuration_incomplete");
  }

  async function isPrivatePlacementUnsafe() {
    if (config.configError === "configuration_invalid") return true;
    try {
      const [privatePath, publicPath, buildPath] = await Promise.all([
        prospectiveRealPath(config.privateDir),
        prospectiveRealPath(config.publicDir),
        prospectiveRealPath(config.buildOutDir),
      ]);
      return hasGoogleDrivePrivatePathComponent(config.publicDir)
        || hasGoogleDrivePrivatePathComponent(publicPath)
        || hasGoogleDrivePrivatePathComponent(config.buildOutDir)
        || hasGoogleDrivePrivatePathComponent(buildPath)
        || isInside(publicPath, privatePath)
        || isInside(buildPath, privatePath);
    } catch {
      return true;
    }
  }

  async function assertSafePrivatePlacement() {
    if (await isPrivatePlacementUnsafe()) throw new GoogleDriveError("configuration_invalid");
  }

  async function assertPrivatePath({ create = false } = {}) {
    try {
      const dataInfo = await lstat(config.dataDirectory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (dataInfo?.isSymbolicLink() || (dataInfo && !dataInfo.isDirectory())) throw new Error("private data root type");
      if (!dataInfo && !create) return { exists: false, fileInfo: null };
      const dirInfo = await lstat(config.privateDir);
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error("private directory type");
      await chmod(config.privateDir, 0o700);
      const fileInfo = await lstat(config.connectionFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (fileInfo && (fileInfo.isSymbolicLink() || !fileInfo.isFile())) throw new Error("private file type");
      if (fileInfo) await chmod(config.connectionFile, 0o600);
      return { exists: true, fileInfo };
    } catch (error) {
      if (error.code === "ENOENT" && !create) return { exists: false, fileInfo: null };
      if (error.code === "ENOENT" && create) {
        await mkdir(config.dataDirectory, { recursive: true });
        await mkdir(config.privateDir, { recursive: false, mode: 0o700 }).catch((mkdirError) => {
          if (mkdirError.code !== "EEXIST") throw mkdirError;
        });
        await chmod(config.privateDir, 0o700);
        return { exists: true, fileInfo: null };
      }
      throw new GoogleDriveError("private_state_invalid", undefined, { cause: error });
    }
  }

  async function loadConnection() {
    if (await isPrivatePlacementUnsafe()) return { connection: null, state: "configuration_invalid", error: new GoogleDriveError("configuration_invalid") };
    let checked;
    try { checked = await assertPrivatePath(); }
    catch (error) { return { connection: null, state: "private_state_invalid", error }; }
    if (!checked.exists || !checked.fileInfo) return { connection: null, state: configStatus(config) || "disconnected" };
    try {
      const parsed = JSON.parse(await readFile(config.connectionFile, "utf8"));
      if (!validateConnectionShape(parsed)) return { connection: null, state: "private_state_invalid", error: new GoogleDriveError("private_state_invalid") };
      if (!config.configured) return { connection: null, state: configStatus(config) || "disconnected" };
      if (parsed.configFingerprint !== config.fingerprint || parsed.folder.id !== config.values.GOOGLE_DRIVE_FOLDER_ID) return { connection: parsed, state: "target_changed" };
      if (!validateTargetFingerprint(parsed, config)) return { connection: null, state: "private_state_invalid", error: new GoogleDriveError("private_state_invalid") };
      if (parsed.reconnectRequired) return { connection: parsed, state: "reconnect_required" };
      return { connection: parsed, state: "connected" };
    } catch (error) {
      return { connection: null, state: "private_state_invalid", error: new GoogleDriveError("private_state_invalid", undefined, { cause: error }) };
    }
  }

  async function atomicPersist(connection) {
    let dirReady;
    try {
      await assertSafePrivatePlacement();
      dirReady = await assertPrivatePath({ create: true });
      const temporary = path.join(config.privateDir, `.connection-${randomBytes(8).toString("hex")}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(connection, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
      } finally { await handle.close(); }
      try { await rename(temporary, config.connectionFile); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      // Rename preserves the already-restricted temporary file mode.
      return dirReady;
    } catch (error) {
      throw new GoogleDriveError("persistence_failed", undefined, { status: 500, cause: error });
    }
  }

  async function removeConnection() {
    try {
      const checked = await assertPrivatePath();
      if (checked.exists && checked.fileInfo) await unlink(config.connectionFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw new GoogleDriveError("persistence_failed", undefined, { status: 500, cause: error });
    }
  }

  async function postToken(fields, operation, assertCurrent = async () => {}) {
    const response = await fetchWithTimeout(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(fields),
    });
    await assertCurrent();
    const payload = await responseJson(response);
    await assertCurrent();
    if (!response.ok) throw googleError(response, payload, operation);
    if (!isObject(payload)) throw new GoogleDriveError("google_unavailable", undefined, { status: 502, retryable: true });
    return payload;
  }

  async function googleRequest(accessToken, { method = "GET", url, query, headers = {}, body, responseType = "json" } = {}, assertCurrent = async () => {}) {
    const target = new URL(url);
    if (target.origin !== "https://www.googleapis.com" || !target.pathname.startsWith("/drive/v3/") && !target.pathname.startsWith("/upload/drive/v3/")) {
      throw new GoogleDriveError("google_unavailable", undefined, { status: 400 });
    }
    if (query) for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
    let payloadBody = body;
    const requestHeaders = { Accept: "application/json", Authorization: `Bearer ${accessToken}`, ...headers };
    if (isObject(body) && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      payloadBody = JSON.stringify(body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) requestHeaders["Content-Type"] = "application/json";
    }
    const response = await fetchWithTimeout(fetchImpl, target, { method, headers: requestHeaders, body: payloadBody });
    await assertCurrent();
    if (!response.ok) {
      const payload = await responseJson(response);
      await assertCurrent();
      throw googleError(response, payload, "drive");
    }
    if (responseType === "none" || response.status === 204) {
      await assertCurrent();
      return { status: response.status, headers: response.headers, data: null };
    }
    if (responseType === "bytes") {
      const bytes = Buffer.from(await response.arrayBuffer());
      await assertCurrent();
      return { status: response.status, headers: response.headers, bytes };
    }
    const data = await responseJson(response);
    await assertCurrent();
    if (!data) throw new GoogleDriveError("google_unavailable", undefined, { status: 502, retryable: true });
    return { status: response.status, headers: response.headers, data };
  }

  async function userInfo(accessToken, assertCurrent = async () => {}) {
    const response = await fetchWithTimeout(fetchImpl, GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    await assertCurrent();
    const payload = await responseJson(response);
    await assertCurrent();
    if (!response.ok) throw googleError(response, payload, "userinfo");
    if (!isObject(payload) || typeof payload.sub !== "string" || !payload.sub
        || typeof payload.email !== "string" || !payload.email) throw new GoogleDriveError("google_unavailable", undefined, { status: 502, retryable: true });
    return { id: payload.sub.slice(0, 255), email: payload.email.slice(0, 320), name: typeof payload.name === "string" ? payload.name.slice(0, 255) : "" };
  }

  async function candidateFolder(accessToken, assertCurrent = async () => {}) {
    const request = (input) => googleRequest(accessToken, input, assertCurrent);
    const client = createBoundedDriveClient({ folderId: config.values.GOOGLE_DRIVE_FOLDER_ID, request });
    try { return safeFolderMetadata(await client.verifyRoot()); }
    catch (error) {
      if (error.code === "google_authentication_failed" || error.retryable) throw error;
      throw new GoogleDriveError("folder_access_denied", undefined, { status: 403, cause: error });
    }
  }

  async function readConnectionOrThrow() {
    assertConfigured();
    const loaded = await loadConnection();
    if (loaded.state === "private_state_invalid") throw loaded.error;
    if (loaded.state === "target_changed") throw new GoogleDriveError("target_changed");
    if (!loaded.connection) throw new GoogleDriveError("stale_connection");
    if (loaded.connection.reconnectRequired) throw new GoogleDriveError("reconnect_required");
    return loaded.connection;
  }

  async function assertSnapshotCurrent(connection, expectedRevision = lifecycleRevision) {
    if (expectedRevision !== lifecycleRevision) throw new GoogleDriveError("stale_connection");
    const latest = await loadConnection();
    if (expectedRevision !== lifecycleRevision || !latest.connection
        || latest.connection.connectionGeneration !== connection.connectionGeneration
        || latest.connection.targetFingerprint !== connection.targetFingerprint) {
      throw new GoogleDriveError("stale_connection");
    }
    return latest.connection;
  }

  function setRuntimeError(code, connection, expectedRevision = lifecycleRevision, { verificationFailure = false, retryable = code === "google_unavailable" || code === "incomplete_drive_listing" } = {}) {
    if (expectedRevision !== lifecycleRevision || !connection?.connectionGeneration) return false;
    runtimeError = {
      code,
      connectionGeneration: connection.connectionGeneration,
      lifecycleRevision: expectedRevision,
      verificationFailure,
      retryable,
    };
    return true;
  }

  function clearRuntimeError(connection, expectedRevision = lifecycleRevision, { clearVerificationFailure = false } = {}) {
    if (expectedRevision !== lifecycleRevision || !connection?.connectionGeneration) return false;
    if (runtimeError?.connectionGeneration !== connection.connectionGeneration
        || runtimeError.lifecycleRevision !== expectedRevision
        || (runtimeError.verificationFailure && !clearVerificationFailure)) return false;
    runtimeError = null;
    return true;
  }

  async function markReconnectRequired(connection, expectedRevision) {
    return serialize(async () => {
      if (expectedRevision !== lifecycleRevision) return false;
      const current = await loadConnection();
      if (!current.connection || current.connection.connectionGeneration !== connection.connectionGeneration
          || expectedRevision !== lifecycleRevision) return false;
      const updated = { ...current.connection, reconnectRequired: true };
      await atomicPersist(updated);
      if (expectedRevision !== lifecycleRevision) return false;
      setRuntimeError("reconnect_required", current.connection, expectedRevision);
      return true;
    });
  }

  async function refreshConnection(snapshot, force = false) {
    const expectedRevision = lifecycleRevision;
    const current = await readConnectionOrThrow();
    if (expectedRevision !== lifecycleRevision || current.connectionGeneration !== snapshot.connectionGeneration
        || current.targetFingerprint !== snapshot.targetFingerprint) throw new GoogleDriveError("stale_connection");
    if (!force && current.expiresAt > now() + REFRESH_WINDOW_MS) return current;
    if (refreshFlight?.connectionGeneration === current.connectionGeneration
        && refreshFlight.lifecycleRevision === expectedRevision) return refreshFlight.promise;
    const flightGeneration = current.connectionGeneration;
    let flight;
    const promise = (async () => {
      let result;
      try {
        result = await postToken({
          client_id: config.values.GOOGLE_DRIVE_CLIENT_ID,
          client_secret: config.values.GOOGLE_DRIVE_CLIENT_SECRET,
          refresh_token: current.refreshToken,
          grant_type: "refresh_token",
        }, "refresh", () => assertSnapshotCurrent(current, expectedRevision));
      } catch (error) {
        await assertSnapshotCurrent(current, expectedRevision);
        if (error.code === "reconnect_required") await markReconnectRequired(current, expectedRevision).catch(() => {});
        else if (error.code === "google_unavailable") setRuntimeError("google_unavailable", current, expectedRevision);
        await assertSnapshotCurrent(current, expectedRevision);
        throw error;
      }
      await assertSnapshotCurrent(current, expectedRevision);
      if (!validToken(result.access_token) || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw new GoogleDriveError("google_unavailable", undefined, { status: 502, retryable: true });
      const updated = {
        ...current,
        accessToken: result.access_token,
        refreshToken: validToken(result.refresh_token) ? result.refresh_token : current.refreshToken,
        expiresAt: now() + Number(result.expires_in) * 1000,
        scopes: result.scope ? parseScopes(result.scope) : current.scopes,
        reconnectRequired: false,
      };
      if (!hasRequiredScopes(updated.scopes)) throw new GoogleDriveError("oauth_scope_insufficient");
      return serialize(async () => {
        const latest = await assertSnapshotCurrent(current, expectedRevision);
        if (latest.connectionGeneration !== flightGeneration) throw new GoogleDriveError("stale_connection");
        await atomicPersist(updated);
        await assertSnapshotCurrent(current, expectedRevision);
        clearRuntimeError(current, expectedRevision);
        return updated;
      });
    })();
    flight = {
      connectionGeneration: current.connectionGeneration,
      lifecycleRevision: expectedRevision,
      promise: promise.finally(() => { if (refreshFlight === flight) refreshFlight = null; }),
    };
    refreshFlight = flight;
    return flight.promise;
  }

  async function authenticatedRequest(snapshot, input) {
    const expectedRevision = lifecycleRevision;
    await assertSnapshotCurrent(snapshot, expectedRevision);
    let current = await refreshConnection(snapshot);
    try {
      const result = await googleRequest(current.accessToken, input, () => assertSnapshotCurrent(snapshot, expectedRevision));
      await assertSnapshotCurrent(snapshot, expectedRevision);
      clearRuntimeError(snapshot, expectedRevision);
      return result;
    }
    catch (error) {
      await assertSnapshotCurrent(snapshot, expectedRevision);
      if (error.code !== "google_authentication_failed") {
        if (error.code === "google_unavailable") setRuntimeError("google_unavailable", snapshot, expectedRevision);
        throw error;
      }
      current = await refreshConnection(snapshot, true);
      try {
        const result = await googleRequest(current.accessToken, input, () => assertSnapshotCurrent(snapshot, expectedRevision));
        await assertSnapshotCurrent(snapshot, expectedRevision);
        clearRuntimeError(snapshot, expectedRevision);
        return result;
      }
      catch (retryError) {
        await assertSnapshotCurrent(snapshot, expectedRevision);
        if (retryError.code === "google_authentication_failed") setRuntimeError("reconnect_required", snapshot, expectedRevision);
        else if (retryError.code === "google_unavailable") setRuntimeError("google_unavailable", snapshot, expectedRevision);
        throw retryError;
      }
    }
  }

  async function authenticatedUserInfo(snapshot) {
    const expectedRevision = lifecycleRevision;
    await assertSnapshotCurrent(snapshot, expectedRevision);
    let current = await refreshConnection(snapshot);
    try {
      const result = await userInfo(current.accessToken, () => assertSnapshotCurrent(snapshot, expectedRevision));
      await assertSnapshotCurrent(snapshot, expectedRevision);
      clearRuntimeError(snapshot, expectedRevision);
      return result;
    }
    catch (error) {
      await assertSnapshotCurrent(snapshot, expectedRevision);
      if (error.code !== "google_authentication_failed") {
        if (error.code === "google_unavailable") setRuntimeError("google_unavailable", snapshot, expectedRevision);
        throw error;
      }
      current = await refreshConnection(snapshot, true);
      try {
        const result = await userInfo(current.accessToken, () => assertSnapshotCurrent(snapshot, expectedRevision));
        await assertSnapshotCurrent(snapshot, expectedRevision);
        clearRuntimeError(snapshot, expectedRevision);
        return result;
      } catch (retryError) {
        await assertSnapshotCurrent(snapshot, expectedRevision);
        if (retryError.code === "google_authentication_failed") setRuntimeError("reconnect_required", snapshot, expectedRevision);
        else if (retryError.code === "google_unavailable") setRuntimeError("google_unavailable", snapshot, expectedRevision);
        throw retryError;
      }
    }
  }

  function makeTarget(connection) {
    return Object.freeze({
      targetFingerprint: connection.targetFingerprint,
      connectionGeneration: connection.connectionGeneration,
      accountId: connection.account.id,
      folderId: connection.folder.id,
      driveId: connection.folder.driveId,
    });
  }

  async function checkExpectedTarget(expected, expectedRevision = lifecycleRevision) {
    if (expectedRevision !== lifecycleRevision) throw new GoogleDriveError("stale_connection");
    const connection = await readConnectionOrThrow();
    if (expectedRevision !== lifecycleRevision) throw new GoogleDriveError("stale_connection");
    if (!expected || expected.targetFingerprint !== connection.targetFingerprint
        || expected.connectionGeneration !== connection.connectionGeneration
        || expected.accountId !== connection.account.id || expected.folderId !== connection.folder.id
        || expected.driveId !== connection.folder.driveId) throw new GoogleDriveError("stale_connection");
    return assertSnapshotCurrent(connection, expectedRevision);
  }

  async function getStatus() {
    const base = {
      configured: config.configured,
      state: configStatus(config) || "disconnected",
      connected: false,
      backupEnabled: false,
      reconnectRequired: false,
      account: null,
      folder: null,
      targetFingerprint: null,
      connectionGeneration: null,
      connectedAt: null,
      verifiedAt: null,
      error: null,
      lastAuthError: callbackError ? asSafeError(callbackError) : null,
    };
    if (disconnectingCount > 0) {
      base.state = "disconnected";
      return base;
    }
    const loaded = await loadConnection();
    if (loaded.state === "configuration_invalid") {
      base.configured = false;
      base.state = "configuration_invalid";
      base.error = asSafeError(loaded.error);
      return base;
    }
    if (loaded.state === "private_state_invalid") {
      base.state = "private_state_invalid";
      base.error = asSafeError(loaded.error);
      return base;
    }
    if (base.state !== "disconnected" && base.state !== "connected") {
      if (base.state === "configuration_incomplete" || base.state === "configuration_invalid") base.error = asSafeError(new GoogleDriveError(base.state));
      return base;
    }
    if (loaded.connection) {
      if (loaded.state === "target_changed" || loaded.connection.configFingerprint !== config.fingerprint) {
        base.state = "target_changed";
        base.error = asSafeError(new GoogleDriveError("target_changed"));
        return base;
      }
      const currentRuntimeError = runtimeError?.lifecycleRevision === lifecycleRevision
          && runtimeError.connectionGeneration === loaded.connection.connectionGeneration
        ? runtimeError
        : null;
      const runtimeCode = currentRuntimeError?.code || null;
      base.state = loaded.connection.reconnectRequired || runtimeCode === "reconnect_required" ? "reconnect_required" : "connected";
      base.reconnectRequired = loaded.connection.reconnectRequired || runtimeCode === "reconnect_required";
      base.connected = !base.reconnectRequired;
      base.account = { id: loaded.connection.account.id, email: loaded.connection.account.email, name: loaded.connection.account.name };
      base.folder = { ...loaded.connection.folder };
      base.targetFingerprint = loaded.connection.targetFingerprint;
      base.connectionGeneration = loaded.connection.connectionGeneration;
      base.connectedAt = loaded.connection.connectedAt;
      base.verifiedAt = loaded.connection.verifiedAt;
    }
    const currentRuntimeError = loaded.connection && runtimeError?.lifecycleRevision === lifecycleRevision
        && runtimeError.connectionGeneration === loaded.connection.connectionGeneration
      ? runtimeError
      : null;
    if (currentRuntimeError) {
      const runtimeCode = currentRuntimeError.code;
      base.error = asSafeError(new GoogleDriveError(runtimeCode, undefined, { retryable: currentRuntimeError.retryable }));
      if (["google_unavailable", "incomplete_drive_listing", "malformed_drive_listing"].includes(runtimeCode)) {
        base.state = "unavailable";
        if (currentRuntimeError.verificationFailure) base.connected = false;
      }
      if (runtimeCode === "google_permission_denied" || runtimeCode === "folder_access_denied") {
        base.state = "folder_access_denied";
        base.connected = false;
      }
      if (runtimeCode === "target_changed") { base.state = "target_changed"; base.connected = false; }
      if (runtimeCode === "google_authentication_failed" || runtimeCode === "reconnect_required") { base.state = "reconnect_required"; base.reconnectRequired = true; base.connected = false; }
      if (runtimeCode === "account_mismatch") { base.state = "target_changed"; base.connected = false; }
    }
    return base;
  }

  async function startOAuth() {
    assertConfigured();
    await assertSafePrivatePlacement();
    const nowValue = now();
    for (const [state, attempt] of attempts) if (attempt.expiresAt <= nowValue) attempts.delete(state);
    while (attempts.size >= MAX_PENDING_ATTEMPTS) attempts.delete(attempts.keys().next().value);
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    attempts.set(state, {
      nonceHash: hash(nonce),
      verifier,
      configFingerprint: config.fingerprint,
      createdAt: nowValue,
      expiresAt: nowValue + ATTEMPT_LIFETIME_MS,
      lifecycleRevision,
    });
    const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorization.searchParams.set("client_id", config.values.GOOGLE_DRIVE_CLIENT_ID);
    authorization.searchParams.set("redirect_uri", config.values.GOOGLE_DRIVE_REDIRECT_URI);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
    authorization.searchParams.set("access_type", "offline");
    authorization.searchParams.set("prompt", "consent select_account");
    authorization.searchParams.set("include_granted_scopes", "true");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: authorization.toString(), nonce, cookieName: "wardrobe_google_oauth_nonce", maxAge: Math.floor(ATTEMPT_LIFETIME_MS / 1000), secure: config.redirectUrl.protocol === "https:" };
  }

  function assertAttemptCurrent(attempt) {
    if (attempt.lifecycleRevision !== lifecycleRevision || attempt.configFingerprint !== config.fingerprint) {
      throw new GoogleDriveError("stale_connection");
    }
  }

  async function handleOAuthCallback(input = {}) {
    assertConfigured();
    await assertSafePrivatePlacement();
    const state = typeof input.state === "string" ? input.state : "";
    const attempt = attempts.get(state);
    if (attempt) attempts.delete(state); // A callback can never be replayed after this point.
    try {
      if (!attempt || attempt.expiresAt <= now() || attempt.configFingerprint !== config.fingerprint
          || attempt.lifecycleRevision !== lifecycleRevision || typeof input.nonce !== "string"
          || hash(input.nonce) !== attempt.nonceHash) throw new GoogleDriveError("oauth_state_invalid", undefined, { status: 400 });
      if (input.error) throw new GoogleDriveError("oauth_denied", undefined, { status: 400 });
      if (typeof input.code !== "string" || !input.code || input.code.length > 4096 || /[\0\r\n]/.test(input.code)) throw new GoogleDriveError("oauth_code_missing", undefined, { status: 400 });

      const candidate = await postToken({
        code: input.code,
        client_id: config.values.GOOGLE_DRIVE_CLIENT_ID,
        client_secret: config.values.GOOGLE_DRIVE_CLIENT_SECRET,
        redirect_uri: config.values.GOOGLE_DRIVE_REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: attempt.verifier,
      }, "exchange", () => assertAttemptCurrent(attempt));
      assertAttemptCurrent(attempt);
      const scopes = parseScopes(candidate.scope);
      if (!validToken(candidate.access_token) || !Number.isFinite(Number(candidate.expires_in)) || Number(candidate.expires_in) <= 0) throw new GoogleDriveError("google_unavailable", undefined, { status: 502, retryable: true });
      if (!validToken(candidate.refresh_token)) throw new GoogleDriveError("oauth_refresh_missing", undefined, { status: 400 });
      if (!hasRequiredScopes(scopes)) throw new GoogleDriveError("oauth_scope_insufficient", undefined, { status: 403 });

      const account = await userInfo(candidate.access_token, () => assertAttemptCurrent(attempt));
      assertAttemptCurrent(attempt);
      const folder = await candidateFolder(candidate.access_token, () => assertAttemptCurrent(attempt));
      assertAttemptCurrent(attempt);
      if (folder.id !== config.values.GOOGLE_DRIVE_FOLDER_ID) throw new GoogleDriveError("target_changed");
      const targetFingerprint = hash(JSON.stringify({ clientId: config.values.GOOGLE_DRIVE_CLIENT_ID, accountId: account.id, folderId: folder.id, driveId: folder.driveId }));
      const connectedAt = isoNow(now);
      const connection = {
        version: PRIVATE_STATE_VERSION,
        configFingerprint: config.fingerprint,
        connectionGeneration: randomUUID(),
        account,
        folder,
        targetFingerprint,
        accessToken: candidate.access_token,
        refreshToken: candidate.refresh_token,
        expiresAt: now() + Number(candidate.expires_in) * 1000,
        scopes,
        connectedAt,
        verifiedAt: connectedAt,
        reconnectRequired: false,
      };
      return await serialize(async () => {
        assertAttemptCurrent(attempt);
        if (!validateConnectionShape(connection) || !validateTargetFingerprint(connection, config)) throw new GoogleDriveError("persistence_failed", undefined, { status: 500 });
        await atomicPersist(connection);
        assertAttemptCurrent(attempt);
        lifecycleRevision += 1;
        runtimeError = null;
        callbackError = null;
        return { success: true, account: { ...account }, folder: { ...folder }, target: makeTarget(connection) };
      });
    } catch (error) {
      if (attempt && attempt.lifecycleRevision !== lifecycleRevision) throw new GoogleDriveError("stale_connection");
      if (attempt && attempt.lifecycleRevision === lifecycleRevision) callbackError = error;
      throw error;
    }
  }

  async function verifyConnection() {
    const expectedRevision = lifecycleRevision;
    const connection = await readConnectionOrThrow();
    await assertSnapshotCurrent(connection, expectedRevision);
    const expected = makeTarget(connection);
    const request = (input) => authenticatedRequest(connection, input);
    const client = createBoundedDriveClient({ folderId: connection.folder.id, request, expectedDriveId: connection.folder.driveId, assertCurrentTarget: () => checkExpectedTarget(expected, expectedRevision) });
    try {
      const [account, folderInfo] = await Promise.all([
        authenticatedUserInfo(connection),
        client.verifyRoot(),
      ]);
      await assertSnapshotCurrent(connection, expectedRevision);
      if (account.id !== connection.account.id) throw new GoogleDriveError("account_mismatch", undefined, { status: 403 });
      const folder = safeFolderMetadata(folderInfo);
      if (folder.id !== connection.folder.id || folder.driveId !== connection.folder.driveId) throw new GoogleDriveError("target_changed");
      return await serialize(async () => {
        const latest = await assertSnapshotCurrent(connection, expectedRevision);
        const updated = { ...latest, account, folder, verifiedAt: isoNow(now), reconnectRequired: false };
        await atomicPersist(updated);
        await assertSnapshotCurrent(connection, expectedRevision);
        clearRuntimeError(connection, expectedRevision, { clearVerificationFailure: true });
        if (expectedRevision === lifecycleRevision) callbackError = null;
        return getStatus();
      });
    } catch (error) {
      await assertSnapshotCurrent(connection, expectedRevision);
      if (error.code !== "stale_connection") {
        let code = SAFE_ERROR_MESSAGES[error.code] ? error.code : "google_unavailable";
        if (["google_permission_denied", "folder_access_denied", "folder_read_denied", "folder_write_denied", "invalid_root_folder", "shortcut_not_supported"].includes(code)) code = "folder_access_denied";
        else if (["account_mismatch", "target_changed"].includes(code)) code = "target_changed";
        else if (["google_authentication_failed", "reconnect_required"].includes(code)) code = "reconnect_required";
        setRuntimeError(code, connection, expectedRevision, { verificationFailure: true });
      }
      throw error;
    }
  }

  async function disconnect() {
    attempts.clear();
    lifecycleRevision += 1;
    runtimeError = null;
    callbackError = null;
    disconnectingCount += 1;
    return serialize(async () => {
      try {
        await removeConnection();
        return getStatus();
      } finally {
        disconnectingCount -= 1;
      }
    });
  }

  async function getTarget() {
    return makeTarget(await readConnectionOrThrow());
  }

  async function getClient(expectedTarget) {
    const connection = await checkExpectedTarget(expectedTarget);
    const request = (input) => authenticatedRequest(connection, input);
    return createBoundedDriveClient({
      folderId: connection.folder.id,
      request,
      expectedDriveId: connection.folder.driveId,
      assertCurrentTarget: () => checkExpectedTarget(expectedTarget),
    });
  }

  return Object.freeze({
    getStatus,
    startOAuth,
    handleOAuthCallback,
    verifyConnection,
    disconnect,
    getTarget,
    getClient,
    // These getters support a same-origin adapter without exposing credentials.
    get callbackOrigin() { return config.redirectUrl?.origin || null; },
    get callbackUrl() { return config.configured ? config.values.GOOGLE_DRIVE_REDIRECT_URI : null; },
    get privateDir() { return config.privateDir; },
  });
}

export const GOOGLE_DRIVE_REQUIRED_SCOPES = REQUIRED_SCOPES;
export const GOOGLE_DRIVE_PRIVATE_DIRECTORY = PRIVATE_DIRECTORY_NAME;
