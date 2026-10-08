import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createGoogleDriveService, GoogleDriveError } from "./google-drive-auth.mjs";
import { getGoogleDriveSyncWorker } from "./google-drive-sync.mjs";
import { hasGoogleDrivePrivatePathComponent } from "./google-drive-private-path.mjs";
import { createArchiveAdmissionMiddleware, ensureArchiveRecovered, setArchiveRecovery } from "./archive-coordinator.mjs";
import { createGoogleDriveArchiveManager, recoverArchiveRestore } from "./archive-restore.mjs";

const COOKIE_NAME = "wardrobe_google_oauth_nonce";
const workerCloseWrappedServers = new WeakSet();
function inside(parent, candidate) {
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

async function privatePathUnderStaticRoot(privateDir, publicDir, buildDir) {
  const [privatePath, publicPath, outputPath] = await Promise.all([
    prospectiveRealPath(privateDir),
    prospectiveRealPath(publicDir),
    prospectiveRealPath(buildDir),
  ]);
  return hasGoogleDrivePrivatePathComponent(publicDir)
    || hasGoogleDrivePrivatePathComponent(publicPath)
    || hasGoogleDrivePrivatePathComponent(buildDir)
    || hasGoogleDrivePrivatePathComponent(outputPath)
    || inside(publicPath, privatePath)
    || inside(outputPath, privatePath);
}

function decodePath(value) {
  let result = String(value || "");
  for (let count = 0; count < 3; count += 1) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch { return null; }
  }
  return result.replaceAll("\\", "/");
}

