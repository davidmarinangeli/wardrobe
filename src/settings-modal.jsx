import { useEffect, useRef } from "react";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { ArchiveSettings, GoogleDriveOfflineNotice, useGoogleDriveStorage } from "./google-drive-storage.jsx";
import { AiSettings } from "./onboarding.jsx";
import "./settings-modal.css";

const TABS = [
  { id: "ai", label: "AI" },
  { id: "archive", label: "Cloud backup" },
];

/**
 * Settings behind the gear: one modal, an AI tab and an Archive tab. Always
 * mounted, because it owns the Google Drive controller, and that has to keep
 * running while the modal is closed — it drives the offline notice and the
 * archive-maintenance lock the rest of the app waits on.
 *
 * The Archive tab is only usable once the four GOOGLE_DRIVE_* values are in
 * .env. Until then it stays visible but greyed out, and selecting it explains
 * what is missing instead of opening an empty Drive panel.
 */
export function SettingsModal({ open, tab, onTabChange, onClose, aiSetup, aiBadge, onAiSetupChange, onAiModeChange, onArchiveChanged, onMaintenanceChange }) {
  const { controller, snapshot } = useGoogleDriveStorage({ onArchiveChanged, onMaintenanceChange });
  const status = snapshot.status;
  // Unknown until the first status poll answers; don't grey it out in the meantime.
  const archiveDisabled = Boolean(status && !status.configured);
  const showArchive = tab === "archive" && !archiveDisabled;
  const closeButtonRef = useRef(null);
  const tabRefs = useRef({});

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Escape goes through the same gate as the close button: Drive may refuse
  // while an operation runs, or cancel an open preview first.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      void controller.requestClose().then((allowed) => { if (allowed) onClose(); });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, controller]);

  const onTabKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id;
    onTabChange(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <GoogleDriveOfflineNotice status={status} />
      {open && (
        <ViewerPanel
          title="Settings"
          onClose={onClose}
          onRequestClose={controller.requestClose}
          closeRef={closeButtonRef}
          overlayClassName="onboarding-overlay settings-overlay"
          entryClassName="onboarding-entry settings-entry"
          panelClassName="onboarding settings-panel"
          // Closing never waits on a Drive action (it keeps running on the
          // server); only a preview cancellation that closing started does.
          closeDisabled={snapshot.busy === "cancel-preview"}
          swipeToClose={!snapshot.preview}
          focusTrap
        >
          <div className="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKeyDown}>
            {TABS.map((item) => {
              const disabled = item.id === "archive" && archiveDisabled;
              const selected = tab === item.id;
              return (
                <button
                  key={item.id}
                  ref={(element) => { tabRefs.current[item.id] = element; }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${item.id}`}
                  aria-controls={`settings-panel-${item.id}`}
                  aria-selected={selected}
                  // aria-disabled rather than disabled: a greyed tab still has to
                  // be clickable, or nobody finds out why it is greyed.
                  aria-disabled={disabled || undefined}
                  tabIndex={selected ? 0 : -1}
                  className={`settings-tab${selected ? " is-active" : ""}${disabled ? " is-disabled" : ""}`}
                  onClick={() => onTabChange(item.id)}
                >
                  {item.label}
                  {item.id === "ai" && aiBadge}
                </button>
              );
            })}
          </div>

          <div id="settings-panel-ai" role="tabpanel" aria-labelledby="settings-tab-ai" hidden={tab !== "ai"}>
            {/* Mounted only while shown: the key form inside should start empty every time. */}
            {tab === "ai" && <AiSettings setup={aiSetup} onSetupChange={onAiSetupChange} onModeChange={onAiModeChange} />}
          </div>

          {/* Kept mounted while hidden, so switching tabs mid-preview loses nothing. */}
          <div id="settings-panel-archive" role="tabpanel" aria-labelledby="settings-tab-archive" hidden={tab !== "archive"}>
            {archiveDisabled ? (
              <div className="settings-archive-off" lang="it">
                <p className="onboarding-eyebrow">Archive</p>
                <h3>Google Drive non è configurato</h3>
                <p>
                  L’archivio resta su questo computer. Per tenerne una copia su Google Drive, imposta{" "}
                  <code>GOOGLE_DRIVE_CLIENT_ID</code>, <code>GOOGLE_DRIVE_CLIENT_SECRET</code>,{" "}
                  <code>GOOGLE_DRIVE_REDIRECT_URI</code> e <code>GOOGLE_DRIVE_FOLDER_ID</code> nel file <code>.env</code>,
                  poi riavvia l’app. I passaggi sono in <code>docs/google-drive-operations.md</code>.
                </p>
              </div>
            ) : (
              <ArchiveSettings controller={controller} snapshot={snapshot} open={open && showArchive} />
            )}
          </div>
        </ViewerPanel>
      )}
    </>
  );
}
