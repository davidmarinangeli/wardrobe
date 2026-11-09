import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowClockwise, Check, CloudArrowDown, CloudArrowUp, HardDrive, LinkSimple, SpinnerGap, X } from "@phosphor-icons/react";
import { createGoogleDriveStorageController, formatArchiveBytes, formatBackupDate, GOOGLE_DRIVE_OUTAGE_NOTICE } from "./google-drive-storage.js";
import "./google-drive-storage.css";

const DECISION_COPY = {
  local_to_empty: "La cartella Google Drive è stata verificata ed è vuota. Puoi caricare l’archivio locale completo.",
  drive_to_empty: "L’archivio Drive è completo e valido. L’archivio locale è vuoto e verrà sostituito interamente.",
  initialize: "Entrambi gli archivi sono vuoti. Puoi inizializzare la sincronizzazione.",
  equivalent: "Le copie verificate sono equivalenti. La sincronizzazione può essere attivata senza trasferire contenuti.",
  different: "Le copie contengono dati diversi. Scegli quale copia conservare come archivio completo.",
  local_invalid: "L’archivio locale è corrotto o incompleto. Puoi ripararlo con una copia Drive completa e verificata.",
  unavailable: "La cartella o l’archivio Drive non ha superato la verifica. Non è stata considerata vuota.",
};

const RESTORE_DECISION_COPY = {
  local_to_empty: "La copia Drive verificata è vuota. Ripristinarla sostituirà interamente l’archivio locale.",
  drive_to_empty: "L’archivio Drive è completo e valido. Il ripristino sostituirà l’archivio locale vuoto.",
  initialize: "Entrambi gli archivi verificati sono vuoti. Il ripristino sostituirà comunque l’intero archivio locale con la copia Drive.",
  equivalent: "Le copie verificate sono equivalenti. Il ripristino manuale sostituirà comunque l’intero archivio locale con la copia Drive.",
  different: "Le copie contengono dati diversi. Confermando, la copia Drive verificata sostituirà interamente l’archivio locale.",
  local_invalid: "L’archivio locale è corrotto o incompleto. Puoi sostituirlo con la copia Drive completa e verificata.",
  unavailable: "La cartella o l’archivio Drive non ha superato la verifica. Non c’è una copia valida da ripristinare.",
};

const CHOICE_LABELS = {
  "use-local": "Usa locale",
  "use-drive": "Usa Google Drive",
  initialize: "Inizializza archivio",
  equivalent: "Attiva backup",
};

const STAGE_COPY = {
  running: "In attesa di avviare il ripristino…",
  capturing: "Preparazione e verifica delle copie…",
  fencing: "Sospensione delle modifiche e sincronizzazione…",
  replacing: "Sostituzione dell’intero archivio…",
  sync_commit: "Verifica finale e riattivazione della modalità scelta…",
  complete: "Ripristino completato.",
  failed: "Ripristino non completato. I dati locali precedenti sono stati conservati.",
  recovery_required: "Il ripristino richiede un recupero prima di riprendere le modifiche.",
};

function formatCount(value) {
  return new Intl.NumberFormat("it-IT").format(Number.isFinite(value) ? value : 0);
}

function archiveDescription(label, archive) {
  if (!archive.valid) return `${label}: archivio non valido o non verificabile.`;
  if (!archive.populated) return `${label}: vuoto (verificato).`;
  return `${label}: ${formatCount(archive.files)} file, ${formatArchiveBytes(archive.bytes)}.`;
}