function privateDirectoryCandidates(urlPath, root, publicDir, buildDir) {
  const decoded = decodePath(urlPath);
  if (!decoded) return [];
  const candidates = [];
  const add = (value) => { if (value && path.isAbsolute(value)) candidates.push(path.normalize(value)); };

  const pathValue = decoded.split(/[?#]/, 1)[0];
  if (pathValue.startsWith("/@fs/")) {
    let absolute = pathValue.slice("/@fs/".length);
    if (!absolute.startsWith("/")) absolute = `/${absolute}`;
    add(absolute);
  }

  const relative = pathValue.replace(/^\/+/, "");
  if (relative && !relative.startsWith("@")) {
    add(path.resolve(root, relative));
    add(path.resolve(publicDir, relative));
    add(path.resolve(buildDir, relative));
  }

  // IPX URLs encode transforms before the source path. Try each possible
  // source suffix so a private file remains denied before the IPX plugin runs.
  if (relative.startsWith("_ipx/")) {
    const segments = relative.split("/").slice(1);
    for (let start = 0; start < segments.length; start += 1) {
      const suffix = segments.slice(start).join("/");
      if (!suffix) continue;
      add(path.resolve(root, suffix));
      add(path.resolve(publicDir, suffix));
      add(path.resolve(buildDir, suffix));
    }
  }

  return candidates;
}

async function resolvesInsidePrivate(candidate, privateDir, privateRealPath) {
  if (hasGoogleDrivePrivatePathComponent(candidate)) return true;
  if (inside(privateDir, candidate) || inside(privateRealPath, candidate)) return true;
  try {
    const resolved = await realpath(candidate);
    return hasGoogleDrivePrivatePathComponent(resolved) || inside(privateRealPath, resolved) || inside(privateDir, resolved);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return false;
  }
}

/** Middleware mounted before Vite and application middleware. */
export function createPrivateFileGuard({ root, privateDir, publicDir = path.join(root, "public"), buildDir = path.join(root, "dist") } = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const resolvedPrivate = path.resolve(privateDir || path.join(resolvedRoot, "data", ".google-drive"));
  const resolvedPublic = path.resolve(publicDir);
  const resolvedBuild = path.resolve(buildDir);

  return async function privateFileGuard(req, res, next) {
    let pathname;
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
    catch { return next(); }
  let privateRealPath = resolvedPrivate;
  try { privateRealPath = await realpath(resolvedPrivate); }
  catch { /* The private directory is intentionally absent until a successful OAuth link. */ }
  try {
    const candidates = privateDirectoryCandidates(pathname, resolvedRoot, resolvedPublic, resolvedBuild);
    // A protocol-relative-looking request can be reinterpreted as an authority
    // by URL parsers. Also evaluate it as a root-relative path before Vite does.
    const rawPath = String(req.url || "/").split("?", 1)[0];
    if (rawPath.startsWith("//")) candidates.push(...privateDirectoryCandidates(rawPath.slice(1), resolvedRoot, resolvedPublic, resolvedBuild));
      for (const candidate of candidates) {
        if (await resolvesInsidePrivate(candidate, resolvedPrivate, privateRealPath)) {
          res.statusCode = 404;
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }
      }
    } catch {
      // If path resolution fails, fail closed for any request mentioning the
      // private control directory name. This does not reveal whether it exists.
      if (decodePath(pathname)?.includes(".google-drive")) {
        res.statusCode = 404;
        res.setHeader("Cache-Control", "no-store");
        res.end("Not found");
        return;
      }
    }
    return next();
  };
}

async function auditPublicSymlinks(publicDir, privateDir) {
  if (hasGoogleDrivePrivatePathComponent(publicDir)) throw new Error("Google Drive private state cannot be copied from publicDir");
  let privateReal = privateDir;
  try { privateReal = await realpath(privateDir); } catch { /* no OAuth state yet */ }
  let publicInfo;
  try { publicInfo = await lstat(publicDir); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (publicInfo.isSymbolicLink()) throw new Error("Google Drive private state cannot be reached through publicDir");
  if (!publicInfo.isDirectory()) return;
  const scannedDirectories = new Set();
  async function walk(dir, ancestors = new Set()) {
    if (hasGoogleDrivePrivatePathComponent(dir)) throw new Error("Google Drive private state cannot be copied from publicDir");
    const resolvedDirectory = await realpath(dir);
    if (hasGoogleDrivePrivatePathComponent(resolvedDirectory)) throw new Error("Google Drive private state cannot be copied from publicDir");
    if (ancestors.has(resolvedDirectory)) throw new Error("Directory symlink cycle under publicDir");
    if (scannedDirectories.has(resolvedDirectory)) return;
    scannedDirectories.add(resolvedDirectory);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(resolvedDirectory);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (hasGoogleDrivePrivatePathComponent(file)) throw new Error("Google Drive private state cannot be copied from publicDir");
      let resolvedEntry;
      try { resolvedEntry = await realpath(file); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (hasGoogleDrivePrivatePathComponent(resolvedEntry)) throw new Error("Google Drive private state cannot be copied from publicDir");
      if (entry.isSymbolicLink()) {
        const target = resolvedEntry;
        if (hasGoogleDrivePrivatePathComponent(target)
            || inside(privateDir, target) || inside(privateReal, target) || inside(target, privateDir) || inside(target, privateReal)) {
          throw new Error("Google Drive private state is linked from publicDir");
        }
        let targetInfo;
        try { targetInfo = await stat(file); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (targetInfo.isDirectory()) await walk(file, nextAncestors);
      } else if (entry.isDirectory()) await walk(file, nextAncestors);
    }
  }
  await walk(publicDir);
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(value));
}

function safeError(error) {
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) ? error.code : "google_unavailable";
  const allowed = new Set([
    "invalid_request", "cross_origin_request", "file_trashed", "drive_metadata_id_mismatch",
    "configuration_incomplete", "configuration_invalid", "private_state_invalid", "target_changed", "reconnect_required",
    "oauth_state_invalid", "oauth_denied", "oauth_code_missing", "oauth_scope_insufficient", "oauth_refresh_missing",
    "google_unavailable", "google_permission_denied", "google_authentication_failed", "account_mismatch", "folder_access_denied",
    "stale_connection", "persistence_failed", "invalid_drive_id", "malformed_drive_metadata", "shortcut_not_supported",
    "invalid_root_folder", "folder_read_denied", "folder_write_denied", "incomplete_drive_listing", "malformed_drive_listing",
    "duplicate_drive_id", "drive_parent_mismatch", "foreign_shared_drive", "file_read_denied", "file_write_denied",
    "file_edit_denied", "file_delete_denied", "file_too_large", "google_document_not_supported", "invalid_file_name",
    "invalid_mime_type", "invalid_app_properties", "empty_update", "drive_parent_ambiguous", "drive_ancestry_cycle",
    "drive_ancestry_too_deep", "drive_parent_not_folder", "root_mutation_forbidden", "created_file_outside_target",
    "updated_file_moved", "malformed_page_token", "repeated_page_token", "drive_listing_too_large", "drive_listing_too_many_pages",
    "archive_maintenance", "archive_control_invalid", "archive_invalid", "snapshot_changed", "sync_conflict",
  ]);
  const exposedCode = allowed.has(code) ? code : "google_unavailable";
  const safeMessages = {
    invalid_request: "La richiesta non è valida.",
    cross_origin_request: "La richiesta deve provenire da questa applicazione.",
    file_trashed: "Il file Drive richiesto è nel cestino.",
    drive_metadata_id_mismatch: "Google Drive ha restituito metadati per un elemento diverso.",
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
    google_permission_denied: "L’account non può accedere alla cartella Google Drive configurata.",
    google_authentication_failed: "Google Drive non ha accettato la sessione. Ricollega l’account.",
    account_mismatch: "L’account Google verificato non corrisponde alla connessione attiva.",
    folder_access_denied: "La cartella configurata non è accessibile o non consente le operazioni richieste.",
    stale_connection: "La connessione Google Drive è cambiata durante l’operazione. Riprova.",
    persistence_failed: "Non è stato possibile salvare in modo sicuro la connessione Google Drive.",
    invalid_drive_id: "L’identificativo Drive non è valido.",
    malformed_drive_metadata: "Google Drive ha restituito metadati non validi.",
    shortcut_not_supported: "I collegamenti Drive non sono supportati per l’archivio.",
    invalid_root_folder: "La destinazione configurata non è una cartella Drive valida.",
    folder_read_denied: "La cartella Drive non può essere letta.",
    folder_write_denied: "La cartella Drive non consente di aggiungere l’archivio.",
    incomplete_drive_listing: "Google Drive non ha completato l’elenco della cartella.",
    malformed_drive_listing: "Google Drive ha restituito un elenco non valido.",
    duplicate_drive_id: "Google Drive ha restituito elementi duplicati.",
    drive_parent_mismatch: "Google Drive ha restituito un elemento fuori dalla cartella richiesta.",
    foreign_shared_drive: "L’elemento si trova in un’altra unità Drive.",
    file_read_denied: "Questo file Drive non può essere scaricato.",
    file_write_denied: "Questo file Drive non può essere sostituito.",
    file_edit_denied: "I metadati di questo file Drive non possono essere modificati.",
    file_delete_denied: "Questo file Drive non può essere eliminato.",
    file_too_large: "Il file supera la dimensione supportata.",
    google_document_not_supported: "I documenti Google nativi non sono supportati nell’archivio.",
    invalid_file_name: "Il nome del file non è valido.",
    invalid_mime_type: "Il tipo del file non è supportato.",
    invalid_app_properties: "I metadati applicativi non sono validi.",
    empty_update: "Indica almeno un campo da aggiornare.",
    drive_parent_ambiguous: "La posizione del file Drive non è univoca.",
    drive_ancestry_cycle: "La struttura delle cartelle Drive non è valida.",
    drive_ancestry_too_deep: "La struttura delle cartelle Drive è troppo profonda.",
    drive_parent_not_folder: "La cartella superiore Drive non è valida.",
    root_mutation_forbidden: "La cartella archivio configurata non può essere modificata o eliminata.",
    created_file_outside_target: "Google Drive ha creato un elemento fuori dalla destinazione verificata.",
    updated_file_moved: "Google Drive ha spostato il file durante l’aggiornamento.",
    malformed_page_token: "Google Drive ha restituito un token di pagina non valido.",
    repeated_page_token: "Google Drive ha ripetuto una pagina dell’elenco.",
    drive_listing_too_large: "La cartella Drive supera il limite di elementi supportato.",
    drive_listing_too_many_pages: "La cartella Drive ha troppe pagine da elencare.",
    archive_maintenance: "L’archivio è in manutenzione. Riprova tra poco.",
    archive_control_invalid: "Lo stato di ripristino dell’archivio non è leggibile o non è valido.",
    archive_invalid: "L’archivio selezionato non è completo o non è valido.",
    snapshot_changed: "L’archivio è cambiato dopo l’anteprima. Rivedi la scelta.",
    sync_conflict: "La scelta dell’archivio è scaduta o non corrisponde all’anteprima.",
    google_unavailable: "Google Drive non è raggiungibile in questo momento.",
  };
  return { error: { code: exposedCode, message: safeMessages[exposedCode] || safeMessages.google_unavailable, retryable: Boolean(error?.retryable) } };
}

function cookieValue(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== "string") return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()).slice(0, 256); }
    catch { return ""; }
  }
  return "";
}

