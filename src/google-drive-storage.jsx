import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowClockwise, CloudArrowDown, CloudArrowUp, Folder, HardDrive, LinkSimple, SignOut, SpinnerGap, User, X } from "@phosphor-icons/react";
import { createGoogleDriveStorageController, formatArchiveBytes, formatBackupDate, GOOGLE_DRIVE_OUTAGE_NOTICE, GOOGLE_DRIVE_REMOTE_CONNECT_NOTICE, isRemoteHostname } from "./google-drive-storage.js";
import "./google-drive-storage.css";

const STAGE_COPY = {
  running: "Waiting to start…",
  capturing: "Preparing and checking the copies…",
  fencing: "Pausing changes…",
  replacing: "Replacing the data on this computer…",
  sync_commit: "Final check…",
  complete: "Restore complete.",
  failed: "Restore failed. The data on this computer is unchanged.",
  recovery_required: "The restore was interrupted and needs recovery before you can edit your wardrobe again.",
};

const SLOW_COPY = "This is taking longer than expected. You can close Settings: it keeps running in the background.";
const SLOW_PREVIEW_COPY = "Checking the copies is taking longer than expected. You can close Settings and try again later.";

function formatCount(value) {
  return new Intl.NumberFormat().format(Number.isFinite(value) ? value : 0);
}

function sizeOf(archive, { remote = false } = {}) {
  if (!archive.valid) return remote ? "unreadable" : "damaged";
  if (!archive.populated) return "empty";
  return `${formatCount(archive.files)} ${archive.files === 1 ? "file" : "files"}, ${formatArchiveBytes(archive.bytes)}`;
}

/**
 * What a preview asks of the person. The friction follows the risk: copying
 * into an empty place is one click, replacing data names what gets replaced
 * on the button itself, and choosing between two different copies is an
 * explicit pick before that button unlocks.
 */
