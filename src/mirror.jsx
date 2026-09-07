import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, MagicWand, UploadSimple, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { api } from "./api.js";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import { usePopoverOrigin } from "./hooks/usePopoverOrigin.js";
import { MirrorVariantHost, useMirrorVariant } from "./prototypes/mirror/MirrorVariantHost.jsx";
import "./mirror.css";

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
  reader.readAsDataURL(file);
});

// Shown one at a time while the critique is running. The wait is a few seconds
// of real work, and a single frozen string makes it feel like nothing is
// happening — these say what is actually being looked at.
//
// Two rules on this copy. It never implies a verdict before one exists (the
// board's no-judgment guardrail covers loading states too: "checking the
// proportions" is fine, "seeing what went wrong" is not), and the sequence
// stops on its last line instead of wrapping, because a status that loops back
// to the beginning reads as stuck.
const MIRROR_STATUS_LINES = [
  "Looking you over…",
  "Reading the silhouette…",
  "Working out the proportions…",
  "Pulling the colors out of the photo…",
  "Checking how the layers sit…",
  "Measuring the contrast…",
  "Looking at where things break…",
  "Thinking about the shoes…",
  "Cross-checking against your wardrobe…",
  "Looking for something that would swap in…",
  "Weighing it up…",
  "Second-guessing myself about the shoes…",
  "Putting it into words…",
  "Almost there…",
];

const STATUS_LINE_MS = 1600;

function shuffledStatusLines() {
  // The first line is always the same, so the panel opens on a familiar beat;
  // everything after it is shuffled so two runs don't read identically.
  const [first, ...rest] = MIRROR_STATUS_LINES;
  for (let index = rest.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [rest[index], rest[swap]] = [rest[swap], rest[index]];
  }
  return [first, ...rest];
}

// Advances through the lines while `active`, holding on the last one.
function useStatusLine(active) {
  const [lines, setLines] = useState(shuffledStatusLines);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    setLines(shuffledStatusLines());
    setIndex(0);
    const timer = setInterval(() => {
      setIndex((current) => {
        if (current >= MIRROR_STATUS_LINES.length - 1) return current;
        return current + 1;
      });
    }, STATUS_LINE_MS);
    return () => clearInterval(timer);
  }, [active]);

  return { line: lines[index], index };
}

// Placeholders in the shape of the result that's coming — verdict, the overall
// line, two things that work, two issue cards — so the panel fills in rather
// than cutting from a spinner to a page of text. Decorative: the status line
// above it is what gets announced.
function MirrorSkeleton() {
  return (
    <div className="mirror-skeleton" aria-hidden="true">
      <div className="mirror-skeleton__verdict">
        <span className="mirror-skeleton__block mirror-skeleton__dot" />
        <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--label" />
      </div>
      <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--lead" />
      <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--lead-short" />
      <div className="mirror-skeleton__section">
        <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--heading" />
        <span className="mirror-skeleton__block mirror-skeleton__line" />
        <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--short" />
      </div>
      <div className="mirror-skeleton__section">
        <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--heading" />
        <div className="mirror-skeleton__card">
          <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--short" />
          <span className="mirror-skeleton__block mirror-skeleton__line" />
        </div>
        <div className="mirror-skeleton__card">
          <span className="mirror-skeleton__block mirror-skeleton__line mirror-skeleton__line--short" />
          <span className="mirror-skeleton__block mirror-skeleton__line" />
        </div>
      </div>
    </div>
  );
}

// A finding can now end in four different places, and the difference between
// them is the whole point of the rewrite. "Take the belt off" is often the true
// answer to too much going on, and the old shape — one swap card, or nothing —
// had no way to say it, so it said the nearest wrong thing instead. "none" is
// also a real outcome: an observation worth making that no single move fixes.
const REMEDY_EYEBROW = { replace: "Try instead", add: "Try adding", remove: "Try this" };

function Remedy({ remedy, itemMap }) {
  if (!remedy) return null;

  // Saying nothing here reads as a dead end, and inventing a swap is how this
  // feature went wrong in the first place. Some problems are also not one swap
  // away — three patterns competing is not settled by removing one — so the
  // rule gets to say what would actually help before falling back to the
  // honest admission that nothing owned answers it.
  if (remedy.action === "none") {
    return (
      <p className="mirror-issue-no-fix">
        {remedy.guidance || "Nothing in your wardrobe swaps in cleanly for this one."}
      </p>
    );
  }

  if (remedy.action === "remove") {
    return (
      <div className="mirror-issue-fix mirror-issue-fix--remove">
        <div className="mirror-issue-fix-body">
          <p className="mirror-issue-fix-eyebrow">{REMEDY_EYEBROW.remove}</p>
          <p className="mirror-issue-fix-name">Leave the {remedy.target} off</p>
          <p className="mirror-issue-fix-reason">{remedy.reason}</p>
        </div>
      </div>
    );
  }

  const item = itemMap[remedy.itemId];
  if (!item) return null;
  return (
    <div className="mirror-issue-fix">
      <div className="mirror-issue-fix-image">
        <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="48px" breakpoints={[48, 72]} />
      </div>
      <div className="mirror-issue-fix-body">
        <p className="mirror-issue-fix-eyebrow">{REMEDY_EYEBROW[remedy.action]}</p>
        <p className="mirror-issue-fix-name">{item.name}</p>
        <p className="mirror-issue-fix-reason">{remedy.reason}</p>
      </div>
    </div>
  );
}

