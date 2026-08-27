import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle, SpinnerGap, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { api } from "./api.js";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import "./onboarding.css";

const CONFIG_API = "/api/import/config";
export const DISMISS_KEY = "open-wardrobe-onboarding-dismissed-v1";
export const RESUME_KEY = "open-wardrobe-onboarding-resume-v1";

const STEPS = ["welcome", "provider", "keys", "photos", "done"];
const STEP_LABELS = { welcome: "Welcome", provider: "Provider", keys: "API key", photos: "Reference photo", done: "Done" };

const PROVIDERS = [
  {
    id: "gemini",
    label: "Gemini",
    tagline: "Free tier available",
    description: "Google AI Studio gives you a free key (500 images/day, no billing) — the easiest way to try Wardrobe at no cost.",
    getKeyUrl: "https://aistudio.google.com/apikey",
    getKeyLabel: "aistudio.google.com/apikey",
    recommended: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    tagline: "gpt-image-2",
    description: "The original provider this project shipped with. Reliable detection and cutouts; no free tier.",
    getKeyUrl: "https://platform.openai.com/api-keys",
    getKeyLabel: "platform.openai.com/api-keys",
  },
  {
    id: "minimax",
    label: "MiniMax",
    tagline: "Subject-reference images",
    description: "Strong identity consistency for modeled photos, at a small per-image cost.",
    getKeyUrl: "https://www.minimax.io/platform",
    getKeyLabel: "minimax.io/platform",
  },
];

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
  reader.readAsDataURL(file);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function initialStepFor(setup) {
  if (!setup || !setup.hasApiKey) return "welcome";
  if (!setup.hasModelReference) return "photos";
  return "done";
}

function StepDots({ step }) {
  const activeIndex = STEPS.indexOf(step);
  return (
    <ol className="onboarding-dots" aria-label="Setup progress">
      {STEPS.map((id, index) => (
        <li key={id} className={index === activeIndex ? "is-active" : index < activeIndex ? "is-done" : ""} title={STEP_LABELS[id]} />
      ))}
    </ol>
  );
}

