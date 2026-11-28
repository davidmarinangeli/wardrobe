import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CaretUp, Check } from "@phosphor-icons/react";
import { OptimizedImage } from "../OptimizedImage.jsx";
import { CATEGORY_LABEL, WARDROBE_TYPES } from "../categories.js";
import { useIsPhone } from "../hooks/useIsPhone.js";
import { ViewerPanel } from "./ViewerPanel.jsx";
import { ConfirmDialog } from "./ConfirmDialog.jsx";
import { blockedCoverages, blockedReason } from "../../shared/outfit-rules.mjs";
import { buildOverviewIndex, filterByPart, filterByTags, filterOverviewIndex, overviewSuggestions, overviewTagKey as tagKey } from "../../shared/overview-index.mjs";
import { normalizePieceSelection, selectionChanged } from "../../shared/piece-selection.mjs";
import { initialVariantForPiece, variantImage, variantOwnImage } from "../../shared/wardrobe-model.mjs";
import "./piece-picker.css";

/**
 * Full-screen picker for choosing wardrobe pieces (and how each is worn).
 *
 * Owns the selection, search, category and tag filters; knows nothing about
 * what the pieces are for beyond `rules`. The caller owns saving and its error
 * message: the picker never closes itself, so on success the caller unmounts
 * it, and a rejected `onConfirm` keeps it open (and opens the phone tray, where
 * the caller's footer lives).
 *
 * Props
 * ─────
 * title             string  – Heading and dialog label.
 * items             array   – Wardrobe items to choose from.
 * initialSelection  array   – [{ itemId, variantId }], read once at mount.
 *                             Unknown items are not shown and not counted.
 * rules             "outfit"|null – "outfit" greys out pieces the selection's
 *                             coverage rules out (see shared/outfit-rules.mjs).
 * renderPreview     fn      – (selectedPieces) => node; pieces carry variantId/image/thumbnail.
 * confirmLabel      string  – Confirm button label.
 * minPieces         number  – Confirm is disabled below this count.
 * maxPieces         number  – Once this many are picked, unpicked pieces are
 *                             blocked and a notice says why (default: no cap).
 * notice            node    – Shown above the grid (e.g. why the selection
 *                             differs from what was saved).
 * footer            node    – Rendered under the preview (e.g. a name field and error).
 * onConfirm         fn      – ([{ itemId, variantId }]) => maybe a promise.
 * onClose           fn      – Called once the picker may close.
 */
