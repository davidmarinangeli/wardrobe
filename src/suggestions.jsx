import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Heart, MagicWand, SpinnerGap, Sparkle, X } from "@phosphor-icons/react";
import { api } from "./api.js";
import { OutfitStack } from "./components/OutfitStack.jsx";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import "./suggestions.css";

const OCCASIONS = [
  { id: "casual", label: "Casual", emoji: "👕" },
  { id: "work", label: "Work", emoji: "💼" },
  { id: "date", label: "Date", emoji: "🌹" },
  { id: "sport", label: "Sport", emoji: "🏃" },
  { id: "event", label: "Event", emoji: "🎉" },
];

// How many cards behind the top one are drawn. Three is enough to read as a
// deck with depth; more is invisible under the card above it and just costs
// layout on every advance.
const DECK_DEPTH = 3;

// Fraction of the card's width a drag has to cross to count as a decision.
// Below it the card springs back — a hesitant drag is not an answer.
const COMMIT_RATIO = 0.28;

// Long enough to notice a mis-tap and reach for it, short enough that it isn't
// still hanging around two cards later.
const UNDO_MS = 6000;

const EXIT_MS = 420;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ─── Hearts ───────────────────────────────────────────────────────────────────
// The reward for a ♥. Purely decorative and purely transient: a handful of
// hearts drift off the button and are dropped from the DOM when they land.
function HeartBurst({ id }) {
  const hearts = useMemo(
    () => Array.from({ length: 6 }, (_, index) => ({
      index,
      dx: (index - 2.5) * 16 + (index % 2 ? 6 : -6),
      delay: index * 34,
      scale: 0.6 + ((index * 37) % 50) / 100,
    })),
    [id],
  );

  return (
    <div className="heart-burst" aria-hidden="true">
      {hearts.map((heart) => (
        <Heart
          key={heart.index}
          size={18}
          weight="fill"
          style={{ "--dx": `${heart.dx}px`, "--delay": `${heart.delay}ms`, "--scale": heart.scale }}
        />
      ))}
    </div>
  );
}