const VERDICT_LABEL = (critique) => {
  if (critique.verdict === "clean") return "Clean fit";
  return critique.issues.length === 1 ? "1 thing to adjust" : `${critique.issues.length} things to adjust`;
};

export function Mirror({ items }) {
  const inputRef = useRef(null);
  const closeButtonRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const identityRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [critique, setCritique] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // This popover doesn't mount/unmount with `open` — it's rendered once and
  // toggles its own backdrop via CSS. `enabled: open` keeps Escape and the
  // body-scroll lock scoped to while it's actually visible.
  useViewerKeyboard(() => setOpen(false), closeButtonRef, open);

  // Measured just before opening, so the panel grows out of the chip rather
  // than out of a corner. See usePopoverOrigin for why it can't be measured
  // from the panel's own rect while it's closed.
  const anchorToTrigger = usePopoverOrigin(triggerRef, panelRef, identityRef);
  const status = useStatusLine(loading);
  // PROTOTYPE hook — null unless ?mirrorVariant= is in the URL, and always null
  // in a production build. Remove with src/prototypes/mirror.
  const prototypeVariant = useMirrorVariant();

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
        ref={triggerRef}
        type="button"
        className={`top-action top-action--secondary ai-action${open ? " is-morphing" : ""}`}
        onClick={() => { anchorToTrigger(); setOpen(true); }}
        aria-label="How do I look?"
      >
        <MagicWand size={17} weight="bold" />
        <span className="top-action__label">How do I look?</span>
        <span className="ai-action-beam-mask" aria-hidden="true">
          <span className="ai-action-beam" />
        </span>
      </button>

      <div className="mirror-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section ref={panelRef} className="mirror-popover" role="dialog" aria-modal="true" aria-labelledby="mirror-title">
          <header className="mirror-popover__header">
            <div className="mirror-popover__heading">
              <p className="mirror-popover__eyebrow popover-eyebrow">AI Mirror</p>
              {/* Same icon, same words as the chip — this block IS the chip,
                  moved. usePopoverOrigin measures where it has to start. */}
              <div className="popover-identity" ref={identityRef}>
                <span className="popover-identity__icon" aria-hidden="true">
                  <MagicWand size={22} weight="bold" />
                </span>
                <h2 className="mirror-popover__title" id="mirror-title">How do I look?</h2>
              </div>
            </div>
            <button className="mirror-close" type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeButtonRef}>
              <X size={20} />
            </button>
          </header>

          {!photo && !prototypeVariant ? (
            <div className="mirror-dropzone">
              <UploadSimple size={28} />
              <h2>What do you think of my outfit?</h2>
              <p>Upload a photo of yourself wearing the outfit and get a fit and color critique, plus swap suggestions from your own wardrobe.</p>
              <button type="button" className="primary-button" onClick={() => inputRef.current?.click()}>Choose a photo</button>
            </div>
          ) : (
            <div className="mirror-layout">
              <div className="mirror-photo">
                {photo
                  ? <img src={photo} alt="Outfit you're wearing" />
                  /* PROTOTYPE: the panel is reachable with no photo when a
                     variant is being reviewed, so the frame holds its shape. */
                  : <div className="mirror-photo__placeholder" />}
                <div className="mirror-photo-actions">
                  <button type="button" className="secondary-button" onClick={() => (photo ? reset() : inputRef.current?.click())}>
                    <ArrowCounterClockwise size={15} /> {photo ? "New photo" : "Choose a photo"}
                  </button>
                  {photo && !critique && (
                    <button type="button" className="primary-button" onClick={getFeedback} disabled={loading}>
                      <MagicWand size={15} weight="bold" /> Get feedback
                    </button>
                  )}
                </div>
              </div>

              <div className="mirror-result" aria-busy={loading}>
                {error && <p className="status error">{error}</p>}

                {loading && (
                  <>
                    <p className="mirror-status" aria-live="polite">
                      {/* Keyed on the index so each line is a fresh element and
                          replays the entry animation instead of the text
                          swapping under a static node. */}
                      <span className="mirror-status__line" key={status.index}>{status.line}</span>
                    </p>
                    <MirrorSkeleton />
                  </>
                )}

                {!loading && prototypeVariant && (
                  <MirrorVariantHost variantKey={prototypeVariant} critique={critique} itemMap={itemMap} />
                )}

                {!loading && !prototypeVariant && critique && (
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
                          {critique.issues.map((issue) => (
                            <div className="mirror-issue-card" key={issue.id}>
                              <p className="mirror-issue-label">{issue.label}</p>
                              <p className="mirror-issue-summary">{issue.summary}</p>
                              <Remedy remedy={issue.remedy} itemMap={itemMap} />
                            </div>
                          ))}
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