function cookieHeader(value, { secure = false, clear = false } = {}) {
  return `${COOKIE_NAME}=${clear ? "" : encodeURIComponent(value)}; Path=/api/google-drive/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${secure ? "; Secure" : ""}`;
}

async function readJsonBody(req, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new GoogleDriveError("invalid_request", "Request too large", { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new GoogleDriveError("invalid_request", "Expected a JSON request body", { status: 400 }); }
}

function sameOrigin(req, service) {
  if (!service.callbackOrigin || typeof req.headers?.origin !== "string") return false;
  try { return new URL(req.headers.origin).origin === service.callbackOrigin; }
  catch { return false; }
}

export function googleDriveApi(options = {}) {
  let service;
  let root;
  let publicDir;
  let buildDir;
  let guard;
  let syncWorker;
  let archiveManager;
  let admission;

  function installHandlers(server) {
    server.middlewares.use(guard);
    server.middlewares.use(admission);
    server.middlewares.use(handler);
    syncWorker?.start();
    if (typeof server.close === "function" && !workerCloseWrappedServers.has(server)) {
      const closeServer = server.close;
      server.close = async function closeAfterSyncDrain(...args) {
        await syncWorker?.stop();
        return closeServer.apply(this, args);
      };
      workerCloseWrappedServers.add(server);
    }
    server.httpServer?.once("close", () => { void syncWorker?.stop(); });
  }

  async function handler(req, res, next) {
    const url = new URL(req.url || "/", "http://localhost");
    if (!url.pathname.startsWith("/api/google-drive")) return next();
    const route = url.pathname;
    const method = req.method || "GET";
    try {
      if (route === "/api/google-drive/status") {
        if (method !== "GET") return json(res, 405, { error: { code: "method_not_allowed", message: "Metodo non consentito.", retryable: false } });
        const [authStatus, syncStatus, archiveStatus] = await Promise.all([service.getStatus(), syncWorker?.getSafeStatus() || {}, archiveManager?.status() || {}]);
        return json(res, 200, { ...authStatus, ...syncStatus, ...archiveStatus });
      }

      if (route === "/api/google-drive/archive/status") {
        if (method !== "GET") return json(res, 405, { error: { code: "method_not_allowed", message: "Metodo non consentito.", retryable: false } });
        return json(res, 200, await archiveManager.status());
      }

      const previewRoutes = new Map([
        ["/api/google-drive/archive/activation/preview", "activation"],
        ["/api/google-drive/archive/restore/preview", "restore"],
      ]);
      const choiceRoutes = new Map([
        ["/api/google-drive/archive/activation/choice", "activation"],
        ["/api/google-drive/archive/restore/confirm", "restore"],
      ]);
      if (previewRoutes.has(route) || choiceRoutes.has(route) || route === "/api/google-drive/archive/disable") {
        if (method !== "POST") return json(res, 405, { error: { code: "method_not_allowed", message: "Metodo non consentito.", retryable: false } });
        if (!service.callbackOrigin) {
          const status = await service.getStatus();
          throw new GoogleDriveError(status.error?.code || "configuration_incomplete");
        }
        if (!sameOrigin(req, service)) throw new GoogleDriveError("cross_origin_request", "Cross-origin request rejected", { status: 403 });
        const body = await readJsonBody(req);
        if (previewRoutes.has(route)) return json(res, 200, await archiveManager.preview(previewRoutes.get(route)));
        if (choiceRoutes.has(route)) return json(res, 202, await archiveManager.choose({ ...body, operation: choiceRoutes.get(route) }));
        return json(res, 200, await syncWorker.disable());
      }

      if (route === "/api/google-drive/oauth/callback") {
        if (method !== "GET") return json(res, 405, { error: { code: "method_not_allowed", message: "Metodo non consentito.", retryable: false } });
        let resultCode = "oauth_state_invalid";
        try {
          await service.handleOAuthCallback({
            state: url.searchParams.get("state"),
            code: url.searchParams.get("code"),
            error: url.searchParams.get("error"),
            nonce: cookieValue(req, COOKIE_NAME),
          });
          resultCode = "connected";
        } catch (error) { resultCode = safeError(error).error.code; }
        res.statusCode = 303;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Set-Cookie", cookieHeader("", { clear: true, secure: service.callbackUrl?.startsWith("https:") }));
        const destination = new URL("/", service.callbackOrigin || "http://localhost");
        destination.searchParams.set("googleDrive", resultCode);
        res.setHeader("Location", destination.toString());
        res.end();
        return;
      }

      if (!["/api/google-drive/oauth/start", "/api/google-drive/verify", "/api/google-drive/disconnect"].includes(route)) {
        return json(res, 404, { error: { code: "not_found", message: "Risorsa non trovata.", retryable: false } });
      }
      if (method !== "POST") return json(res, 405, { error: { code: "method_not_allowed", message: "Metodo non consentito.", retryable: false } });
      if (!service.callbackOrigin) {
        const status = await service.getStatus();
        const code = status.error?.code || (status.state === "configuration_invalid" ? "configuration_invalid" : "configuration_incomplete");
        throw new GoogleDriveError(code);
      }
      if (!sameOrigin(req, service)) throw new GoogleDriveError("cross_origin_request", "Cross-origin request rejected", { status: 403 });
      await readJsonBody(req);

      if (route === "/api/google-drive/oauth/start") {
        const started = await service.startOAuth();
        res.setHeader("Set-Cookie", cookieHeader(started.nonce, { secure: started.secure }));
        return json(res, 200, { authorizationUrl: started.authorizationUrl });
      }
      if (route === "/api/google-drive/verify") return json(res, 200, await service.verifyConnection());
      if (route === "/api/google-drive/disconnect") return json(res, 200, await service.disconnect());
    } catch (error) {
      const response = safeError(error);
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
      return json(res, status, response);
    }
    return next();
  }

  return {
    name: "wardrobe-google-drive-api",
    enforce: "pre",
    async configResolved(config) {
      root = path.resolve(config.root);
      publicDir = path.resolve(config.publicDir || path.join(root, "public"));
      buildDir = path.resolve(root, config.build.outDir || "dist");
      const env = options.env || process.env;
      const privateDir = path.join(path.resolve(root, typeof env?.WARDROBE_DATA_DIR === "string" && env.WARDROBE_DATA_DIR.trim() ? env.WARDROBE_DATA_DIR : "data"), ".google-drive");
      const dataDir = path.dirname(privateDir);
      const serving = config.command !== "build";
      let markWorkerReady;
      const workerReady = new Promise((resolve) => { markWorkerReady = resolve; });
      let recoveryWorker = null;
      let workerInitError = null;
      if (serving) setArchiveRecovery(dataDir, async () => {
        await workerReady;
        if (workerInitError) throw workerInitError;
        return recoverArchiveRestore({ dataDir, worker: recoveryWorker });
      });
      let privatePlacementInvalid;
      try {
        privatePlacementInvalid = await privatePathUnderStaticRoot(privateDir, publicDir, buildDir).catch(() => true);
        service = options.service || createGoogleDriveService({
          root,
          env,
          fetchImpl: options.fetchImpl,
          now: options.now,
          randomBytes: options.randomBytes,
          publicDir,
          buildOutDir: buildDir,
          privatePlacementInvalid,
        });
        if (service.privateDir !== privateDir) throw new Error("Injected Google Drive service uses a different private data root");
        syncWorker = options.syncWorker || getGoogleDriveSyncWorker({
          service,
          dataDir: path.dirname(service.privateDir),
          now: options.now,
        });
        recoveryWorker = syncWorker;
        markWorkerReady();
        if (serving) {
          await ensureArchiveRecovered(dataDir);
          await recoverArchiveRestore({ dataDir, worker: syncWorker, recoverOrphan: true });
        }
      } catch (error) {
        workerInitError = error;
        markWorkerReady();
        throw error;
      }
      guard = createPrivateFileGuard({ root, privateDir, publicDir, buildDir });
      if (config.command === "build") {
        if (privatePlacementInvalid) throw new Error("Google Drive private state cannot be stored under Vite publicDir or build.outDir");
        await auditPublicSymlinks(publicDir, privateDir);
      } else {
        archiveManager = createGoogleDriveArchiveManager({ dataDir, service, worker: syncWorker, now: options.now });
        admission = createArchiveAdmissionMiddleware(dataDir);
      }
    },
    configureServer(server) {
      installHandlers(server);
    },
    configurePreviewServer(server) {
      installHandlers(server);
    },
    // Server-side workers can share this exact instance so refresh, relink,
    // disconnect, and generation checks all use one lifecycle.
    getService() { return service || null; },
    // Feature 04 uses this internal server-only seam for preview/choice/restore.
    getSyncWorker() { return syncWorker || null; },
  };
}
