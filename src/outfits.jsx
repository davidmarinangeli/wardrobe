import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, PencilSimple, Plus, Sparkle, SpinnerGap, Trash, X, Lightbulb, MagicWand, ArrowRight } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import "./outfits.css";
import "./suggestions.css";

const MODEL_TIERS = [
  { id: "standard", label: "Standard", detail: "Gemini 2.5 Flash — fast, ~$0.04" },
  { id: "premium", label: "Premium", detail: "Nano Banana 2 — sharper, ~$0.07" },
];

const OCCASIONS = [
  { id: "casual", label: "Casual", emoji: "👕" },
  { id: "work", label: "Work", emoji: "💼" },
  { id: "date", label: "Date", emoji: "🌹" },
  { id: "sport", label: "Sport", emoji: "🏃" },
  { id: "event", label: "Event", emoji: "🎉" },
];

const CATEGORIES = [
  { id: "upperbody", label: "Top" },
  { id: "lowerbody", label: "Bottom" },
  { id: "wholebody_up", label: "Jacket" },
  { id: "shoes", label: "Shoes" },
  { id: "socks", label: "Socks" },
  { id: "accessories_up", label: "Accessory" },
];

// Groups garments into worn-order zones (top of the body first) so a picked
// tee and a picked jacket read as layered rather than as an unordered pile.
const STACK_ZONES = [
  { id: "top", parts: ["accessories_up", "upperbody", "wholebody_up"] },
  { id: "bottom", parts: ["lowerbody"] },
  { id: "feet", parts: ["socks", "shoes"] },
];

function OutfitStack({ items, compact = false }) {
  const byPart = useMemo(() => {
    const groups = {};
    for (const item of items) (groups[item.part] ||= []).push(item);
    return groups;
  }, [items]);

  return (
    <div className={`outfit-stack${compact ? " compact" : ""}`}>
      {STACK_ZONES.map((zone) => {
        const zoneItems = zone.parts.flatMap((part) => byPart[part] || []);
        if (!zoneItems.length) return null;
        return (
          <div className="outfit-stack-zone" key={zone.id}>
            {zoneItems.map((item, index) => (
              <div
                key={item.id}
                className="outfit-stack-item"
                style={{ transform: `translateX(${index * 12}px) rotate(${index ? (index * 4) - 2 : 0}deg)`, zIndex: index + 1 }}
              >
                <OptimizedImage src={item.thumbnail || item.image} alt="" sizes={compact ? "70px" : "96px"} breakpoints={[70, 96, 140]} />
              </div>
            ))}
          </div>
        );
      })}
      {!items.length && <p className="status empty">Add pieces below to build the look.</p>}
    </div>
  );
}

// Fixed spots (per body part) where a hovered card scatters its composing
// pieces. Mirrors the flat-lay layout from the OutfitStack zones above.
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

// Scattered garment cutouts revealed on hover, layered over a faded hero photo.
function OutfitHoverPieces({ outfitId, pieces }) {
  const seenByPart = {};
  return (
    <div className="outfit-card-hover-pieces">
      {pieces.map((item) => {
        const part = item.part || "upperbody";
        const index = (seenByPart[part] = (seenByPart[part] || 0) + 1) - 1;
        const slot = hoverSlot(part, index, outfitId, item.id);
        const style = { "--rot": `${slot.rot}deg`, maxHeight: slot.maxH, maxWidth: slot.maxW };
        if (slot.top != null) style.top = slot.top;
        if (slot.bottom != null) style.bottom = slot.bottom;
        if (slot.left != null) style.left = slot.left;
        if (slot.right != null) style.right = slot.right;
        return <img key={item.id} className="outfit-card-hover-piece" src={item.thumbnail || item.image} alt="" style={style} />;
      })}
    </div>
  );
}

