import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, Copy, HandHeart, Tag, ArrowCounterClockwise, Check } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import { GARMENT_PART_MAP } from "../shared/garments.mjs";
// Pure — style-rules only reaches into shared/, never into node — so the client
// can name a colour the same way the server does rather than keeping a second,
// slightly different list of colour names that would eventually disagree.
import { classifyColor } from "../scripts/style-rules.mjs";
import "./declutter.css";

const KEPT_KEY = "open-wardrobe-declutter-kept-v1";

function readKept() {
  try { return new Set(JSON.parse(localStorage.getItem(KEPT_KEY) || "[]")); }
  catch { return new Set(); }
}

/** The listing text, in the order a marketplace form asks for it. */
export function listingText(item) {
  const part = GARMENT_PART_MAP[item.part]?.label;
  const colors = [item.color, item.secondaryColor]
    .filter(Boolean)
    .map((hex) => classifyColor(hex).name)
    .filter((name, index, all) => name && all.indexOf(name) === index);

  return [
    item.name,
    [part, colors.join(" and ")].filter(Boolean).join(" · "),
    item.tags?.length ? `Details: ${item.tags.join(", ")}` : null,
  ].filter(Boolean).join("\n");
}

function PieceThumb({ item }) {
  if (!item) return <div className="declutter-thumb" aria-hidden="true" />;
  return (
    <div className="declutter-thumb">
      <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="96px" breakpoints={[96, 144]} />
    </div>
  );
}

/**
 * The locked half of the feature — a real screen, not an empty state.
 *
 * It exists because hiding declutter until the log is deep enough makes the
 * "Wore it" button look pointless: nothing visibly depends on it. Saying plainly
 * what the app cannot know yet, and showing the weak evidence clearly marked as
 * weak, turns the wait into a path.
 */
