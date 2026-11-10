export const GOOGLE_DRIVE_OUTAGE_NOTICE = "Google Drive non è raggiungibile. Le modifiche restano salvate sul computer e verranno caricate su Drive appena torna la connessione.";

const SAFE_ERRORS = Object.freeze({
  configuration_incomplete: "Completa la configurazione Google Drive nel file .env e riavvia l’app.",
  configuration_invalid: "La configurazione Google Drive non è valida. Controlla le quattro variabili nel file .env.",
  private_state_invalid: "Non riesco a leggere le impostazioni Google Drive salvate su questo computer. I dati dell’archivio non sono stati toccati.",
  sync_state_invalid: "Lo stato di sincronizzazione Google Drive salvato su questo computer è illeggibile o danneggiato. I dati dell’archivio non sono stati toccati.",
  reconnect_required: "La sessione Google Drive è scaduta. Ricollega l’account.",
  target_changed: "L’account o la cartella Google Drive sono cambiati. Verifica di nuovo l’accesso.",
  google_unavailable: "Google Drive non è raggiungibile in questo momento.",
  google_permission_denied: "Questo account non può accedere alla cartella Google Drive configurata.",
  folder_access_denied: "La cartella configurata non è accessibile o non consente le operazioni richieste.",
  folder_read_denied: "Google Drive non ha completato la lettura della cartella, quindi non la considero vuota. Riprova.",
  folder_write_denied: "La cartella Google Drive non consente di aggiungere l’archivio.",
  incomplete_drive_listing: "Google Drive non ha completato l’elenco della cartella. Riprova la verifica.",
  archive_invalid: "La copia scelta è incompleta o danneggiata. I dati sul computer non sono stati toccati.",
  remote_unavailable: "La copia su Google Drive non è raggiungibile o è danneggiata.",
  snapshot_changed: "I dati sono cambiati nel frattempo. Riprova per vedere la situazione aggiornata.",
  sync_conflict: "La scelta è scaduta o i dati sono cambiati. Riprova per vedere la situazione aggiornata.",
  archive_maintenance: "L’archivio è occupato da un’altra operazione, per esempio una generazione ancora in corso. Riprova tra poco.",
  archive_control_invalid: "Il ripristino si è interrotto e richiede un recupero. Le modifiche restano sospese: vedi docs/google-drive-operations.md.",
  cross_origin_request: "La richiesta deve provenire da questa applicazione.",
  oauth_denied: "L’autorizzazione Google Drive è stata annullata.",
  oauth_scope_insufficient: "Google non ha concesso i permessi richiesti. Ricollega l’account e verifica i permessi.",
  account_mismatch: "L’account Google verificato non corrisponde alla connessione attiva.",
  persistence_failed: "Non è stato possibile salvare in modo sicuro la connessione Google Drive.",
});
const UNREACHABLE_ERRORS = new Set([
  "google_unavailable", "google_permission_denied", "folder_access_denied", "folder_read_denied",
  "incomplete_drive_listing", "reconnect_required", "target_changed", "stale_connection",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// After this long an action says it is slow and that Settings can be closed.
const SLOW_ACTION_MS = 12_000;
const TERMINAL_RESTORE_STAGES = new Set(["complete", "failed", "recovery_required"]);

function messageFor(error, fallback = "L’operazione Google Drive non è riuscita. Riprova.") {
  const code = typeof error?.code === "string" ? error.code : "";
  return SAFE_ERRORS[code] || fallback;
}

function targetIdentity(status) {
  if (!status || typeof status !== "object") return null;
  return JSON.stringify([
    status.targetFingerprint || null,
    status.connectionGeneration || null,
    status.account?.id || null,
    status.folder?.id || null,
    status.folder?.driveId || null,
  ]);
}

function presentStatus(raw, archive = null) {
  const source = isRecord(raw) ? raw : {};
  const archiveSource = isRecord(archive) ? archive : source;
  const error = source.error || source.lastAuthError || null;
  const syncError = source.syncError || null;
  return {
    configured: source.configured === true,
    state: typeof source.state === "string" ? source.state : "disconnected",
    connected: source.connected === true,
    reconnectRequired: source.reconnectRequired === true,
    account: source.account && typeof source.account === "object" ? {
      name: typeof source.account.name === "string" ? source.account.name : "",
      email: typeof source.account.email === "string" ? source.account.email : "",
    } : null,
    folder: source.folder && typeof source.folder === "object" ? {
      name: typeof source.folder.name === "string" ? source.folder.name : "",
      readable: source.folder.readable === true,
      writable: source.folder.writable === true,
    } : null,
    backupEnabled: source.backupEnabled === true,
    syncState: typeof source.syncState === "string" ? source.syncState : "disabled",
    syncCurrentFiles: Number.isFinite(source.syncCurrentFiles) ? source.syncCurrentFiles : 0,
    syncTotalFiles: Number.isFinite(source.syncTotalFiles) ? source.syncTotalFiles : 0,
    syncCurrentBytes: Number.isFinite(source.syncCurrentBytes) ? source.syncCurrentBytes : 0,
    syncTotalBytes: Number.isFinite(source.syncTotalBytes) ? source.syncTotalBytes : 0,
    pendingChanges: source.pendingChanges === true,
    syncPaused: source.syncPaused === true,
    syncError: syncError ? {
      message: messageFor(syncError, "La sincronizzazione è in attesa di essere ripresa."),
      retryable: syncError.retryable === true,
      unreachable: UNREACHABLE_ERRORS.has(syncError.code),
    } : null,
    retryAt: typeof source.retryAt === "string" ? source.retryAt : null,
    lastCompletedBackup: source.lastCompletedBackup && typeof source.lastCompletedBackup === "object" ? {
      completedAt: typeof source.lastCompletedBackup.completedAt === "string" ? source.lastCompletedBackup.completedAt : null,
      fileCount: Number.isFinite(source.lastCompletedBackup.fileCount) ? source.lastCompletedBackup.fileCount : 0,
      totalBytes: Number.isFinite(source.lastCompletedBackup.totalBytes) ? source.lastCompletedBackup.totalBytes : 0,
    } : null,
    maintenance: {
      active: archiveSource.maintenance?.active === true,
      activation: archiveSource.maintenance?.activation === true,
      error: archiveSource.maintenance?.error ? messageFor({ code: archiveSource.maintenance.error }) : null,
    },
    archiveGeneration: Number.isSafeInteger(archiveSource.archiveGeneration) ? archiveSource.archiveGeneration : null,
    connectionError: error ? messageFor(error, "La connessione Google Drive richiede attenzione.") : null,
  };
}

function presentPreview(raw) {
  return {
    operation: raw.operation === "restore" ? "restore" : "activation",
    decision: typeof raw.decision === "string" ? raw.decision : "unavailable",
    choices: Array.isArray(raw.choices) ? raw.choices.filter((choice) => ["use-local", "use-drive", "initialize", "equivalent", "cancel"].includes(choice)) : [],
    local: {
      valid: raw.local?.valid === true,
      populated: raw.local?.populated === true,
      files: Number.isFinite(raw.local?.files) ? raw.local.files : 0,
      bytes: Number.isFinite(raw.local?.bytes) ? raw.local.bytes : 0,
    },
    remote: {
      valid: raw.remote?.valid === true,
      empty: raw.remote?.empty === true,
      populated: raw.remote?.populated === true,
      files: Number.isFinite(raw.remote?.files) ? raw.remote.files : 0,
      bytes: Number.isFinite(raw.remote?.bytes) ? raw.remote.bytes : 0,
      error: raw.remote?.error ? messageFor({ code: raw.remote.error }) : null,
    },
  };
}

function operationPresentation(operation, activeOperationId) {
  if (!operation || !activeOperationId || operation.operationId !== activeOperationId) return null;
  const stage = ["running", "capturing", "fencing", "replacing", "sync_commit", "complete", "failed", "recovery_required"].includes(operation.stage)
    ? operation.stage : "running";
  return {
    stage,
    progress: Number.isFinite(operation.progress) ? Math.max(0, Math.min(100, operation.progress)) : null,
    startedAt: typeof operation.startedAt === "string" ? operation.startedAt : null,
    error: operation.error ? messageFor({ code: operation.error }) : null,
    active: !["complete", "failed", "recovery_required"].includes(stage),
  };
}

export function formatArchiveBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 byte";
  if (value < 1_000) return `${value} byte`;
  const units = ["kB", "MB", "GB", "TB"];
  let size = value / 1_000;
  let unit = 0;
  while (size >= 1_000 && unit < units.length - 1) { size /= 1_000; unit += 1; }
  return `${new Intl.NumberFormat("it-IT", { maximumFractionDigits: size >= 100 ? 0 : 1 }).format(size)} ${units[unit]}`;
}

export function formatBackupDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function createGoogleDriveStorageController({
  request = defaultRequest,
  navigate = (url) => globalThis.location?.assign?.(url),
  getWindow = () => typeof window === "undefined" ? null : window,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onArchiveChanged = () => {},
} = {}) {
  let snapshot = {
    status: null,
    statusError: null,
    actionError: null,
    busy: null,
    preview: null,
    restoreOperation: null,
    confirmation: null,
    slow: false,
    notice: null,
  };
  const subscribers = new Set();
  let started = false;
  let stopped = false;
  let timer = null;
  let pollPromise = null;
  let pollPromiseLifecycle = null;
  let pollQueued = false;
  let actionSequence = 0;
  let lifecycle = 0;
  let currentRawStatus = null;
  let targetKey = null;
  let currentPreview = null;
  let previewTargetKey = null;
  let activeOperationId = null;
  let trackedOperationTerminal = false;
  let lastReportedGeneration = null;
  let pendingGeneration = null;
  let lastCompletionNotice = null;
  let closeAfterCancel = null;
  let windowTarget = null;
  let focusListener = null;
  let visibilityListener = null;

  function publish(next) {
    snapshot = { ...snapshot, ...next };
    for (const listener of subscribers) listener();
  }

  function getSnapshot() { return snapshot; }
  function subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); }

  async function send(path, options) {
    const response = await request(path, options);
    if (response && response.ok === false) {
      const body = await response.json().catch(() => null);
      throw body?.error || { code: "google_unavailable" };
    }
    return response;
  }

  async function readStatus() {
    const response = await send("/api/google-drive/status", { cache: "no-store" });
    const raw = await response.json();
    if (!isRecord(raw)) throw { code: "google_unavailable" };
    return raw;
  }

  async function readArchiveStatus() {
    const response = await send("/api/google-drive/archive/status", { cache: "no-store" });
    const raw = await response.json();
    return isRecord(raw) ? raw : null;
  }

  async function cancelServerPreview(preview, operation = preview?.operation) {
    if (!preview?.actionToken || !["activation", "restore"].includes(operation)) return false;
    const route = operation === "restore" ? "/api/google-drive/archive/restore/confirm" : "/api/google-drive/archive/activation/choice";
    await send(route, { method: "POST", body: JSON.stringify({ actionToken: preview.actionToken, choice: "cancel" }) });
    return true;
  }

  function clearPreview(next = {}) {
    currentPreview = null;
    previewTargetKey = null;
    publish({ preview: null, confirmation: null, ...next });
  }

  async function poll() {
    if (stopped) return;
    if (snapshot.busy) return;
    if (pollPromise) {
      if (pollPromiseLifecycle !== lifecycle) {
        pollQueued = true;
        const pending = pollPromise;
        return pending.then(() => {
          if (!pollQueued || stopped || snapshot.busy) return;
          pollQueued = false;
          return poll();
        });
      }
      return pollPromise;
    }
    pollQueued = false;
    const requestLifecycle = lifecycle;
    const read = (async () => {
      const [statusResult, archiveResult] = await Promise.allSettled([readStatus(), readArchiveStatus()]);
      if (stopped || requestLifecycle !== lifecycle || snapshot.busy) return;
      const archive = archiveResult.status === "fulfilled" ? archiveResult.value : null;
      if (statusResult.status === "fulfilled") {
        const raw = statusResult.value;
        const nextTarget = targetIdentity(raw);
        const targetChanged = targetKey !== null && nextTarget !== null && nextTarget !== targetKey;
        currentRawStatus = raw;
        targetKey = nextTarget;
        const serverOperation = archive?.restore || raw.restore;
        if (serverOperation?.operationId) {
          const serverOperationIsTerminal = TERMINAL_RESTORE_STAGES.has(serverOperation.stage);
          if (!activeOperationId || (serverOperation.operationId !== activeOperationId && trackedOperationTerminal)) {
            activeOperationId = serverOperation.operationId;
            trackedOperationTerminal = serverOperationIsTerminal;
          }
        }
        const visibleRestore = operationPresentation(serverOperation, activeOperationId);
        if (visibleRestore && TERMINAL_RESTORE_STAGES.has(visibleRestore.stage)) trackedOperationTerminal = true;
        const safe = presentStatus(raw, archive || raw);
        publish({ status: safe, statusError: null, ...(visibleRestore ? { restoreOperation: visibleRestore } : {}) });
        if (Number.isSafeInteger(safe.archiveGeneration)) {
          if (lastReportedGeneration !== null && lastReportedGeneration !== safe.archiveGeneration) pendingGeneration = safe.archiveGeneration;
          lastReportedGeneration = safe.archiveGeneration;
        }
        const previewChanged = targetChanged && currentPreview && previewTargetKey !== nextTarget;
        if (previewChanged) {
          const owned = currentPreview;
          clearPreview({ actionError: SAFE_ERRORS.target_changed });
          void cancelServerPreview(owned).catch(() => {});
        }
        const terminalRestore = !visibleRestore || ["complete", "failed", "recovery_required"].includes(visibleRestore.stage);
        const canRefreshArchive = !safe.maintenance.active && terminalRestore;
        const completionKey = visibleRestore?.stage === "complete" ? `${activeOperationId}:${safe.archiveGeneration}` : null;
        if (canRefreshArchive && pendingGeneration !== null) {
          onArchiveChanged({ archiveGeneration: pendingGeneration });
          pendingGeneration = null;
          if (completionKey) lastCompletionNotice = completionKey;
        } else if (canRefreshArchive && completionKey && completionKey !== lastCompletionNotice) {
          onArchiveChanged({ archiveGeneration: safe.archiveGeneration });
          lastCompletionNotice = completionKey;
        }
        return;
      }
      if (archive) {
        const prior = snapshot.status;
        const archiveOnly = presentStatus(currentRawStatus || {}, archive);
        publish({ status: prior ? { ...prior, maintenance: archiveOnly.maintenance, archiveGeneration: archiveOnly.archiveGeneration } : null });
        const visibleRestore = operationPresentation(archive.restore, activeOperationId);
        if (visibleRestore) publish({ restoreOperation: visibleRestore });
      }
      publish({ statusError: "Impossibile aggiornare lo stato Google Drive. L’ultimo stato confermato resta valido." });
    })();
    let trackedRead;
    trackedRead = read.finally(() => {
      if (pollPromise === trackedRead) {
        pollPromise = null;
        pollPromiseLifecycle = null;
      }
    });
    pollPromise = trackedRead;
    pollPromiseLifecycle = requestLifecycle;
    return trackedRead;
  }

  function scheduleNextPoll() {
    if (!started || stopped) return;
    if (timer !== null) clearTimeoutFn(timer);
    const delay = snapshot.restoreOperation?.active || snapshot.status?.maintenance.active ? 1_500 : 12_000;
    timer = setTimeoutFn(async () => {
      await poll();
      scheduleNextPoll();
    }, delay);
  }

  function onFocus() {
    if (windowTarget?.document?.visibilityState === "hidden") return;
    void poll().finally(scheduleNextPoll);
  }

  function start() {
    if (started) return pollPromise || Promise.resolve();
    started = true;
    stopped = false;
    windowTarget = getWindow();
    focusListener = onFocus;
    visibilityListener = onFocus;
    windowTarget?.addEventListener?.("focus", focusListener);
    windowTarget?.document?.addEventListener?.("visibilitychange", visibilityListener);
    const initial = poll();
    void initial.finally(scheduleNextPoll);
    return initial;
  }

  async function runAction(name, work, { refresh = true } = {}) {
    if (snapshot.busy) return false;
    const actionId = ++actionSequence;
    lifecycle += 1;
    publish({ busy: name, slow: false, actionError: null, notice: null });
    const slowTimer = setTimeoutFn(() => { if (isCurrentAction(actionId)) publish({ slow: true }); }, SLOW_ACTION_MS);
    try {
      const result = await work(actionId);
      if (actionId !== actionSequence || stopped) return false;
      return result;
    } catch (error) {
      if (actionId === actionSequence && !stopped) publish({ actionError: messageFor(error) });
      return false;
    } finally {
      clearTimeoutFn(slowTimer);
      if (actionId === actionSequence && !stopped) {
        publish({ busy: null, slow: false });
        if (refresh) void poll().finally(scheduleNextPoll);
      }
    }
  }

  function isCurrentAction(actionId) { return actionId === actionSequence && !stopped; }

  async function clearPriorPreview() {
    if (!currentPreview) return true;
    const owned = currentPreview;
    try {
      await cancelServerPreview(owned);
      clearPreview();
      return true;
    } catch (error) {
      publish({ actionError: messageFor(error, "Non è stato possibile annullare l’anteprima. Riprova prima di proseguire.") });
      return false;
    }
  }

  async function openPreview(operation) {
    return runAction(operation === "restore" ? "restore-preview" : "activation-preview", async (actionId) => {
      if (!(await clearPriorPreview())) return false;
      if (!isCurrentAction(actionId)) return false;
      const raw = currentRawStatus;
      if (!raw?.connected || raw?.reconnectRequired || raw?.folder?.readable !== true || raw?.folder?.writable !== true) {
        publish({ actionError: raw?.error ? messageFor(raw.error) : "Collega e verifica l’account e la cartella Google Drive prima di continuare." });
        return false;
      }
      const route = operation === "restore" ? "/api/google-drive/archive/restore/preview" : "/api/google-drive/archive/activation/preview";
      const response = await send(route, { method: "POST", body: JSON.stringify({}) });
      const preview = await response.json();
      if (typeof preview.actionToken !== "string") throw { code: "google_unavailable" };
      if (!isCurrentAction(actionId)) {
        await cancelServerPreview({ actionToken: preview.actionToken, operation }).catch(() => {});
        return false;
      }
      const currentTarget = targetIdentity(currentRawStatus);
      currentPreview = { actionToken: preview.actionToken, operation };
      previewTargetKey = currentTarget;
      publish({ preview: presentPreview({ ...preview, operation }), confirmation: null, actionError: null });
      return true;
    });
  }

  async function choose(choice) {
    return runAction("choice", async (actionId) => {
      const owned = currentPreview;
      if (!owned || !snapshot.preview?.choices.includes(choice)) return false;
      if (choice === "cancel") {
        await cancelServerPreview(owned);
        if (!isCurrentAction(actionId)) { currentPreview = null; previewTargetKey = null; return false; }
        clearPreview();
        return true;
      }
      if (previewTargetKey !== targetIdentity(currentRawStatus)) {
        try { await cancelServerPreview(owned); } catch {}
        clearPreview({ actionError: SAFE_ERRORS.target_changed });
        return false;
      }
      const route = owned.operation === "restore" ? "/api/google-drive/archive/restore/confirm" : "/api/google-drive/archive/activation/choice";
      let response;
      try {
        response = await send(route, { method: "POST", body: JSON.stringify({ actionToken: owned.actionToken, choice }) });
      } catch (error) {
        // The server consumed the preview for all of these, so it cannot be retried.
        if (["sync_conflict", "snapshot_changed", "target_changed", "archive_invalid", "archive_maintenance"].includes(error?.code)) {
          try { await cancelServerPreview(owned); } catch {}
          clearPreview({ actionError: messageFor(error) });
        }
        throw error;
      }
      const result = await response.json();
      if (!isCurrentAction(actionId)) { currentPreview = null; previewTargetKey = null; return false; }
      currentPreview = null;
      previewTargetKey = null;
      if (result.status === "running" && typeof result.operationId === "string") {
        activeOperationId = result.operationId;
        trackedOperationTerminal = false;
        publish({ preview: null, confirmation: null, actionError: null, restoreOperation: { stage: "running", progress: 0, startedAt: null, error: null, active: true } });
      } else {
        publish({ preview: null, confirmation: null, actionError: null, restoreOperation: null, notice: result.status === "complete" ? "activated" : null });
      }
      return true;
    });
  }

  async function startOAuth() {
    return runAction("connect", async (actionId) => {
      if (!(await clearPriorPreview())) return false;
      if (!isCurrentAction(actionId)) return false;
      const response = await send("/api/google-drive/oauth/start", { method: "POST", body: JSON.stringify({}) });
      const { authorizationUrl } = await response.json();
      if (!isCurrentAction(actionId)) return false;
      let parsed;
      try { parsed = new URL(authorizationUrl); } catch { throw { code: "google_unavailable" }; }
      if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com" || parsed.username || parsed.password) throw { code: "google_unavailable" };
      navigate(parsed.toString());
      return true;
    }, { refresh: false });
  }

  async function verify() {
    return runAction("verify", async (actionId) => {
      if (!(await clearPriorPreview())) return false;
      if (!isCurrentAction(actionId)) return false;
      await send("/api/google-drive/verify", { method: "POST", body: JSON.stringify({}) });
      return true;
    });
  }

  async function disable() {
    return runAction("disable", async (actionId) => {
      if (!(await clearPriorPreview())) return false;
      if (!isCurrentAction(actionId)) return false;
      await send("/api/google-drive/archive/disable", { method: "POST", body: JSON.stringify({}) });
      return true;
    });
  }

  async function disconnect({ disableFirst = false } = {}) {
    return runAction("disconnect", async (actionId) => {
      if (snapshot.status?.backupEnabled && !disableFirst) {
        publish({ actionError: "Disattiva prima la sincronizzazione. Le copie locale e Google Drive resteranno disponibili." });
        return false;
      }
      if (!(await clearPriorPreview())) return false;
      if (!isCurrentAction(actionId)) return false;
      if (snapshot.status?.backupEnabled && disableFirst) {
        await send("/api/google-drive/archive/disable", { method: "POST", body: JSON.stringify({}) });
        if (!isCurrentAction(actionId)) return false;
      }
      await send("/api/google-drive/disconnect", { method: "POST", body: JSON.stringify({}) });
      return true;
    });
  }

  /**
   * Stops waiting for the running action without undoing it. The request
   * keeps going on the server and its outcome arrives through polling; a
   * preview that is still being prepared is cancelled when it arrives.
   */
  function abandonAction() {
    const choosing = snapshot.busy === "choice";
    actionSequence += 1;
    lifecycle += 1;
    if (choosing) { currentPreview = null; previewTargetKey = null; }
    publish({ busy: null, slow: false, ...(choosing ? { preview: null, confirmation: null } : {}) });
    void poll().finally(scheduleNextPoll);
  }

  // Settings can always be closed: only a preview cancellation is waited for,
  // because closing is what asked for it.
  async function requestClose() {
    if (snapshot.busy === "cancel-preview") return closeAfterCancel || false;
    if (snapshot.busy) { abandonAction(); return true; }
    if (!currentPreview) return true;
    if (closeAfterCancel) return false;
    publish({ busy: "cancel-preview", actionError: null });
    closeAfterCancel = cancelServerPreview(currentPreview).then(() => {
      clearPreview({ busy: null });
      closeAfterCancel = null;
      return true;
    }).catch((error) => {
      closeAfterCancel = null;
      publish({ busy: null, actionError: messageFor(error, "Non è stato possibile annullare l’anteprima. Riprova prima di chiudere.") });
      return false;
    });
    return closeAfterCancel;
  }

  function confirmAction(name) { publish({ confirmation: name, notice: null }); }
  function clearConfirmation() { publish({ confirmation: null }); }
  function clearNotice() { publish({ notice: null }); }

  function stop() {
    stopped = true;
    lifecycle += 1;
    actionSequence += 1;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    windowTarget?.removeEventListener?.("focus", focusListener);
    windowTarget?.document?.removeEventListener?.("visibilitychange", visibilityListener);
    started = false;
    const owned = currentPreview;
    currentPreview = null;
    if (owned) void cancelServerPreview(owned).catch(() => {});
  }

  return Object.freeze({
    getSnapshot, subscribe, start, stop, poll, openPreview, choose, startOAuth, verify, disable, disconnect,
    requestClose, confirmAction, clearConfirmation, clearNotice,
  });
}

async function defaultRequest(url, options = {}) {
  const method = options.method || "GET";
  const init = { method, cache: "no-store", ...options };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json", ...options.headers };
    if (typeof init.body !== "string") init.body = JSON.stringify({});
  }
  return fetch(url, init);
}