function previewPlan(preview) {
  const can = (choice) => preview.choices.includes(choice);
  const activate = (choice, label) => ({ choice, label, busyLabel: "Turning on…", working: "Checking that the data hasn't changed and turning on backup…" });
  const replaceLocal = (label, danger) => ({ choice: "use-drive", label, busyLabel: "Starting…", danger, working: "Getting ready to replace the data on this computer…" });

  if (preview.decision === "unavailable" || !preview.remote.valid) {
    return {
      title: preview.operation === "restore" ? "There's no copy to restore" : "Can't read Google Drive",
      body: preview.remote.error || (preview.operation === "restore"
        ? "Google Drive doesn't have a valid copy to restore yet."
        : "The folder didn't respond completely, so it isn't treated as empty. Check the connection and try again."),
      alert: true,
    };
  }

  if (preview.operation === "restore") {
    const localFull = preview.local.valid && preview.local.populated;
    return {
      title: "Restore from Google Drive",
      body: !preview.local.valid
        ? "The archive on this computer is damaged and will be replaced entirely by the copy on Drive."
        : localFull
          ? "All the data on this computer (wardrobe, outfits, photos, preferences and history) will be replaced by the copy on Drive. Anything that exists only on this computer will be lost."
          : "This computer has no data yet: the archive on Drive will be copied here.",
      note: "Backup stays as you set it. If something goes wrong, your current data stays where it is.",
      action: can("use-drive") ? { ...replaceLocal(localFull || !preview.local.valid ? "Replace the data on this computer" : "Restore from Drive", localFull || !preview.local.valid), busyLabel: "Starting the restore…" } : null,
    };
  }

  switch (preview.decision) {
    case "local_to_empty":
      return { title: "Google Drive is empty", body: "Your archive will be uploaded to Drive and kept up to date from then on.", action: can("use-local") && activate("use-local", "Upload to Drive and turn on") };
    case "initialize":
      return { title: "Nothing to copy yet", body: "This computer and Drive are both empty. Backup will start with the first pieces you add.", action: can("initialize") && activate("initialize", "Turn on backup") };
    case "equivalent":
      return { title: "Drive already has the same copy", body: "This computer and Drive hold the same data: nothing needs to be uploaded.", action: can("equivalent") && activate("equivalent", "Turn on backup") };
    case "drive_to_empty":
      return { title: "Drive already has an archive", body: "This computer has no data yet. The archive on Drive will be copied here and backup will stay on.", action: can("use-drive") && replaceLocal("Copy from Drive and turn on", false) };
    case "different":
      return {
        title: "The two copies are different",
        body: "Choose which one to keep. The other will be replaced entirely, and anything that exists only there will be lost.",
        options: [
          can("use-local") && { title: "Keep this computer's copy", detail: "The data on Drive is replaced.", action: { ...activate("use-local", "Replace the data on Drive"), danger: true } },
          can("use-drive") && { title: "Keep the copy on Drive", detail: "The data on this computer is replaced.", action: replaceLocal("Replace the data on this computer", true) },
        ].filter(Boolean),
      };
    case "local_invalid":
      return can("use-drive")
        ? { title: "The archive on this computer is damaged", body: "You can replace it with the copy on Drive. If something goes wrong, the current files stay where they are.", action: replaceLocal("Replace with the copy on Drive", true) }
        : { title: "The archive on this computer is damaged", body: "Drive has no copy to repair it with.", alert: true };
    default:
      return { title: "Can't read Google Drive", body: "Check the connection and try again.", alert: true };
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
  const action = plan.options ? option?.action || { label: "Choose a copy", unpicked: true } : plan.action;
  const choosing = busy === "choice";
  const cancelling = choosing && pendingChoice === "cancel";
  const confirming = choosing && !cancelling;
  const choose = (choice) => { setPendingChoice(choice); void onChoose(choice); };

  return (
    <section ref={sectionRef} className="drive-preview" aria-labelledby="drive-preview-title" aria-busy={choosing}>
      <h4 id="drive-preview-title" ref={titleRef} tabIndex={-1}>{plan.title}</h4>
      <dl className="drive-preview__counts">
        <div><dt>This computer</dt><dd>{sizeOf(preview.local)}</dd></div>
        <div><dt>Google Drive</dt><dd>{sizeOf(preview.remote, { remote: true })}</dd></div>
      </dl>
      <p className={plan.alert ? "drive-alert" : "drive-preview__body"} role={plan.alert ? "alert" : undefined}>{plan.body}</p>
      {plan.note && <p className="drive-hint">{plan.note}</p>}
      {plan.options && (
        <div className="drive-preview__options" role="radiogroup" aria-label="Which copy to keep">
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
            {cancelling ? "Cancelling…" : action ? "Cancel" : "Close"}
          </button>
        )}
        {action && !cancelling && (
          <button
            className={action.danger ? "danger-button danger-button--solid" : "primary-button"}
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
    <div className="drive-offline-notice" role="status">
      <p>{GOOGLE_DRIVE_OUTAGE_NOTICE}</p>
      <button type="button" className="icon-button button--sm" aria-label="Dismiss notice" onClick={() => setDismissed(true)}><X size={14} weight="bold" /></button>
    </div>
  );
}

function backupState(status) {
  if (!status?.backupEnabled) return { tone: "off", label: "Off", detail: "The archive is only on this computer." };
  if (status.syncState === "syncing") return { tone: "busy", label: "Uploading to Drive", detail: null };
  if (status.syncPaused) return { tone: "warn", label: "Paused", detail: "Changes stay on this computer until backup resumes." };
  if (status.syncError) return { tone: "warn", label: "Waiting", detail: null };
  return { tone: "on", label: "On", detail: "Every change is uploaded to Drive." };
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
  // Opened from a phone or another computer (Tailscale): the Google sign-in
  // would return to localhost on that device, so Connect is not offered.
  const remote = typeof window !== "undefined" && isRemoteHostname(window.location.hostname);
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
    <div className="drive-settings">
      <header className="drive-settings__intro">
        <h3>Your archive</h3>
        <p>Wardrobe saves everything on this computer. With backup on, Google Drive keeps a complete, up-to-date copy.</p>
        <p>You can open Wardrobe in more than one browser and always see the same data. Another Wardrobe installation has its own separate archive, which doesn't sync with this one.</p>
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
          <div className="drive-section-heading"><h4 id="drive-other-operation-heading">Operation in progress</h4>{spinner}</div>
          <p>{status.maintenance.activation
            ? "Turning on backup to Google Drive. You can edit your wardrobe again as soon as it finishes."
            : "An archive operation is in progress, for example one started from another tab. You can edit your wardrobe again as soon as it finishes."}</p>
        </section>
      )}

      {restore && (
        <section ref={operationSectionRef} className={`drive-operation${restore.stage === "recovery_required" ? " is-error" : ""}`} aria-labelledby="drive-operation-heading" aria-live="polite" aria-atomic="true">
          <div className="drive-section-heading">
            <h4 id="drive-operation-heading" ref={operationHeadingRef} tabIndex={-1}>
              {restore.active ? "Restore in progress" : restore.stage === "complete" ? "Restore complete" : "Restore failed"}
            </h4>
            {restore.active && spinner}
          </div>
          <p role={restore.stage === "failed" || restore.stage === "recovery_required" ? "alert" : "status"}>
            {status?.maintenance.active && restore.stage === "running" ? "Waiting for changes already under way to finish…" : STAGE_COPY[restore.stage] || STAGE_COPY.running}
          </p>
          {restore.progress !== null && restore.stage !== "running" && <progress max="100" value={restore.progress} aria-label="Restore progress" />}
          {restore.active && <p>You can close Settings: the restore continues in the background.</p>}
          {restore.stage === "complete" && status?.maintenance.active && <p>Running final checks: the wardrobe will be available again shortly.</p>}
          {restore.error && <p className="drive-alert" role="alert">{restore.error}</p>}
        </section>
      )}

      <section className="drive-account" aria-labelledby="drive-account-heading">
        <div className="drive-account__title">
          <img src="/google-drive.svg" alt="" width="24" height="24" />
          <h4 id="drive-account-heading">Google Drive account</h4>
        </div>
        {status?.account ? (
          <div className="drive-account__card">
            <dl className="drive-account__details">
              <div>
                <dt><User size={16} aria-hidden="true" /><span className="sr-only">Account</span></dt>
                <dd>
                  {status.account.name || status.account.email || "Connected account"}
                  {status.account.name && status.account.email && <span className="drive-account__email"> — {status.account.email}</span>}
                </dd>
              </div>
              <div>
                <dt><Folder size={16} aria-hidden="true" /><span className="sr-only">Folder</span></dt>
                <dd>{status.folder?.name ? `/${status.folder.name}` : "Not available"}</dd>
              </div>
              <div>
                <dt>
                  <span className={`drive-dot${status.reconnectRequired || (status.connected && !folderReady) ? " is-warn" : status.connected ? " is-ok" : ""}`} aria-hidden="true" />
                  <span className="sr-only">Status</span>
                </dt>
                <dd>{status.reconnectRequired ? "Needs reconnecting" : status.connected ? (folderReady ? "Connected" : "Folder not accessible") : "Not connected"}</dd>
              </div>
            </dl>
            <button className="danger-button button--sm drive-disconnect" type="button" disabled={accountLocked} onClick={() => controller.confirmAction("disconnect")}>
              <SignOut size={15} aria-hidden="true" />
              Disconnect account
            </button>
          </div>
        ) : <p className="drive-hint">No account connected.</p>}
        {(status && (!status.connected || status.reconnectRequired) || needsVerify) && <div className="drive-actions">
          {status && (!status.connected || status.reconnectRequired) && remote && (
            <p className="drive-hint" data-testid="drive-remote-connect">{GOOGLE_DRIVE_REMOTE_CONNECT_NOTICE}</p>
          )}
          {status && (!status.connected || status.reconnectRequired) && !remote && (
            <button className="primary-button" type="button" disabled={accountLocked} aria-busy={busy === "connect"} onClick={() => void controller.startOAuth()}>
              {busy === "connect" ? spinner : <LinkSimple size={15} aria-hidden="true" />}
              {status?.reconnectRequired ? "Reconnect account" : "Connect account"}
            </button>
          )}
          {needsVerify && (
            <button className="secondary-button" type="button" disabled={accountLocked} aria-busy={busy === "verify"} onClick={() => void controller.verify()}>
              {busy === "verify" ? spinner : <ArrowClockwise size={15} aria-hidden="true" />}
              {busy === "verify" ? "Verifying…" : "Verify access"}
            </button>
          )}
        </div>}
        {snapshot.confirmation === "disconnect" && (
          <div className="drive-confirm" role="group" aria-labelledby="drive-disconnect-title">
            <strong id="drive-disconnect-title">{status?.backupEnabled ? "Turn off backup and disconnect the account?" : "Disconnect this account?"}</strong>
            <p>{status?.backupEnabled
              ? "Backup stops, and changes not yet uploaded stay only on this computer. The existing copies, on this computer and on Drive, stay where they are."
              : "Wardrobe forgets its access to this account. The copy on Drive isn't deleted; to revoke access completely, use your Google account settings."}</p>
            <div className="drive-preview__choices">
              {busy !== "disconnect" && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => controller.clearConfirmation()}>Cancel</button>}
              <button className="danger-button danger-button--solid" type="button" disabled={Boolean(busy)} aria-busy={busy === "disconnect"} onClick={() => void confirmDisconnect()}>
                {busy === "disconnect" ? spinner : <X size={15} aria-hidden="true" />}
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="drive-backup" aria-labelledby="drive-backup-heading">
        <div className="drive-section-heading">
          <h4 id="drive-backup-heading" ref={backupHeadingRef} tabIndex={-1}>Backup to Google Drive</h4>
          <div className="drive-section-heading__actions">
            {status?.backupEnabled && status.retryAt && !status.syncPaused && (
              <button className="secondary-button button--sm drive-retry" type="button" disabled={blocked} aria-busy={busy === "retry"} aria-label={busy === "retry" ? "Retrying…" : undefined} onClick={() => void controller.retrySync()}>
                {busy === "retry" ? spinner : <><ArrowClockwise size={15} aria-hidden="true" />Retry now</>}
              </button>
            )}
            {!snapshot.preview && snapshot.confirmation !== "disable" && (
              <div className="drive-actions">
                {status?.backupEnabled ? (
                  <button className="secondary-button" type="button" disabled={blocked} onClick={() => controller.confirmAction("disable")}>
                    <HardDrive size={15} aria-hidden="true" />
                    Turn off backup
                  </button>
                ) : (
                  <button className={hasVerifiedFolder ? "primary-button" : "secondary-button"} type="button" disabled={!status || blocked || !hasVerifiedFolder} aria-busy={busy === "activation-preview"} onClick={() => void controller.openPreview("activation")}>
                    {busy === "activation-preview" ? spinner : <CloudArrowUp size={15} aria-hidden="true" />}
                    {busy === "activation-preview" ? "Checking the copies…" : "Turn on backup"}
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
            <div className="drive-progress-copy"><span>{formatCount(status.syncCurrentFiles)} / {formatCount(status.syncTotalFiles)} {status.syncTotalFiles === 1 ? "file" : "files"}</span><span>{formatArchiveBytes(status.syncCurrentBytes)} / {formatArchiveBytes(status.syncTotalBytes)}</span></div>
            <progress max={Math.max(1, status.syncTotalFiles)} value={Math.min(status.syncCurrentFiles, status.syncTotalFiles)} aria-label="Upload to Drive progress" />
          </>
        )}
        {status?.backupEnabled && status.pendingChanges && <p className="drive-pending"><span aria-hidden="true" /> Changes waiting for the next upload</p>}
        {status?.backupEnabled && status.syncError && <p className="drive-hint" role="status">{status.syncError.message}{status.retryAt ? ` Next attempt: ${formatBackupDate(status.retryAt)}.` : ""}</p>}
        {snapshot.notice === "activated" && (
          <p className="drive-success" role="status">Backup turned on. The upload to Drive continues in the background: you can close Settings.</p>
        )}
        <p className="drive-last-backup">{status?.lastCompletedBackup?.completedAt
          ? <>Last completed backup: <strong>{formatBackupDate(status.lastCompletedBackup.completedAt)}</strong> · {formatCount(status.lastCompletedBackup.fileCount)} {status.lastCompletedBackup.fileCount === 1 ? "file" : "files"} · {formatArchiveBytes(status.lastCompletedBackup.totalBytes)}</>
          : "No completed backup yet."}</p>
        {!status?.backupEnabled && !hasVerifiedFolder && (
          <p className="drive-hint">{status?.connected && !status.reconnectRequired
            ? "The Google Drive folder isn't accessible: verify access above."
            : "Connect a Google Drive account above first."}</p>
        )}
        {snapshot.confirmation === "disable" && (
          <div className="drive-confirm" role="group" aria-labelledby="drive-disable-title">
            <strong id="drive-disable-title">Turn off backup?</strong>
            <p>Changes stop being uploaded to Drive. The copy already on Drive and the one on this computer stay where they are.</p>
            <div className="drive-preview__choices">
              {busy !== "disable" && <button className="secondary-button" type="button" disabled={blocked} onClick={() => controller.clearConfirmation()}>Cancel</button>}
              <button className="primary-button" type="button" disabled={blocked} aria-busy={busy === "disable"} onClick={() => void confirmDisable()}>
                {busy === "disable" ? spinner : <HardDrive size={15} aria-hidden="true" />}
                {busy === "disable" ? "Turning off…" : "Turn off backup"}
              </button>
            </div>
          </div>
        )}
      </section>

      {snapshot.preview?.operation === "activation" && <PreviewContent preview={snapshot.preview} busy={busy} slow={snapshot.slow} onChoose={controller.choose} />}

      <section className="drive-restore" aria-labelledby="drive-restore-heading">
        <div>
          <h4 id="drive-restore-heading">Restore from Google Drive</h4>
          <p>Replaces all the data on this computer with the copy on Drive. Anything that exists only on this computer is lost.</p>
        </div>
        <button className="secondary-button" type="button" disabled={!hasVerifiedFolder || blocked || Boolean(snapshot.preview)} aria-busy={busy === "restore-preview"} onClick={() => void controller.openPreview("restore")}>
          {busy === "restore-preview" ? spinner : <CloudArrowDown size={16} aria-hidden="true" />}
          {busy === "restore-preview" ? "Checking the copies…" : "Restore…"}
        </button>
      </section>

      {snapshot.preview?.operation === "restore" && <PreviewContent preview={snapshot.preview} busy={busy} slow={snapshot.slow} onChoose={controller.choose} />}

      <footer className="drive-settings__footer">
        <a href="https://developers.google.com/workspace/drive/api/guides/api-specific-auth" target="_blank" rel="noreferrer">Permissions Wardrobe requests on Google Drive <span aria-hidden="true">↗</span></a>
      </footer>
    </div>
  );
}
