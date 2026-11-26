// Small building blocks shared by the sections.
import { useState } from "react";
import * as api from "./api.js";
import { secretLabel, validateSecretValue } from "./validation.js";

export function Section({ id, title, intro, children }) {
  return (
    <section className="section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {intro && <p className="muted">{intro}</p>}
      {children}
    </section>
  );
}

export function ErrorText({ children }) {
  if (!children) return null;
  return <p className="error" role="alert">{children}</p>;
}

/** A path with a Reveal button (opens the folder in Finder or Explorer). */
export function PathRow({ label, path, location, children }) {
  const [error, setError] = useState("");
  return (
    <div className="path-row">
      <div className="path-row__text">
        <span className="field-label">{label}</span>
        <code className="path">{path || "…"}</code>
      </div>
      <div className="actions">
        {location && (
          <button type="button" className="secondary" onClick={() => api.revealLocation(location).then(() => setError(""), (e) => setError(api.errorText(e)))}>
            Reveal
          </button>
        )}
        {children}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/**
 * One keychain entry: "Not set" or "Set, ends with …ab12", with Add/Replace
 * and Remove. The typed value is sent once and dropped; nothing ever shows a
 * stored value, because Rust never returns one.
 */
/**
 * `beforeSave` (optional) runs right before the value is sent, for example to
 * save the provider the key belongs to.
 */
export function SecretField({ name, label, description, status, onChanged, beforeSave }) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const present = Boolean(status?.present);
  const inputId = `secret-${name}`;

  const save = async (event) => {
    event.preventDefault();
    const problem = validateSecretValue(value);
    if (problem) { setError(problem); return; }
    const sent = value;
    setValue("");
    setPending("Saving and restarting the server…");
    setError("");
    try {
      await beforeSave?.();
      await api.secretSet(name, sent);
      setEditing(false);
      await onChanged?.();
    } catch (failure) {
      setError(api.errorText(failure));
    } finally {
      setPending(null);
    }
  };

  const remove = async () => {
    setPending("Removing and restarting the server…");
    setError("");
    try {
      await api.secretDelete(name);
      setConfirmRemove(false);
      await onChanged?.();
    } catch (failure) {
      setError(api.errorText(failure));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="secret-field" data-secret={name}>
      <div className="secret-field__head">
        <div>
          <span className="field-label">{label}</span>
          <span className={`secret-state ${present ? "is-set" : "is-unset"}`} data-testid={`status-${name}`}>{secretLabel(status)}</span>
        </div>
        {!editing && !confirmRemove && (
          <div className="actions">
            <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => { setEditing(true); setError(""); }}>
              {present ? "Replace" : "Add key"}
            </button>
            {present && (
              <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => setConfirmRemove(true)}>Remove</button>
            )}
          </div>
        )}
      </div>
      {description && <p className="muted">{description}</p>}
      {status?.error && <p className="error">The keychain could not be read: {status.error}</p>}
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <label htmlFor={inputId} className="visually-hidden">{label}</label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={value}
            placeholder={present ? "Paste the new key" : "Paste the key"}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit" disabled={Boolean(pending) || !value.trim()}>Save</button>
          <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => { setEditing(false); setValue(""); setError(""); }}>Cancel</button>
        </form>
      )}
      {confirmRemove && (
        <div className="confirm">
          <span>Remove {label} from the keychain? The server restarts without it.</span>
          <div className="actions">
            <button type="button" className="danger" disabled={Boolean(pending)} onClick={remove}>Remove</button>
            <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => setConfirmRemove(false)}>Cancel</button>
          </div>
        </div>
      )}
      {pending && <p className="muted" aria-live="polite">{pending}</p>}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
