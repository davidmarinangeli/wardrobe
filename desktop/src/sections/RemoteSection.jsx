// Remote access through Tailscale (Feature 07). Every Tailscale call runs in
// Rust (tailscale_* commands); the panel only shows the result.
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api.js";
import { ErrorText, Section } from "../components.jsx";
import { useAction } from "../hooks.js";
import { QrCode } from "../qr.jsx";

export const REMOTE_EXPLANATION = "Anyone logged into your tailnet can open Wardrobe at this address. Keys and settings stay on this computer.";

/** The state line: not installed / not logged in / connected as <dnsname>. */
export function tailscaleStateLabel(status) {
  if (!status) return "Checking Tailscale…";
  switch (status.state) {
    case "notInstalled": return "Tailscale is not installed on this computer.";
    case "unavailable": return "Tailscale is installed but not running.";
    case "stopped": return "Tailscale is turned off.";
    case "loggedOut": return "Tailscale is not logged in.";
    case "starting": return "Tailscale is starting…";
    case "connected": return `Connected as ${status.dnsName || "this computer"}${status.online ? "" : " (offline)"}`;
    default: return "Tailscale state unknown.";
  }
}

function seconds(ms) {
  const value = Math.max(0, ms || 0) / 1000;
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

export function RemoteSection({ info, onConfigChanged }) {
  const [status, setStatus] = useState(null);
  const [health, setHealth] = useState(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { pending, error, setError, run } = useAction();
  // Ignores a health result that arrives after remote access was turned off
  // or another check started.
  const healthRun = useRef(0);
  const enabled = Boolean(status?.enabled);
  const connected = status?.state === "connected";

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.tailscaleStatus();
      setStatus(next);
      return next;
    } catch (failure) {
      setError(api.errorText(failure));
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [setError]);

  const checkHealth = useCallback(async () => {
    const id = ++healthRun.current;
    setHealth({ checking: true });
    let result;
    try {
      result = await api.tailscaleHealth();
    } catch (failure) {
      result = { ok: false, error: api.errorText(failure) };
    }
    if (id === healthRun.current) setHealth(result);
  }, []);

  useEffect(() => {
    refresh().then((next) => { if (next?.enabled && next.state === "connected") checkHealth(); });
  }, [refresh, checkHealth]);

  const enable = () => run("enable", async () => {
    const next = await api.tailscaleEnable();
    setStatus(next);
    await onConfigChanged?.();
    checkHealth();
  });

  const disable = () => run("disable", async () => {
    healthRun.current += 1;
    setHealth(null);
    const next = await api.tailscaleDisable();
    setStatus(next);
    await onConfigChanged?.();
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (failure) {
      setError(`Copy failed: ${api.errorText(failure)}`);
    }
  };

  const help = (topic) => api.openHelp(topic).catch((failure) => setError(api.errorText(failure)));
  const canToggle = !pending && status && (enabled || connected);

  return (
    <Section id="remote" title="Remote access">
      <p className="muted">
        Open Wardrobe from your phone or another computer in your Tailscale network, at an HTTPS address only your tailnet can reach.
      </p>
      <div className="card" aria-live="polite">
        <div className="row-between">
          <p className={`status ${connected ? "status-running" : status ? "status-starting" : ""}`} data-testid="tailscale-state">{tailscaleStateLabel(status)}</p>
          <button type="button" className="secondary" disabled={refreshing || Boolean(pending)} onClick={refresh}>{refreshing ? "Checking…" : "Refresh"}</button>
        </div>
        {status?.state === "notInstalled" && (
          <div className="actions">
            <span className="muted">Install Tailscale and log in, then come back here.</span>
            <button type="button" className="secondary" onClick={() => help("tailscale-download")}>Download Tailscale</button>
          </div>
        )}
        {["unavailable", "stopped", "loggedOut"].includes(status?.state) && (
          <p className="muted">Open the Tailscale app{status.state === "loggedOut" ? " and log in" : status.state === "stopped" ? " and turn it on" : ""}, then choose Refresh.</p>
        )}
        {status?.message && <p className="warning" data-testid="remote-message">{status.message}</p>}

        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canToggle}
            onChange={(event) => (event.target.checked ? enable() : disable())}
          />
          Enable remote access
        </label>
        <p className="muted">{REMOTE_EXPLANATION}</p>
        {pending === "enable" && <p className="muted">Asking Tailscale to serve Wardrobe and restarting the server…</p>}
        {pending === "disable" && <p className="muted">Turning remote access off and restarting the server…</p>}
        {!enabled && connected && status.serveTarget && !status.served && (
          <p className="warning">https://{status.dnsName}/ already points at {status.serveTarget}. Turning remote access on replaces it.</p>
        )}
        <ErrorText>{error}</ErrorText>
      </div>

      {enabled && status?.url && (
        <div className="card remote-address">
          <span className="field-label">Address</span>
          <div className="actions">
            <code className="remote-url" data-testid="remote-url">{status.url}</code>
            <button type="button" className="secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <div className="remote-qr">
            <QrCode text={status.url} label="QR code of the Wardrobe address. Scan it with the phone's camera." />
            <p className="muted">Scan with the phone's camera. The phone must be logged into the same tailnet.</p>
          </div>
          <RemoteHealth health={health} onCheck={checkHealth} />
          {!connected && (
            <p className="warning">Remote access is on, but Tailscale is not connected on this computer, so the address does not answer.</p>
          )}
          {connected && !status.served && (
            <div className="actions">
              <p className="warning">
                Tailscale no longer serves Wardrobe at this address{status.serveTarget ? ` (it points at ${status.serveTarget})` : ""}.
              </p>
              <button type="button" disabled={Boolean(pending)} onClick={enable}>Turn on again</button>
            </div>
          )}
          {status.funnel && (
            <p className="error">Tailscale Funnel is on for this address, so it is reachable from the public internet. Turn it off with <code>tailscale funnel --https=443 off</code>.</p>
          )}
        </div>
      )}

      <details className="card advanced" open={Boolean(connected && (!status.magicDns || !status.https))}>
        <summary>Troubleshooting</summary>
        {connected && (
          <dl className="facts">
            <dt>MagicDNS</dt><dd data-testid="magic-dns">{status.magicDns ? "On" : "Off"}</dd>
            <dt>HTTPS certificates</dt><dd data-testid="https-certs">{status.https ? "On" : "Off"}</dd>
          </dl>
        )}
        <ul className="plain troubleshooting">
          <li>
            <strong>MagicDNS or HTTPS is disabled in the admin console.</strong> Both must be on (DNS page of the Tailscale admin
            console: MagicDNS, then HTTPS Certificates › Enable HTTPS).{" "}
            <button type="button" className="link" onClick={() => help("tailscale-dns")}>Open the DNS page</button>
          </li>
          <li>
            <strong>The computer is asleep.</strong> The address answers only while this computer is awake and Wardrobe is running.
            Adjust the sleep settings in {info?.platform === "macos" ? "System Settings › Energy" : "Settings › System › Power & battery"} if needed.
          </li>
          <li>
            <strong>The certificate is pending.</strong> The first visit after turning remote access on can take up to a minute while
            Tailscale issues the certificate. Reload the page on the phone.
          </li>
        </ul>
        <p className="muted">
          Keys, settings and the Google Drive connection can only be changed on this computer.{" "}
          <button type="button" className="link" onClick={() => help("remote-access")}>Remote access guide</button>
        </p>
      </details>
    </Section>
  );
}

function RemoteHealth({ health, onCheck }) {
  if (!health) {
    return (
      <div className="actions">
        <span className="muted">Not checked yet.</span>
        <button type="button" className="secondary" onClick={onCheck}>Check now</button>
      </div>
    );
  }
  if (health.checking) {
    return <p className="muted" data-testid="remote-health">Checking the address… The first time can take up to a minute while Tailscale issues the certificate.</p>;
  }
  if (health.ok) {
    return (
      <div className="actions">
        <p className="status status-running" data-testid="remote-health">Reachable through Tailscale (answered in {seconds(health.elapsedMs)} s).</p>
        <button type="button" className="secondary" onClick={onCheck}>Check again</button>
      </div>
    );
  }
  return (
    <div className="subsection">
      <p className="error" data-testid="remote-health">Not reachable yet. {health.error}</p>
      <div className="actions">
        <button type="button" className="secondary" onClick={onCheck}>Check again</button>
      </div>
    </div>
  );
}
