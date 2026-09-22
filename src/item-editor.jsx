import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowCounterClockwise, CaretDown, CaretRight, Check, DotsThree, ImageSquare, PencilLine, Plus, Sparkle, SpinnerGap, Star, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import { useDismiss } from "./hooks/useDismiss.js";
import { useSheetGesture } from "./hooks/useSheetGesture.js";
import { useIsPhone } from "./hooks/useIsPhone.js";
import { useExpandOrigin } from "./hooks/useExpandOrigin.js";
import { ModeledHero } from "./components/ModeledHero.jsx";
import { EditableTitle } from "./components/EditableTitle.jsx";
import { WARDROBE_TYPES as TYPES, TYPE_MAP } from "./categories.js";
import { itemVariant, variantImage, variantModeledImage, variantOwnImage } from "../shared/wardrobe-model.mjs";
import { galleryVariantIndex, galleryVariantPhotos, isPeekGesture } from "./gallery-variants.js";
import { DEFAULT_ITEM_COLOR, changedDraftFields, itemMenuActions, itemMetaLine, unsavedLabel } from "./item-sheet.js";
import { GenerateButton, RefineComposer, StageStatus, useRememberedTier } from "./components/ModelPhotoControls.jsx";
import { moveMenuFocus, useDismissOnOutsidePointer } from "./hooks/usePopover.js";

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
  reader.readAsDataURL(file);
});

// Memoised. Opening or closing a sheet is an App render, and without this every
// card in the grid re-rendered with it — ~300 of them, in the same frames the
// sheet's exit spring and the page's scale-back were trying to animate. Both call
// sites pass a stable onOpen, so only the cards whose `selected` flipped render.
export const GalleryItem = memo(function GalleryItem({ item, index, selected, onOpen, outfitCount = 0 }) {
  const peek = useRef(null);
  // Set the moment a drag clears PEEK_SLOP, read by the click that follows it.
  // A ref rather than state: the click handler needs the value synchronously in
  // the same gesture, and re-rendering on it would fight the image cross-fade.
  const peeked = useRef(false);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  const variantPhotos = useMemo(() => galleryVariantPhotos(item), [item]);
  // One photo is not a carousel: no dots, no gesture, no aria position.
  const canPeek = variantPhotos.length > 1;
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";
  // A piece in four looks is a different piece from one in none, and the grid
  // used to render them identically. The count rides the type line rather than
  // becoming a badge: the card's whole premise is a clean cutout on cream, and
  // this is the first mark the grid would carry. Zero says nothing — a piece in
  // no outfits is normal, especially early.
  const outfitLabel = outfitCount ? `in ${outfitCount} ${outfitCount === 1 ? "look" : "looks"}` : "";

  useEffect(() => {
    setActivePhotoIndex(0);
    peek.current = null;
    peeked.current = false;
  }, [variantPhotos]);

  // A mouse peeks on hover; a finger peeks by dragging. The shipped version
  // returned early on anything but a mouse, which left the whole feature
  // nonexistent on phones — the shape this app is mostly used in.
  const armHoverPeek = (event) => {
    if (!canPeek || event.pointerType !== "mouse") return;
    peek.current = { bounds: event.currentTarget.getBoundingClientRect(), clientX: event.clientX, dragging: false };
  };

  const armDragPeek = (event) => {
    if (!canPeek || event.pointerType === "mouse") return;
    peeked.current = false;
    peek.current = {
      bounds: event.currentTarget.getBoundingClientRect(),
      clientX: event.clientX,
      originX: event.clientX,
      dragging: true,
    };
    // Capture, so a finger that slides past the card's edge keeps steering it
    // instead of silently dropping the gesture mid-swipe.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const movePeek = (event) => {
    const current = peek.current;
    if (!current || current.clientX === event.clientX) return;
    if (current.dragging && isPeekGesture(current.originX, event.clientX)) peeked.current = true;
    current.clientX = event.clientX;
    setActivePhotoIndex(galleryVariantIndex(event.clientX, current.bounds, variantPhotos.length));
  };

  // A mouse leaving means the peek is over, so the card returns to its default
  // presentation. A finger lifting does not: the swipe was deliberate, and
  // snapping back would read as the gesture having failed. What it swiped to is
  // what the tap then opens.
  const endPeek = (event) => {
    const current = peek.current;
    if (!current) return;
    if (current.dragging) {
      peek.current = null;
      return;
    }
    if (event?.pointerType === "mouse" || !event) {
      peek.current = null;
      setActivePhotoIndex(0);
    }
  };

  const stepPeek = (event) => {
    if (!canPeek) return;
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    setActivePhotoIndex((current) => Math.max(0, Math.min(variantPhotos.length - 1, current + delta)));
  };

  const activeVariantId = variantPhotos[activePhotoIndex]?.variantId;
  const peekPosition = canPeek ? ` — showing ${activePhotoIndex + 1} of ${variantPhotos.length} ways to wear it` : "";

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      onClick={(event) => {
        // The release of a swipe is not a tap. Without this, every peek on a
        // phone would also open the sheet.
        if (peeked.current) {
          peeked.current = false;
          return;
        }
        // Open on what the card is actually showing, so a peeked variant is the
        // one the sheet lands on rather than snapping back to the default.
        onOpen(item.id, event.currentTarget, activeVariantId);
      }}
      onKeyDown={stepPeek}
      aria-label={`View ${item.name || type}${outfitLabel ? ` — ${outfitLabel}` : ""}${peekPosition}`}
      aria-pressed={selected}
      data-part={item.part}
      // Stagger is capped: past the first screenful the delay would only ever
      // fire off-screen, so it just adds latency to scrolling into view.
      style={{ "--stagger-index": Math.min(index, 11) }}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <span
        className="gallery-item__art"
        // Only the art takes the gesture. The label below stays an ordinary tap
        // target, and `touch-action: pan-y` in CSS keeps the page scrollable
        // vertically through the card.
        data-peekable={canPeek ? "" : undefined}
        onPointerEnter={armHoverPeek}
        onPointerDown={armDragPeek}
        onPointerMove={movePeek}
        onPointerUp={endPeek}
        onPointerLeave={endPeek}
        onPointerCancel={endPeek}
      >
        <span className="gallery-item__variant-stack" aria-hidden="true">
          {variantPhotos.map((photo, photoIndex) => (
            <OptimizedImage
              key={photo.variantId}
              className={`gallery-item__variant-image${photoIndex === activePhotoIndex ? " is-active" : ""}`}
              src={photo.image}
              alt=""
              sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 220px"
              breakpoints={[120, 180, 240, 320, 480]}
            />
          ))}
        </span>
      </span>
      {/* The dots are what make the gesture discoverable, and they carry the
          count the type line used to spell out in words. */}
      {canPeek && (
        <span className="gallery-item__peek-dots" aria-hidden="true">
          {variantPhotos.map((photo, photoIndex) => (
            <span key={photo.variantId} className={`gallery-item__peek-dot${photoIndex === activePhotoIndex ? " is-active" : ""}`} />
          ))}
        </span>
      )}
      <span className="gallery-item__label">
        <span className="gallery-item__name">{item.name || type}</span>
        <span className="gallery-item__type">
          {type}
          {outfitLabel && <span className="gallery-item__outfits"> · {outfitLabel}</span>}
        </span>
      </span>
    </button>
  );
});

