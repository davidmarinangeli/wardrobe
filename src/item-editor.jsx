import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, Sparkle, SpinnerGap, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import { useDismiss } from "./hooks/useDismiss.js";
import { ModeledHero } from "./components/ModeledHero.jsx";
import { PanelActions } from "./components/PanelActions.jsx";
import { EditableTitle } from "./components/EditableTitle.jsx";
import { WARDROBE_TYPES as TYPES, TYPE_MAP } from "./categories.js";

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

export function GalleryItem({ item, selected, onOpen, seasonMatch, index = 0 }) {
  const type = TYPE_MAP[item.part]?.singular || "wardrobe item";

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onOpen(item.id)}
      aria-label={`View ${item.name || type}`}
      aria-pressed={selected}
      data-part={item.part}
      // Stagger is capped: past the first screenful the delay would only ever
      // fire off-screen, so it just adds latency to scrolling into view.
      style={{ "--stagger-index": Math.min(index, 11) }}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <span className="gallery-item__art">
        {seasonMatch && <span className="gallery-item-badge" style={{ backgroundColor: seasonMatch.accent }} title={`Matches your ${seasonMatch.label} palette`} />}
        <OptimizedImage
          src={item.thumbnail || item.image}
          alt=""
          sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 220px"
          breakpoints={[120, 180, 240, 320, 480]}
        />
      </span>
      <span className="gallery-item__label">
        <span className="gallery-item__name">{item.name || type}</span>
        <span className="gallery-item__type">{type}</span>
      </span>
    </button>
  );
}

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

export function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <EditableTitle
        value={draft.name}
        placeholder={TYPE_MAP[draft.part]?.singular || "Wardrobe item"}
        onChange={(name) => setDraft((current) => ({ ...current, name }))}
        ariaLabel="Item name"
      />

      <label className="field">
        <span>Category</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>Colors</legend>
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
        <p className="color-help" aria-live="polite">{sampling ? `Click anywhere on the garment to sample the ${sampling} color.` : sampleStatus || "Primary colors come from the image. A secondary is suggested only when a distinct color has meaningful coverage."}</p>
      </fieldset>

      <div className="field details-field">
        <span>Details</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

const MODEL_TIERS = [
  { id: "standard", label: "Standard", detail: "Gemini 2.5 Flash — fast, ~$0.04/image" },
  { id: "premium", label: "Premium", detail: "Nano Banana 2 — sharper detail, ~$0.07/image" },
];

export function ModeledPhotoPrompt({ status, error, busy, onGenerate, premiumAllowed = true, hasImage = false, initialTier = "standard", note, onNoteChange }) {
  const [tier, setTier] = useState(initialTier);
  useEffect(() => { if (tier === "premium" && !premiumAllowed) setTier("standard"); }, [premiumAllowed, tier]);
  if (status === "processing") {
    return (
      <div className="modeled-photo-prompt is-processing">
        <SpinnerGap size={16} className="modeled-photo-spinner" aria-hidden="true" />
        <p>Generating your model photo — this can take a bit.</p>
      </div>
    );
  }
  return (
    <div className="modeled-photo-prompt">
      {!hasImage && (
        <>
          <p className="modeled-photo-prompt__title">No model photo yet</p>
          <p className="modeled-photo-prompt__detail">Optional — generate an editorial shot of this piece worn by your reference model. Nothing happens until you pick a quality and generate.</p>
        </>
      )}
      {status === "error" && <p className="modeled-photo-prompt__error">{error || "That attempt failed."}</p>}
      <div className="modeled-tier-picker" role="radiogroup" aria-label="Model photo quality">
        {MODEL_TIERS.map((option) => {
          const disabled = option.id === "premium" && !premiumAllowed;
          return (
            <button
              key={option.id}
              type="button"
              className={tier === option.id ? "active" : ""}
              aria-pressed={tier === option.id}
              disabled={disabled}
              title={disabled ? "Switch to PROD mode to use Premium quality" : undefined}
              onClick={() => setTier(option.id)}
            >
              <span>{option.label}</span>
              <small>{disabled ? "Needs PROD mode" : option.detail}</small>
            </button>
          );
        })}
      </div>
      {hasImage && onNoteChange && (
        <input
          type="text"
          className="outfit-card-note"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="What's off? e.g. jacket should be darker"
        />
      )}
      <button className="primary-button" type="button" disabled={busy} onClick={() => onGenerate(tier)}>
        {hasImage
          ? <><ArrowCounterClockwise size={15} weight="bold" aria-hidden="true" /> Regenerate model photo</>
          : <><Sparkle size={15} weight="bold" aria-hidden="true" /> Generate model photo</>}
      </button>
    </div>
  );
}

export function ItemViewer({ item, onClose, onSave, onDelete, onGenerateModeled, premiumAllowed, showModeledPhoto = true }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [modeledNote, setModeledNote] = useState("");
  const type = TYPE_MAP[item.part]?.singular || "Wardrobe item";
  const hasModeledImage = Boolean(item.modeledImage);

  const handleGenerateModeled = async (tier) => {
    setGenerating(true);
    try {
      await onGenerateModeled(item, tier, modeledNote.trim());
      setModeledNote("");
    } catch {
      // surfaced via item.modeledError once the request settles
    } finally {
      setGenerating(false);
    }
  };
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

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

  useEffect(() => {
    if (!sampling) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') setSampling(null); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    dismiss();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus("Changes saved.");
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
        src={item.image}
        alt={`Selected ${type.toLowerCase()}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">Click garment to sample</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" data-closing={closing} onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="Selected wardrobe item">
      <button className="icon-button viewer-icon-close" type="button" onClick={() => requestClose()} aria-label="Close viewer" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      {hasModeledImage ? (
        <ModeledHero src={item.modeledImage} alt={`${draft.name || type} worn by a model`} showHeading={false}>
          {garmentArtwork}
        </ModeledHero>
      ) : (
        garmentArtwork
      )}

      <div className="viewer-details editing">
        {showModeledPhoto && (
          <ModeledPhotoPrompt
            status={item.modeledStatus}
            error={item.modeledError}
            busy={generating}
            onGenerate={handleGenerateModeled}
            premiumAllowed={premiumAllowed}
            hasImage={hasModeledImage}
            initialTier={item.modeledTier || "standard"}
            note={modeledNote}
            onNoteChange={setModeledNote}
          />
        )}
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        {closeBlocked && <p className="unsaved-notice" role="status">Save or cancel changes before closing.</p>}

        <PanelActions
          onDelete={() => onDelete(item.id)}
          onCancel={cancelEditing}
          onConfirm={saveEditing}
          confirmIcon={<Check size={15} weight="bold" aria-hidden="true" />}
        />
      </div>
    </aside>
    </div>
    </div>
  );
}