// ─── One card ─────────────────────────────────────────────────────────────────
function SuggestionCard({ suggestion, pieces, depth, drag, leaving, dragHandlers }) {
  // Depth drives the resting transform; drag overrides it while a pointer is
  // down. Both are transforms, so the two never fight over layout.
  const style = drag
    ? {
        transform: `translate3d(${drag.dx}px, ${Math.abs(drag.dx) * 0.06}px, 0) rotate(${drag.dx * 0.045}deg)`,
        transition: "none",
      }
    : { "--depth": depth };

  const verdictOpacity = drag ? Math.min(1, Math.abs(drag.dx) / 90) : 0;

  return (
    <article
      className={`deck-card${leaving ? ` is-leaving is-leaving--${leaving}` : ""}${drag ? " is-dragging" : ""}`}
      style={style}
      data-depth={depth}
      aria-hidden={depth > 0 || Boolean(leaving)}
      {...(depth === 0 && !leaving ? dragHandlers : {})}
    >
      {/* The verdict a release would produce right now. It appears under the
          thumb during a drag so the gesture is never a guess. */}
      <span className="deck-stamp deck-stamp--like" style={{ opacity: drag?.dx > 0 ? verdictOpacity : 0 }} aria-hidden="true">
        <Heart size={16} weight="fill" /> Save it
      </span>
      <span className="deck-stamp deck-stamp--pass" style={{ opacity: drag?.dx < 0 ? verdictOpacity : 0 }} aria-hidden="true">
        <X size={16} weight="bold" /> Not today
      </span>

      <h3 className="deck-card-name">{suggestion.name}</h3>

      {/* The card is one scroll region with the look at the top of it. On a tall
          window nothing scrolls; on a short one the garments stay whole and the
          reasoning is what runs past the fold — which is the right way round,
          because the look is the thing being judged. */}
      <div className="deck-card-scroll">
        <div className="deck-card-stack">
          <OutfitStack items={pieces} emptyMessage={null} />
        </div>
        <p className="deck-card-lead">{suggestion.reasoning?.style || suggestion.styleReasoning}</p>
        <dl className="deck-card-notes">
          {[
            ["Colour", suggestion.reasoning?.color || suggestion.colorReasoning],
            ["Weather", suggestion.reasoning?.weather || suggestion.weatherReasoning],
            ["Occasion", suggestion.reasoning?.occasion || suggestion.occasionReasoning],
          ].filter(([, value]) => value).map(([label, value]) => (
            <div className="deck-card-note" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

// ─── The panel ────────────────────────────────────────────────────────────────
/**
 * Outfit suggestions, dealt one at a time.
 *
 * Two actions, and only two. ♥ saves the outfit *and* records that the
 * suggestion was good; ✕ passes and records the only honest negative the app
 * can collect. There is no separate "Save to outfits" button any more — making
 * someone say "nice" and "I'll wear it" as two clicks split one intention into
 * a chore, and the second click was the one people skipped.
 *
 * A pass is undoable for as long as the toast is up. A ♥ is not: it produced a
 * real outfit in the user's collection, and silently deleting a saved outfit to
 * honour an undo would be a bigger surprise than the mis-tap.
 */
export function SuggestionPanel({ items, onSaveOutfit, onClose }) {
  const closeRef = useRef(null);
  const deckRef = useRef(null);

  const [occasion, setOccasion] = useState("casual");
  const [suggestions, setSuggestions] = useState([]);
  const [index, setIndex] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const [style, setStyle] = useState(null);          // { styleDna, pinCount, minPins }
  const [leaving, setLeaving] = useState(null);      // { index, verdict }
  const [drag, setDrag] = useState(null);            // { dx }
  const [undo, setUndo] = useState(null);            // { index }
  const [burst, setBurst] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const dragState = useRef(null);
  const exitTimer = useRef(null);
  const undoTimer = useRef(null);
  const pendingPass = useRef(null);

  useViewerKeyboard(onClose, closeRef);

  // Recording a preference is always secondary to the action the user asked
  // for, so a failure here is swallowed: the card must not break because a
  // datapoint didn't land.
  const sendSignal = (type, suggestion) => {
    api("/api/preferences/signal", {
      method: "POST",
      body: JSON.stringify({ type, itemIds: suggestion.itemIds, name: suggestion.name }),
    }).catch(() => {});
  };

  // A pass is only recorded once it can no longer be taken back. Posting it
  // immediately and leaving it in the log after an undo would mean a mis-tap
  // the user corrected still counts as a rejection — and a corrected mis-tap is
  // not a signal the user produced.
  const settlePass = useCallback(() => {
    const pending = pendingPass.current;
    pendingPass.current = null;
    if (pending) sendSignal("outfit_passed", pending);
  }, []);

  useEffect(() => () => {
    clearTimeout(exitTimer.current);
    clearTimeout(undoTimer.current);
    // Closing the panel ends the chance to undo, so anything still pending is
    // now a decision the user stood by.
    settlePass();
  }, [settlePass]);

  // What the inspo board says about this user, shown before a single suggestion
  // is generated. Free (it reads a cache) and entirely optional — a board that
  // hasn't been read yet just means no memo line.
  useEffect(() => {
    api("/api/suggestions/style-dna").then(setStyle).catch(() => {});
  }, []);

  const itemMap = useMemo(() => Object.fromEntries(items.map((item) => [item.id, item])), [items]);
  const piecesFor = useCallback(
    (suggestion) => (suggestion?.itemIds || []).map((id) => itemMap[id]).filter(Boolean),
    [itemMap],
  );

  const generate = async () => {
    // A new batch ends the last undo window: the offer has to go before the
    // card it points at is replaced, or a failed generate would leave an undo
    // aimed at a suggestion that no longer exists.
    settlePass();
    clearTimeout(undoTimer.current);
    setUndo(null);
    setGenerating(true);
    setError("");
    try {
      const colorProfile = JSON.parse(localStorage.getItem("open-wardrobe-color-profile-v1") || "null");
      const result = await api("/api/suggestions/generate", {
        method: "POST",
        body: JSON.stringify({ occasion, colorProfile }),
      });
      setSuggestions(result.suggestions || []);
      setIndex(0);
      setLeaving(null);
      if (result.styleDna !== undefined) {
        setStyle({ styleDna: result.styleDna, pinCount: result.pinCount, minPins: result.minPins });
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setGenerating(false);
    }
  };

  // One advance path for every way a card can leave — button, key or swipe — so
  // the animation and the bookkeeping can never disagree about which card is on
  // top.
  const advance = useCallback((verdict) => {
    setDrag(null);
    dragState.current = null;
    setLeaving({ index, verdict });
    clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => {
      setLeaving(null);
      setIndex((current) => current + 1);
    }, prefersReducedMotion() ? 0 : EXIT_MS);
  }, [index]);

  const like = useCallback(async (suggestion) => {
    if (leaving) return;
    setBurst((current) => current + 1);
    setAnnouncement(`Saved ${suggestion.name} to your outfits.`);
    advance("like");
    sendSignal("outfit_liked", suggestion);
    try {
      await onSaveOutfit({ name: suggestion.name, itemIds: suggestion.itemIds, source: "suggestion" });
      setSavedCount((current) => current + 1);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [advance, leaving, onSaveOutfit]);

  const pass = useCallback((suggestion, cardIndex) => {
    if (leaving) return;
    settlePass();                                    // the previous pass stands
    setAnnouncement("Passed.");
    advance("pass");
    pendingPass.current = suggestion;
    setUndo({ index: cardIndex });
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => { settlePass(); setUndo(null); }, UNDO_MS);
  }, [advance, leaving, settlePass]);

  // Deals the passed card again, and drops the pass before it is ever written.
  // The log is append-only precisely so that nothing in it has to be edited
  // later — which only works if what goes into it was real in the first place.
  const undoPass = useCallback(() => {
    if (!undo) return;
    pendingPass.current = null;
    clearTimeout(exitTimer.current);
    clearTimeout(undoTimer.current);
    setLeaving(null);
    setIndex(undo.index);
    setUndo(null);
    setAnnouncement("Brought that one back.");
  }, [undo]);

  const current = suggestions[index] || null;
  const exhausted = suggestions.length > 0 && !current && !leaving;

  // Arrow keys are how a deck wants to be driven, and they make the ♥ cheap to
  // press over and over — which is the entire point of the surface.
  useEffect(() => {
    if (!current) return undefined;
    const onKeyDown = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key === "ArrowRight") { event.preventDefault(); like(current); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); pass(current, index); }
      else if (event.key.toLowerCase() === "z" && undo) { event.preventDefault(); undoPass(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [current, index, like, pass, undo, undoPass]);

  // ─── Drag ───────────────────────────────────────────────────────────────────
  const dragHandlers = {
    onPointerDown: (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      dragState.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, aborted: false };
    },
    onPointerMove: (event) => {
      const state = dragState.current;
      if (!state || state.id !== event.pointerId || state.aborted) return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;

      if (!state.moved) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;   // absorb the jitter in a click
        // A mostly-vertical gesture belongs to the reasoning's scrollbar, not to
        // the deck. Bailing out here — and only capturing the pointer once the
        // gesture is unambiguously sideways — is what lets a card be both
        // swipeable and scrollable.
        if (Math.abs(dx) <= Math.abs(dy)) { state.aborted = true; return; }
        state.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      setDrag({ dx });
    },
    onPointerUp: (event) => {
      const state = dragState.current;
      dragState.current = null;
      if (!state || state.id !== event.pointerId || !state.moved) return;
      const dx = event.clientX - state.x;
      const width = deckRef.current?.offsetWidth || 320;
      if (Math.abs(dx) > width * COMMIT_RATIO) {
        if (dx > 0) like(current); else pass(current, index);
        return;
      }
      setDrag(null);                                  // under the threshold: spring home
    },
    onPointerCancel: () => { dragState.current = null; setDrag(null); },
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  const memo = style?.styleDna
    ? style.styleDna
    : style && style.pinCount < (style.minPins ?? 3)
      ? `Pin ${(style.minPins ?? 3) - style.pinCount} more look${(style.minPins ?? 3) - style.pinCount === 1 ? "" : "s"} to Inspo and these suggestions start reading your board.`
      : null;

  // While a card flies out, the deck behind it is already drawn one position
  // forward — that is what makes the next look rise into its place instead of
  // popping in once the animation has finished. `index` catches up when the
  // exit timer fires, so the very same cards keep the very same keys and no
  // second transition is triggered.
  const deckStart = leaving ? leaving.index + 1 : index;
  const visible = [];
  if (leaving) visible.push({ suggestion: suggestions[leaving.index], key: leaving.index, depth: 0, leaving: leaving.verdict });
  for (let offset = 0; offset < DECK_DEPTH; offset += 1) {
    const cardIndex = deckStart + offset;
    if (!suggestions[cardIndex]) break;
    visible.push({ suggestion: suggestions[cardIndex], key: cardIndex, depth: offset, leaving: null });
  }

  return (
    <ViewerPanel
      title="Suggest Outfits"
      ariaLabel="Outfit suggestions"
      onClose={onClose}
      closeRef={closeRef}
      entryClassName="suggestion-panel-entry"
      panelClassName="suggestion-panel"
    >
      <div className="suggestion-body">
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

        {memo && (
          <div className="style-memo">
            <p className="style-memo-label">
              <Sparkle size={13} weight="fill" aria-hidden="true" />
              What your inspo board says
            </p>
            <p className="style-memo-text">{memo}</p>
          </div>
        )}

        <div className="occasion-picker" role="group" aria-label="Occasion">
          {OCCASIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={occasion === entry.id ? "active" : ""}
              aria-pressed={occasion === entry.id}
              onClick={() => setOccasion(entry.id)}
            >
              <span aria-hidden="true">{entry.emoji}</span> {entry.label}
            </button>
          ))}
        </div>

        {error && <p className="status error">{error}</p>}

        {generating && (
          <div className="deck-placeholder">
            <SpinnerGap size={26} className="outfit-card-spinner" aria-hidden="true" />
            <p>Putting looks together…</p>
          </div>
        )}

        {!generating && !suggestions.length && (
          <div className="deck-placeholder">
            <p>Pick an occasion and get a handful of looks from what you already own.</p>
            <button className="primary-button" type="button" onClick={generate}>
              <MagicWand size={15} weight="bold" aria-hidden="true" /> Generate suggestions
            </button>
          </div>
        )}

        {!generating && suggestions.length > 0 && !exhausted && (
          <>
            <div className="deck" ref={deckRef}>
              {undo && (
                <button type="button" className="deck-undo" onClick={undoPass}>
                  <ArrowCounterClockwise size={15} aria-hidden="true" /> Undo pass
                </button>
              )}
              {visible.map((card) => (
                <SuggestionCard
                  key={card.key}
                  suggestion={card.suggestion}
                  pieces={piecesFor(card.suggestion)}
                  depth={card.depth}
                  leaving={card.leaving}
                  drag={card.depth === 0 && !card.leaving ? drag : null}
                  dragHandlers={dragHandlers}
                />
              ))}
            </div>

            <div className="deck-controls">
              <button
                type="button"
                className="deck-action deck-action--pass"
                onClick={() => current && pass(current, index)}
                disabled={!current}
                aria-label="Pass on this outfit"
                title="Not today  ·  ←"
              >
                <X size={22} weight="bold" aria-hidden="true" />
              </button>

              <p className="deck-count">
                {Math.min(index + 1, suggestions.length)} <span>/ {suggestions.length}</span>
              </p>

              <button
                type="button"
                className="deck-action deck-action--like"
                onClick={() => current && like(current)}
                disabled={!current}
                aria-label="Save this outfit"
                title="Save it  ·  →"
              >
                <Heart size={24} weight="fill" aria-hidden="true" />
                {burst > 0 && <HeartBurst key={burst} id={burst} />}
              </button>
            </div>
          </>
        )}

        {!generating && exhausted && (
          <div className="deck-placeholder deck-done">
            <Sparkle size={24} weight="fill" aria-hidden="true" />
            <p className="deck-done-tally">
              {savedCount
                ? `${savedCount} look${savedCount === 1 ? "" : "s"} saved to your outfits.`
                : "That's the batch."}
            </p>
            <p className="deck-done-sub">Every save and every pass sharpens the next set.</p>
            <button className="primary-button" type="button" onClick={generate}>
              <MagicWand size={15} weight="bold" aria-hidden="true" /> Deal me more
            </button>
          </div>
        )}

      </div>
    </ViewerPanel>
  );
}