function PreviewContent({ preview, actionBusy, onChoose }) {
  const [selectedChoice, setSelectedChoice] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const previewSectionRef = useRef(null);
  const confirmationGroupRef = useRef(null);
  const titleRef = useRef(null);
  const confirmationRef = useRef(null);
  useEffect(() => {
    setSelectedChoice(null);
    setConfirmed(false);
    if (!preview) return undefined;
    const frame = requestAnimationFrame(() => {
      previewSectionRef.current?.scrollIntoView({ block: "start" });
      titleRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [preview]);
  useEffect(() => {
    if (!selectedChoice) return undefined;
    const frame = requestAnimationFrame(() => {
      confirmationGroupRef.current?.scrollIntoView({ block: "start" });
      confirmationRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedChoice]);
  if (!preview) return null;
  const needsExplicitConfirmation = (choice) => preview.operation === "restore" || ["use-local", "use-drive", "initialize"].includes(choice);
  const choose = (choice) => {
    if (choice === "cancel") { void onChoose(choice); return; }
    if (needsExplicitConfirmation(choice)) {
      setSelectedChoice(choice);
      setConfirmed(false);
    } else void onChoose(choice);
  };
  const selectedIsManualRestore = preview.operation === "restore";

  return (
    <section ref={previewSectionRef} className="drive-preview" aria-labelledby="drive-preview-title">
      <p className="drive-eyebrow">{selectedIsManualRestore ? "Ripristino manuale" : "Decisione archivio"}</p>
      <h3 id="drive-preview-title" ref={titleRef} tabIndex={-1}>{(selectedIsManualRestore ? RESTORE_DECISION_COPY[preview.decision] : DECISION_COPY[preview.decision]) || DECISION_COPY.unavailable}</h3>
      <div className="drive-preview__counts">
        <p>{archiveDescription("Sul computer", preview.local)}</p>
        <p>{preview.remote.valid
          ? (preview.remote.empty ? "Su Google Drive: cartella verificata vuota." : archiveDescription("Su Google Drive", preview.remote))
          : `Su Google Drive: ${preview.remote.error || "lettura non completata; contenuto non verificato."}`}</p>
      </div>
      {preview.decision === "local_invalid" && (
        <p className="drive-alert" role="alert">L’archivio locale è corrotto o incompleto. Se la sostituzione da Drive fallisse la verifica, i file locali precedenti resterebbero conservati.</p>
      )}
      {preview.decision === "unavailable" && <p className="drive-alert" role="alert">La cartella non verificata non può essere trattata come vuota. Controlla la connessione e riprova.</p>}
      {selectedIsManualRestore && (
        <p className="drive-preview__consequence">Il ripristino sostituisce tutto l’archivio locale — guardaroba, outfit, media, preferenze e cronologia — senza unire le copie. La modalità di archiviazione scelta resterà invariata. Se validazione o sostituzione falliscono, i dati locali precedenti vengono conservati.</p>
      )}
      <div className="drive-preview__choices" aria-label="Scelte per l’archivio">
        {preview.choices.map((choice) => (
          <button
            key={choice}
            type="button"
            className={choice === "cancel" ? "secondary-button" : "primary-button"}
            disabled={actionBusy}
            onClick={() => choose(choice)}
          >
            {choice === "cancel" ? "Annulla" : CHOICE_LABELS[choice] || choice}
          </button>
        ))}
      </div>
      {selectedChoice && (
        <div ref={confirmationGroupRef} className="drive-confirm" role="group" aria-labelledby="drive-confirm-title">
            <h4 id="drive-confirm-title" ref={confirmationRef} tabIndex={-1}>{selectedIsManualRestore ? "Conferma la sostituzione completa" : "Conferma la decisione"}</h4>
          <p>{selectedIsManualRestore
            ? "Tutti i dati locali saranno sostituiti dalla copia Drive verificata. Non verrà eseguita alcuna unione."
            : selectedChoice === "use-local"
              ? "La copia locale completa diventerà il backup su Google Drive."
              : selectedChoice === "initialize"
                ? "La sincronizzazione verrà inizializzata con entrambi gli archivi vuoti."
                : selectedChoice === "equivalent"
                  ? "Attiverai la sincronizzazione tra copie già verificate come equivalenti."
                  : "La copia locale verrà sostituita interamente dai dati verificati su Google Drive."}</p>
          <label className="drive-confirm__check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>{selectedIsManualRestore ? "Confermo la sostituzione completa dell’archivio locale." : "Confermo questa scelta per l’archivio."}</span>
          </label>
          <div className="drive-preview__choices">
            <button className="secondary-button" type="button" disabled={actionBusy} onClick={() => { setSelectedChoice(null); setConfirmed(false); }}>Indietro</button>
            <button className="primary-button" type="button" disabled={!confirmed || actionBusy} onClick={() => void onChoose(selectedChoice)}>
              {actionBusy ? <SpinnerGap size={15} className="drive-spinner" /> : <Check size={15} weight="bold" />}
              Conferma
            </button>
          </div>
        </div>
      )}
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
  return offline ? <p className="drive-offline-notice" role="status">{GOOGLE_DRIVE_OUTAGE_NOTICE}</p> : null;
}

// `open` is true while the Archive tab is on screen, so the focus moves below
// only happen when someone can see where focus went.
export function ArchiveSettings({ controller, snapshot, open }) {
  const modeHeadingRef = useRef(null);
  const operationSectionRef = useRef(null);
  const operationHeadingRef = useRef(null);
  const hadPreviewRef = useRef(false);
  const restoreWasActiveRef = useRef(null);
  const wasOpenRef = useRef(false);
  const status = snapshot.status;
  const restore = snapshot.restoreOperation;
  const blocked = Boolean(snapshot.busy || status?.maintenance.active || restore?.active || restore?.stage === "recovery_required");
  const hasVerifiedFolder = Boolean(status?.connected && !status.reconnectRequired && status.folder?.readable && status.folder?.writable);

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
        modeHeadingRef.current?.scrollIntoView({ block: "nearest" });
        modeHeadingRef.current?.focus({ preventScroll: true });
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
    if (completed) {
      controller.clearConfirmation();
    }
  };

  return (
    <div className="drive-settings">
      <header className="drive-settings__intro">
        <p className="drive-eyebrow">ARCHIVIO</p>
        <h2>Il tuo archivio resta sul computer</h2>
        <p>Google Drive conserva una copia completa. Puoi usare più browser con questo stesso backend; le installazioni indipendenti non uniscono i dati automaticamente.</p>
      </header>

      {snapshot.statusError && <p className="drive-alert" role="status">{snapshot.statusError}</p>}
      {snapshot.actionError && <p className="drive-alert" role="alert">{snapshot.actionError}</p>}
      {status?.connectionError && <p className="drive-alert" role="status">{status.connectionError}</p>}
      {status?.maintenance.error && <p className="drive-alert" role="alert">{status.maintenance.error}</p>}

      <section className="drive-mode" aria-labelledby="drive-mode-heading">
        <div>
          <p className="drive-eyebrow">MODALITÀ DI ARCHIVIAZIONE</p>
          <h3 id="drive-mode-heading" ref={modeHeadingRef} tabIndex={-1}>Dove vuoi tenere una copia?</h3>
        </div>
        <div className="drive-mode__options" role="radiogroup" aria-label="Modalità di archiviazione">
          <button type="button" role="radio" aria-checked={status?.backupEnabled === false} disabled={!status || blocked || Boolean(snapshot.preview)} onClick={() => status?.backupEnabled && controller.confirmAction("disable")}>
            <HardDrive size={19} aria-hidden="true" /><span><strong>Solo locale</strong><small>Una copia sul computer.</small></span>
          </button>
          <button type="button" role="radio" aria-checked={status?.backupEnabled === true} disabled={!status || blocked || Boolean(snapshot.preview) || !hasVerifiedFolder} onClick={() => !status?.backupEnabled && controller.openPreview("activation")}>
            <CloudArrowUp size={19} aria-hidden="true" /><span><strong>Locale + Google Drive</strong><small>Backup completo e sincronizzazione.</small></span>
          </button>
        </div>
        {!hasVerifiedFolder && <p className="drive-hint">Per attivare il backup, collega e verifica prima l’account e la cartella Google Drive.</p>}
        {snapshot.confirmation === "disable" && (
          <div className="drive-confirm" role="group" aria-label="Conferma modalità solo locale">
            <strong>Disattivare il backup?</strong>
            <p>La sincronizzazione verrà fermata; entrambe le copie resteranno disponibili.</p>
            <div className="drive-preview__choices">
              <button className="secondary-button" type="button" disabled={blocked} onClick={() => controller.clearConfirmation()}>Annulla</button>
              <button className="primary-button" type="button" disabled={blocked} onClick={() => void confirmDisable()}>{snapshot.busy ? <SpinnerGap size={15} className="drive-spinner" /> : <HardDrive size={15} />} Usa solo locale</button>
            </div>
          </div>
        )}
      </section>

      <section className="drive-account" aria-labelledby="drive-account-heading">
        <div className="drive-account__title">
          <img src="/google-drive.svg" alt="" width="28" height="28" />
          <div><p className="drive-eyebrow">GOOGLE DRIVE</p><h3 id="drive-account-heading">Connessione e cartella</h3></div>
        </div>
        {status?.account ? (
          <dl className="drive-account__details">
            <div><dt>Account</dt><dd>{status.account.name || status.account.email || "Account collegato"}</dd></div>
            {status.account.name && status.account.email && <div><dt>Email</dt><dd>{status.account.email}</dd></div>}
            <div><dt>Cartella configurata</dt><dd>{status.folder?.name || "Non disponibile"}</dd></div>
            <div><dt>Stato</dt><dd>{status.reconnectRequired ? "Da ricollegare" : status.connected ? "Collegato e verificato" : "Non collegato"}</dd></div>
          </dl>
        ) : <p className="drive-hint">{status?.configured ? "Nessun account collegato." : "La connessione richiede configurazione nel file .env."}</p>}
        <div className="drive-actions">
          <button className="secondary-button" type="button" disabled={Boolean(snapshot.busy || status?.maintenance.active || restore?.active || snapshot.preview)} onClick={() => void controller.startOAuth()}>
            {snapshot.busy === "connect" ? <SpinnerGap size={15} className="drive-spinner" /> : <LinkSimple size={15} />}{status?.connected || status?.reconnectRequired ? "Ricollega account" : "Collega account"}
          </button>
          <button className="secondary-button" type="button" disabled={!status?.connected || Boolean(snapshot.busy || status?.maintenance.active || restore?.active || snapshot.preview)} onClick={() => void controller.verify()}>
            {snapshot.busy === "verify" ? <SpinnerGap size={15} className="drive-spinner" /> : <ArrowClockwise size={15} />}
            Verifica accesso
          </button>
          <button className="text-button" type="button" disabled={!status?.account || Boolean(snapshot.busy || status?.maintenance.active || restore?.active || snapshot.preview)} onClick={() => controller.confirmAction("disconnect")}>
            Disconnetti questo account
          </button>
        </div>
        {snapshot.confirmation === "disconnect" && (
          <div className="drive-confirm" role="group" aria-label="Conferma disconnessione Google Drive">
            <strong>{status?.backupEnabled ? "Fermare il backup e disconnettere?" : "Disconnettere questo account?"}</strong>
            <p>{status?.backupEnabled
              ? "Prima verrà fermata e svuotata la coda di sincronizzazione. Le copie locale e Drive resteranno disponibili."
              : "Verranno rimosse solo le credenziali salvate in questa installazione. L’archivio Drive non verrà eliminato e il consenso del progetto Google non verrà revocato."}</p>
            <div className="drive-preview__choices">
              <button className="secondary-button" type="button" disabled={Boolean(snapshot.busy)} onClick={() => controller.clearConfirmation()}>Annulla</button>
              <button className="primary-button" type="button" disabled={Boolean(snapshot.busy)} onClick={() => void confirmDisconnect()}>{snapshot.busy ? <SpinnerGap size={15} className="drive-spinner" /> : <X size={15} />} Disconnetti</button>
            </div>
          </div>
        )}
        <div className="drive-env-help">
          <p>La connessione non richiede una chiave AI. Configura nel backend <code>GOOGLE_DRIVE_CLIENT_ID</code>, <code>GOOGLE_DRIVE_CLIENT_SECRET</code>, <code>GOOGLE_DRIVE_REDIRECT_URI</code> e <code>GOOGLE_DRIVE_FOLDER_ID</code>, quindi riavvia l’app.</p>
          <a href="https://developers.google.com/identity/protocols/oauth2/web-server" target="_blank" rel="noreferrer">Guida ufficiale OAuth di Google <span aria-hidden="true">↗</span></a>
        </div>
      </section>

      <section className="drive-sync" aria-labelledby="drive-sync-heading">
        <div className="drive-section-heading"><div><p className="drive-eyebrow">STATO DEL BACKUP</p><h3 id="drive-sync-heading">Sincronizzazione</h3></div><button className="drive-refresh" type="button" onClick={() => void controller.poll()} disabled={Boolean(snapshot.busy)} aria-label="Aggiorna stato"><ArrowClockwise size={17} /></button></div>
        <p className="drive-sync__state">{status?.syncState === "syncing" ? "Sincronizzazione in corso" : status?.backupEnabled ? status.syncPaused ? "Backup in pausa" : status.syncError ? "Sincronizzazione in attesa" : "Backup attivo" : "Backup disattivato"}</p>
        {status?.backupEnabled && (
          <>
            <div className="drive-progress-copy"><span>{formatCount(status.syncCurrentFiles)} / {formatCount(status.syncTotalFiles)} file</span><span>{formatArchiveBytes(status.syncCurrentBytes)} / {formatArchiveBytes(status.syncTotalBytes)}</span></div>
            <progress max={Math.max(1, status.syncTotalFiles)} value={Math.min(status.syncCurrentFiles, status.syncTotalFiles)} aria-label="Progresso trasferimento archivio" />
            {status.pendingChanges && <p className="drive-pending"><span aria-hidden="true" /> Modifiche locali in attesa del prossimo backup</p>}
            {status.syncError && <p className="drive-hint" role="status">{status.syncError.message}{status.retryAt ? ` Nuovo tentativo previsto: ${formatBackupDate(status.retryAt)}.` : ""}</p>}
          </>
        )}
        <p className="drive-last-backup">{status?.lastCompletedBackup?.completedAt
          ? <>Ultimo backup completato: <strong>{formatBackupDate(status.lastCompletedBackup.completedAt)}</strong> · {formatCount(status.lastCompletedBackup.fileCount)} file · {formatArchiveBytes(status.lastCompletedBackup.totalBytes)}</>
          : "Nessun backup completato in questa installazione."}</p>
      </section>

      <section className="drive-restore" aria-labelledby="drive-restore-heading">
        <div><p className="drive-eyebrow">OPERAZIONE SEPARATA</p><h3 id="drive-restore-heading">Ripristina da Google Drive</h3><p>Sostituisce l’archivio locale completo. Non unisce le copie e mantiene la modalità scelta.</p></div>
        <button className="secondary-button" type="button" disabled={!hasVerifiedFolder || blocked || Boolean(snapshot.preview)} onClick={() => void controller.openPreview("restore")}>
          {snapshot.busy === "restore-preview" ? <SpinnerGap size={15} className="drive-spinner" /> : <CloudArrowDown size={16} />}
          Anteprima ripristino
        </button>
      </section>

      {snapshot.preview && <PreviewContent preview={snapshot.preview} actionBusy={Boolean(snapshot.busy)} onChoose={controller.choose} />}

      {restore && (
        <section ref={operationSectionRef} className={`drive-operation${restore.stage === "recovery_required" ? " is-error" : ""}`} aria-labelledby="drive-operation-heading" aria-live="polite" aria-atomic="true">
          <div className="drive-section-heading"><div><p className="drive-eyebrow">RIPRISTINO</p><h3 id="drive-operation-heading" ref={operationHeadingRef} tabIndex={-1}>{status?.maintenance.active ? "Archivio in manutenzione" : restore.active ? "Operazione in corso" : "Stato operazione"}</h3></div>{restore.active && <SpinnerGap size={19} className="drive-spinner" aria-hidden="true" />}</div>
          <p role={restore.stage === "failed" || restore.stage === "recovery_required" ? "alert" : "status"}>{status?.maintenance.active && restore.stage === "running" ? "In attesa che le modifiche già avviate terminino…" : STAGE_COPY[restore.stage] || STAGE_COPY.running}</p>
          {restore.progress !== null && restore.stage !== "running" && <progress max="100" value={restore.progress} aria-label="Progresso ripristino" />}
          {restore.stage === "complete" && status?.maintenance.active && <p>Verifica della manutenzione in corso; il completamento verrà confermato quando l’archivio sarà nuovamente disponibile.</p>}
          {restore.error && <p className="drive-alert" role="alert">{restore.error}</p>}
        </section>
      )}

      <footer className="drive-settings__footer">
        <a href="https://developers.google.com/workspace/drive/api/guides/api-specific-auth" target="_blank" rel="noreferrer">Permessi Google Drive <span aria-hidden="true">↗</span></a>
      </footer>
    </div>
  );
}
