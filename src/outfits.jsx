import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Palette, PencilSimple, Sparkle, SpinnerGap, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { api } from "./api.js";
import { OUTFIT_CATEGORIES as CATEGORIES } from "./categories.js";
import { GARMENT_PART_MAP } from "../shared/garments.mjs";
import { ModeledPhotoPrompt } from "./item-editor.jsx";
import { SuggestionPanel } from "./suggestions.jsx";
import { OutfitStack } from "./components/OutfitStack.jsx";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { ModeledHero } from "./components/ModeledHero.jsx";
import { PanelActions } from "./components/PanelActions.jsx";
import { EditableTitle } from "./components/EditableTitle.jsx";
import { PageShell } from "./components/PageShell.jsx";
import { PageStatus } from "./components/PageStatus.jsx";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import "./outfits.css";
import "./suggestions.css";

// Fixed spots (per body part) where a hovered card scatters its composing
// pieces. Mirrors the flat-lay layout from the OutfitStack zones
// (see components/OutfitStack.jsx).
const HOVER_SLOTS = {
  upperbody: [
    { top: "6%", left: "8%", maxH: "50%", maxW: "42%", rot: -6 },
    { top: "6%", right: "8%", maxH: "50%", maxW: "42%", rot: 6 },
  ],
  wholebody_up: [
    { top: "6%", left: "8%", maxH: "50%", maxW: "42%", rot: -6 },
    { top: "6%", right: "8%", maxH: "50%", maxW: "42%", rot: 6 },
  ],
  lowerbody: [
    { bottom: "6%", right: "8%", maxH: "50%", maxW: "42%", rot: 6 },
    { bottom: "6%", left: "8%", maxH: "50%", maxW: "42%", rot: -6 },
  ],
  // Full-length pieces get the tall centre of the card, since they are the
  // whole outfit rather than one half of it.
  dress: [
    { top: "8%", left: "50%", maxH: "78%", maxW: "46%", rot: -3 },
    { top: "8%", right: "10%", maxH: "78%", maxW: "46%", rot: 4 },
  ],
  jumpsuit: [
    { top: "8%", left: "50%", maxH: "78%", maxW: "46%", rot: -3 },
    { top: "8%", right: "10%", maxH: "78%", maxW: "46%", rot: 4 },
  ],
  skirt: [
    { bottom: "6%", right: "8%", maxH: "46%", maxW: "42%", rot: 6 },
    { bottom: "6%", left: "8%", maxH: "46%", maxW: "42%", rot: -6 },
  ],
  shorts: [
    { bottom: "6%", right: "8%", maxH: "40%", maxW: "40%", rot: 6 },
    { bottom: "6%", left: "8%", maxH: "40%", maxW: "40%", rot: -6 },
  ],
  bodysuit: [
    { top: "6%", left: "8%", maxH: "50%", maxW: "42%", rot: -6 },
    { top: "6%", right: "8%", maxH: "50%", maxW: "42%", rot: 6 },
  ],
  shoes: [
    { bottom: "8%", left: "16%", maxH: "24%", maxW: "30%", rot: -4 },
    { bottom: "8%", right: "16%", maxH: "24%", maxW: "30%", rot: 4 },
  ],
  socks: [
    { bottom: "32%", left: "22%", maxH: "18%", maxW: "24%", rot: -3 },
    { bottom: "32%", right: "22%", maxH: "18%", maxW: "24%", rot: 3 },
  ],
  accessories_up: [
    { top: "8%", right: "12%", maxH: "26%", maxW: "28%", rot: 8 },
    { top: "8%", left: "12%", maxH: "26%", maxW: "28%", rot: -8 },
  ],
};