function LockedState({ wear, itemsById, onGoToOutfits }) {
  const preview = wear.provisional.slice(0, 8);

  return (
    <div className="declutter-locked">
      <p className="declutter-lede">
        I know what you own. I don&rsquo;t yet know what you <em>wear</em>.
      </p>

      <div className="declutter-progress">
        <div
          className="declutter-progress__track"
          role="progressbar"
          aria-valuenow={wear.loggedDays}
          aria-valuemin={0}
          aria-valuemax={wear.daysNeeded}
          aria-label={`${wear.loggedDays} of ${wear.daysNeeded} days logged`}
        >
          <span
            className="declutter-progress__fill"
            style={{ inlineSize: `${Math.min(100, (wear.loggedDays / wear.daysNeeded) * 100)}%` }}
          />
        </div>
        <p className="declutter-progress__label">
          {wear.loggedDays} of {wear.daysNeeded} days logged
        </p>
      </div>

      <p className="declutter-hint">
        Tap <strong>Wore it</strong> on an outfit each time you wear one.
      </p>

      <button type="button" className="primary-button declutter-cta" onClick={onGoToOutfits}>
        Go to outfits <ArrowSquareOut size={15} weight="regular" aria-hidden="true" />
      </button>

      {!!preview.length && (
        <div className="declutter-provisional">
          <h3 className="declutter-provisional__heading">Never styled</h3>
          <p className="declutter-provisional__caveat">Which isn&rsquo;t the same as never worn.</p>
          <ul className="declutter-provisional__list">
            {preview.map((entry) => (
              <li key={entry.id} className="declutter-provisional__item">
                <PieceThumb item={itemsById[entry.id]} />
                <span className="declutter-provisional__name">{entry.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One candidate at a time. Keep is a decision, not a skip. */
function TriageDeck({ candidates, itemsById, onDecide }) {
  if (!candidates.length) {
    return (
      <div className="declutter-empty">
        <p>Nothing is going unworn.</p>
      </div>
    );
  }

  const [current] = candidates;
  const item = itemsById[current.id];

  return (
    <div className="declutter-deck">
      <p className="declutter-deck__count">
        {candidates.length} {candidates.length === 1 ? "piece" : "pieces"} to review
      </p>

      <div className="declutter-card">
        {item ? (
          <div className="declutter-card__art">
            <OptimizedImage src={item.modeledImage || item.image} alt={item.name} sizes="(max-width: 700px) 70vw, 320px" breakpoints={[220, 320, 440]} />
          </div>
        ) : <div className="declutter-card__art" aria-hidden="true" />}

        <h3 className="declutter-card__name">{current.name}</h3>
        <p className="declutter-card__reason">{current.reason}</p>
      </div>

      <div className="declutter-actions">
        <button type="button" className="secondary-button" onClick={() => onDecide(current.id, "keep")}>
          <Check size={15} weight="regular" aria-hidden="true" /> Keep
        </button>
        <button type="button" className="secondary-button" onClick={() => onDecide(current.id, "sell")}>
          <Tag size={15} weight="regular" aria-hidden="true" /> Sell
        </button>
        <button type="button" className="secondary-button" onClick={() => onDecide(current.id, "donate")}>
          <HandHeart size={15} weight="regular" aria-hidden="true" /> Donate
        </button>
      </div>

    </div>
  );
}

function Pile({ title, empty, items, onRestore }) {
  const [copied, setCopied] = useState(null);

  const copy = async (item) => {
    try {
      await navigator.clipboard.writeText(listingText(item));
      setCopied(item.id);
      setTimeout(() => setCopied((id) => (id === item.id ? null : id)), 1600);
    } catch { /* clipboard blocked; the text is still visible on the card */ }
  };

  if (!items.length) return <div className="declutter-pile"><h3>{title}</h3><p className="declutter-note">{empty}</p></div>;

  return (
    <div className="declutter-pile">
      <div className="declutter-pile__head">
        <h3>{title} <span className="declutter-pile__count">{items.length}</span></h3>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${title.toLowerCase().replace(/\s+/g, "-")}-pile.json`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export
        </button>
      </div>

      <ul className="declutter-pile__list">
        {items.map((item) => (
          <li key={item.id} className="declutter-pile__item">
            <PieceThumb item={item} />
            <div className="declutter-pile__text">
              <span className="declutter-pile__name">{item.name}</span>
              <span className="declutter-pile__meta">{GARMENT_PART_MAP[item.part]?.label}</span>
            </div>
            <button type="button" className="declutter-icon-btn" onClick={() => copy(item)} title="Copy listing text" aria-label={`Copy listing text for ${item.name}`}>
              {copied === item.id ? <Check size={15} weight="bold" /> : <Copy size={15} weight="regular" />}
            </button>
            <button type="button" className="declutter-icon-btn" onClick={() => onRestore(item.id)} title="Put back in wardrobe" aria-label={`Put ${item.name} back in the wardrobe`}>
              <ArrowCounterClockwise size={15} weight="regular" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The declutter session.
 *
 * Nothing here deletes anything. A piece leaves the wardrobe you dress from and
 * goes into a pile you can empty at your own pace, or put straight back — the
 * outfits it appears in are history and stay exactly as they were.
 */
export function DeclutterPanel({ wear, itemsById, retiredItems, onSetStatus, onClose, onGoToOutfits }) {
  const closeRef = useRef(null);
  // Escape, and focus landing on the close button — the same contract every
  // other panel signs. This one was rendering without it.
  useViewerKeyboard(onClose, closeRef);

  const [tab, setTab] = useState("review");
  const [kept, setKept] = useState(readKept);

  const decide = useCallback(async (id, decision) => {
    if (decision === "keep") {
      // A kept piece is a judgement the user already made; asking again next
      // session would be the app forgetting, not being thorough.
      setKept((current) => {
        const next = new Set(current).add(id);
        try { localStorage.setItem(KEPT_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
        return next;
      });
      return;
    }
    await onSetStatus(id, decision);
  }, [onSetStatus]);

  const candidates = useMemo(
    () => (wear?.candidates || []).filter((entry) => !kept.has(entry.id)),
    [wear, kept],
  );

  const sell = retiredItems.filter((item) => item.status === "sell");
  const donate = retiredItems.filter((item) => item.status === "donate");
  const hasPiles = sell.length + donate.length > 0;

  return (
    <ViewerPanel
      title="Declutter"
      ariaLabel="Declutter your wardrobe"
      onClose={onClose}
      closeRef={closeRef}
      entryClassName="declutter-entry"
    >
      <div className="declutter-body">
        {!wear && <p className="declutter-note">Loading…</p>}

        {wear && (hasPiles || wear.unlocked) && (
          <div className="declutter-tabs" role="tablist" aria-label="Declutter sections">
            <button type="button" role="tab" aria-selected={tab === "review"} className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>
              Review
            </button>
            <button type="button" role="tab" aria-selected={tab === "piles"} className={tab === "piles" ? "active" : ""} onClick={() => setTab("piles")}>
              Piles {hasPiles && <span className="declutter-pile__count">{sell.length + donate.length}</span>}
            </button>
          </div>
        )}

        {!wear ? null : tab === "review" ? (
          wear.unlocked
            ? <TriageDeck candidates={candidates} itemsById={itemsById} onDecide={decide} />
            : <LockedState wear={wear} itemsById={itemsById} onGoToOutfits={onGoToOutfits} />
        ) : (
          <div className="declutter-piles">
            <Pile title="To sell" empty="Nothing here yet." items={sell} onRestore={(id) => onSetStatus(id, "active")} />
            <Pile title="To give away" empty="Nothing here yet." items={donate} onRestore={(id) => onSetStatus(id, "active")} />
          </div>
        )}
      </div>
    </ViewerPanel>
  );
}