async function api(path, options) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "The outfit could not be saved.");
  return value;
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
          <button className="viewer-icon-close" type="button" onClick={onCancel} aria-label="Close">
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
                    {itemsByCategory[category.id].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`outfit-piece${selected.has(item.id) ? " active" : ""}`}
                        onClick={() => toggleItem(item.id)}
                        aria-pressed={selected.has(item.id)}
                        title={item.name}
                      >
                        <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="72px" breakpoints={[72, 108]} />
                      </button>
                    ))}
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
    <button type="button" className="outfit-card" onClick={() => onOpen(outfit.id)} aria-label={`View ${outfit.name}`}>
      <div className="outfit-card-art">
        {hasModeledImage ? (
          <>
            <div className="outfit-card-hero">
              <OptimizedImage src={outfit.modeledImage} alt={`${outfit.name} worn by a model`} sizes="(max-width: 520px) 44vw, 300px" breakpoints={[220, 320, 440, 600]} />
            </div>
            {!!pieces.length && <OutfitHoverPieces outfitId={outfit.id} pieces={pieces} />}
          </>
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

function OutfitViewer({ outfit, itemMap, onClose, onEdit, onDelete, onGenerateModeled, premiumAllowed }) {
  const closeButtonRef = useRef(null);
  const pieces = outfit.itemIds.map((id) => itemMap[id]).filter(Boolean);
  const [tier, setTier] = useState(outfit.modeledTier || "standard");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const hasModeledImage = Boolean(outfit.modeledImage);
  const processing = outfit.modeledStatus === "processing";

  useEffect(() => { if (tier === "premium" && !premiumAllowed) setTier("standard"); }, [premiumAllowed, tier]);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
    };
  }, [onClose]);

  const generate = async () => {
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
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className={`viewer${hasModeledImage ? " has-modeled-image" : ""}`} role="dialog" aria-modal="true" aria-label={`Outfit: ${outfit.name}`}>
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close viewer" ref={closeButtonRef}>
            <X size={24} weight="light" aria-hidden="true" />
          </button>

          {hasModeledImage ? (
            <div className="modeled-hero">
              <OptimizedImage
                className="modeled-hero-photo"
                src={outfit.modeledImage}
                alt={`${outfit.name} worn by a model`}
                sizes="(max-width: 860px) 100vw, 520px"
                breakpoints={[320, 480, 640, 800, 1040, 1280]}
                quality={82}
                priority
              />
              <div className="viewer-heading modeled-heading">
                <div><h2>{outfit.name}</h2></div>
              </div>
            </div>
          ) : (
            <>
              <div className="viewer-heading"><div><h2>{outfit.name}</h2></div></div>
              <div className="viewer-art outfit-viewer-art"><OutfitStack items={pieces} /></div>
            </>
          )}

          <div className="viewer-details editing">
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
                  <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="64px" breakpoints={[64, 96]} />
                </div>
              ))}
            </div>

            {processing ? (
              <p className="outfit-card-status"><SpinnerGap size={13} className="outfit-card-spinner" aria-hidden="true" /> Generating model photo…</p>
            ) : (
              <div className="modeled-photo-prompt outfit-viewer-generate">
                {outfit.modeledStatus === "error" && <p className="modeled-photo-prompt__error">{outfit.modeledError || "That attempt failed."}</p>}
                <div className="modeled-tier-picker" role="radiogroup" aria-label="Model photo quality">
                  {MODEL_TIERS.map((option) => {
                    const disabled = option.id === "premium" && !premiumAllowed;
                    return (
                      <button key={option.id} type="button" className={tier === option.id ? "active" : ""} aria-pressed={tier === option.id} disabled={disabled} title={disabled ? "Switch to PROD mode to use Premium quality" : undefined} onClick={() => setTier(option.id)}>
                        <span>{option.label}</span>
                        <small>{disabled ? "Needs PROD mode" : option.detail}</small>
                      </button>
                    );
                  })}
                </div>
                {hasModeledImage && (
                  <input
                    type="text"
                    className="outfit-card-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="What's off? e.g. jacket should be darker"
                  />
                )}
                <button className="primary-button" type="button" onClick={generate} disabled={busy}>
                  {hasModeledImage
                    ? <><ArrowCounterClockwise size={15} weight="bold" aria-hidden="true" /> Regenerate model photo</>
                    : <><Sparkle size={15} weight="bold" aria-hidden="true" /> Generate model photo</>}
                </button>
              </div>
            )}

            <div className="viewer-actions">
              <button className="delete-button" type="button" onClick={() => onDelete(outfit.id)}>
                <Trash size={15} weight="regular" aria-hidden="true" /> Delete
              </button>
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={() => onEdit(outfit)}>
                <PencilSimple size={15} weight="regular" aria-hidden="true" /> Edit
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function SuggestionNudges({ items }) {
  const [dismissed, setDismissed] = useState(() => new Set());
  
  if (!items) return null;
  
  const dismiss = (id) => setDismissed(prev => new Set(prev).add(id));
  
  const hasColorProfile = !!localStorage.getItem('open-wardrobe-color-profile-v1');
  const hasTops = items.some(i => i.part === 'upperbody' || i.part === 'wholebody_up');
  const hasBottoms = items.some(i => i.part === 'lowerbody');
  
  const nudges = [];
  
  if (items.length < 15 && !dismissed.has('few-items')) {
    nudges.push({ id: 'few-items', msg: "Add more clothes to your wardrobe for better outfit suggestions" });
  } else if (!hasBottoms && !dismissed.has('no-bottoms')) {
    nudges.push({ id: 'no-bottoms', msg: "You don't have any bottoms yet. Add some for complete outfits." });
  } else if (!hasTops && !dismissed.has('no-tops')) {
    nudges.push({ id: 'no-tops', msg: "You don't have any tops yet. Add some for complete outfits." });
  } else if (!hasColorProfile && !dismissed.has('no-color')) {
    nudges.push({ id: 'no-color', msg: "Take the color quiz for suggestions that match your skin tone" });
  }
  
  if (!nudges.length) return null;
  
  const nudge = nudges[0];
  
  return (
    <div className="nudge-banner">
      <span>{nudge.msg}</span>
      <button type="button" onClick={() => dismiss(nudge.id)} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}

function SuggestionPanel({ items, outfits, onSaveOutfit, onClose }) {
  const [occasion, setOccasion] = useState("casual");
  const [suggestions, setSuggestions] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [savedIds, setSavedIds] = useState(() => new Set());
  
  const generate = async () => {
    setGenerating(true);
    setError("");
    try {
      const colorProfile = JSON.parse(localStorage.getItem('open-wardrobe-color-profile-v1') || 'null');
      const res = await api("/api/suggestions/generate", {
        method: "POST",
        body: JSON.stringify({ occasion, colorProfile })
      });
      setSuggestions(res.suggestions || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async (suggestion, index) => {
    try {
      await onSaveOutfit({ name: suggestion.name, itemIds: suggestion.itemIds });
      setSavedIds(prev => new Set(prev).add(index));
    } catch (e) {
      setError(e.message);
    }
  };

  const itemMap = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items]);

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-entry outfit-builder-entry" style={{ width: 'clamp(390px, 80vw, 900px)' }}>
        <aside className="viewer outfit-builder suggestion-panel" role="dialog" aria-modal="true" aria-label="Suggest outfits">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading">
            <h2>Suggest Outfits</h2>
          </div>
          
          <div className="outfit-builder-body">
            <div className="occasion-picker">
              {OCCASIONS.map(occ => (
                <button
                  key={occ.id}
                  type="button"
                  className={occasion === occ.id ? "active" : ""}
                  onClick={() => setOccasion(occ.id)}
                >
                  {occ.emoji} {occ.label}
                </button>
              ))}
            </div>
            
            <button className="primary-button" type="button" onClick={generate} disabled={generating}>
              <MagicWand size={15} weight="bold" /> Generate suggestions
            </button>
            
            {error && <p className="status error">{error}</p>}
            
            {generating && (
              <div className="suggestion-loading">
                <SpinnerGap size={24} className="outfit-card-spinner" />
                Finding outfit ideas...
              </div>
            )}
            
            {!generating && suggestions.length > 0 && (
              <div className="suggestion-cards">
                {suggestions.map((sugg, i) => {
                  const pieces = sugg.itemIds.map(id => itemMap[id]).filter(Boolean);
                  const isSaved = savedIds.has(i);
                  return (
                    <div key={i} className="suggestion-card">
                      <h3>{sugg.name}</h3>
                      <OutfitStack items={pieces} />
                      <div className="suggestion-reasoning">
                        <div className="suggestion-reasoning-item"><strong>Style:</strong> {sugg.reasoning?.style || sugg.styleReasoning}</div>
                        <div className="suggestion-reasoning-item"><strong>Color:</strong> {sugg.reasoning?.color || sugg.colorReasoning}</div>
                        <div className="suggestion-reasoning-item"><strong>Weather:</strong> {sugg.reasoning?.weather || sugg.weatherReasoning}</div>
                        <div className="suggestion-reasoning-item"><strong>Occasion:</strong> {sugg.reasoning?.occasion || sugg.occasionReasoning}</div>
                      </div>
                      <div className="suggestion-actions">
                        <button 
                          type="button"
                          className={isSaved ? "secondary-button" : "primary-button"}
                          onClick={() => !isSaved && handleSave(sugg, i)}
                          disabled={isSaved}
                        >
                          {isSaved ? <><Check size={15} /> Saved</> : "Save to outfits"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            
            <div className="viewer-actions">
              <span className="action-spacer" />
              <button className="secondary-button" type="button" onClick={onClose}>Done</button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function Outfits({ items, premiumAllowed = true }) {
  const [outfits, setOutfits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [builderOutfit, setBuilderOutfit] = useState(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [viewingOutfitId, setViewingOutfitId] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

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

  const openNewOutfit = () => { setBuilderOutfit(null); setShowBuilder(true); };
  const openEditOutfit = (outfit) => { setViewingOutfitId(null); setBuilderOutfit(outfit); setShowBuilder(true); };
  const closeBuilder = () => setShowBuilder(false);

  const saveOutfit = async (draft) => {
    const saved = builderOutfit
      ? await api(`/api/outfits/${builderOutfit.id}`, { method: "PATCH", body: JSON.stringify(draft) })
      : await api("/api/outfits", { method: "POST", body: JSON.stringify(draft) });
    setOutfits((current) => builderOutfit
      ? current.map((outfit) => outfit.id === saved.id ? saved : outfit)
      : [...current, saved]);
    setShowBuilder(false);
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

  const viewingOutfit = outfits.find((outfit) => outfit.id === viewingOutfitId) || null;

  return (
    <main className="gallery-pane">
      <header className="gallery-header">
        <div className="gallery-meta-row">
          <p className="piece-count">{outfits.length} {outfits.length === 1 ? "outfit" : "outfits"}</p>
          <button type="button" className="color-profile-trigger suggest-trigger" onClick={() => setShowSuggestions(true)} disabled={items.length < 5}>
            <Lightbulb size={13} weight="bold" aria-hidden="true" /> Suggest outfits
          </button>
          <button type="button" className="color-profile-trigger" onClick={openNewOutfit} disabled={!items.length}>
            <Plus size={13} weight="bold" aria-hidden="true" /> New outfit
          </button>
        </div>
      </header>

      {error && <p className="status error">{error}</p>}
      {!error && loading && <p className="status">Loading outfits</p>}
      {!error && !loading && !items.length && <p className="status empty">Import some wardrobe pieces first, then come back to build outfits.</p>}
      {!error && !loading && !!items.length && !outfits.length && <p className="status empty">No outfits yet — combine pieces from your wardrobe into a look.</p>}

      <SuggestionNudges items={items} />

      {!!outfits.length && (
        <section className="outfits-grid">
          {outfits.map((outfit) => (
            <OutfitCard key={outfit.id} outfit={outfit} itemMap={itemMap} onOpen={setViewingOutfitId} />
          ))}
        </section>
      )}

      {viewingOutfit && (
        <OutfitViewer
          outfit={viewingOutfit}
          itemMap={itemMap}
          onClose={() => setViewingOutfitId(null)}
          onEdit={openEditOutfit}
          onDelete={deleteOutfit}
          onGenerateModeled={generateOutfitModeled}
          premiumAllowed={premiumAllowed}
        />
      )}

      {showBuilder && <OutfitBuilder items={items} initialOutfit={builderOutfit} onCancel={closeBuilder} onSave={saveOutfit} />}

      {showSuggestions && (
        <SuggestionPanel
          items={items}
          outfits={outfits}
          onSaveOutfit={async (draft) => {
            const saved = await api("/api/outfits", { method: "POST", body: JSON.stringify(draft) });
            setOutfits((current) => [...current, saved]);
            return saved;
          }}
          onClose={() => setShowSuggestions(false)}
        />
      )}
    </main>
  );
}