export function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" className="icon-button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`Remove ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="Add a detail"
          aria-label="Add detail tag"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="Add detail">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>Optional</small>
        </div>
        <p>No distinct secondary color detected.</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>Add secondary color</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>Remove</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Choose ${label.toLowerCase()}`}
        />
        <span className="selected-color-copy">
          <small>Selected</small>
          <strong>{value || "Custom"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>Image suggestions</span>
        <small>Click to apply</small>
      </div>
      <div className="palette" aria-label={`${label} suggestions from image`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`Use ${color} as ${label.toLowerCase()}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "Cancel picking" : `Pick ${label.toLowerCase()} from image`}
      </button>
    </div>
  );
}

// The other half of the answer: the grid says how many, this says which, with
// enough of each look to recognise it. Tapping one lands on the outfit itself
// rather than on a filtered grid.
function OutfitsWithItem({ outfits, onOpen }) {
  // Zero is not an error state, so it is not a state at all here.
  if (!outfits.length) return null;

  return (
    <section className="item-outfits">
      <p className="details-label">Outfits · {outfits.length}</p>
      <div className="item-outfits__row">
        {outfits.map((outfit) => (
          <button
            type="button"
            key={outfit.id}
            className="item-outfits__card"
            onClick={() => onOpen(outfit.id)}
            aria-label={`Open outfit: ${outfit.name || "Outfit"}`}
          >
            <span className="item-outfits__art">
              {outfit.modeledImage ? (
                <OptimizedImage src={outfit.modeledImage} alt="" sizes="76px" breakpoints={[76, 152]} />
              ) : (
                // No model photo yet — the pieces themselves read well enough at
                // this size, and they are already loaded for the grid behind.
                <span className="item-outfits__pieces">
                  {outfit.pieces.slice(0, 3).map((piece) => (
                    <img key={piece.id} src={piece.thumbnail || piece.image} alt="" loading="lazy" />
                  ))}
                </span>
              )}
            </span>
            <span className="item-outfits__name">{outfit.name || "Outfit"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ─── Item sheet ──────────────────────────────────────────────────────────────

function draftFromItem(item) {
  return {
    name: item.name || "",
    part: item.part,
    color: item.color || DEFAULT_ITEM_COLOR,
    secondaryColor: item.secondaryColor || null,
    tags: [...(item.tags || [])],
  };
}

/**
 * The ⋯ menu: rare and destructive actions, off the sheet itself. Destructive
 * entries take two taps — the first turns the entry into its own confirmation,
 * so a stray tap in a menu that has only just opened cannot delete anything.
 */
function MoreMenu({ sections, busyAction, onSelect, onClose }) {
  const menuRef = useRef(null);
  const [confirming, setConfirming] = useState(null);

  useEffect(() => {
    menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={menuRef}
      className="sheet-menu"
      role="menu"
      aria-label="More actions"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onClose();
          return;
        }
        moveMenuFocus(event, event.currentTarget);
      }}
    >
      {sections.map((section, sectionIndex) => (
        <Fragment key={section.id}>
          {sectionIndex > 0 && <span className="sheet-menu__divider" role="separator" />}
          {section.label && <p className="sheet-menu__label">{section.label}</p>}
          {section.entries.map((entry) => {
            const isConfirming = confirming === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className={`sheet-menu__item${entry.danger ? " is-danger" : ""}${isConfirming ? " is-confirming" : ""}`}
                disabled={busyAction === entry.id}
                onClick={() => {
                  if (entry.confirmLabel && !isConfirming) {
                    setConfirming(entry.id);
                    return;
                  }
                  onSelect(entry.id);
                }}
              >
                {busyAction === entry.id ? <SpinnerGap size={18} className="modeled-photo-spinner" aria-hidden="true" /> : entry.icon}
                <span>{isConfirming ? entry.confirmLabel : entry.label}</span>
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Ways to wear it, as a gallery strip ending in an Add tile — the same shape at
 * one variant as at four. Variants differ visually, so the thumbnail is the
 * label and the name is its caption.
 */
function VariantStrip({ item, selectedVariantId, onSelect, onAdd, canAdd }) {
  const variants = item.variants || [];
  const several = variants.length > 1;

  return (
    <section className="variant-strip" aria-label="Ways to wear it">
      <p className="variant-strip__label">Ways to wear it{several ? ` · ${variants.length}` : ""}</p>
      <div className="variant-strip__row">
        {variants.map((variant) => {
          const image = variantOwnImage(item, variant.id);
          const processing = variant.processingStatus === "processing";
          // The cover is what the wardrobe grid shows. With one variant there is
          // nothing to distinguish it from, so it carries no mark.
          const isCover = several && variant.id === item.defaultVariantId;
          const art = (
            <span className="variant-strip__art">
              {processing
                ? <SpinnerGap size={20} className="modeled-photo-spinner" aria-hidden="true" />
                : image
                  ? <OptimizedImage src={image} alt="" sizes="64px" breakpoints={[64, 128]} />
                  : <Sparkle size={18} aria-hidden="true" />}
              {isCover && <Star className="variant-strip__cover" size={13} weight="fill" aria-hidden="true" />}
            </span>
          );
          const caption = <span className="variant-strip__name">{variant.name}</span>;

          // Nothing to choose between yet, so not a control.
          if (!several) return <span key={variant.id} className="variant-strip__tile">{art}{caption}</span>;

          const active = variant.id === selectedVariantId;
          return (
            <button
              key={variant.id}
              type="button"
              className={`variant-strip__tile${active ? " active" : ""}`}
              aria-pressed={active}
              aria-label={[variant.name, isCover && "cover", processing && "being made"].filter(Boolean).join(", ")}
              onClick={() => onSelect(variant.id)}
            >
              {art}
              {caption}
            </button>
          );
        })}
        {canAdd && (
          <button type="button" className="variant-strip__tile variant-strip__add" onClick={onAdd} aria-label="Add a way to wear it">
            <span className="variant-strip__art"><Plus size={18} aria-hidden="true" /></span>
            <span className="variant-strip__name">Add</span>
          </button>
        )}
      </div>
    </section>
  );
}

function Swatch({ color }) {
  return (
    <span className="detail-swatch">
      <span className="detail-swatch__dot" style={{ backgroundColor: color }} />
      {color}
    </span>
  );
}

/**
 * The item's properties as rows you tap to edit — iOS Settings, Notion. Only
 * one editor is open at a time. The colour editor alone used to put ten
 * controls on screen permanently; now it is one row until it is wanted.
 */
function ItemDetails({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const [openRow, setOpenRow] = useState(null);
  const toggle = (row) => setOpenRow((current) => current === row ? null : row);
  // Sampling happens on the photo, so the editor it started from has to stay
  // open to show what was picked.
  const colorsOpen = openRow === "colors" || Boolean(sampling);
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || DEFAULT_ITEM_COLOR;

  return (
    <section className="detail-rows" aria-label="Details">
      {/* A real select, styled as a row: on a phone the tap opens the native
          picker, which is the best category chooser the platform has. */}
      <label className="detail-row">
        <span className="detail-row__label">Category</span>
        <select
          className="detail-row__select"
          value={draft.part}
          onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}
        >
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
        <CaretDown className="detail-row__caret" size={14} weight="bold" aria-hidden="true" />
      </label>

      <button
        type="button"
        className="detail-row"
        aria-expanded={colorsOpen}
        aria-controls="item-colors-editor"
        onClick={() => {
          if (sampling) setSampling(null);
          toggle("colors");
        }}
      >
        <span className="detail-row__label">Colors</span>
        <span className="detail-row__value detail-row__swatches">
          <Swatch color={draft.color} />
          {draft.secondaryColor ? <Swatch color={draft.secondaryColor} /> : <span className="detail-row__muted">No secondary</span>}
        </span>
        <CaretRight className="detail-row__caret" size={14} weight="bold" aria-hidden="true" />
      </button>
      {colorsOpen && (
        <div id="item-colors-editor" className="detail-row__editor">
          <div className="colors-editor">
            <ColorControl
              label="Primary color"
              field="primary"
              value={draft.color}
              palette={palette}
              onChange={(color) => setDraft((current) => ({ ...current, color }))}
              sampling={sampling}
              setSampling={setSampling}
            />
            <ColorControl
              label="Secondary color"
              field="secondary"
              value={draft.secondaryColor}
              palette={palette}
              onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
              sampling={sampling}
              setSampling={setSampling}
              optional
              onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
              onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
            />
          </div>
          {(sampling || sampleStatus) && (
            <p className="color-help" aria-live="polite">
              {sampling ? `Tap the garment in the photo to sample the ${sampling} color.` : sampleStatus}
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        className="detail-row"
        aria-expanded={openRow === "tags"}
        aria-controls="item-tags-editor"
        onClick={() => toggle("tags")}
      >
        <span className="detail-row__label">Tags</span>
        <span className="detail-row__value detail-row__tags">
          {draft.tags.length
            ? draft.tags.map((tag) => <span className="detail-row__tag" key={tag}>{tag}</span>)
            : <span className="detail-row__muted">Add details</span>}
        </span>
        <CaretRight className="detail-row__caret" size={14} weight="bold" aria-hidden="true" />
      </button>
      {openRow === "tags" && (
        <div id="item-tags-editor" className="detail-row__editor">
          <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
        </div>
      )}
    </section>
  );
}

/**
 * Adding a way to wear it, in its own sheet over the item rather than a form
 * inside it. The method is the first question because it decides which of two
 * pipelines runs; every field below it follows from that answer.
 */
function AddVariantSheet({ item, sourceVariantId, tier, tiers, onTierChange, premiumAllowed, onCreated, onClose }) {
  const [method, setMethod] = useState("describe");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const photoInputRef = useRef(null);
  const dialogRef = useRef(null);
  // A described variant is nothing without the words that generate it, and a
  // photo variant is nothing without the photo.
  const canSubmit = method === "photo" ? Boolean(photo) : Boolean(name.trim() || description.trim());

  // Focus the sheet, not its first field: on a phone a focused input raises the
  // keyboard over the very sheet that just opened.
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  const choosePhoto = async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    setError("");
    try {
      setPhoto({ dataUrl: await fileToDataUrl(file), name: file.name });
    } catch (readError) {
      setPhoto(null);
      setError(readError.message);
    }
  };

  const submit = async () => {
    if (!canSubmit || busy) return;
    const requestedName = name.trim();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/wardrobe/items/${encodeURIComponent(item.id)}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: requestedName,
          description: description.trim(),
          origin: method === "photo" ? "photo" : "generated",
          sourceVariantId: method === "photo" ? undefined : sourceVariantId,
          imageDataUrl: method === "photo" ? photo?.dataUrl : undefined,
          tier,
        }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || "Could not add that way to wear it.");
      const created = value.variants?.find((variant) => variant.id === value.createdVariantId)
        || (requestedName ? value.variants?.find((variant) => variant.name === requestedName) : null)
        || value.variants?.at(-1);
      onCreated(value, created?.id || null);
    } catch (submitError) {
      setError(submitError.message);
      setBusy(false);
    }
  };

  const methods = [
    { id: "describe", label: "Describe it", detail: "Restyles the cutout you already have", icon: <PencilLine size={20} aria-hidden="true" /> },
    { id: "photo", label: "Use a photo", detail: "Cuts the garment out of your own shot", icon: <UploadSimple size={20} aria-hidden="true" /> },
  ];

  return (
    <div className="add-variant-layer">
      <div className="add-variant-scrim" aria-hidden="true" onPointerDown={() => { if (!busy) onClose(); }} />
      <div
        ref={dialogRef}
        className="add-variant-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-variant-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          event.preventDefault();
          if (!busy) onClose();
        }}
      >
        <span className="add-variant-sheet__grabber" aria-hidden="true" />
        <div className="add-variant-sheet__head">
          <div>
            <h2 id="add-variant-title">Add a way to wear it</h2>
            <p>{item.name || "This item"}</p>
          </div>
          <button type="button" className="add-variant-sheet__close" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div className="variant-method-picker" role="group" aria-label="How to make it">
          {methods.map((option) => (
            <button
              key={option.id}
              type="button"
              className={method === option.id ? "active" : ""}
              aria-pressed={method === option.id}
              disabled={busy}
              onClick={() => setMethod(option.id)}
            >
              {option.icon}
              <span>{option.label}</span>
              <small>{option.detail}</small>
            </button>
          ))}
        </div>

        {method === "photo" && (
          <div className="add-variant-sheet__photo">
            <input ref={photoInputRef} type="file" accept="image/*" hidden disabled={busy} onChange={choosePhoto} />
            <button
              type="button"
              className={`variant-photo-upload${photo ? " has-photo" : ""}`}
              disabled={busy}
              onClick={() => photoInputRef.current?.click()}
              aria-label={photo ? `Replace photo: ${photo.name}` : "Choose a photo of it worn this way"}
            >
              <span className="variant-photo-upload__art" aria-hidden="true">
                {photo ? <img src={photo.dataUrl} alt="" /> : <ImageSquare size={30} weight="regular" />}
                <span className="variant-photo-upload__plus"><Plus size={11} weight="bold" /></span>
              </span>
              <span className="variant-photo-upload__text">{photo ? photo.name : "Choose a photo of it worn this way"}</span>
            </button>
          </div>
        )}

        <label className="sheet-field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Sleeves rolled" disabled={busy} />
          <small>Shown under the thumbnail.</small>
        </label>

        <label className="sheet-field">
          <span>Detail <em>— optional</em></span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Folded twice, above the elbow" disabled={busy} />
          <small>{method === "describe" ? "Guides both the garment image and the model photo." : "Guides the model photo."}</small>
        </label>

        {error && <p className="status error" role="alert">{error}</p>}

        <p className="add-variant-sheet__cost">
          {method === "describe"
            ? "Makes two images — the garment, then a model photo wearing it."
            : "Cuts the garment out of your photo, then makes a model photo wearing it."}
          {" "}About a minute.
        </p>

        <GenerateButton
          block
          icon={<Sparkle size={16} weight="bold" aria-hidden="true" />}
          label={method === "describe" ? "Generate" : "Add from photo"}
          busy={busy}
          disabled={!canSubmit}
          onGenerate={submit}
          tier={tier}
          tiers={tiers}
          onTierChange={onTierChange}
          premiumAllowed={premiumAllowed}
        />
      </div>
    </div>
  );
}

export function ItemViewer({ item, onClose, onSave, onDelete, onGenerateModeled, premiumAllowed, provider = null, showModeledPhoto = true, openedFrom = null, initialVariantId = null, outfits = [], onOpenOutfit, deleteLabel = "Delete from wardrobe" }) {
  const closeButtonRef = useRef(null);
  const entryRef = useRef(null);
  const sheetRef = useRef(null);
  const scrollRef = useRef(null);
  const overlayRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const moreRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState(() => draftFromItem(item));
  // Seeded from the card that opened this sheet, so a variant peeked in the
  // grid is still the one on screen here. Validated against the record rather
  // than trusted, since the caller's id may be stale by the time we mount.
  const [selectedVariantId, setSelectedVariantId] = useState(
    () => (initialVariantId && item.variants?.some((variant) => variant.id === initialVariantId)
      ? initialVariantId
      : item.defaultVariantId || item.variants?.[0]?.id || null),
  );
  const [addingVariant, setAddingVariant] = useState(false);
  const [variantError, setVariantError] = useState("");
  const [variantNotice, setVariantNotice] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuBusy, setMenuBusy] = useState(null);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [shaking, setShaking] = useState(false);
  // This viewer is hand-rolled rather than a ViewerPanel — it needs the
  // unsaved-changes shake — so it opts into the card-anchored entry itself.
  useExpandOrigin(entryRef, openedFrom);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const isPhone = useIsPhone();
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [modeledNote, setModeledNote] = useState("");
  const { tier, tiers, chooseTier } = useRememberedTier(provider, premiumAllowed);
  // From the draft, so the meta line follows a category change before it is saved.
  const type = TYPE_MAP[draft.part]?.singular || "Wardrobe item";
  const variants = item.variants || [];
  const selectedVariant = itemVariant(item, selectedVariantId);
  const selectedVariantImage = variantOwnImage(item, selectedVariantId);
  const selectedImage = selectedVariantImage || variantImage(item);
  const isVariantPhotoMissing = Boolean(selectedVariantId && !selectedVariantImage);
  const hasModeledImage = Boolean(variantModeledImage(item, selectedVariantId));
  const modeledStatus = selectedVariant ? selectedVariant.modeledStatus : item.modeledStatus;
  const modeledError = selectedVariant ? selectedVariant.modeledError : item.modeledError;
  const variantProcessing = selectedVariant?.processingStatus === "processing";
  const modeledProcessing = modeledStatus === "processing";
  const canModel = showModeledPhoto && Boolean(onGenerateModeled);
  const canGenerate = canModel && !hasModeledImage && !isVariantPhotoMissing && !variantProcessing && !modeledProcessing;
  const canRegenerate = canModel && hasModeledImage && !variantProcessing && !modeledProcessing;
  const changes = useMemo(() => changedDraftFields(draft, item), [draft, item]);
  const isDirty = changes.length > 0;
  // What the draft resets against. The app re-fetches every item every 1.5s
  // while anything is processing, handing this sheet a new `item` object each
  // time; resetting on the object itself wiped unsaved edits on every poll.
  const savedFields = JSON.stringify([item.id, item.name, item.part, item.color, item.secondaryColor, item.tags]);

  const handleGenerateModeled = async (chosenTier) => {
    setGenerating(true);
    setGenerateError("");
    try {
      await onGenerateModeled(item, chosenTier, modeledNote.trim(), selectedVariantId);
      setModeledNote("");
      setRegenerateOpen(false);
    } catch (error) {
      setGenerateError(error.message || "Could not start generating a model photo.");
    } finally {
      setGenerating(false);
    }
  };

  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const { closing, dismiss } = useDismiss(onClose);

  const requestClose = useCallback((options) => {
    if (isDirty) nudgeUnsaved();
    else dismiss(options);
  }, [isDirty, nudgeUnsaved, dismiss]);

  useViewerKeyboard(requestClose, closeButtonRef);

  // A swipe down is a close like any other, so it goes through requestClose and
  // gets the same unsaved-changes guard: drag a sheet with unsaved edits and it
  // springs back and shakes rather than discarding them. onDismiss fires only
  // once the gesture has committed, so the shake reads as a refusal to leave.
  const { dragHandlers } = useSheetGesture({
    sheetRef,
    overlayRef,
    scrollRef,
    enabled: isPhone,
    onDismiss: () => requestClose({ instant: true }),
  });

  // Leaving for an outfit is still leaving: unsaved edits get the same shake
  // they get from the close button, not a silent discard.
  const openOutfit = useCallback((outfitId) => {
    if (isDirty) nudgeUnsaved();
    else onOpenOutfit(outfitId);
  }, [isDirty, nudgeUnsaved, onOpenOutfit]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismissOnOutsidePointer(menuOpen, moreRef, closeMenu);

  useEffect(() => {
    if (!sampling) return undefined;
    const onKeyDown = (e) => { if (e.key === "Escape") setSampling(null); };
    document.addEventListener("keydown", onKeyDown);
    // The colour editor sits below the photo it samples from; bring the photo
    // back into view so the instruction to tap it is something you can act on.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    imageRef.current?.scrollIntoView?.({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setDraft(draftFromItem(item));
    // Only when what is saved actually changed — see savedFields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedFields]);

  useEffect(() => {
    setPalette(item.palette || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useEffect(() => {
    setSelectedVariantId((current) => item.variants?.some((variant) => variant.id === current)
      ? current
      : item.defaultVariantId || item.variants?.[0]?.id || null);
  }, [item]);

  const selectVariant = (variantId) => {
    setSelectedVariantId(variantId);
    setRegenerateOpen(false);
    setGenerateError("");
    setVariantNotice(null);
  };

  const setCover = async (variantId) => {
    const response = await fetch(`/api/wardrobe/items/${encodeURIComponent(item.id)}/variants/${encodeURIComponent(variantId)}/default`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Could not change the cover");
    onSave(value);
  };

  const deleteVariant = async (variant) => {
    const replacement = variants.find((candidate) => candidate.id === item.defaultVariantId && candidate.id !== variant.id)
      || variants.find((candidate) => candidate.id !== variant.id);
    if (!replacement) {
      setVariantError("An item needs at least one way to wear it.");
      return;
    }
    setVariantError("");
    setVariantNotice(null);
    const response = await fetch(`/api/wardrobe/items/${encodeURIComponent(item.id)}/variants/${encodeURIComponent(variant.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replacementVariantId: replacement.id }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Could not delete that way to wear it");
    const updatedItem = value.item;
    if (!updatedItem) throw new Error("Could not refresh the item after deleting");
    setSelectedVariantId(updatedItem.defaultVariantId || replacement.id);
    setVariantNotice({ itemId: item.id, message: `“${variant.name}” deleted.` });
    onSave(updatedItem);
  };

  const runMenuAction = async (id) => {
    if (id === "regenerate") {
      setMenuOpen(false);
      setRegenerateOpen(true);
      return;
    }
    if (id === "delete-item") {
      setMenuOpen(false);
      onDelete(item.id);
      return;
    }
    setMenuBusy(id);
    try {
      if (id === "cover") await setCover(selectedVariantId);
      if (id === "delete-variant" && selectedVariant) await deleteVariant(selectedVariant);
      setMenuOpen(false);
    } catch (error) {
      setVariantError(error.message);
      setMenuOpen(false);
    } finally {
      setMenuBusy(null);
    }
  };

  const menu = itemMenuActions({
    variants,
    selectedVariantId,
    defaultVariantId: item.defaultVariantId,
    canRegenerate,
    canDeleteItem: Boolean(onDelete),
  });
  const menuEntries = {
    regenerate: { label: "Regenerate model photo", icon: <ArrowCounterClockwise size={18} aria-hidden="true" /> },
    cover: { label: "Use as cover in wardrobe", icon: <Star size={18} aria-hidden="true" /> },
    "delete-variant": { label: "Delete this way to wear it", confirmLabel: "Tap again to delete it", danger: true, icon: <Trash size={18} aria-hidden="true" /> },
    // Named by where it is deleted from: the same sheet opens wishlist pieces in Inspo.
    "delete-item": { label: deleteLabel, confirmLabel: "Tap again to delete the item", danger: true, icon: <Trash size={18} aria-hidden="true" /> },
  };
  const menuSections = [
    menu.variantActions.length > 0 && { id: "variant", label: menu.variantLabel, entries: menu.variantActions.map((id) => ({ id, ...menuEntries[id] })) },
    menu.itemActions.length > 0 && { id: "item", label: menu.variantLabel ? "Item" : null, entries: menu.itemActions.map((id) => ({ id, ...menuEntries[id] })) },
  ].filter(Boolean);

  const discardEditing = () => {
    setDraft(draftFromItem(item));
    setSampling(null);
    setSampleStatus("");
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("");
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("That spot is transparent—try directly on the garment.");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`Sampled ${color} as the ${sampling} color.`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={selectedImage}
        alt={`Selected ${type.toLowerCase()}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Tap the garment to sample</span>}
      {isVariantPhotoMissing && !variantProcessing && <span className="variant-photo-missing" role="status">Photo not generated yet</span>}
    </div>
  );

  // ⋯ and ✕ ride on the photo, top right, in both hero treatments.
  const toolbar = (
    <div className="viewer-toolbar">
      {menuSections.length > 0 && (
        <div className="viewer-more" ref={moreRef}>
          <button
            type="button"
            className="viewer-toolbar__button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <DotsThree size={20} weight="bold" aria-hidden="true" />
          </button>
          {menuOpen && <MoreMenu sections={menuSections} busyAction={menuBusy} onSelect={runMenuAction} onClose={closeMenu} />}
        </div>
      )}
      <button type="button" className="viewer-toolbar__button" onClick={() => requestClose()} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={18} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );

  const stageStatus = (variantProcessing || modeledProcessing) && (
    <div className="stage-action">
      <StageStatus>{variantProcessing ? "Making this way to wear it…" : "Generating model photo…"}</StageStatus>
    </div>
  );

  const content = (
    <div
      ref={overlayRef}
      className="viewer-overlay"
      role="presentation"
      data-closing={closing}
      // pointerdown, not mousedown: after a touch the browser replays a
      // synthetic mousedown at the release point, which lands on the overlay
      // once the sheet has moved out from under the finger and closes a panel
      // the user was only dragging.
      onPointerDown={(event) => event.target === event.currentTarget && requestClose()}
    >
    <div ref={entryRef} className={`viewer-entry${openedFrom ? " viewer-entry--from-card" : ""}`}>
    <aside
      ref={sheetRef}
      className={`viewer editing item-sheet${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={draft.name || type}
      {...(isPhone ? dragHandlers : null)}
    >
      <div ref={scrollRef} className="item-sheet__scroll">
      {hasModeledImage ? (
        <ModeledHero src={variantModeledImage(item, selectedVariantId)} alt={`${draft.name || type} worn by a model`} showHeading={false}>
          {garmentArtwork}
          {toolbar}
          {stageStatus}
          {/* Opened from ⋯, so there is no chip to grow from; it rises from
              the bottom centre, where the photo's actions always sit. */}
          <RefineComposer
            open={regenerateOpen && canRegenerate}
            onClose={() => setRegenerateOpen(false)}
            note={modeledNote}
            onNoteChange={setModeledNote}
            busy={generating}
            onGenerate={handleGenerateModeled}
            tier={tier}
            tiers={tiers}
            onTierChange={chooseTier}
            premiumAllowed={premiumAllowed}
          />
        </ModeledHero>
      ) : (
        <div className="item-stage">
          {garmentArtwork}
          {toolbar}
          {stageStatus || (canGenerate && (
            <div className="stage-action">
              <GenerateButton
                icon={<Sparkle size={16} weight="bold" aria-hidden="true" />}
                label="Generate model photo"
                busy={generating}
                onGenerate={handleGenerateModeled}
                tier={tier}
                tiers={tiers}
                onTierChange={chooseTier}
                premiumAllowed={premiumAllowed}
              />
            </div>
          ))}
        </div>
      )}

      <div className="viewer-details editing">
        {(generateError || modeledStatus === "error") && (
          <p className="stage-error" role="alert">{generateError || modeledError || "That model photo could not be made."}</p>
        )}

        {/* The name straight after the photo. It used to be the fourth thing on
            the sheet, under two optional AI features. */}
        <header className="item-heading">
          <EditableTitle
            value={draft.name}
            placeholder={type}
            onChange={(name) => setDraft((current) => ({ ...current, name }))}
            ariaLabel="Item name"
          />
          <p className="item-meta">
            {itemMetaLine({ typeLabel: type, outfitCount: onOpenOutfit ? outfits.length : 0, createdAt: item.createdAt })}
          </p>
        </header>

        {variants.length > 0 && (
          <VariantStrip
            item={item}
            selectedVariantId={selectedVariantId}
            onSelect={selectVariant}
            onAdd={() => setAddingVariant(true)}
            canAdd={showModeledPhoto}
          />
        )}
        {selectedVariant?.processingStatus === "error" && (
          <p className="status error variant-strip__status" role="alert">
            {selectedVariant.processingError || "That way to wear it could not be made."}
          </p>
        )}
        {variantNotice?.itemId === item.id && <p className="variant-notice" role="status" aria-live="polite">{variantNotice.message}</p>}
        {variantError && <p className="status error variant-strip__status" role="alert">{variantError}</p>}

        <ItemDetails
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        {onOpenOutfit && <OutfitsWithItem outfits={outfits} onOpen={openOutfit} />}

        {/* Save and Discard exist only while there is something to save — the
            contextual save bar of Shopify's admin. The footer they replace
            showed Delete, Cancel and a filled Save on every item, always. */}
        {isDirty && (
          <div className={`save-bar${closeBlocked ? " is-blocked" : ""}`} role="region" aria-label="Unsaved changes">
            <span className="save-bar__label" role="status">
              {closeBlocked ? "Save or discard before closing" : unsavedLabel(changes.length)}
            </span>
            <button type="button" className="save-bar__discard" onClick={discardEditing}>Discard</button>
            <button type="button" className="save-bar__save" onClick={saveEditing}>
              <Check size={15} weight="bold" aria-hidden="true" /> Save
            </button>
          </div>
        )}
      </div>
      </div>
    </aside>
    </div>
    </div>
  );

  // The add sheet is a sibling of the viewer in the React tree, not a child.
  // React replays pointer events up its own tree, so a child — even portalled —
  // would feed every drag inside the sub-sheet to the viewer's swipe-to-close.
  const addSheet = addingVariant && (
    <AddVariantSheet
      item={item}
      sourceVariantId={selectedVariantId}
      tier={tier}
      tiers={tiers}
      onTierChange={chooseTier}
      premiumAllowed={premiumAllowed}
      onCreated={(updatedItem, createdId) => {
        onSave(updatedItem);
        if (createdId) setSelectedVariantId(createdId);
        setAddingVariant(false);
      }}
      onClose={() => setAddingVariant(false)}
    />
  );

  if (typeof document === "undefined") return content;
  return (
    <>
      {createPortal(content, document.body)}
      {addSheet && createPortal(addSheet, document.body)}
    </>
  );
}
