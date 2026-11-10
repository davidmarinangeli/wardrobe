import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowClockwise, CloudArrowDown, CloudArrowUp, Folder, HardDrive, LinkSimple, SignOut, SpinnerGap, User, X } from "@phosphor-icons/react";
import { createGoogleDriveStorageController, formatArchiveBytes, formatBackupDate, GOOGLE_DRIVE_OUTAGE_NOTICE } from "./google-drive-storage.js";
import "./google-drive-storage.css";

const STAGE_COPY = {
  running: "In attesa di iniziare…",
  capturing: "Preparo e controllo le copie…",
  fencing: "Sospendo le modifiche…",
  replacing: "Sostituisco i dati sul computer…",
  sync_commit: "Controllo finale…",
  complete: "Ripristino completato.",
  failed: "Ripristino non riuscito. I dati sul computer sono rimasti com’erano.",
  recovery_required: "Il ripristino si è interrotto e richiede un recupero prima di riprendere le modifiche.",
};

const SLOW_COPY = "Sta impiegando più del previsto. Puoi chiudere Settings: l’operazione continua in background.";
const SLOW_PREVIEW_COPY = "Il controllo delle copie sta impiegando più del previsto. Puoi chiudere Settings e riprovare più tardi.";

function formatCount(value) {
  return new Intl.NumberFormat("it-IT").format(Number.isFinite(value) ? value : 0);
}

function sizeOf(archive, { remote = false } = {}) {
  if (!archive.valid) return remote ? "non leggibile" : "danneggiato";
  if (!archive.populated) return "vuoto";
  return `${formatCount(archive.files)} file, ${formatArchiveBytes(archive.bytes)}`;
}

/**
 * What a preview asks of the person. The friction follows the risk: copying
 * into an empty place is one click, replacing data names what gets replaced
 * on the button itself, and choosing between two different copies is an
 * explicit pick before that button unlocks.
 */
