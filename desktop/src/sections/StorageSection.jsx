import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import { ErrorText, PathRow, Section } from "../components.jsx";
import { useAction } from "../hooks.js";
import { defaultRedirectUri, formatBytes, validatePort } from "../validation.js";

export function StorageSection({ config, onConfigChanged }) {
  return (
    <Section id="storage" title="Storage">
      <DataDirectory config={config} onConfigChanged={onConfigChanged} />
      <ImportData config={config} />
      <Cache config={config} />
      <PortSetting config={config} onConfigChanged={onConfigChanged} />
    </Section>
  );
}

function DataDirectory({ config, onConfigChanged }) {
  const [candidate, setCandidate] = useState(null);
  const { pending, error, run } = useAction();
  const custom = Boolean(config?.config?.data_dir);

  const choose = () => run("pick", async () => {
    const picked = await api.pickDirectory("Choose the Wardrobe data folder", config?.data_dir);
    if (picked) setCandidate(picked);
  });
  const apply = (value) => run("apply", async () => {
    await api.setConfig({ data_dir: value });
    setCandidate(null);
    await onConfigChanged();
  });

  return (
    <div className="card">
      <PathRow label="Data directory" path={config?.data_dir} location="data">
        <button type="button" className="secondary" disabled={Boolean(pending)} onClick={choose}>Change…</button>
        {custom && <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => apply("")}>Use default</button>}
      </PathRow>
      <p className="muted">Changing it restarts the server, which then uses the new folder as it is: nothing is copied or moved. To bring an existing wardrobe along, use Import existing data below.</p>
      {candidate && (
        <div className="confirm">
          <span>Use <code>{candidate}</code> as the data directory? The server restarts.</span>
          <div className="actions">
            <button type="button" disabled={Boolean(pending)} onClick={() => apply(candidate)}>Use this folder</button>
            <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => setCandidate(null)}>Cancel</button>
          </div>
        </div>
      )}
      {pending === "apply" && <p className="muted">Restarting the server…</p>}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Pure view of an import outcome, exported for tests. */
export function ImportResult({ outcome, onReplace, busy }) {
  if (!outcome) return null;
  if (outcome.status === "imported") {
    return (
      <div className="result ok" data-testid="import-result">
        <p>Imported {outcome.files} files ({formatBytes(outcome.bytes)}) into <code>{outcome.to}</code>.</p>
        {outcome.backup && <p>The previous data was moved to <code>{outcome.backup}</code>.</p>}
        {outcome.warnings?.length > 0 && (
          <ul className="plain">{outcome.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        )}
        <p className="muted">Google Drive is not connected for the imported data: connect it again in Wardrobe › Settings › Archive if you use it.</p>
      </div>
    );
  }
  if (outcome.status === "targetPopulated") {
    return (
      <div className="result warn" data-testid="import-result">
        <p>The data directory <code>{outcome.to}</code> already holds a wardrobe.</p>
        <p>Replace moves it to a backup folder next to it (<code>…before-import-&lt;time&gt;</code>), then imports.</p>
        <div className="actions">
          <button type="button" className="danger" disabled={busy} onClick={onReplace}>Replace</button>
        </div>
      </div>
    );
  }
  return (
    <div className="result failed" data-testid="import-result">
      <p className="error">{outcome.message}</p>
      {outcome.errors?.length > 0 && (
        <ul className="errors">{outcome.errors.map((item) => <li key={item}>{item}</li>)}</ul>
      )}
    </div>
  );
}

function ImportData({ config }) {
  const [source, setSource] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const { pending, error, run } = useAction();

  const start = (from, replace) => run(replace ? "replace" : "import", async () => {
    setOutcome(null);
    setOutcome(await api.dataImport(from, replace));
  });
  const choose = async () => {
    const picked = await run("pick", () => api.pickDirectory("Choose the data folder to import"));
    if (!picked) return;
    setSource(picked);
    await start(picked, false);
  };

  return (
    <div className="card">
      <div className="row-between">
        <h3>Import existing data</h3>
        <button type="button" className="secondary" disabled={Boolean(pending)} onClick={choose}>Import existing data…</button>
      </div>
      <p className="muted">
        Copies a Wardrobe <code>data/</code> folder (for example from a clone of the repository) into the data directory
        {config?.data_dir ? <> <code>{config.data_dir}</code></> : null}. Keys, the Google Drive connection and jobs are not copied.
        The server stops during the import.
      </p>
      {(pending === "import" || pending === "replace") && <p className="muted" aria-live="polite">Importing from <code>{source}</code>… the server is stopped meanwhile.</p>}
      <ImportResult outcome={outcome} busy={Boolean(pending)} onReplace={() => start(source, true)} />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function Cache({ config }) {
  const [status, setStatus] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const { pending, error, run } = useAction();
  const load = useCallback(() => api.cacheStatus().then(setStatus, () => {}), []);
  useEffect(() => { load(); }, [load, config?.cache_dir]);

  const clear = () => run("clear", async () => {
    setStatus(await api.cacheClearModels());
    setConfirm(false);
  });

  return (
    <div className="card">
      <PathRow label="Cache directory" path={config?.cache_dir} location="cache" />
      <dl className="facts">
        <dt>Background-removal model</dt><dd>{status ? (status.transformers.exists ? formatBytes(status.transformers.bytes) : "Not downloaded") : "…"}</dd>
        <dt>Drape portraits</dt><dd>{status ? formatBytes(status.drapes.bytes) : "…"}</dd>
      </dl>
      {!confirm ? (
        <div className="actions">
          <button type="button" className="secondary" disabled={Boolean(pending) || !status?.transformers.exists} onClick={() => setConfirm(true)}>Clear model cache</button>
        </div>
      ) : (
        <div className="confirm">
          <span>The next import downloads the background-removal model again (about 470 MB). The server restarts.</span>
          <div className="actions">
            <button type="button" className="danger" disabled={Boolean(pending)} onClick={clear}>{pending ? "Clearing…" : "Clear model cache"}</button>
            <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

export function PortSetting({ config, onConfigChanged }) {
  const saved = config?.config?.port ?? config?.default_port ?? 5173;
  const [text, setText] = useState(String(saved));
  const { pending, error, run } = useAction();
  useEffect(() => { setText(String(saved)); }, [saved]);
  const { port, error: invalid } = validatePort(text);
  const changed = port !== undefined && port !== saved;

  const save = (event) => {
    event.preventDefault();
    if (invalid || !changed) return;
    run("save", async () => {
      await api.setConfig({ port });
      await onConfigChanged();
    });
  };

  return (
    <form className="card" onSubmit={save}>
      <label className="field" htmlFor="port">
        <span className="field-label">Port</span>
      </label>
      <div className="inline-form">
        <input id="port" inputMode="numeric" value={text} onChange={(event) => setText(event.target.value)} aria-invalid={Boolean(invalid)} className="narrow" />
        <button type="submit" disabled={Boolean(invalid) || !changed || Boolean(pending)}>{pending ? "Restarting…" : "Save"}</button>
        {saved !== (config?.default_port ?? 5173) && (
          <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => setText(String(config?.default_port ?? 5173))}>Default</button>
        )}
      </div>
      {invalid && <p className="error" data-testid="port-error">{invalid}</p>}
      <p className="muted">
        Default 5173. Wardrobe never picks another port on its own. The Google Drive redirect URI must match the port:
        with {port ?? saved} it is <code>{defaultRedirectUri(port ?? saved)}</code>, which you register in Google Cloud Console.
      </p>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