export function PiecePicker({
  title,
  items,
  initialSelection = [],
  rules = null,
  renderPreview,
  confirmLabel = "Done",
  minPieces = 1,
  maxPieces = Infinity,
  notice,
  footer,
  onConfirm,
  onClose,
}) {
  const isPhone = useIsPhone();
  // A snapshot: the caller may re-render with fresh objects (outfit polling),
  // and re-seeding from them would wipe what the user has picked so far.
  const [baseline] = useState(() => normalizePieceSelection(initialSelection, items));
  const [selected, setSelected] = useState(() => new Map(baseline.map((piece) => [piece.itemId, piece.variantId])));
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [activeTags, setActiveTags] = useState([]);
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const searchRef = useRef(null);
  const closeRef = useRef(null);
  const returnFocusRef = useRef(null);
  const mountedRef = useRef(false);
  const trayId = useId();

  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const index = useMemo(() => buildOverviewIndex(items), [items]);
  const visible = useMemo(
    () => filterByTags(filterByPart(filterOverviewIndex(index, query), category), activeTags),
    [index, query, category, activeTags],
  );
  const tagSuggestions = useMemo(() => overviewSuggestions(items), [items]);
  // Active chips first, in the order they were turned on. One that no longer
  // matches any piece still shows (count 0), or it could never be turned off.
  const tagChips = useMemo(() => {
    const byKey = new Map(tagSuggestions.map((chip) => [tagKey(chip.tag), chip]));
    const activeKeys = new Set(activeTags.map(tagKey));
    return [
      ...activeTags.map((tag) => byKey.get(tagKey(tag)) || { tag, count: 0 }),
      ...tagSuggestions.filter((chip) => !activeKeys.has(tagKey(chip.tag))),
    ];
  }, [tagSuggestions, activeTags]);

  const selectedPieces = useMemo(() => [...selected].flatMap(([itemId, variantId]) => {
    const item = itemsById.get(itemId);
    if (!item) return [];
    const image = variantImage(item, variantId);
    return [{ ...item, variantId, image, thumbnail: image }];
  }), [selected, itemsById]);
  const count = selectedPieces.length;
  const pieces = useMemo(() => selectedPieces.map(({ id, variantId }) => ({ itemId: id, variantId })), [selectedPieces]);
  const hasChanges = selectionChanged(baseline, pieces);
  const coverage = rules === "outfit" ? blockedCoverages(selectedPieces) : null;
  const atLimit = count >= maxPieces;
  const canConfirm = !pending && count >= minPieces && count <= maxPieces;

  const focusDefault = () => {
    // On a phone the close button, so opening the picker doesn't pop the
    // keyboard; never leave focus on the trigger behind this modal.
    (isPhone ? closeRef : searchRef).current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    mountedRef.current = true;
    const frame = requestAnimationFrame(focusDefault);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(frame);
    };
    // Mount only: later breakpoint changes must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (item) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, initialVariantForPiece(item));
      return next;
    });
  };

  const selectVariant = (itemId, variantId) => setSelected((current) => new Map(current).set(itemId, variantId));

  const toggleTag = (tag) => {
    const key = tagKey(tag);
    setActiveTags((current) => current.some((active) => tagKey(active) === key)
      ? current.filter((active) => tagKey(active) !== key)
      : [...current, tag]);
  };

  const clearFilters = () => {
    setQuery("");
    setCategory("all");
    setActiveTags([]);
    focusDefault();
  };

  const confirm = async () => {
    if (!canConfirm) return;
    setPending(true);
    try {
      await onConfirm(pieces);
    } catch {
      // The caller's error lives in the footer, which a collapsed phone tray hides.
      if (mountedRef.current) setTrayOpen(true);
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  // Shared by the X, the overlay (through ViewerPanel) and Escape.
  const requestClose = () => {
    if (pending || confirmOpen) return false;
    if (hasChanges) {
      returnFocusRef.current = document.activeElement;
      setConfirmOpen(true);
      return false;
    }
    return true;
  };

  const keepPicking = () => {
    setConfirmOpen(false);
    requestAnimationFrame(() => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected && target.closest(".piece-picker-panel")) target.focus({ preventScroll: true });
      else focusDefault();
    });
  };

  const discard = () => {
    setConfirmOpen(false);
    onClose();
  };

  // ViewerPanel has no Escape handling, and useViewerKeyboard would close
  // without asking. Window capture + stopImmediatePropagation so a panel
  // underneath (the cheat sheet editor) never sees the key.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (confirmOpen) keepPicking();
      else if (!pending && requestClose()) onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen, pending, hasChanges, isPhone, onClose]);

  const hasSide = Boolean(renderPreview || footer);
  const confirmButton = (
    <button
      type="button"
      className="primary-button piece-picker__confirm"
      onClick={confirm}
      disabled={!canConfirm}
      aria-busy={pending || undefined}
    >
      {confirmLabel}
    </button>
  );

  return (
    <ViewerPanel
      ariaLabel={title}
      onClose={onClose}
      onRequestClose={requestClose}
      closeRef={closeRef}
      overlayClassName="piece-picker-overlay"
      entryClassName="piece-picker-entry"
      panelClassName="piece-picker-panel"
      focusTrap
      swipeToClose={false}
      closeDisabled={pending || confirmOpen}
    >
      <div className="piece-picker" inert={confirmOpen || undefined}>
        <header className="piece-picker__header">
          <h2 className="piece-picker__title">{title}</h2>
          <span className="piece-picker__close-spacer" aria-hidden="true" />
        </header>

        <div className="piece-picker__filters">
          <input
            ref={searchRef}
            className="piece-picker__search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search pieces"
            placeholder="Search by name, color, fabric, tag…"
            enterKeyHint="search"
            autoComplete="off"
          />
          <div className="piece-picker__chips" role="group" aria-label="Filter by category">
            {WARDROBE_TYPES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`piece-picker__chip${category === entry.id ? " is-active" : ""}`}
                aria-pressed={category === entry.id}
                onClick={() => setCategory(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {tagChips.length > 0 && (
            <div className="piece-picker__chips piece-picker__tags" role="group" aria-label="Filter by tag">
              {tagChips.map((chip) => {
                const active = activeTags.some((tag) => tagKey(tag) === tagKey(chip.tag));
                return (
                  <button
                    key={tagKey(chip.tag)}
                    type="button"
                    className={`piece-picker__chip${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => toggleTag(chip.tag)}
                  >
                    #{chip.tag} <span className="piece-picker__chip-count">{chip.count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Always mounted, so the limit notice is announced when it appears. */}
        <div className="piece-picker__notices" aria-live="polite">
          {notice}
          {atLimit && (
            <p className="piece-picker__notice">
              {count > maxPieces
                ? `That’s more than the limit of ${maxPieces} pieces. Remove ${count - maxPieces} to save.`
                : `That’s the limit of ${maxPieces} pieces. Remove one to pick another.`}
            </p>
          )}
        </div>

        <div className="piece-picker__body">
          <section className="piece-picker__grid-pane" aria-label="Wardrobe pieces">
            {visible.length ? (
              <div className="piece-picker__grid">
                {visible.map(({ item }) => {
                  const isSelected = selected.has(item.id);
                  // Only unselected pieces are ever blocked: a picked piece must
                  // never grey itself out (see shared/outfit-rules.mjs).
                  const reason = isSelected ? null
                    : (coverage && blockedReason(item, coverage)) || (atLimit ? `already ${maxPieces} pieces picked` : null);
                  const blocked = Boolean(reason);
                  const variantId = selected.get(item.id) ?? item.defaultVariantId;
                  return (
                    <div key={item.id} className={`piece-picker__card${isSelected ? " is-selected" : ""}${blocked ? " is-blocked" : ""}`}>
                      <button
                        type="button"
                        className="card card--tile"
                        data-part={item.part}
                        aria-pressed={isSelected}
                        aria-disabled={blocked || undefined}
                        title={blocked ? `${item.name} — ${reason}` : item.name}
                        onClick={() => !blocked && toggle(item)}
                      >
                        <span className="card__art">
                          <OptimizedImage src={variantImage(item, variantId)} alt="" sizes="(max-width: 860px) 33vw, 160px" />
                          <span className="card__check" aria-hidden="true"><Check size={13} weight="bold" /></span>
                        </span>
                        {/* Singular, like every other card's meta ("Top", not "Tops"). */}
                        <span className="card__caption">
                          <span className="card__name">{item.name || "Untitled piece"}</span>
                          <span className="card__meta">{WARDROBE_TYPES.find((type) => type.id === item.part)?.singular || "Other"}</span>
                        </span>
                      </button>
                      {/* Outside the card button: nested buttons are invalid. */}
                      {isSelected && item.variants?.length > 1 && (
                        <div className="piece-picker__variants" role="group" aria-label={`How to wear ${item.name}`}>
                          {item.variants.map((variant) => {
                            const thumbnail = variantOwnImage(item, variant.id);
                            const active = selected.get(item.id) === variant.id;
                            return (
                              <button
                                key={variant.id}
                                type="button"
                                className={active ? "is-active" : ""}
                                aria-pressed={active}
                                title={variant.name}
                                aria-label={variant.name}
                                onClick={() => selectVariant(item.id, variant.id)}
                              >
                                {thumbnail
                                  ? <OptimizedImage src={thumbnail} alt="" sizes="40px" breakpoints={[40, 60, 80]} />
                                  : <span className="piece-picker__variant-pending" aria-hidden="true">{variant.name?.slice(0, 1)}</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="piece-picker__empty">
                <p>No pieces match</p>
                <button type="button" className="secondary-button" onClick={clearFilters}>Clear filters</button>
              </div>
            )}
          </section>

          {hasSide && (
            <aside className={`piece-picker__side${trayOpen ? " is-open" : ""}`}>
              {/* On a phone the tray's own bar is the picker's footer: what is
                  selected (and opens the tray) on the left, the primary action
                  rightmost. One bar, not a tray stacked on a footer. First in the DOM, so
                  Tab reaches the toggle before what it opens; CSS `order` puts it
                  at the foot of the tray. */}
              {isPhone && (
                <div className="piece-picker__tray-bar">
                  <button
                    type="button"
                    className="piece-picker__tray-toggle"
                    aria-expanded={trayOpen}
                    aria-controls={trayId}
                    onClick={() => setTrayOpen((open) => !open)}
                  >
                    <span>{count} selected</span>
                    <CaretUp size={16} weight="bold" aria-hidden="true" className="piece-picker__tray-caret" />
                  </button>
                  {confirmButton}
                </div>
              )}
              <div id={trayId} className="piece-picker__side-content" hidden={isPhone && !trayOpen}>
                {renderPreview && <div className="piece-picker__preview">{renderPreview(selectedPieces)}</div>}
                {footer && <div className="piece-picker__footer">{footer}</div>}
              </div>
            </aside>
          )}
        </div>

        {/* The action row, fixed under the panes like every panel's footer:
            what is selected on the left, the primary action rightmost. On a
            phone the tray bar above takes this role. */}
        {!(isPhone && hasSide) && (
          <footer className="piece-picker__actions">
            <span className="piece-picker__count" aria-live="polite">{count} selected</span>
            <span className="action-spacer" />
            {confirmButton}
          </footer>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          eyebrow="Unsaved changes"
          title="Discard this selection?"
          description="Your changes to the selected pieces haven’t been saved."
          keepLabel="Keep editing"
          discardLabel="Discard changes"
          onKeep={keepPicking}
          onDiscard={discard}
        />
      )}
    </ViewerPanel>
  );
}