function previewPlan(preview) {
  const can = (choice) => preview.choices.includes(choice);
  const activate = (choice, label) => ({ choice, label, busyLabel: "Attivazione…", working: "Controllo che i dati non siano cambiati e attivo il backup…" });
  const replaceLocal = (label, danger) => ({ choice: "use-drive", label, busyLabel: "Avvio…", danger, working: "Preparo la sostituzione dei dati sul computer…" });

  if (preview.decision === "unavailable" || !preview.remote.valid) {
    return {
      title: preview.operation === "restore" ? "Non c’è una copia da ripristinare" : "Non riesco a leggere Google Drive",
      body: preview.remote.error || (preview.operation === "restore"
        ? "Su Google Drive non c’è ancora una copia valida da ripristinare."
        : "La cartella non ha risposto in modo completo, quindi non la considero vuota. Controlla la connessione e riprova."),
      alert: true,
    };
  }

  if (preview.operation === "restore") {
    const localFull = preview.local.valid && preview.local.populated;
    return {
      title: "Ripristina da Google Drive",
      body: !preview.local.valid
        ? "L’archivio sul computer è danneggiato e verrà sostituito per intero dalla copia su Drive."
        : localFull
          ? "Tutti i dati sul computer (guardaroba, outfit, foto, preferenze e cronologia) verranno sostituiti dalla copia su Drive. Quello che c’è solo sul computer andrà perso."
          : "Il computer non ha ancora dati: verrà copiato qui l’archivio su Drive.",
      note: "Il backup resta come l’hai impostato. Se qualcosa va storto, i dati attuali restano al loro posto.",
      action: can("use-drive") ? { ...replaceLocal(localFull || !preview.local.valid ? "Sostituisci i dati sul computer" : "Ripristina da Drive", localFull || !preview.local.valid), busyLabel: "Avvio del ripristino…" } : null,
    };
  }

  switch (preview.decision) {
    case "local_to_empty":
      return { title: "Google Drive è vuoto", body: "Il tuo archivio verrà caricato su Drive e da lì in poi tenuto aggiornato.", action: can("use-local") && activate("use-local", "Carica su Drive e attiva") };
    case "initialize":
      return { title: "Non c’è ancora niente da copiare", body: "Il computer e Drive sono entrambi vuoti. Il backup partirà con i primi capi che aggiungi.", action: can("initialize") && activate("initialize", "Attiva backup") };
    case "equivalent":
      return { title: "Su Drive c’è già la stessa copia", body: "Il computer e Drive contengono gli stessi dati: non serve caricare nulla.", action: can("equivalent") && activate("equivalent", "Attiva backup") };
    case "drive_to_empty":
      return { title: "Su Drive c’è già un archivio", body: "Il computer non ha ancora dati. L’archivio su Drive verrà copiato qui e il backup resterà attivo.", action: can("use-drive") && replaceLocal("Copia da Drive e attiva", false) };
    case "different":
      return {
        title: "Le due copie sono diverse",
        body: "Scegli quale tenere. L’altra verrà sostituita per intero e quello che c’è solo lì andrà perso.",
        options: [
          can("use-local") && { title: "Tieni la copia del computer", detail: "I dati su Drive vengono sostituiti.", action: { ...activate("use-local", "Sostituisci i dati su Drive"), danger: true } },
          can("use-drive") && { title: "Tieni la copia su Drive", detail: "I dati sul computer vengono sostituiti.", action: replaceLocal("Sostituisci i dati sul computer", true) },
        ].filter(Boolean),
      };
    case "local_invalid":
      return can("use-drive")
        ? { title: "L’archivio sul computer è danneggiato", body: "Puoi sostituirlo con la copia su Drive. Se qualcosa va storto, i file attuali restano al loro posto.", action: replaceLocal("Sostituisci con la copia su Drive", true) }
        : { title: "L’archivio sul computer è danneggiato", body: "Su Drive non c’è una copia da usare per ripararlo.", alert: true };
    default:
      return { title: "Non riesco a leggere Google Drive", body: "Controlla la connessione e riprova.", alert: true };
  }
}

function PreviewContent({ preview, busy, slow, onChoose }) {
  const [picked, setPicked] = useState(null);
  const [pendingChoice, setPendingChoice] = useState(null);
  const sectionRef = useRef(null);
  const titleRef = useRef(null);
  useEffect(() => {
    setPicked(null);
    setPendingChoice(null);
    if (!preview) return undefined;
    const frame = requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ block: "start" });
      titleRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [preview]);
  if (!preview) return null;

  const plan = previewPlan(preview);
  const option = plan.options?.find((candidate) => candidate.action.choice === picked);
  // Until a copy is picked the button names no consequence: it has none yet.
  const action = plan.options ? option?.action || { label: "Scegli una copia", unpicked: true } : plan.action;
  const choosing = busy === "choice";
  const cancelling = choosing && pendingChoice === "cancel";
  const confirming = choosing && !cancelling;
  const choose = (choice) => { setPendingChoice(choice); void onChoose(choice); };

  return (
    <section ref={sectionRef} className="drive-preview" aria-labelledby="drive-preview-title" aria-busy={choosing}>
      <h3 id="drive-preview-title" ref={titleRef} tabIndex={-1}>{plan.title}</h3>
      <dl className="drive-preview__counts">
        <div><dt>Sul computer</dt><dd>{sizeOf(preview.local)}</dd></div>
        <div><dt>Su Google Drive</dt><dd>{sizeOf(preview.remote, { remote: true })}</dd></div>
      </dl>
      <p className={plan.alert ? "drive-alert" : "drive-preview__body"} role={plan.alert ? "alert" : undefined}>{plan.body}</p>
      {plan.note && <p className="drive-hint">{plan.note}</p>}
      {plan.options && (
        <div className="drive-preview__options" role="radiogroup" aria-label="Quale copia tenere">
          {plan.options.map((candidate) => (
            <label key={candidate.action.choice} className={picked === candidate.action.choice ? "is-picked" : ""}>
              <input type="radio" name="drive-keep" checked={picked === candidate.action.choice} disabled={Boolean(busy)} onChange={() => setPicked(candidate.action.choice)} />
              <span><strong>{candidate.title}</strong><small>{candidate.detail}</small></span>
            </label>
          ))}
        </div>
      )}
      <div className="drive-preview__choices">
        {!confirming && (
          <button className="secondary-button" type="button" disabled={Boolean(busy)} aria-busy={cancelling} onClick={() => choose("cancel")}>
            {cancelling && <SpinnerGap size={15} className="drive-spinner" aria-hidden="true" />}
            {cancelling ? "Annullo…" : action ? "Annulla" : "Chiudi"}
          </button>
        )}
        {action && !cancelling && (
          <button
            className={`primary-button${action.danger ? " is-danger" : ""}`}
            type="button"
            disabled={Boolean(busy) || action.unpicked}
            aria-busy={confirming}
            onClick={() => choose(action.choice)}
          >
            {confirming && <SpinnerGap size={15} className="drive-spinner" aria-hidden="true" />}
            {confirming ? action.busyLabel : action.label}
          </button>
        )}
      </div>
      {confirming && <p className="drive-working" role="status">{slow ? SLOW_COPY : action.working}</p>}
    </section>
  );
}

