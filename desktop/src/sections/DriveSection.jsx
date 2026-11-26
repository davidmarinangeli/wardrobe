import { useEffect, useState } from "react";
import * as api from "../api.js";
import { ErrorText, Section, SecretField } from "../components.jsx";
import { useAction } from "../hooks.js";
import { validateClientId, validateFolderId, validateRedirectUri } from "../validation.js";

export function DriveSection({ config, secrets, onConfigChanged, onSecretsChanged }) {
  const drive = config?.config?.google_drive ?? { client_id: "", redirect_uri: null, folder_id: "" };
  const defaultUri = config?.default_drive_redirect_uri ?? "";
  const [clientId, setClientId] = useState(drive.client_id);
  const [redirectUri, setRedirectUri] = useState(drive.redirect_uri ?? "");
  const [folderId, setFolderId] = useState(drive.folder_id);
  const { pending, error, run } = useAction();

  useEffect(() => {
    setClientId(drive.client_id);
    setRedirectUri(drive.redirect_uri ?? "");
    setFolderId(drive.folder_id);
  }, [drive.client_id, drive.redirect_uri, drive.folder_id]);

  const errors = {
    clientId: validateClientId(clientId),
    redirectUri: validateRedirectUri(redirectUri),
    folderId: validateFolderId(folderId),
  };
  const invalid = Object.values(errors).some(Boolean);
  // Typing the default itself keeps following the port.
  const redirectValue = redirectUri.trim() === defaultUri ? "" : redirectUri.trim();
  const changed = clientId.trim() !== drive.client_id
    || redirectValue !== (drive.redirect_uri ?? "")
    || folderId.trim() !== drive.folder_id;
  const secretPresent = Boolean(secrets?.GOOGLE_DRIVE_CLIENT_SECRET?.present);
  const complete = Boolean(drive.client_id && drive.folder_id && secretPresent);

  const save = (event) => {
    event.preventDefault();
    if (invalid || !changed) return;
    run("save", async () => {
      await api.setConfig({ google_drive: { client_id: clientId.trim(), redirect_uri: redirectValue, folder_id: folderId.trim() } });
      await onConfigChanged();
    });
  };

  return (
    <Section id="drive" title="Google Drive">
      <p className="muted">
        The OAuth client and the Drive folder used for archive snapshots. Activation, account connection and restore stay in
        Wardrobe › Settings › Archive.{" "}
        <button type="button" className="link" onClick={() => api.openHelp("google-drive").catch(() => {})}>Setup guide on GitHub</button>
      </p>
      <form className="card" onSubmit={save}>
        <label className="field">
          <span className="field-label">Client ID</span>
          <input value={clientId} spellCheck={false} placeholder="1234-abc.apps.googleusercontent.com" onChange={(event) => setClientId(event.target.value)} aria-invalid={Boolean(errors.clientId)} />
          {errors.clientId && <span className="error">{errors.clientId}</span>}
        </label>
        <label className="field">
          <span className="field-label">Redirect URI</span>
          <input value={redirectUri} spellCheck={false} placeholder={defaultUri} onChange={(event) => setRedirectUri(event.target.value)} aria-invalid={Boolean(errors.redirectUri)} />
          {errors.redirectUri
            ? <span className="error">{errors.redirectUri}</span>
            : <span className="muted">Leave empty to use <code>{defaultUri}</code>, which follows the port. Register the same URI in Google Cloud Console.</span>}
        </label>
        <label className="field">
          <span className="field-label">Folder ID</span>
          <input value={folderId} spellCheck={false} placeholder="The last part of the Drive folder URL" onChange={(event) => setFolderId(event.target.value)} aria-invalid={Boolean(errors.folderId)} />
          {errors.folderId && <span className="error">{errors.folderId}</span>}
        </label>
        <div className="actions">
          <button type="submit" disabled={invalid || !changed || Boolean(pending)}>{pending ? "Saving…" : "Save"}</button>
          {changed && <span className="muted">Saving restarts the server.</span>}
        </div>
        <ErrorText>{error}</ErrorText>
      </form>
      <div className="card">
        <SecretField
          name="GOOGLE_DRIVE_CLIENT_SECRET"
          label="Client secret"
          description="Stored in the keychain, like the API keys."
          status={secrets?.GOOGLE_DRIVE_CLIENT_SECRET}
          onChanged={onSecretsChanged}
        />
      </div>
      <p className="muted" data-testid="drive-summary">
        {complete
          ? "All four values are set. Connect your account in Wardrobe › Settings › Archive."
          : "Wardrobe › Settings › Archive stays unavailable until the client ID, client secret and folder ID are set."}
      </p>
    </Section>
  );
}
