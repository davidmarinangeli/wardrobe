import { useEffect, useMemo, useState } from "react";
import * as api from "../api.js";
import { ErrorText, Section, SecretField } from "../components.jsx";
import { useAction } from "../hooks.js";
import { DEFAULT_PROVIDER, PROVIDERS, formatOverrides, parseOverrides } from "../validation.js";

const KEY_LABELS = {
  OPENAI_API_KEY: "OpenAI API key",
  OPENROUTER_API_KEY: "OpenRouter API key",
  GEMINI_API_KEY_TEST: "Gemini TEST key",
  GEMINI_API_KEY_PROD: "Gemini PROD key",
  MINIMAX_API_KEY: "MiniMax API key",
};

const KEY_DESCRIPTIONS = {
  GEMINI_API_KEY_TEST: "Free tier, no billing attached — recommended. Create it in a Google Cloud project with no billing account attached, so it physically can't be charged, even by mistake. TEST mode refuses the paid premium model photos.",
  GEMINI_API_KEY_PROD: "Optional — a billed key, for higher-quality output. PROD mode unlocks the premium tier.",
};

export function AiSection({ config, secrets, info, onConfigChanged, onSecretsChanged, firstLaunch }) {
  const saved = config?.config?.provider ?? DEFAULT_PROVIDER;
  const [provider, setProvider] = useState(saved);
  const providerAction = useAction();
  useEffect(() => { setProvider(saved); }, [saved]);
  const option = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  const otherKeys = PROVIDERS.filter((p) => p.id !== provider)
    .flatMap((p) => p.keys)
    .filter((name) => secrets?.[name]?.present);

  const saveProvider = () => providerAction.run("provider", async () => {
    await api.setConfig({ provider });
    await onConfigChanged();
  });

  return (
    <Section id="ai" title="AI provider and keys">
      {firstLaunch && (
        <div className="card intro" data-testid="first-launch">
          <h3>Welcome to Wardrobe</h3>
          <p>
            Wardrobe uses an AI provider to recognise your clothes and generate photos. Choose a provider and add its key:
            the server restarts with it, and Wardrobe opens as soon as it is ready.
          </p>
          {info?.secrets_persistent && (
            <p className="muted">Keys are stored in this computer's {info.platform === "macos" ? "Keychain" : "Credential Manager"} and never leave it except to call the provider.</p>
          )}
        </div>
      )}

      <div className="card">
        <label className="field">
          <span className="field-label">Provider</span>
          <div className="inline-form">
            <select value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Provider">
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <button type="button" disabled={provider === saved || Boolean(providerAction.pending)} onClick={saveProvider}>
              {providerAction.pending ? "Saving…" : "Save"}
            </button>
          </div>
        </label>
        {provider !== saved && <p className="muted">Save to switch the server to {option.label}. It restarts.</p>}
        <ErrorText>{providerAction.error}</ErrorText>

        {option.keys.map((name) => (
          <SecretField
            key={name}
            name={name}
            label={KEY_LABELS[name]}
            description={KEY_DESCRIPTIONS[name]}
            status={secrets?.[name]}
            onChanged={async () => { await onSecretsChanged(); await onConfigChanged(); }}
            // A key added for the provider shown in the select switches the
            // server to that provider too, so the key is actually used.
            beforeSave={provider !== saved ? () => api.setConfig({ provider }) : undefined}
          />
        ))}

        {otherKeys.length > 0 && (
          <div className="subsection">
            <h3>Keys for other providers</h3>
            {otherKeys.map((name) => (
              <SecretField key={name} name={name} label={KEY_LABELS[name]} status={secrets?.[name]} onChanged={onSecretsChanged} />
            ))}
          </div>
        )}

        {info && !info.secrets_persistent && (
          <p className="warning">Keys are kept for this session only (WARDROBE_DESKTOP_SECRETS=memory). They are lost when Wardrobe quits.</p>
        )}
        {info?.platform === "macos" && (
          <p className="muted">
            After an update, macOS may ask whether Wardrobe can use confidential information stored in your keychain.
            Choose <strong>Always Allow</strong>: this build is not signed by Apple, so macOS asks again whenever the app changes.
          </p>
        )}
      </div>

      <div className="card">
        <p>
          Reference photos are managed in Wardrobe › Settings.{" "}
          <button type="button" className="link" onClick={() => api.openWardrobe().catch(() => {})}>Open Wardrobe</button>
        </p>
      </div>

      <AdvancedOverrides config={config} onConfigChanged={onConfigChanged} />
    </Section>
  );
}

export function AdvancedOverrides({ config, onConfigChanged }) {
  const savedText = useMemo(() => formatOverrides(config?.config?.overrides), [config]);
  const [text, setText] = useState(savedText);
  const { pending, error, run } = useAction();
  useEffect(() => { setText(savedText); }, [savedText]);
  const { entries, errors } = parseOverrides(text);
  const changed = formatOverrides(entries) !== savedText;

  const save = () => run("save", async () => {
    await api.setConfig({ overrides: entries });
    await onConfigChanged();
  });

  return (
    <details className="card advanced" open={Boolean(savedText)}>
      <summary>Advanced: environment overrides</summary>
      <p className="muted">
        One <code>KEY=value</code> per line, for non-secret settings such as <code>OPENAI_IMAGE_MODEL</code>,{" "}
        <code>GEMINI_IMAGE_MODEL</code>, <code>OPENAI_IMAGE_ROUTE</code> or <code>WARDROBE_FACE_REFERENCE</code>.
        Blank lines and lines starting with # are skipped and not kept. Saving restarts the server.
      </p>
      <label htmlFor="overrides" className="visually-hidden">Environment overrides</label>
      <textarea
        id="overrides"
        rows={6}
        spellCheck={false}
        value={text}
        placeholder={"OPENAI_IMAGE_MODEL=gpt-image-2\nGEMINI_IMAGE_SIZE=2K"}
        onChange={(event) => setText(event.target.value)}
        aria-invalid={errors.length > 0}
      />
      {errors.length > 0 && (
        <ul className="errors" data-testid="override-errors">
          {errors.map((item) => <li key={item.line}>{item.message}</li>)}
        </ul>
      )}
      <div className="actions">
        <button type="button" disabled={errors.length > 0 || !changed || Boolean(pending)} onClick={save}>{pending ? "Saving…" : "Save overrides"}</button>
        {changed && <button type="button" className="secondary" onClick={() => setText(savedText)}>Revert</button>}
      </div>
      <ErrorText>{error}</ErrorText>
    </details>
  );
}