/**
 * The Drive controller outlives the settings modal: it keeps polling so the
 * offline notice and the archive-maintenance lock work while the modal is
 * closed. The modal only borrows it to render the Archive tab.
 */
export function useGoogleDriveStorage({ onArchiveChanged, onMaintenanceChange }) {
  const callbackRef = useRef(onArchiveChanged);
  callbackRef.current = onArchiveChanged;
  const controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createGoogleDriveStorageController({ onArchiveChanged: (info) => callbackRef.current?.(info) });
  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const status = snapshot.status;

  useEffect(() => {
    void controller.start();
    return () => controller.stop();
  }, [controller]);

  useEffect(() => {
    onMaintenanceChange?.(Boolean(status?.maintenance.active), status?.maintenance.error || null);
  }, [status?.maintenance.active, status?.maintenance.error, onMaintenanceChange]);

  return { controller, snapshot };
}

export function GoogleDriveOfflineNotice({ status }) {
  const offline = Boolean(status?.backupEnabled && (!status.connected || status.syncError?.unreachable));
  const [dismissed, setDismissed] = useState(false);
  // A new outage shows the notice again.
  useEffect(() => { if (!offline) setDismissed(false); }, [offline]);
  if (!offline || dismissed) return null;
  return (
    <div className="drive-offline-notice" role="status" lang="it">
      <p>{GOOGLE_DRIVE_OUTAGE_NOTICE}</p>
      <button type="button" aria-label="Chiudi avviso" onClick={() => setDismissed(true)}><X size={14} weight="bold" /></button>
    </div>
  );
}

function backupState(status) {
  if (!status?.backupEnabled) return { tone: "off", label: "Disattivato", detail: "L’archivio è solo su questo computer." };
  if (status.syncState === "syncing") return { tone: "busy", label: "Upload su Drive in corso", detail: null };
  if (status.syncPaused) return { tone: "warn", label: "In pausa", detail: "Le modifiche restano sul computer finché il backup non riprende." };
  if (status.syncError) return { tone: "warn", label: "In attesa", detail: null };
  return { tone: "on", label: "Attivo", detail: "Ogni modifica viene caricata su Drive." };
}

