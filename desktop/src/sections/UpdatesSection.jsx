import { useEffect, useState } from "react";
import * as api from "../api.js";
import { ErrorText, Section } from "../components.jsx";
import { useAction } from "../hooks.js";
import { Markdown } from "../markdown.jsx";
import { formatBytes, lastCheckLabel } from "../validation.js";

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** Re-renders every 30 s so "Checked 3 minutes ago" stays true. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The Updates screen. `updates` is the status from `update_state` and the
 * `update-state` event; `onStatus` stores a status a command returned.
 * Installing always needs the button: there is no automatic installation.
 */
export function UpdatesSection({ updates, onStatus, info }) {
  const { pending, error, run } = useAction();
  const now = useNow();
  const busy = Boolean(pending) || ["downloading", "ready"].includes(updates?.state);
  // A check that joined a running one resolves at once with `checking: true`;
  // the running check's result arrives as an `update-state` event, possibly
  // before this reply, so the reply must not overwrite it.
  const check = () => run("check", async () => {
    const next = await api.updateCheck();
    if (!next?.checking) onStatus(next);
  });
  const install = () => run("install", async () => onStatus(await api.updateInstall()));
  const skip = (version) => run("skip", async () => onStatus(await api.updateSkip(version)));
  const checking = updates?.checking || pending === "check";

  return (
    <Section id="updates" title="Updates">
      <div className="card" aria-live="polite" data-testid="update-card">
        <p>
          This is Wardrobe <strong data-testid="current-version">v{updates?.current || info?.version || "…"}</strong>.
          {updates?.updatedFrom && <> Updated from v{updates.updatedFrom}.</>}
        </p>
        <UpdateBody updates={updates} busy={busy} onInstall={install} onSkip={skip} />
        <div className="actions">
          <button type="button" className={updates?.state === "available" && !updates.skipped ? "secondary" : undefined} disabled={busy || checking} onClick={check}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
          <button type="button" className="secondary" onClick={() => api.openHelp("releases").catch(() => {})}>All releases</button>
        </div>
        <p className="muted" data-testid="last-check">{lastCheckLabel(updates, now)}</p>
        {updates && !updates.autoCheck && (
          <p className="muted">Automatic checks are off in this build. Use Check for updates.</p>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
      <p className="muted">
        Wardrobe checks for a new version shortly after it starts and every six hours while it runs. Nothing is installed until you choose Install and restart.
        The update replaces the whole app; your wardrobe, settings and keys stay where they are.
      </p>
    </Section>
  );
}

function UpdateBody({ updates, busy, onInstall, onSkip }) {
  switch (updates?.state) {
    case "upToDate":
      return <p className="status status-running">Wardrobe is up to date.</p>;
    case "available":
      if (updates.skipped) {
        return (
          <div className="update-skipped">
            <p>You skipped v{updates.version}. Wardrobe will offer the next version when it is released.</p>
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={onInstall}>Install v{updates.version} anyway</button>
              <button type="button" className="link" disabled={busy} onClick={() => onSkip(null)}>Stop skipping</button>
            </div>
          </div>
        );
      }
      return (
        <div className="update-available">
          <h3>Wardrobe v{updates.version} is available</h3>
          {formatDate(updates.date) && <p className="muted">Released {formatDate(updates.date)}</p>}
          {updates.notes
            ? <div className="release-notes" data-testid="release-notes"><Markdown text={updates.notes} /></div>
            : <p className="muted">No release notes.</p>}
          <div className="actions">
            <button type="button" disabled={busy} onClick={onInstall}>Install and restart</button>
            <button type="button" className="link" disabled={busy} onClick={() => onSkip(updates.version)}>Skip this version</button>
          </div>
          <p className="muted">The server stops while the update installs, then Wardrobe restarts on the new version.</p>
        </div>
      );
    case "downloading": {
      const percent = updates.total ? Math.min(100, Math.floor((updates.received / updates.total) * 100)) : null;
      return (
        <div>
          <p>Downloading v{updates.version}… {percent != null ? `${percent}%` : formatBytes(updates.received)}</p>
          <progress max={updates.total || undefined} value={updates.total ? updates.received : undefined} aria-label="Download progress" />
        </div>
      );
    }
    case "ready":
      return <p>Installing v{updates.version}. Wardrobe will restart in a moment.</p>;
    case "failed":
      return (
        <div>
          <p className="error" role="alert">{updates.version ? `The update to v${updates.version} failed.` : "The check for updates failed."} {updates.reason}</p>
          {updates.version && <p className="muted">This version keeps working. Check for updates to try again.</p>}
        </div>
      );
    default:
      // Idle: a failed automatic check is already in the last-check line.
      return updates?.lastFailure ? null : <p className="muted">Wardrobe has not checked for updates yet.</p>;
  }
}