function Dropzone({ label, hint, required, uploaded, previewUrl, busy, onFile }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);

  const handleFiles = (files) => {
    const file = [...files].find((candidate) => candidate.type.startsWith("image/"));
    if (file) onFile(file);
  };

  return (
    <div
      className={`onboarding-dropzone${over ? " is-over" : ""}${uploaded ? " is-uploaded" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => { event.preventDefault(); setOver(false); handleFiles(event.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}
    >
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(event) => { handleFiles(event.target.files); event.target.value = ""; }} />
      {previewUrl ? <img className="onboarding-dropzone__preview" src={previewUrl} alt="" /> : (
        busy ? <SpinnerGap size={26} className="onboarding-spinner" /> : uploaded ? <CheckCircle size={26} weight="fill" /> : <UploadSimple size={26} weight="light" />
      )}
      <div className="onboarding-dropzone__text">
        <p className="onboarding-dropzone__label">{label}{required && <span className="onboarding-required"> · required</span>}</p>
        <p className="onboarding-dropzone__hint">{uploaded ? "Saved — drop a new photo to replace it." : hint}</p>
      </div>
    </div>
  );
}

function WelcomeStep({ onNext }) {
  return (
    <div className="onboarding-step">
      <p className="onboarding-eyebrow">Setup</p>
      <h2>Welcome to your wardrobe</h2>
      <p className="onboarding-lede">A local-first closet: detect clothes from a photo, plan outfits, keep a mood board and a wishlist, and see yourself wearing anything in it. Before any of it works, it needs two things: an AI API key, and a reference photo of you.</p>
      <ul className="onboarding-highlights">
        <li>Detects every clothing item in a photo and cuts it out cleanly</li>
        <li>Generates an editorial photo of you wearing each piece — or a full outfit</li>
        <li>Suggests outfits from your own wardrobe, tuned to occasion, weather, and your colors</li>
        <li>Everything — photos, keys, the wardrobe database — stays on your machine in <code>data/</code></li>
      </ul>
      <div className="onboarding-actions">
        <span className="action-spacer" />
        <button className="primary-button" type="button" onClick={onNext}>Get started <ArrowRight size={14} weight="bold" /></button>
      </div>
    </div>
  );
}

function ProviderStep({ provider, setProvider, onNext, onBack }) {
  return (
    <div className="onboarding-step">
      <p className="onboarding-eyebrow">Step 1 of 3</p>
      <h2>Choose an AI provider</h2>
      <p className="onboarding-lede">This decides which service detects your clothes and generates the images. You can switch this later.</p>
      <div className="onboarding-provider-list" role="radiogroup" aria-label="AI provider">
        {PROVIDERS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={provider === option.id}
            className={`onboarding-provider${provider === option.id ? " is-selected" : ""}`}
            onClick={() => setProvider(option.id)}
          >
            <div className="onboarding-provider__head">
              <span className="onboarding-provider__label">{option.label}</span>
              {option.recommended && <span className="onboarding-badge">Recommended</span>}
              <span className="onboarding-provider__tagline">{option.tagline}</span>
            </div>
            <p className="onboarding-provider__description">{option.description}</p>
          </button>
        ))}
      </div>
      <div className="onboarding-actions">
        <button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <span className="action-spacer" />
        <button className="primary-button" type="button" onClick={onNext}>Continue <ArrowRight size={14} weight="bold" /></button>
      </div>
    </div>
  );
}

function KeysStep({ provider, onSaved, onBack }) {
  const option = PROVIDERS.find((item) => item.id === provider);
  const [openaiKey, setOpenaiKey] = useState("");
  const [geminiTestKey, setGeminiTestKey] = useState("");
  const [geminiProdKey, setGeminiProdKey] = useState("");
  const [minimaxKey, setMinimaxKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState("");

  const values = provider === "gemini"
    ? { GEMINI_API_KEY_TEST: geminiTestKey.trim(), GEMINI_API_KEY_PROD: geminiProdKey.trim() }
    : provider === "minimax"
      ? { MINIMAX_API_KEY: minimaxKey.trim() }
      : { OPENAI_API_KEY: openaiKey.trim() };
  const canSave = Object.values(values).some(Boolean);

  const save = async () => {
    setSaving(true); setError("");
    try {
      sessionStorage.setItem(RESUME_KEY, "1");
      // Gemini checks the PROD key by default; a TEST-only key would otherwise stay unusable
      // until someone flips the header toggle, so point the app at whichever key is being saved
      // — before the .env write below, since that write restarts the dev server.
      if (provider === "gemini") {
        await api("/api/import/mode", { method: "POST", body: JSON.stringify({ mode: values.GEMINI_API_KEY_TEST ? "test" : "prod" }) });
      }
      await api("/api/setup/config", { method: "POST", body: JSON.stringify({ provider, values }) });
      setRestarting(true);
      let latest = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await wait(750);
        try {
          latest = await api(CONFIG_API);
          if (latest.hasApiKey) break;
        } catch {
          // The dev server is mid-restart — keep polling. A full page reload usually
          // arrives on its own once Vite's client reconnects.
        }
      }
      setRestarting(false);
      if (latest?.hasApiKey) onSaved(latest);
      else setError("Still waiting on the dev server to restart. If this page doesn't reload on its own in a few seconds, refresh it.");
    } catch (requestError) {
      sessionStorage.removeItem(RESUME_KEY);
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="onboarding-step">
      <p className="onboarding-eyebrow">Step 2 of 3</p>
      <h2>Add your {option.label} key</h2>
      <p className="onboarding-lede">
        Saved straight into <code>.env</code> on your machine — it never leaves this computer. Get a key at{" "}
        <a href={option.getKeyUrl} target="_blank" rel="noreferrer">{option.getKeyLabel}</a>.
      </p>

      {provider === "gemini" ? (
        <>
          <div className="onboarding-field">
            <label htmlFor="gemini-test-key">TEST key <span>free tier, no billing attached — recommended</span></label>
            <input id="gemini-test-key" type="password" autoComplete="off" spellCheck="false" value={geminiTestKey} onChange={(event) => setGeminiTestKey(event.target.value)} placeholder="AIza…" />
          </div>
          <div className="onboarding-field">
            <label htmlFor="gemini-prod-key">PROD key <span>optional — a billed key, for higher-quality output</span></label>
            <input id="gemini-prod-key" type="password" autoComplete="off" spellCheck="false" value={geminiProdKey} onChange={(event) => setGeminiProdKey(event.target.value)} placeholder="AIza…" />
          </div>
        </>
      ) : provider === "minimax" ? (
        <div className="onboarding-field">
          <label htmlFor="minimax-key">MINIMAX_API_KEY</label>
          <input id="minimax-key" type="password" autoComplete="off" spellCheck="false" value={minimaxKey} onChange={(event) => setMinimaxKey(event.target.value)} placeholder="sk-…" />
        </div>
      ) : (
        <div className="onboarding-field">
          <label htmlFor="openai-key">OPENAI_API_KEY</label>
          <input id="openai-key" type="password" autoComplete="off" spellCheck="false" value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} placeholder="sk-…" />
        </div>
      )}

      {error && <p className="onboarding-status is-error"><WarningCircle size={14} /> {error}</p>}
      {restarting && <p className="onboarding-status"><SpinnerGap size={14} className="onboarding-spinner" /> Saving and restarting the dev server…</p>}

      <div className="onboarding-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <span className="action-spacer" />
        <button className="primary-button" type="button" disabled={!canSave || saving} onClick={save}>
          {saving ? <SpinnerGap size={14} className="onboarding-spinner" /> : <Check size={14} weight="bold" />} Save &amp; continue
        </button>
      </div>
    </div>
  );
}

function PhotosStep({ setup, onSetupChange, onNext, onBack }) {
  const [fullUploaded, setFullUploaded] = useState(setup?.hasModelReference || false);
  const [faceUploaded, setFaceUploaded] = useState(setup?.hasFaceReference || false);
  const [fullPreview, setFullPreview] = useState(null);
  const [facePreview, setFacePreview] = useState(null);
  const [busyKind, setBusyKind] = useState(null);
  const [error, setError] = useState("");

  const upload = async (kind, file) => {
    setBusyKind(kind); setError("");
    try {
      const imageDataUrl = await fileToDataUrl(file);
      (kind === "face" ? setFacePreview : setFullPreview)(imageDataUrl);
      await api("/api/setup/reference", { method: "POST", body: JSON.stringify({ kind, imageDataUrl }) });
      (kind === "face" ? setFaceUploaded : setFullUploaded)(true);
      // No server restart happens for a reference photo — refresh the shared setup status
      // directly so the rest of the app (e.g. the import tray) notices immediately.
      onSetupChange?.(await api(CONFIG_API));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <div className="onboarding-step">
      <p className="onboarding-eyebrow">Step 3 of 3</p>
      <h2>Add a reference photo</h2>
      <p className="onboarding-lede">Wardrobe uses this to put you in every modeled photo. A clear, well-lit full-body shot works best — plain background, facing the camera.</p>

      <Dropzone
        label="Full-body photo"
        hint="Drag a photo here, or click to choose one"
        required
        uploaded={fullUploaded}
        previewUrl={fullPreview}
        busy={busyKind === "full"}
        onFile={(file) => upload("full", file)}
      />
      <Dropzone
        label="Face close-up"
        hint="Optional — sharpens facial identity across generations"
        uploaded={faceUploaded}
        previewUrl={facePreview}
        busy={busyKind === "face"}
        onFile={(file) => upload("face", file)}
      />

      {error && <p className="onboarding-status is-error"><WarningCircle size={14} /> {error}</p>}

      <div className="onboarding-actions">
        <button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <span className="action-spacer" />
        <button className="primary-button" type="button" disabled={!fullUploaded} onClick={onNext}>Continue <ArrowRight size={14} weight="bold" /></button>
      </div>
    </div>
  );
}

function DoneStep({ setup, onClose }) {
  return (
    <div className="onboarding-step">
      <p className="onboarding-eyebrow">All set</p>
      <h2>Your wardrobe is ready</h2>
      <p className="onboarding-lede">Drag any clothing photo onto the gallery — or paste one — to start importing. Every item gets a clean cutout and, once you ask for it, a modeled photo of you wearing it.</p>
      <ul className="onboarding-highlights">
        <li>Running on <strong>{setup?.provider}</strong>{setup?.provider === "gemini" && <> — use the TEST/PROD toggle in the header any time</>}</li>
        <li>Try the bundled <code>$import-clothes</code> and <code>$generate-outfits</code> Codex skills for hands-off importing</li>
        <li>Have a whole camera roll? <code>npm run bulk-import -- --input ~/Pictures/outfits --dry-run</code></li>
      </ul>
      <div className="onboarding-actions">
        <span className="action-spacer" />
        <button className="primary-button" type="button" onClick={onClose}><Check size={14} weight="bold" /> Start building your wardrobe</button>
      </div>
    </div>
  );
}

export function Onboarding({ setup, onSetupChange, onClose }) {
  const [step, setStep] = useState(() => initialStepFor(setup));
  // checkSetup() always resolves a provider — falling back to "openai" — even when nothing has
  // been configured yet, so that fallback can't be trusted as a real choice. Only treat
  // setup.provider as intentional once a key actually exists; otherwise default to the
  // free-tier-friendly recommendation.
  const [provider, setProvider] = useState(setup?.hasApiKey ? setup.provider : "gemini");

  useEffect(() => {
    sessionStorage.removeItem(RESUME_KEY);
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, "1");
    onClose();
  }, [onClose]);

  const finish = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, "1");
    onClose();
  }, [onClose]);

  return (
    <ViewerPanel
      onClose={dismiss}
      ariaLabel="Wardrobe setup"
      overlayClassName="onboarding-overlay"
      entryClassName="onboarding-entry"
      panelClassName="onboarding"
    >
      <StepDots step={step} />
      {step === "welcome" && <WelcomeStep onNext={() => setStep("provider")} />}
      {step === "provider" && <ProviderStep provider={provider} setProvider={setProvider} onNext={() => setStep("keys")} onBack={() => setStep("welcome")} />}
      {step === "keys" && (
        <KeysStep
          provider={provider}
          onBack={() => setStep("provider")}
          onSaved={(latest) => { onSetupChange?.(latest); setStep(latest.hasModelReference ? "done" : "photos"); }}
        />
      )}
      {step === "photos" && <PhotosStep setup={setup} onSetupChange={onSetupChange} onNext={() => setStep("done")} onBack={() => setStep(setup?.hasApiKey ? "welcome" : "keys")} />}
      {step === "done" && <DoneStep setup={setup} onClose={finish} />}
    </ViewerPanel>
  );
}
