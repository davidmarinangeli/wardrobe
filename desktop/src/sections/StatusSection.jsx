import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import { ErrorText, PathRow, Section } from "../components.jsx";
import { useAction } from "../hooks.js";
import { formatUptime, stateLabel } from "../validation.js";

const LOG_LINES = 500;

export function StatusSection({ server, config, info }) {
  const [health, setHealth] = useState(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState([]);
  const [copied, setCopied] = useState(false);
  const { pending, error, run } = useAction();
  const running = server?.state === "running";

  useEffect(() => {
    if (!running) { setHealth(null); return undefined; }
    let alive = true;
    const load = () => api.serverHealth().then((next) => { if (alive) setHealth(next); }, () => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [running, server?.port, server?.pid]);

  const loadLogs = useCallback(() => api.serverLogs(LOG_LINES).then(setLogs, () => {}), []);
  useEffect(() => { if (logsOpen) loadLogs(); }, [logsOpen, server, loadLogs]);

  const logText = logs.map((line) => `${line.time} ${line.stream} | ${line.text}`).join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Section id="status" title="Status">
      <div className="card" aria-live="polite">
        <p className={`status status-${server?.state || "unknown"}`} data-testid="server-state">{stateLabel(server)}</p>
        {running && (
          <dl className="facts">
            <dt>Version</dt><dd>{health?.version || server.version || "…"}</dd>
            <dt>Uptime</dt><dd>{health?.uptime != null ? formatUptime(health.uptime) : "…"}</dd>
            <dt>Address</dt><dd><code>{server.url}</code></dd>
          </dl>
        )}
        {server?.state === "failed" && (
          <>
            <p className="error">{server.reason}</p>
            {server.lastLines?.length > 0 && <pre className="log">{server.lastLines.join("\n")}</pre>}
          </>
        )}
        <div className="actions">
          <button type="button" disabled={!running || Boolean(pending)} onClick={() => run("open", api.openWardrobe)}>Open Wardrobe</button>
          <button type="button" className="secondary" disabled={!running || Boolean(pending)} onClick={() => run("browser", api.openInBrowser)}>Open in browser</button>
          <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => run("restart", api.serverRestart)}>
            {pending === "restart" ? "Restarting…" : "Restart server"}
          </button>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>

      <div className="card">
        <PathRow label="Data directory" path={config?.data_dir} location="data" />
        <PathRow label="Cache directory" path={config?.cache_dir} location="cache" />
        {info?.sidecar_mode === "dev" && <p className="muted">Development build: the server runs from the repository with node from PATH.</p>}
      </div>

      <div className="card">
        <div className="row-between">
          <h3>Server log</h3>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setLogsOpen((open) => !open)}>{logsOpen ? "Hide logs" : "Show logs"}</button>
            <button type="button" className="secondary" onClick={() => api.revealLocation("logs").catch(() => {})}>Open log folder</button>
          </div>
        </div>
        {logsOpen && (
          <>
            <div className="actions">
              <button type="button" className="secondary" onClick={copy} disabled={!logs.length}>{copied ? "Copied" : "Copy"}</button>
              <button type="button" className="secondary" onClick={loadLogs}>Refresh</button>
              <span className="muted">Last {logs.length} lines</span>
            </div>
            <pre className="log" data-testid="server-log">{logText || "No log lines yet."}</pre>
          </>
        )}
        {info?.server_log && <p className="muted">Full log: <code>{info.server_log}</code></p>}
      </div>
    </Section>
  );
}
