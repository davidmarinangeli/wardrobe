import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Lightbulb, Palette, PencilSimple, Plus, Sparkle, SpinnerGap, X } from "@phosphor-icons/react";
import { CheckCircle } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { api } from "./api.js";
import { GARMENT_PART_MAP } from "../shared/garments.mjs";
import { OUTFIT_MAX_PIECES } from "../shared/outfit-rules.mjs";
import { migrateOutfit, resolveOutfitPieces } from "../shared/wardrobe-model.mjs";
import { GenerateButton, RefineComposer, StageChip, StageError, StageStatus, useRememberedTier } from "./components/ModelPhotoControls.jsx";
import { SuggestionPanel } from "./suggestions.jsx";
import { OutfitStack } from "./components/OutfitStack.jsx";
import { PiecePicker } from "./components/PiecePicker.jsx";
import { ViewerFooter, ViewerPanel } from "./components/ViewerPanel.jsx";
import { ModeledHero } from "./components/ModeledHero.jsx";
import { PanelActions } from "./components/PanelActions.jsx";
import { EditableTitle } from "./components/EditableTitle.jsx";
import { PageStatus } from "./components/PageStatus.jsx";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import { useWornToday } from "./hooks/useWornToday.js";
import { updateBrowserSet, useBrowserState } from "./browser-state.js";
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
    return <OptimizedImage key={item.id} className="outfit-card-hover-piece outfit-card-solo-piece" src={item.image || item.thumbnail} alt="" style={style} />;
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
    return <OptimizedImage key={item.id} className="outfit-card-hover-piece" src={item.image || item.thumbnail} alt="" style={style} />;
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

