import { useRef, useState } from "react";
import { ArrowCounterClockwise, MagicWand, SpinnerGap, UploadSimple, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { api } from "./api.js";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import "./mirror.css";

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
  reader.readAsDataURL(file);
});

const VERDICT_LABEL = (critique) => {
  if (critique.verdict === "clean") return "Clean fit";
  return critique.issues.length === 1 ? "1 thing to adjust" : `${critique.issues.length} things to adjust`;
};

export function Mirror({ items }) {
  const inputRef = useRef(null);
  const closeButtonRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [critique, setCritique] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // This popover doesn't mount/unmount with `open` — it's rendered once and
  // toggles its own backdrop via CSS. `enabled: open` keeps Escape and the
  // body-scroll lock scoped to while it's actually visible.
  useViewerKeyboard(() => setOpen(false), closeButtonRef, open);

  const itemMap = Object.fromEntries(items.map((item) => [item.id, item]));

  const choosePhoto = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setError("");
    setCritique(null);
    setPhoto(await fileToDataUrl(file));
  };

  const getFeedback = async () => {
    if (!photo) return;
    setLoading(true);
    setError("");
    try {
      const result = await api("/api/mirror/critique", {
        method: "POST",
        body: JSON.stringify({ imageDataUrl: photo }),
      });
      setCritique(result.critique);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setPhoto(null);
    setCritique(null);
    setError("");
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => { choosePhoto(event.target.files?.[0]); event.target.value = ""; }}
      />

      <button
        type="button"
        className="top-action top-action--secondary ai-action"
        onClick={() => setOpen(true)}
        aria-label="How do I look?"
      >
        <MagicWand size={17} weight="bold" />
        <span className="top-action__label">How do I look?</span>
        <span className="ai-action-beam-mask" aria-hidden="true">
          <span className="ai-action-beam" />
        </span>
      </button>

      <div className="mirror-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="mirror-popover" role="dialog" aria-modal="true" aria-labelledby="mirror-title">
          <header className="mirror-popover__header">
            <div>
              <p className="mirror-popover__eyebrow">AI Mirror</p>
              <h2 className="mirror-popover__title" id="mirror-title">How do I look?</h2>
            </div>
            <button className="mirror-close" type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeButtonRef}>
              <X size={20} />
            </button>
          </header>

          {!photo ? (
            <div className="mirror-dropzone">
              <UploadSimple size={28} />
              <h2>What do you think of my outfit?</h2>
              <p>Upload a photo of yourself wearing the outfit and get a fit and color critique, plus swap suggestions from your own wardrobe.</p>
              <button type="button" className="primary-button" onClick={() => inputRef.current?.click()}>Choose a photo</button>
            </div>
          ) : (
            <div className="mirror-layout">
              <div className="mirror-photo">
                <img src={photo} alt="Outfit you're wearing" />
                <div className="mirror-photo-actions">
                  <button type="button" className="secondary-button" onClick={reset}>
                    <ArrowCounterClockwise size={15} /> New photo
                  </button>
                  {!critique && (
                    <button type="button" className="primary-button" onClick={getFeedback} disabled={loading}>
                      <MagicWand size={15} weight="bold" /> Get feedback
                    </button>
                  )}
                </div>
              </div>

              <div className="mirror-result">
                {error && <p className="status error">{error}</p>}

                {loading && (
                  <div className="suggestion-loading">
                    <SpinnerGap size={24} className="outfit-card-spinner" />
                    Looking you over...
                  </div>
                )}

                {!loading && critique && (
                  <div className="mirror-critique">
                    <div className="mirror-verdict">
                      <span className={`mirror-verdict-dot${critique.verdict !== "clean" ? " is-attention" : ""}`} />
                      <span className="mirror-verdict-label">{VERDICT_LABEL(critique)}</span>
                    </div>
                    <p className="mirror-critique-overall">{critique.overall}</p>

                    {!!critique.works?.length && (
                      <div className="mirror-critique-section">
                        <h3>What's working</h3>
                        <ul className="mirror-works-list">
                          {critique.works.map((line, index) => <li key={index}>{line}</li>)}
                        </ul>
                      </div>
                    )}

                    {!!critique.issues?.length && (
                      <div className="mirror-critique-section">
                        <h3>Room to improve</h3>
                        <div className="mirror-issues">
                          {critique.issues.map((issue) => {
                            const fixItem = issue.fix ? itemMap[issue.fix.itemId] : null;
                            return (
                              <div className="mirror-issue-card" key={issue.id}>
                                <p className="mirror-issue-label">{issue.label}</p>
                                <p className="mirror-issue-summary">{issue.summary}</p>
                                {issue.fix && fixItem && (
                                  <div className="mirror-issue-fix">
                                    <div className="mirror-issue-fix-image">
                                      <OptimizedImage src={fixItem.thumbnail || fixItem.image} alt="" sizes="48px" breakpoints={[48, 72]} />
                                    </div>
                                    <div className="mirror-issue-fix-body">
                                      <p className="mirror-issue-fix-name">{fixItem.name}</p>
                                      <p className="mirror-issue-fix-reason">{issue.fix.reason}</p>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