// `open` is true while the Archive tab is on screen, so the focus moves below
// only happen when someone can see where focus went.
export function ArchiveSettings({ controller, snapshot, open }) {
  const backupHeadingRef = useRef(null);
  const operationSectionRef = useRef(null);
  const operationHeadingRef = useRef(null);
  const hadPreviewRef = useRef(false);
  const restoreWasActiveRef = useRef(null);
  const wasOpenRef = useRef(false);
  const status = snapshot.status;
  const restore = snapshot.restoreOperation;
  const busy = snapshot.busy;
  const blocked = Boolean(busy || status?.maintenance.active || restore?.active || restore?.stage === "recovery_required");
  const folderReady = Boolean(status?.folder?.readable && status?.folder?.writable);
  const hasVerifiedFolder = Boolean(status?.connected && !status.reconnectRequired && folderReady);
  const accountLocked = Boolean(busy || status?.maintenance.active || restore?.active || snapshot.preview);
  const needsVerify = Boolean(status?.connected && !status.reconnectRequired && (!folderReady || status.connectionError || status.syncError?.unreachable));
  // Maintenance with no restore of ours to show: an activation, or work
  // started from another tab. Say so instead of leaving every control grey.
  const otherOperation = Boolean(status?.maintenance.active && !restore?.active && restore?.stage !== "complete");
  const backup = backupState(status);
  const syncing = Boolean(status?.backupEnabled && (status.syncState === "syncing" || status.syncCurrentFiles < status.syncTotalFiles));

  useEffect(() => {
    const hadPreview = hadPreviewRef.current;
    const wasRestoreActive = restoreWasActiveRef.current;
    const wasOpen = wasOpenRef.current;
    const currentRestore = snapshot.restoreOperation;
    const isRestoreActive = Boolean(currentRestore?.active);
    hadPreviewRef.current = Boolean(snapshot.preview);
    restoreWasActiveRef.current = currentRestore ? isRestoreActive : null;
    wasOpenRef.current = open;
    if (!open) return undefined;
    const previewResolved = hadPreview && !snapshot.preview;
    const restoreStarted = isRestoreActive && wasRestoreActive !== true;
    const restoreFinished = Boolean(currentRestore && !isRestoreActive && wasRestoreActive === true);
    const reopenedWithOperation = !wasOpen && Boolean(currentRestore);
    const showOperation = restoreStarted || restoreFinished || reopenedWithOperation;
    if (!showOperation && !previewResolved) return undefined;
    const frame = requestAnimationFrame(() => {
      if (showOperation) {
        operationSectionRef.current?.scrollIntoView({ block: "start" });
        operationHeadingRef.current?.focus({ preventScroll: true });
      } else {
        backupHeadingRef.current?.scrollIntoView({ block: "nearest" });
        backupHeadingRef.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, snapshot.preview, snapshot.restoreOperation?.active, snapshot.restoreOperation?.stage]);

  useEffect(() => {
    if (open) void controller.poll();
  }, [open, controller]);

  const confirmDisable = async () => {
    const completed = await controller.disable();
    if (completed) controller.clearConfirmation();
  };

  const confirmDisconnect = async () => {
    const completed = await controller.disconnect({ disableFirst: status?.backupEnabled === true });
    if (completed) controller.clearConfirmation();
  };

  const spinner = <SpinnerGap size={15} className="drive-spinner" aria-hidden="true" />;

  return (
    <div className="drive-settings" lang="it">
      <header className="drive-settings__intro">
        <h2>Il tuo archivio</h2>
        <p>Wardrobe salva tutto su questo computer. Con il backup attivo, Google Drive ne tiene una copia completa e aggiornata.</p>
        <p>Puoi aprire Wardrobe da più browser e vedrai sempre gli stessi dati. Un’altra installazione di Wardrobe ha invece un archivio separato, che non si sincronizza con questo.</p>
      </header>

      {snapshot.statusError && <p className="drive-alert" role="status">{snapshot.statusError}</p>}
      {snapshot.actionError && <p className="drive-alert" role="alert">{snapshot.actionError}</p>}
      {status?.connectionError && <p className="drive-alert" role="status">{status.connectionError}</p>}
      {status?.maintenance.error && <p className="drive-alert" role="alert">{status.maintenance.error}</p>}
      {snapshot.slow && busy !== "choice" && (
        <p className="drive-working" role="status">{busy === "activation-preview" || busy === "restore-preview" ? SLOW_PREVIEW_COPY : SLOW_COPY}</p>
      )}

      {otherOperation && (
        <section className="drive-operation" aria-labelledby="drive-other-operation-heading" aria-live="polite">
          <div className="drive-section-heading"><h3 id="drive-other-operation-heading">Operazione in corso</h3>{spinner}</div>
          <p>{status.maintenance.activation
            ? "Sto attivando il backup su Google Drive. Le modifiche al guardaroba riprendono appena finisce."
            : "È in corso un’operazione sull’archivio, per esempio avviata da un altro tab. Le modifiche al guardaroba riprendono appena finisce."}</p>
        </section>
      )}

      {restore && (
        <section ref={operationSectionRef} className={`drive-operation${restore.stage === "recovery_required" ? " is-error" : ""}`} aria-labelledby="drive-operation-heading" aria-live="polite" aria-atomic="true">
          <div className="drive-section-heading">
            <h3 id="drive-operation-heading" ref={operationHeadingRef} tabIndex={-1}>
              {restore.active ? "Ripristino in corso" : restore.stage === "complete" ? "Ripristino completato" : "Ripristino non riuscito"}
            </h3>
            {restore.active && spinner}
          </div>
          <p role={restore.stage === "failed" || restore.stage === "recovery_required" ? "alert" : "status"}>
            {status?.maintenance.active && restore.stage === "running" ? "In attesa che finiscano le modifiche già avviate…" : STAGE_COPY[restore.stage] || STAGE_COPY.running}
          </p>
          {restore.progress !== null && restore.stage !== "running" && <progress max="100" value={restore.progress} aria-label="Avanzamento del ripristino" />}
          {restore.active && <p>Puoi chiudere Settings: il ripristino continua in background.</p>}
          {restore.stage === "complete" && status?.maintenance.active && <p>Ultimi controlli in corso: il guardaroba torna disponibile tra poco.</p>}
          {restore.error && <p className="drive-alert" role="alert">{restore.error}</p>}
        </section>
      )}

      <section className="drive-account" aria-labelledby="drive-account-heading">
        <div className="drive-account__title">
          <img src="/google-drive.svg" alt="" width="24" height="24" />
          <h3 id="drive-account-heading">Account Google Drive</h3>
        </div>
        {status?.account ? (
          <div className="drive-account__card">
            <dl className="drive-account__details">
              <div>
                <dt><User size={16} aria-hidden="true" /><span className="sr-only">Account</span></dt>
                <dd>
                  {status.account.name || status.account.email || "Account collegato"}
                  {status.account.name && status.account.email && <span className="drive-account__email"> — {status.account.email}</span>}
                </dd>
              </div>
              <div>
                <dt><Folder size={16} aria-hidden="true" /><span className="sr-only">Cartella</span></dt>
                <dd>{status.folder?.name ? `/${status.folder.name}` : "Non disponibile"}</dd>
              </div>
              <div>
                <dt>
                  <span className={`drive-dot${status.reconnectRequired || (status.connected && !folderReady) ? " is-warn" : status.connected ? " is-ok" : ""}`} aria-hidden="true" />
                  <span className="sr-only">Stato</span>
                </dt>
                <dd>{status.reconnectRequired ? "Da ricollegare" : status.connected ? (folderReady ? "Collegato" : "Cartella non accessibile") : "Non collegato"}</dd>
              </div>
            </dl>
            <button className="delete-button drive-disconnect" type="button" disabled={accountLocked} onClick={() => controller.confirmAction("disconnect")}>
              <SignOut size={15} aria-hidden="true" />
              Scollega account
            </button>
          </div>
        ) : <p className="drive-hint">Nessun account collegato.</p>}
        {(status && (!status.connected || status.reconnectRequired) || needsVerify) && <div className="drive-actions">
          {status && (!status.connected || status.reconnectRequired) && (
            <button className="primary-button" type="button" disabled={accountLocked} aria-busy={busy === "connect"} onClick={() => void controller.startOAuth()}>
              {busy === "connect" ? spinner : <LinkSimple size={15} aria-hidden="true" />}
              {status?.reconnectRequired ? "Ricollega account" : "Collega account"}
            </button>
          )}
          {needsVerify && (
            <button className="secondary-button" type="button" disabled={accountLocked} aria-busy={busy === "verify"} onClick={() => void controller.verify()}>
              {busy === "verify" ? spinner : <ArrowClockwise size={15} aria-hidden="true" />}
              {busy === "verify" ? "Verifica…" : "Verifica accesso"}
            </button>
          )}
        </div>}
        {snapshot.confirmation === "disconnect" && (
          <div className="drive-confirm" role="group" aria-labelledby="drive-disconnect-title">
            <strong id="drive-disconnect-title">{status?.backupEnabled ? "Disattivare il backup e scollegare l’account?" : "Scollegare questo account?"}</strong>
            <p>{status?.backupEnabled
              ? "Il backup si ferma e le modifiche non ancora caricate restano solo sul computer. Le copie già esistenti, sul computer e su Drive, restano dove sono."
              : "Wardrobe dimentica l’accesso a questo account. La copia su Drive non viene cancellata; per revocare del tutto l’accesso usa le impostazioni del tuo account Google."}</p>
            <div className="drive-preview__choices">
              {busy !== "disconnect" && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => controller.clearConfirmation()}>Annulla</button>}
              <button className="primary-button is-danger" type="button" disabled={Boolean(busy)} aria-busy={busy === "disconnect"} onClick={() => void confirmDisconnect()}>
                {busy === "disconnect" ? spinner : <X size={15} aria-hidden="true" />}
                {busy === "disconnect" ? "Scollego…" : "Scollega"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="drive-backup" aria-labelledby="drive-backup-heading">
        <div className="drive-section-heading">
          <h3 id="drive-backup-heading" ref={backupHeadingRef} tabIndex={-1}>Backup su Google Drive</h3>
          <div className="drive-section-heading__actions">
            {status?.backupEnabled && status.retryAt && !status.syncPaused && (
              <button className="secondary-button drive-retry" type="button" disabled={blocked} aria-busy={busy === "retry"} aria-label={busy === "retry" ? "Riprovo…" : undefined} onClick={() => void controller.retrySync()}>
                {busy === "retry" ? spinner : <><ArrowClockwise size={15} aria-hidden="true" />Riprova ora</>}
              </button>
            )}
            {!snapshot.preview && snapshot.confirmation !== "disable" && (
              <div className="drive-actions">
                {status?.backupEnabled ? (
                  <button className="secondary-button" type="button" disabled={blocked} onClick={() => controller.confirmAction("disable")}>
                    <HardDrive size={15} aria-hidden="true" />
                    Disattiva backup
                  </button>
                ) : (
                  <button className="primary-button" type="button" disabled={!status || blocked || !hasVerifiedFolder} aria-busy={busy === "activation-preview"} onClick={() => void controller.openPreview("activation")}>
                    {busy === "activation-preview" ? spinner : <CloudArrowUp size={15} aria-hidden="true" />}
                    {busy === "activation-preview" ? "Controllo le copie…" : "Attiva backup"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <p className="drive-backup__state"><span className={`drive-dot is-${backup.tone}`} aria-hidden="true" />{backup.label}</p>
        {backup.detail && <p className="drive-hint">{backup.detail}</p>}
        {syncing && (
          <>
            <div className="drive-progress-copy"><span>{formatCount(status.syncCurrentFiles)} / {formatCount(status.syncTotalFiles)} file</span><span>{formatArchiveBytes(status.syncCurrentBytes)} / {formatArchiveBytes(status.syncTotalBytes)}</span></div>
            <progress max={Math.max(1, status.syncTotalFiles)} value={Math.min(status.syncCurrentFiles, status.syncTotalFiles)} aria-label="Avanzamento dell’upload su Drive" />
          </>
        )}
        {status?.backupEnabled && status.pendingChanges && <p className="drive-pending"><span aria-hidden="true" /> Modifiche in attesa del prossimo upload</p>}
        {status?.backupEnabled && status.syncError && <p className="drive-hint" role="status">{status.syncError.message}{status.retryAt ? ` Nuovo tentativo: ${formatBackupDate(status.retryAt)}.` : ""}</p>}
        {snapshot.notice === "activated" && (
          <p className="drive-success" role="status">Backup attivato. L’upload su Drive continua in background: puoi chiudere Settings.</p>
        )}
        <p className="drive-last-backup">{status?.lastCompletedBackup?.completedAt
          ? <>Ultimo backup completato: <strong>{formatBackupDate(status.lastCompletedBackup.completedAt)}</strong> · {formatCount(status.lastCompletedBackup.fileCount)} file · {formatArchiveBytes(status.lastCompletedBackup.totalBytes)}</>
          : "Nessun backup completato finora."}</p>
        {!status?.backupEnabled && !hasVerifiedFolder && (
          <p className="drive-hint">{status?.connected && !status.reconnectRequired
            ? "La cartella Google Drive non è accessibile: verifica l’accesso qui sopra."
            : "Collega prima un account Google Drive, qui sopra."}</p>
        )}
        {snapshot.confirmation === "disable" && (
          <div className="drive-confirm" role="group" aria-labelledby="drive-disable-title">
            <strong id="drive-disable-title">Disattivare il backup?</strong>
            <p>Le modifiche smettono di essere caricate su Drive. La copia già su Drive e quella sul computer restano dove sono.</p>
            <div className="drive-preview__choices">
              {busy !== "disable" && <button className="secondary-button" type="button" disabled={blocked} onClick={() => controller.clearConfirmation()}>Annulla</button>}
              <button className="primary-button" type="button" disabled={blocked} aria-busy={busy === "disable"} onClick={() => void confirmDisable()}>
                {busy === "disable" ? spinner : <HardDrive size={15} aria-hidden="true" />}
                {busy === "disable" ? "Disattivazione…" : "Disattiva backup"}
              </button>
            </div>
          </div>
        )}
      </section>

      {snapshot.preview?.operation === "activation" && <PreviewContent preview={snapshot.preview} busy={busy} slow={snapshot.slow} onChoose={controller.choose} />}

      <section className="drive-restore" aria-labelledby="drive-restore-heading">
        <div>
          <h3 id="drive-restore-heading">Ripristina da Google Drive</h3>
          <p>Sostituisce tutti i dati sul computer con la copia su Drive. Quello che c’è solo sul computer va perso.</p>
        </div>
        <button className="secondary-button" type="button" disabled={!hasVerifiedFolder || blocked || Boolean(snapshot.preview)} aria-busy={busy === "restore-preview"} onClick={() => void controller.openPreview("restore")}>
          {busy === "restore-preview" ? spinner : <CloudArrowDown size={16} aria-hidden="true" />}
          {busy === "restore-preview" ? "Controllo le copie…" : "Ripristina…"}
        </button>
      </section>

      {snapshot.preview?.operation === "restore" && <PreviewContent preview={snapshot.preview} busy={busy} slow={snapshot.slow} onChoose={controller.choose} />}

      <footer className="drive-settings__footer">
        <a href="https://developers.google.com/workspace/drive/api/guides/api-specific-auth" target="_blank" rel="noreferrer">Permessi richiesti a Google Drive <span aria-hidden="true">↗</span></a>
      </footer>
    </div>
  );
}
