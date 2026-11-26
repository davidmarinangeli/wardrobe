// Control-panel scaffold (Feature 03): server status, logs, a session-only
// provider key, and launch at login. Feature 04 replaces it with the full
// panel (keychain, overrides, storage, Google Drive, general options).
import { useCallback, useEffect, useState } from "react";
import * as api from "./api.js";

const PROVIDERS = [
  { id: "openai", label: "OpenAI", key: "OPENAI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", key: "OPENROUTER_API_KEY" },
  { id: "gemini", label: "Gemini (PROD)", key: "GEMINI_API_KEY_PROD" },
  { id: "minimax", label: "MiniMax", key: "MINIMAX_API_KEY" },
];

function stateLabel(state) {
  switch (state?.state) {
    case "running": return state.adopted ? `Running on port ${state.port} (server started outside the app)` : `Running on port ${state.port}`;
    case "starting": return `Starting on port ${state.port}…`;
    case "failed": return "Failed";
    case "stopped": return "Stopped";
    default: return "…";
  }
}

function errorText(error) {
  return typeof error === "string" ? error : error?.message || String(error);
}

export function App() {
  const [state, setState] = useState(null);
  const [info, setInfo] = useState(null);
  const [config, setConfig] = useState(null);
  const [secrets, setSecrets] = useState({});
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [autostart, setAutostart] = useState(null);

  const refresh = useCallback(async () => {
    const [nextState, nextInfo, nextConfig, nextSecrets, nextLogs] = await Promise.all([
      api.serverState(), api.appInfo(), api.getConfig(), api.secretStatus(), api.serverLogs(200),
    ]);
    setState(nextState);
    setInfo(nextInfo);
    setConfig(nextConfig);
    setSecrets(nextSecrets);
    setLogs(nextLogs);
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(errorText(error)));
    api.autostartGet().then(setAutostart, () => setAutostart(null));
    const stop = api.onServerState((next) => {
      setState(next);
      api.serverLogs(200).then(setLogs, () => {});
      api.appInfo().then(setInfo, () => {});
    });
    return stop;
  }, [refresh]);

  const run = async (action) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const running = state?.state === "running";

  return (
    <main className="panel">
      <header className="panel-header">
        <h1>Wardrobe</h1>
        <p className="muted">{info ? `Version ${info.version}${info.sidecar_mode === "dev" ? " · development server" : ""}` : ""}</p>
      </header>

      <section className="card" aria-live="polite">
        <h2>Server</h2>
        <p className={`status status-${state?.state || "unknown"}`}>{stateLabel(state)}</p>
        {state?.state === "failed" && (
          <>
            <p className="error">{state.reason}</p>
            {state.lastLines?.length > 0 && <pre className="log">{state.lastLines.join("\n")}</pre>}
          </>
        )}
        <div className="actions">
          <button type="button" disabled={!running || busy} onClick={() => run(api.openWardrobe)}>Open Wardrobe</button>
          <button type="button" disabled={!running || busy} onClick={() => run(api.openInBrowser)}>Open in browser</button>
          <button type="button" disabled={busy} onClick={() => run(api.serverRestart)}>Restart server</button>
        </div>
      </section>

      {info && !info.has_provider_key && (
        <KeyForm busy={busy} onSave={(provider, value) => run(async () => {
          await api.setConfig({ provider: provider.id });
          await api.secretSet(provider.key, value);
        })} />
      )}

      {info?.has_provider_key && (
        <section className="card">
          <h2>AI provider</h2>
          <p>{config?.config?.provider ? `Provider: ${config.config.provider}` : "Provider: server default"}</p>
          <ul className="plain">
            {Object.entries(secrets).filter(([, status]) => status.present).map(([name, status]) => (
              <li key={name}><code>{name}</code> set, ends with {status.hint}</li>
            ))}
          </ul>
          <p className="muted">Full key management arrives with the next version of this panel.</p>
        </section>
      )}

      <section className="card">
        <h2>General</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(autostart)}
            disabled={autostart === null || busy}
            onChange={(event) => run(async () => setAutostart(await api.autostartSet(event.target.checked)))}
          />
          Launch Wardrobe at login
        </label>
      </section>

      <section className="card">
        <h2>Locations</h2>
        <dl className="paths">
          <dt>Data</dt><dd><code>{config?.data_dir}</code></dd>
          <dt>Cache</dt><dd><code>{config?.cache_dir}</code></dd>
          <dt>Settings file</dt><dd><code>{config?.config_file}</code></dd>
          <dt>Server log</dt><dd><code>{info?.server_log}</code></dd>
        </dl>
      </section>

      <section className="card">
        <details>
          <summary>Server log ({logs.length} lines)</summary>
          <pre className="log">{logs.map((line) => `${line.time} ${line.stream} | ${line.text}`).join("\n")}</pre>
        </details>
      </section>

      {message && <p className="error" role="alert">{message}</p>}
    </main>
  );
}

function KeyForm({ busy, onSave }) {
  const [providerId, setProviderId] = useState("openai");
  const [value, setValue] = useState("");
  const provider = PROVIDERS.find((p) => p.id === providerId);
  return (
    <section className="card">
      <h2>Add an AI provider key</h2>
      <p>Wardrobe needs a key to import clothes and generate photos.</p>
      <form onSubmit={(event) => { event.preventDefault(); if (value.trim()) { onSave(provider, value); setValue(""); } }}>
        <label>
          Provider
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label>
          {provider.key}
          <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <p className="muted">This early version keeps the key only until you quit Wardrobe.</p>
        <button type="submit" disabled={busy || !value.trim()}>Save and start</button>
      </form>
    </section>
  );
}