// Deterministic hash -> [0,1), used to jitter pieces that overflow their
// predefined slot so the same outfit always scatters the same way.
function hash01(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function hoverSlot(part, indexAmongPart, outfitId, itemId) {
  const slots = HOVER_SLOTS[part] || HOVER_SLOTS.upperbody;
  const base = slots[indexAmongPart % slots.length];
  if (indexAmongPart < slots.length) return base;

  const jitterX = (hash01(`${outfitId}:${itemId}:x`) - 0.5) * 16;
  const jitterY = (hash01(`${outfitId}:${itemId}:y`) - 0.5) * 10;
  const jitterR = (hash01(`${outfitId}:${itemId}:r`) - 0.5) * 12;

  const slot = { ...base };
  if (slot.top != null) slot.top = `${parseFloat(slot.top) + jitterY}%`;
  if (slot.bottom != null) slot.bottom = `${parseFloat(slot.bottom) - jitterY}%`;
  if (slot.left != null) slot.left = `${parseFloat(slot.left) + jitterX}%`;
  if (slot.right != null) slot.right = `${parseFloat(slot.right) - jitterX}%`;
  slot.rot = (slot.rot || 0) + jitterR;
  slot.maxH = `${parseFloat(slot.maxH) * 0.82}%`;
  slot.maxW = `${parseFloat(slot.maxW) * 0.82}%`;
  return slot;
}

// Shared by both the hover-reveal (over a photo) and always-on (no photo
// yet) scatter layouts below — same slots, same per-piece element, just a
// different wrapper class controlling whether it starts hidden or visible.
function scatteredPieces(outfitId, pieces) {
  if (pieces.length === 1) {
    const item = pieces[0];
    const isFull = item.part === "dress" || item.part === "jumpsuit";
    const style = {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      maxHeight: isFull ? "82%" : "68%",
      maxWidth: "68%",
    };
    return <img key={item.id} className="outfit-card-hover-piece outfit-card-solo-piece" src={item.image || item.thumbnail} alt="" style={style} />;
  }
  const seenByPart = {};
  return pieces.map((item) => {
    const part = item.part || "upperbody";
    const index = (seenByPart[part] = (seenByPart[part] || 0) + 1) - 1;
    const slot = hoverSlot(part, index, outfitId, item.id);
    const style = { "--rot": `${slot.rot}deg`, maxHeight: slot.maxH, maxWidth: slot.maxW };
    if (slot.top != null) style.top = slot.top;
    if (slot.bottom != null) style.bottom = slot.bottom;
    if (slot.left != null) style.left = slot.left;
    if (slot.right != null) style.right = slot.right;
    return <img key={item.id} className="outfit-card-hover-piece" src={item.image || item.thumbnail} alt="" style={style} />;
  });
}

// Scattered garment cutouts revealed on hover, layered over a faded hero photo.
function OutfitHoverPieces({ outfitId, pieces }) {
  return <div className="outfit-card-hover-pieces">{scatteredPieces(outfitId, pieces)}</div>;
}

// Same scattered flat-lay, but the permanent content for outfits with no
// modeled photo yet — there's nothing to reveal pieces *over*, so they're
// visible from the start. The card still lifts and the pieces still get a
// hover flourish (see .outfit-card-flatlay in outfits.css), so hovering an
// unphotographed outfit feels like the same family of interaction, not a
// dead card next to lively ones.
function OutfitFlatLay({ outfitId, pieces }) {
  return <div className="outfit-card-flatlay">{scatteredPieces(outfitId, pieces)}</div>;
}

function OutfitBuilder({ items, initialOutfit, onCancel, onSave }) {
  const [name, setName] = useState(initialOutfit?.name || "");
  const [selected, setSelected] = useState(() => new Set(initialOutfit?.itemIds || []));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const itemsByCategory = useMemo(() => {
    const groups = Object.fromEntries(CATEGORIES.map((category) => [category.id, []]));
    for (const item of items) if (groups[item.part]) groups[item.part].push(item);
    return groups;
  }, [items]);

  const toggleItem = (itemId) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const selectedItems = items.filter((item) => selected.has(item.id));

  // A dress or jumpsuit already dresses both halves, so the halves it covers
  // stop being available — and once a top or bottom is picked, a full garment
  // no longer fits the outfit either. Blocking the combination here is kinder
  // than letting someone build dress-plus-trousers and discover it in the
  // rendered photo.
  // Layering pieces are exempt in both directions: a jacket goes over a shirt or
  // over a dress equally well, so it never blocks and is never blocked.
  const blockedCoverages = useMemo(() => {
    const coverages = new Set(
      selectedItems
        .filter((item) => !GARMENT_PART_MAP[item.part]?.layer)
        .map((item) => GARMENT_PART_MAP[item.part]?.coverage),
    );
    if (coverages.has("full")) return new Set(["upper", "lower"]);
    if (coverages.has("upper") || coverages.has("lower")) return new Set(["full"]);
    return new Set();
  }, [selectedItems]);

  const isBlocked = (item) => {
    const part = GARMENT_PART_MAP[item.part];
    if (!part || part.layer) return false;
    return blockedCoverages.has(part.coverage);
  };

  const save = async () => {
    setError("");
    if (!name.trim()) return setError("Give this outfit a name.");
    if (!selectedItems.length) return setError("Pick at least one piece.");
    setSaving(true);
    try {
      await onSave({ name: name.trim(), itemIds: [...selected] });
    } catch (saveError) {
      setError(saveError.message);
      setSaving(false);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="viewer-entry outfit-builder-entry">
        <aside className="viewer outfit-builder" role="dialog" aria-modal="true" aria-label={initialOutfit ? "Edit outfit" : "New outfit"}>
          <button className="icon-button viewer-icon-close" type="button" onClick={onCancel} aria-label="Close">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading">
            <h2>{initialOutfit ? "Edit Outfit" : "New Outfit"}</h2>
          </div>

          <div className="outfit-builder-body">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Saturday errands" />
            </label>

            <OutfitStack items={selectedItems} />

            {CATEGORIES.map((category) => (
              itemsByCategory[category.id].length > 0 && (
                <div className="outfit-category" key={category.id}>
                  <p className="outfit-category-label">{category.label}</p>
                  <div className="outfit-category-row">
                    {itemsByCategory[category.id].map((item) => {
                      const blocked = !selected.has(item.id) && isBlocked(item);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`outfit-piece${selected.has(item.id) ? " active" : ""}${blocked ? " blocked" : ""}`}
                          onClick={() => !blocked && toggleItem(item.id)}
                          aria-pressed={selected.has(item.id)}
                          aria-disabled={blocked}
                          title={blocked
                            ? `${item.name} — a full-length piece already covers this`
                            : item.name}
                        >
                          <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="72px" breakpoints={[72, 108]} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )
            ))}

            {error && <p className="status error outfit-error">{error}</p>}

            <div className="viewer-actions">
              <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
              <span className="action-spacer" />
              <button className="primary-button" type="button" onClick={save} disabled={saving}>
                <Check size={15} weight="bold" aria-hidden="true" /> Save
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function OutfitCard({ outfit, itemMap, onOpen }) {
  const pieces = outfit.itemIds.map((id) => itemMap[id]).filter(Boolean);
  const hasModeledImage = Boolean(outfit.modeledImage);
  const processing = outfit.modeledStatus === "processing";

  return (
    <button type="button" className="outfit-card" onClick={(event) => onOpen(outfit.id, event.currentTarget)} aria-label={`View ${outfit.name}`}>
      <div className="outfit-card-art">
        {hasModeledImage ? (
          <>
            <div className="outfit-card-hero">
              <OptimizedImage src={outfit.modeledImage} alt={`${outfit.name} worn by a model`} sizes="(max-width: 520px) 44vw, 300px" breakpoints={[220, 320, 440, 600]} />
            </div>
            {!!pieces.length && <OutfitHoverPieces outfitId={outfit.id} pieces={pieces} />}
          </>
        ) : pieces.length ? (
          <OutfitFlatLay outfitId={outfit.id} pieces={pieces} />
        ) : (
          <OutfitStack items={pieces} />
        )}
        {processing && (
          <div className="outfit-card-processing">
            <p className="outfit-card-status"><SpinnerGap size={13} className="outfit-card-spinner" aria-hidden="true" /> Generating model photo…</p>
          </div>
        )}
      </div>
      <p className="outfit-card-name">{outfit.name}</p>
    </button>
  );
}

function OutfitViewer({ outfit, itemMap, onClose, onEdit, onDelete, onGenerateModeled, onRename, premiumAllowed, openedFrom }) {
  const closeButtonRef = useRef(null);
  const pieces = outfit.itemIds.map((id) => itemMap[id]).filter(Boolean);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const hasModeledImage = Boolean(outfit.modeledImage);
  const processing = outfit.modeledStatus === "processing";

  useViewerKeyboard(onClose, closeButtonRef);

  const generate = async (tier) => {
    setBusy(true);
    try {
      await onGenerateModeled(outfit, tier, note.trim());
      setNote("");
    } catch {
      // surfaced via outfit.modeledError once the request settles
    } finally {
      setBusy(false);
    }
  };

  return (
    <ViewerPanel
      onClose={onClose}
      closeRef={closeButtonRef}
      openedFrom={openedFrom}
      ariaLabel={`Outfit: ${outfit.name}`}
      panelClassName={hasModeledImage ? "has-modeled-image" : undefined}
    >
      {hasModeledImage ? (
        <ModeledHero src={outfit.modeledImage} alt={`${outfit.name} worn by a model`} showHeading={false} />
      ) : (
        <div className="viewer-art outfit-viewer-art">
          {pieces.length ? (
            <OutfitFlatLay outfitId={outfit.id} pieces={pieces} />
          ) : (
            <OutfitStack items={pieces} />
          )}
        </div>
      )}

      <div className="viewer-details editing">
        <EditableTitle
          value={outfit.name}
          placeholder="Outfit"
          onChange={(name) => onRename(outfit, name)}
          ariaLabel="Outfit name"
        />
        {outfit.description && (
          <div className="outfit-style-summary">
            <p className="outfit-style-description">{outfit.description}</p>
            {!!outfit.tags?.length && (
              <div className="outfit-style-tags">
                {outfit.tags.map((tag) => <span key={tag} className="outfit-style-tag">{tag}</span>)}
              </div>
            )}
          </div>
        )}
        <p className="details-label">{pieces.length} {pieces.length === 1 ? "piece" : "pieces"}</p>
        <div className="outfit-viewer-pieces-grid">
          {pieces.map((item) => (
            <div className="outfit-viewer-piece-tile" key={item.id} title={item.name}>
              <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="72px" breakpoints={[72, 108]} />
            </div>
          ))}
        </div>

        {processing ? (
          <p className="outfit-card-status"><SpinnerGap size={13} className="outfit-card-spinner" aria-hidden="true" /> Generating model photo…</p>
        ) : (
          <ModeledPhotoPrompt
            status={outfit.modeledStatus}
            error={outfit.modeledError}
            busy={busy}
            onGenerate={generate}
            premiumAllowed={premiumAllowed}
            hasImage={hasModeledImage}
            initialTier={outfit.modeledTier || "standard"}
            note={note}
            onNoteChange={setNote}
          />
        )}

        <PanelActions
          onDelete={() => onDelete(outfit.id)}
          onCancel={() => onEdit(outfit)}
          cancelLabel={<><PencilSimple size={15} weight="regular" aria-hidden="true" /> Edit</>}
        />
      </div>
    </ViewerPanel>
  );
}

const NUDGE_DISMISS_KEY = "open-wardrobe-nudges-dismissed-v1";

function readDismissedNudges() {
  try {
    const value = JSON.parse(localStorage.getItem(NUDGE_DISMISS_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

// One nudge at a time, on the page gutter, with the action it is asking for
// attached to it. A nudge that only names a button you have to go find is a
// notification, not a nudge — so the colour one opens the quiz itself. The
// wardrobe-coverage nudges carry no button on purpose: the only "add" control
// is the primary in the top bar, and a button pointing at another button is the
// same problem wearing a different hat.
function SuggestionNudges({ items, colorProfile, onOpenColorQuiz }) {
  const [dismissed, setDismissed] = useState(readDismissedNudges);

  const dismiss = (id) => setDismissed((current) => {
    const next = new Set(current).add(id);
    // Persisted, so a dismissal survives a reload. A banner that comes back
    // every time the page mounts is how a nudge turns into nagging.
    try { localStorage.setItem(NUDGE_DISMISS_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });

  if (!items) return null;

  // Coverage, not category: a wardrobe of dresses can already make complete
  // outfits, so telling it that it "has no bottoms" would be both wrong and a
  // criticism of a wardrobe that is working fine.
  const coverages = new Set(items.map((i) => GARMENT_PART_MAP[i.part]?.coverage));
  const hasTops = coverages.has('upper') || coverages.has('full');
  const hasBottoms = coverages.has('lower') || coverages.has('full');

  const nudges = [];

  if (items.length < 15 && !dismissed.has('few-items')) {
    nudges.push({ id: 'few-items', msg: "Add more clothes to your wardrobe for better outfit suggestions" });
  } else if (!hasBottoms && !dismissed.has('no-bottoms')) {
    nudges.push({ id: 'no-bottoms', msg: "You don't have any bottoms yet. Add some for complete outfits." });
  } else if (!hasTops && !dismissed.has('no-tops')) {
    nudges.push({ id: 'no-tops', msg: "You don't have any tops yet. Add some for complete outfits." });
  } else if (!colorProfile && !dismissed.has('no-color')) {
    nudges.push({
      id: 'no-color',
      icon: 'palette',
      msg: "Know your colors and every suggestion can match your skin tone",
      actionLabel: "Take the quiz",
      onAction: onOpenColorQuiz,
    });
  }

  if (!nudges.length) return null;

  const nudge = nudges[0];

  return (
    <aside className="nudge-banner" key={nudge.id}>
      <span className="nudge-banner__icon" aria-hidden="true">
        {nudge.icon === 'palette' ? <Palette size={16} weight="regular" /> : <Sparkle size={16} weight="regular" />}
      </span>
      <p className="nudge-banner__message">{nudge.msg}</p>
      {nudge.actionLabel && nudge.onAction && (
        <button type="button" className="secondary-button nudge-banner__action" onClick={nudge.onAction}>
          {nudge.actionLabel}
        </button>
      )}
      <button type="button" className="nudge-banner__dismiss" onClick={() => dismiss(nudge.id)} aria-label="Dismiss">
        <X size={16} />
      </button>
    </aside>
  );
}

// Add outfit / Suggest outfit trigger from the topbar (see App.jsx's
// .top-actions) — showBuilder/showSuggestions are controlled from there so
// there's exactly one "add" and one "AI action" button per view, not a
// second pair duplicated on the page itself. builderOutfit (which outfit,
// if any, is being edited) stays local — the topbar doesn't need to know.
export function Outfits({ items, premiumAllowed = true, colorProfile, onOpenColorQuiz, showBuilder, onOpenBuilder, onCloseBuilder, showSuggestions, onCloseSuggestions }) {
  const [outfits, setOutfits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [builderOutfit, setBuilderOutfit] = useState(null);
  const [viewingOutfitId, setViewingOutfitId] = useState(null);
  const [openedFrom, setOpenedFrom] = useState(null);

  useEffect(() => {
    api("/api/outfits")
      .then(setOutfits)
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const hasProcessingOutfit = outfits.some((outfit) => outfit.modeledStatus === "processing");

  // Depend only on the boolean (not the whole outfits array) so the interval isn't torn down
  // and recreated on every 1.5s poll tick just because the poll's own setOutfits call below
  // changes the outfits array reference.
  useEffect(() => {
    if (!hasProcessingOutfit) return undefined;
    const timer = setInterval(() => {
      api("/api/outfits")
        .then((fresh) => {
          const freshById = Object.fromEntries(fresh.map((outfit) => [outfit.id, outfit]));
          setOutfits((current) => current.map((outfit) => {
            const next = freshById[outfit.id];
            return next ? { ...outfit, modeledImage: next.modeledImage, modeledStatus: next.modeledStatus, modeledError: next.modeledError, modeledTier: next.modeledTier, description: next.description, tags: next.tags } : outfit;
          }));
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [hasProcessingOutfit]);

  const itemMap = useMemo(() => Object.fromEntries(items.map((item) => [item.id, item])), [items]);

  const generateOutfitModeled = async (outfit, tier, prompt) => {
    const response = await fetch(`/api/outfits/${outfit.id}/modeled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, prompt }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Could not start generating a model photo.");
    setOutfits((current) => current.map((item) => item.id === outfit.id
      ? { ...item, modeledStatus: value.modeledStatus, modeledError: value.modeledError, modeledTier: value.modeledTier }
      : item));
  };

  const openEditOutfit = (outfit) => { setViewingOutfitId(null); setBuilderOutfit(outfit); onOpenBuilder(); };
  // The topbar's "Add outfit" opens the same builder directly (see App.jsx),
  // bypassing openEditOutfit entirely — so builderOutfit must reset to null
  // on every close, or a stale edit target would linger into the next "new".
  const closeBuilder = () => { setBuilderOutfit(null); onCloseBuilder(); };

  const saveOutfit = async (draft) => {
    const saved = builderOutfit
      ? await api(`/api/outfits/${builderOutfit.id}`, { method: "PATCH", body: JSON.stringify(draft) })
      : await api("/api/outfits", { method: "POST", body: JSON.stringify(draft) });
    setOutfits((current) => builderOutfit
      ? current.map((outfit) => outfit.id === saved.id ? saved : outfit)
      : [...current, saved]);
    closeBuilder();
  };

  const deleteOutfit = async (id) => {
    try {
      await api(`/api/outfits/${id}`, { method: "DELETE" });
      setOutfits((current) => current.filter((outfit) => outfit.id !== id));
      setViewingOutfitId((current) => current === id ? null : current);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const renameOutfit = async (outfit, name) => {
    if (!name) return;
    try {
      const saved = await api(`/api/outfits/${outfit.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setOutfits((current) => current.map((item) => item.id === saved.id ? saved : item));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const viewingOutfit = outfits.find((outfit) => outfit.id === viewingOutfitId) || null;

  return (
    <PageShell
      count={outfits.length}
      noun="outfit"
    >
      <PageStatus
        loading={loading}
        error={error}
        empty={!items.length}
        emptyMessage="Import some wardrobe pieces first, then come back to build outfits."
        filterEmpty={!!items.length && !outfits.length}
        filterEmptyMessage="No outfits yet — combine pieces from your wardrobe into a look."
        noun="outfits"
      />

      <SuggestionNudges items={items} colorProfile={colorProfile} onOpenColorQuiz={onOpenColorQuiz} />

      {!!outfits.length && (
        <section className="outfits-grid">
          {outfits.map((outfit) => (
            <OutfitCard key={outfit.id} outfit={outfit} itemMap={itemMap} onOpen={(id, element) => { setOpenedFrom(element); setViewingOutfitId(id); }} />
          ))}
        </section>
      )}

      {viewingOutfit && (
        <OutfitViewer
          outfit={viewingOutfit}
          openedFrom={openedFrom}
          itemMap={itemMap}
          onClose={() => setViewingOutfitId(null)}
          onEdit={openEditOutfit}
          onDelete={deleteOutfit}
          onGenerateModeled={generateOutfitModeled}
          onRename={renameOutfit}
          premiumAllowed={premiumAllowed}
        />
      )}

      {showBuilder && <OutfitBuilder items={items} initialOutfit={builderOutfit} onCancel={closeBuilder} onSave={saveOutfit} />}

      {showSuggestions && (
        <SuggestionPanel
          items={items}
          onSaveOutfit={async (draft) => {
            const saved = await api("/api/outfits", { method: "POST", body: JSON.stringify(draft) });
            setOutfits((current) => [...current, saved]);
            return saved;
          }}
          onClose={onCloseSuggestions}
        />
      )}
    </PageShell>
  );
}