// What a lineup change wipes (scripts/outfits-api.mjs normalizeOutfit), naming
// only what this outfit has. Null when there's nothing to lose.
function clearedOnSave(outfit) {
  const parts = [
    outfit?.modeledImage && "the model photo",
    outfit?.description && "the style notes",
    outfit?.tags?.length && "the tags",
  ].filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// Create and edit both go through the shared picker; the name and its error
// live here, in the picker's footer.
function OutfitPicker({ items, outfit, onCancel, onSave }) {
  const [name, setName] = useState(outfit?.name || "");
  const [error, setError] = useState("");
  // Snapshot at mount. `items` holds active pieces only (App.jsx): retired or
  // deleted pieces can't be shown, so they are dropped on save, and the notice
  // says so. The lineup then changes, so the server also clears the modeled
  // photo, description and tags (scripts/outfits-api.mjs normalizeOutfit).
  const [{ initialSelection, missing }] = useState(() => {
    const all = outfit ? migrateOutfit(outfit, items).pieces : [];
    const ids = new Set(items.map((item) => item.id));
    const initialSelection = all.filter((piece) => ids.has(piece.itemId));
    return { initialSelection, missing: all.length - initialSelection.length };
  });

  // Rejecting (not returning quietly) keeps the picker open and opens its
  // phone tray, where this error is shown.
  const save = async (pieces) => {
    setError("");
    const fail = (message) => { setError(message); throw new Error(message); };
    if (!name.trim()) fail("Give this outfit a name.");
    if (!pieces.length) fail("Pick at least one piece.");
    try {
      await onSave({ name: name.trim(), pieces });
    } catch (saveError) {
      fail(saveError.message || "Could not save this outfit.");
    }
  };

  return (
    <PiecePicker
      title={outfit ? "Edit outfit" : "New outfit"}
      items={items}
      initialSelection={initialSelection}
      rules="outfit"
      confirmLabel="Save"
      minPieces={0}
      maxPieces={OUTFIT_MAX_PIECES}
      notice={missing > 0 && (
        <p className="piece-picker__notice">
          {missing === 1 ? "1 piece is" : `${missing} pieces are`} no longer in your wardrobe and will be removed when you save.
          {clearedOnSave(outfit) && ` Saving also clears ${clearedOnSave(outfit)}, made for the old lineup.`}
        </p>
      )}
      renderPreview={(selectedPieces) => <OutfitStack items={selectedPieces} emptyMessage="Pick pieces to build the look." />}
      footer={(
        <>
          <label className="field">
            <span>Name</span>
            <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Saturday errands" />
          </label>
          {error && <p className="status error outfit-error" role="alert">{error}</p>}
        </>
      )}
      onConfirm={save}
      onClose={onCancel}
    />
  );
}

function OutfitCard({ outfit, itemMap, onOpen, wornToday, wearReady, onWear }) {
  const pieces = resolveOutfitPieces(outfit, itemMap);
  const hasModeledImage = Boolean(outfit.modeledImage);
  const processing = outfit.modeledStatus === "processing";

  // The card is one big button, so the wear control cannot live inside it —
  // nested buttons are invalid and the inner one would never receive a click.
  // It sits alongside as a real button and is positioned over the art by CSS.
  return (
    <div className="outfit-card-wrap">
    <button type="button" className="outfit-card" onClick={(event) => onOpen(outfit.id, event.currentTarget)} aria-label={`View ${outfit.name}`}>
      <div className={`outfit-card-art${processing ? " is-processing" : ""}`}>
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
        {/* Hidden from assistive tech: the card's aria-label already names it. */}
        <span className="outfit-card-caption" aria-hidden="true">
          <span className="outfit-card-name">{outfit.name}</span>
        </span>
      </div>
    </button>
    <button
      type="button"
      className={`secondary-button button--sm button--on-media outfit-worn-btn${wornToday ? " is-worn" : ""}`}
      onClick={() => wearReady && !wornToday && onWear(outfit)}
      disabled={!wearReady || wornToday}
      aria-busy={!wearReady || undefined}
      aria-pressed={wornToday}
      aria-label={wornToday ? `${outfit.name}: logged as worn today` : `Log ${outfit.name} as worn today`}
      title={wornToday ? "Worn today" : "I wore this today"}
    >
      <CheckCircle size={16} weight={wornToday ? "fill" : "regular"} aria-hidden="true" />
      <span className="outfit-worn-btn__label">{wornToday ? "Worn" : "Wore it"}</span>
    </button>
    </div>
  );
}

function OutfitViewer({ outfit, itemMap, onClose, onEdit, onDelete, onGenerateModeled, onRename, premiumAllowed, provider, openedFrom, wornToday, wearReady, onWear }) {
  const closeButtonRef = useRef(null);
  const pieces = resolveOutfitPieces(outfit, itemMap);
  // Retired or deleted pieces: itemMap holds active pieces only.
  const missing = migrateOutfit(outfit).pieces.filter((piece) => !itemMap[piece.itemId]).length;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [generateError, setGenerateError] = useState("");
  // The chip the refine composer grows out of and shrinks back into.
  const refineChipRef = useRef(null);
  const { tier, tiers, chooseTier, tierReady, tierStateError } = useRememberedTier(provider, premiumAllowed);
  const hasModeledImage = Boolean(outfit.modeledImage);
  const processing = outfit.modeledStatus === "processing";
  // The server refuses a photo of pieces that left the wardrobe.
  const photoHint = missing > 0 ? "Edit the outfit first" : undefined;

  useViewerKeyboard(onClose, closeButtonRef);

  const generate = async (chosenTier) => {
    setBusy(true);
    setGenerateError("");
    try {
      await onGenerateModeled(outfit, chosenTier, note.trim());
      setNote("");
      setRefining(false);
    } catch (error) {
      setGenerateError(error.message || "Could not start generating a model photo.");
    } finally {
      setBusy(false);
    }
  };

  // Where the photo's action goes: on the photo, the way the item sheet does
  // it. Making the first one is the accent pill; another go at an existing one
  // is a glass chip that opens the note, because refining with a note is the
  // point of regenerating an outfit.
  const mediaAction = processing ? (
    <StageStatus>Generating model photo…</StageStatus>
  ) : hasModeledImage ? (
    <StageChip
      ref={refineChipRef}
      icon={<ArrowCounterClockwise size={15} weight="bold" aria-hidden="true" />}
      label="Refine photo"
      onClick={() => setRefining(true)}
      disabled={missing > 0}
      title={photoHint}
      concealed={refining}
    />
  ) : (
    <GenerateButton
      icon={<Sparkle size={16} weight="bold" aria-hidden="true" />}
      label="Generate model photo"
      tone="secondary"
      busy={busy}
      disabled={!tierReady || missing > 0}
      title={photoHint}
      onGenerate={generate}
      tier={tier}
      tiers={tiers}
      onTierChange={chooseTier}
      premiumAllowed={premiumAllowed}
      tierStateError={tierStateError}
    />
  );

  return (
    <ViewerPanel
      onClose={onClose}
      closeRef={closeButtonRef}
      openedFrom={openedFrom}
      ariaLabel={`Outfit: ${outfit.name}`}
      panelClassName={hasModeledImage ? "has-modeled-image" : undefined}
      compactTitle={outfit.name || "Outfit"}
    >
      {hasModeledImage ? (
        <ModeledHero src={outfit.modeledImage} alt={`${outfit.name} worn by a model`} showHeading={false}>
          {mediaAction && <div className="stage-action">{mediaAction}</div>}
          <RefineComposer
            open={refining && !processing}
            onClose={() => setRefining(false)}
            originRef={refineChipRef}
            note={note}
            onNoteChange={setNote}
            busy={busy}
            onGenerate={generate}
            tier={tier}
            tiers={tiers}
            onTierChange={chooseTier}
            premiumAllowed={premiumAllowed}
            disabled={!tierReady}
            tone="secondary"
          />
        </ModeledHero>
      ) : (
        // The flat-lay clips its scattered pieces to its rounded square; the
        // action sits outside that clip so the quality menu, which opens
        // upward out of it, is not cut off by the corners.
        <div className="outfit-viewer-stage">
          <div className="viewer-art outfit-viewer-art">
            {pieces.length ? (
              <OutfitFlatLay outfitId={outfit.id} pieces={pieces} />
            ) : (
              <OutfitStack items={pieces} />
            )}
          </div>
          {mediaAction && <div className="stage-action">{mediaAction}</div>}
        </div>
      )}

      <div className="viewer-details editing">
        {(generateError || outfit.modeledStatus === "error") && (
          <StageError message={generateError || outfit.modeledError} />
        )}

        {/* Same heading block as the item sheet: the name, then the one line
            that says what this is. */}
        <header className="item-heading outfit-heading">
          <EditableTitle
            value={outfit.name}
            placeholder="Outfit"
            onChange={(name) => onRename(outfit, name)}
            ariaLabel="Outfit name"
          />
          {outfit.description && <p className="outfit-style-description">{outfit.description}</p>}
        </header>
        {/* Style is a property of the outfit, so it is a row like the item's
            Category, Colors and Tags: key on the left, value on the right. It
            opens nothing, so it has no chevron. */}
        {outfit.description && !!outfit.tags?.length && (
          <dl className="detail-rows viewer-section">
            <div className="detail-row detail-row--static">
              <dt className="detail-row__label">Style</dt>
              <dd className="detail-row__value detail-row__tags outfit-style-tags">
                {outfit.tags.map((tag) => <span key={tag} className="outfit-style-tag">{tag}</span>)}
              </dd>
            </div>
          </dl>
        )}
        {missing > 0 && (
          <p className="outfit-outdated">
            {pieces.length
              ? `Out of date: ${missing === 1 ? "1 piece is" : `${missing} pieces are`} no longer in your wardrobe. Edit the outfit first to remove ${missing === 1 ? "it" : "them"}, then make a new photo.`
              : "Out of date: none of this outfit’s pieces are in your wardrobe any more. Delete it, or Edit to pick new pieces."}
            {hasModeledImage && " The photo shows the old pieces."}
          </p>
        )}
        <section className="viewer-section outfit-viewer-pieces" aria-label="Pieces">
          <p className="details-label">Pieces · {pieces.length}</p>
          <div className="outfit-viewer-pieces-grid">
            {pieces.map((item) => (
              <div className="outfit-viewer-piece-tile" key={item.id} title={item.name}>
                <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="72px" breakpoints={[72, 108]} />
              </div>
            ))}
          </div>
        </section>

        <ViewerFooter>
          <PanelActions
            onDelete={() => onDelete(outfit.id)}
            deleteLabel="Delete outfit"
            deleteConfirmLabel="Tap again to delete"
            onCancel={() => onEdit(outfit)}
            cancelLabel={<><PencilSimple size={15} weight="regular" aria-hidden="true" /> Edit</>}
            onConfirm={() => wearReady && !wornToday && onWear(outfit)}
            confirmDisabled={!wearReady || wornToday}
            confirmIcon={<CheckCircle size={15} weight={wornToday ? "fill" : "regular"} aria-hidden="true" />}
            confirmLabel={wornToday ? "Worn today" : "Wore it today"}
          />
        </ViewerFooter>
      </div>
    </ViewerPanel>
  );
}

// One nudge at a time, on the page gutter, with the action it is asking for
// attached to it. A nudge that only names a button you have to go find is a
// notification, not a nudge — so the colour one opens the quiz itself. The
// wardrobe-coverage nudges carry no button on purpose: the only "add" control
// is the primary in the top bar, and a button pointing at another button is the
// same problem wearing a different hat.
function SuggestionNudges({ items, colorProfile, onOpenColorQuiz }) {
  const [dismissError, setDismissError] = useState("");
  const browserState = useBrowserState();
  const dismissed = useMemo(() => new Set(browserState.state?.dismissedNudges || []), [browserState.state?.dismissedNudges]);

  const dismiss = async (id) => {
    if (!browserState.ready) return;
    setDismissError("");
    try {
      await updateBrowserSet("dismissedNudges", id, true);
    } catch (error) {
      setDismissError(error.message);
    }
  };

  if (!items || !browserState.ready) return (dismissError || browserState.error?.message)
    ? <p className="status error" role="alert">{dismissError || browserState.error.message}</p>
    : null;

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

  if (!nudges.length) return dismissError ? <p className="status error" role="alert">{dismissError}</p> : null;

  const nudge = nudges[0];

  return (
    <aside className="nudge-banner" key={nudge.id}>
      {dismissError && <p className="status error" role="alert">{dismissError}</p>}
      <span className="nudge-banner__icon" aria-hidden="true">
        {nudge.icon === 'palette' ? <Palette size={16} weight="regular" /> : <Sparkle size={16} weight="regular" />}
      </span>
      <p className="nudge-banner__message">{nudge.msg}</p>
      {nudge.actionLabel && nudge.onAction && (
        <button type="button" className="secondary-button nudge-banner__action" onClick={nudge.onAction}>
          {nudge.actionLabel}
        </button>
      )}
      <button type="button" className="icon-button button--sm nudge-banner__dismiss" onClick={() => dismiss(nudge.id)} disabled={!browserState.ready} aria-label="Dismiss">
        <X size={16} />
      </button>
    </aside>
  );
}

// The Outfits section of Overview (see overview.jsx). Its header row owns
// + Outfit and Suggest outfit; the top bar keeps the shared import + Mirror.
// showBuilder opens the shared PiecePicker (through OutfitPicker), and
// builderOutfit is the outfit being edited, or null for a new one. All of it
// is local: an archive change remounts the whole app shell, which resets it.
export function OutfitsSection({ items, premiumAllowed = true, provider = null, colorProfile, onOpenColorQuiz, openOutfitId, onOutfitOpened, archiveGeneration }) {
  const [outfits, setOutfits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [builderOutfit, setBuilderOutfit] = useState(null);
  const { isWornToday, logWear, error: wearError, ready: wearReady } = useWornToday();
  const [viewingOutfitId, setViewingOutfitId] = useState(null);
  const [openedFrom, setOpenedFrom] = useState(null);

  useEffect(() => {
    api("/api/outfits")
      .then(setOutfits)
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [archiveGeneration]);

  // Arriving from a wardrobe piece ("in 3 looks" -> this outfit). The id is set
  // before this section has finished loading its outfits, which is fine: the
  // viewer renders off a lookup that simply finds nothing until the list arrives.
  useEffect(() => {
    if (!openOutfitId) return;
    setViewingOutfitId(openOutfitId);
    setOpenedFrom(null);
    onOutfitOpened?.();
  }, [openOutfitId, onOutfitOpened]);

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
  // The wear signal is per piece; pieces no longer in the wardrobe weren't worn.
  const wearOutfit = (outfit) => logWear({ ...outfit, itemIds: (outfit.itemIds || []).filter((id) => itemMap[id]) });

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

  // The picker's ViewerPanel captures the focused trigger (Chrome focuses a
  // button on click) and hands focus back to it on close.
  const openNewOutfit = () => {
    if (!items.length) return;
    setBuilderOutfit(null);
    setShowBuilder(true);
  };
  const openEditOutfit = (outfit) => { setViewingOutfitId(null); setBuilderOutfit(outfit); setShowBuilder(true); };
  const openSuggestions = () => setShowSuggestions(true);
  // builderOutfit resets on every close so a stale edit target never lingers
  // into the next "new". Edit is only reachable from the viewer, so closing
  // an edit (saved or not) goes back to that viewer, like "back".
  const closeBuilder = () => {
    const returnId = builderOutfit?.id;
    setBuilderOutfit(null);
    setShowBuilder(false);
    if (returnId) { setOpenedFrom(null); setViewingOutfitId(returnId); }
  };

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
    <section className="outfits-section" aria-labelledby="outfits-section-title">
      <header className="overview-panel-head">
        <h2 id="outfits-section-title">Outfits{!loading && <> <span>{outfits.length}</span></>}</h2>
        <div className="overview-panel-head__actions">
          {/* Explicit aria-label: the label span is display:none at phone width. */}
          <button
            type="button"
            className="top-action top-action--secondary ai-action"
            onClick={openSuggestions}
            disabled={items.length < 5}
            aria-haspopup="dialog"
            aria-label="Suggest outfit"
          >
            <Lightbulb size={17} weight="bold" aria-hidden="true" />
            <span className="top-action__label">Suggest outfit</span>
            <span className="ai-action-beam-mask" aria-hidden="true">
              <span className="ai-action-beam" />
            </span>
          </button>
          <button
            type="button"
            className="primary-button overview-panel-head__add"
            onClick={openNewOutfit}
            disabled={!items.length}
            aria-haspopup="dialog"
            title={items.length ? undefined : "Add pieces to your wardrobe first"}
            aria-label={items.length ? "New outfit" : "New outfit, Add pieces to your wardrobe first"}
          ><Plus size={16} weight="bold" aria-hidden="true" /> Outfit</button>
        </div>
      </header>

      <SuggestionNudges items={items} colorProfile={colorProfile} onOpenColorQuiz={onOpenColorQuiz} />

      <PageStatus
        loading={loading}
        error={error || wearError}
        empty={!items.length}
        emptyMessage="Import some wardrobe pieces first, then come back to build outfits."
        filterEmpty={!!items.length && !outfits.length}
        filterEmptyMessage="No outfits yet — combine pieces from your wardrobe into a look."
        noun="outfits"
      />

      {!!outfits.length && (
        <section className="outfits-grid">
          {outfits.map((outfit) => (
            <OutfitCard
              key={outfit.id}
              outfit={outfit}
              itemMap={itemMap}
              onOpen={(id, element) => { setOpenedFrom(element); setViewingOutfitId(id); }}
              wornToday={isWornToday(outfit.id)}
              wearReady={wearReady}
              onWear={wearOutfit}
            />
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
          provider={provider}
          wornToday={isWornToday(viewingOutfit.id)}
          wearReady={wearReady}
          onWear={wearOutfit}
        />
      )}

      {/* + Outfit is disabled with no pieces; an edit still renders so it can be closed. */}
      {showBuilder && (items.length > 0 || builderOutfit) && (
        <OutfitPicker key={builderOutfit?.id || "new"} items={items} outfit={builderOutfit} onCancel={closeBuilder} onSave={saveOutfit} />
      )}

      {showSuggestions && (
        <SuggestionPanel
          items={items}
          onSaveOutfit={async (draft) => {
            const saved = await api("/api/outfits", { method: "POST", body: JSON.stringify(draft) });
            setOutfits((current) => [...current, saved]);
            return saved;
          }}
          onClose={() => setShowSuggestions(false)}
        />
      )}
    </section>
  );
}
