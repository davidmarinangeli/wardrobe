import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MagicWand, PencilSimple, SpinnerGap, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import "./inspo.css";

// ─── Shared category definitions (mirrors App.jsx TYPES) ──────────────────────
const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "upperbody", label: "Tops" },
  { id: "wholebody_up", label: "Jackets" },
  { id: "lowerbody", label: "Bottoms" },
  { id: "accessories_up", label: "Accessories" },
  { id: "shoes", label: "Shoes" },
  { id: "socks", label: "Socks" },
  { id: "full_look", label: "Full Look" },
  { id: "unclassified", label: "Unclassified" },
];

const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "Request failed.");
  return value;
}

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });

// ─── InspoImporter ────────────────────────────────────────────────────────────
function InspoImporter({ onClose, onImported }) {
  const [tab, setTab] = useState("url"); // "url" | "drop"
  const [urlText, setUrlText] = useState("");
  const [dropQueue, setDropQueue] = useState([]); // [{ name, dataUrl }]
  const [over, setOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const fileInputRef = useRef(null);

  const addFiles = useCallback(async (files) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    const encoded = await Promise.all(images.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUrl(f) })));
    setDropQueue((q) => [...q, ...encoded]);
  }, []);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    setOver(false);
    addFiles(event.dataTransfer.files);
  }, [addFiles]);

  const onDragOver = (event) => { event.preventDefault(); setOver(true); };
  const onDragLeave = () => setOver(false);

  const removeQueued = (index) => setDropQueue((q) => q.filter((_, i) => i !== index));

  const submit = async () => {
    setImportErrors([]);
    setImporting(true);

    let entries = [];

    if (tab === "url") {
      const urls = urlText.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!urls.length) { setImporting(false); return; }
      entries = urls.map((url) => ({ url }));
    } else {
      if (!dropQueue.length) { setImporting(false); return; }
      entries = dropQueue.map((item) => ({ imageDataUrl: item.dataUrl }));
    }

    try {
      const result = await api("/api/inspo", {
        method: "POST",
        body: JSON.stringify({ entries }),
      });
      if (result.errors?.length) {
        setImportErrors(result.errors.map((e) => e.error));
      }
      if (result.created?.length) {
        onImported(result.created);
        if (!result.errors?.length) onClose();
        else {
          // partial success — clear what worked
          if (tab === "url") {
            const failedUrls = new Set(result.errors.map((e) => e.input?.url).filter(Boolean));
            setUrlText([...failedUrls].join("\n"));
          } else {
            setDropQueue([]);
          }
        }
      }
    } catch (error) {
      setImportErrors([error.message]);
    } finally {
      setImporting(false);
    }
  };

  const canSubmit = tab === "url" ? urlText.trim().length > 0 : dropQueue.length > 0;

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-entry inspo-importer-entry">
        <aside className="viewer" role="dialog" aria-modal="true" aria-label="Add inspiration">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading">
            <h2>Add Inspo</h2>
          </div>

          <div className="inspo-importer-body">
            <nav className="inspo-tabs">
              <button type="button" className={tab === "url" ? "active" : ""} onClick={() => setTab("url")}>From URLs</button>
              <button type="button" className={tab === "drop" ? "active" : ""} onClick={() => setTab("drop")}>Drop images</button>
            </nav>

            {tab === "url" && (
              <div className="inspo-url-field">
                <label htmlFor="inspo-urls">Image URLs</label>
                <textarea
                  id="inspo-urls"
                  value={urlText}
                  onChange={(e) => setUrlText(e.target.value)}
                  placeholder={"https://i.pinimg.com/736x/…\nhttps://…\nhttps://…"}
                  spellCheck={false}
                />
                <p className="inspo-url-hint">Paste one image URL per line. Any public image link works — Pinterest, Instagram saves, or any site.</p>
              </div>
            )}

            {tab === "drop" && (
              <>
                <div
                  className={`inspo-dropzone${over ? " over" : ""}`}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  aria-label="Drop images here or click to browse"
                  onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    aria-hidden="true"
                    onChange={(e) => addFiles(e.target.files)}
                  />
                  <UploadSimple size={28} weight="light" aria-hidden="true" style={{ color: "var(--muted)" }} />
                  <div className="inspo-dropzone-label">
                    <strong>Drop images here</strong>
                    or click to browse
                  </div>
                </div>

                {dropQueue.length > 0 && (
                  <div className="inspo-queue">
                    {dropQueue.map((item, index) => (
                      <div className="inspo-queue-item" key={index}>
                        <img className="inspo-queue-thumb" src={item.dataUrl} alt="" />
                        <span className="inspo-queue-name">{item.name}</span>
                        <button className="inspo-queue-remove" type="button" onClick={() => removeQueued(index)} aria-label={`Remove ${item.name}`}>
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {importErrors.length > 0 && (
              <p className="inspo-import-errors">
                {importErrors.map((e, i) => <span key={i} style={{ display: "block" }}>{e}</span>)}
              </p>
            )}

            <div className="viewer-actions">
              <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
              <span className="action-spacer" />
              <button
                className="primary-button"
                type="button"
                onClick={submit}
                disabled={importing || !canSubmit}
              >
                {importing
                  ? <><SpinnerGap size={14} className="inspo-classify-spinner" aria-hidden="true" /> Importing…</>
                  : <><Check size={14} weight="bold" aria-hidden="true" /> Import</>}
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── InspoEditor ──────────────────────────────────────────────────────────────
function InspoEditor({ pin, onClose, onSave }) {
  const [name, setName] = useState(pin.name || "");
  const [notes, setNotes] = useState(pin.notes || "");
  const [category, setCategory] = useState(pin.category || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const updated = await api(`/api/inspo/${pin.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, notes, category: category || null }),
      });
      onSave(updated);
      onClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-entry inspo-editor-entry">
        <aside className="viewer" role="dialog" aria-modal="true" aria-label="Edit pin">
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label="Close">
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading">
            <h2>Edit Pin</h2>
          </div>

          <div className="inspo-editor-body">
            <img className="inspo-editor-preview" src={pin.image} alt="" />

            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. oversized linen blazer" />
            </label>

            <label className="field">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">— unclassified —</option>
                {CATEGORIES.slice(1, -1).map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </label>

            <label className="field inspo-notes-field">
              <span>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What you like about it, where you saw it…" />
            </label>

            {error && <p className="status error" style={{ margin: 0 }}>{error}</p>}

            <div className="viewer-actions">
              <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
              <span className="action-spacer" />
              <button className="primary-button" type="button" onClick={save} disabled={saving}>
                <Check size={14} weight="bold" aria-hidden="true" /> Save
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── InspoCard ────────────────────────────────────────────────────────────────
function InspoCard({ pin, onEdit, onDelete, onDetect, onUpdate, wishlistCount = 0 }) {
  const [detecting, setDetecting] = useState(false);

  const isProcessing = pin.detectStatus === "processing";
  const isError = pin.detectStatus === "error";
  const isUnclassified = !pin.category;

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const updated = await onDetect(pin.id);
      onUpdate(updated);
    } catch {
      // error surfaces via pin.detectError once the poll settles
    } finally {
      setDetecting(false);
    }
  };

  const badgeLabel = pin.category ? CATEGORY_LABEL[pin.category] || pin.category : null;

  return (
    <div className="inspo-card">
      <div className="inspo-card-image">
        <OptimizedImage
          src={pin.image}
          alt={pin.name || "Inspiration"}
          sizes="(max-width: 520px) calc(50vw - 16px), 220px"
          breakpoints={[220, 320, 440]}
        />
        {badgeLabel && (
          <span className="inspo-card-badge">{badgeLabel}</span>
        )}
        {!badgeLabel && (
          <span className="inspo-card-badge unclassified">Unclassified</span>
        )}
      </div>

      <div className="inspo-card-body">
        {/* Detect CTA — shown when nothing detected yet, or the last attempt failed */}
        {(!wishlistCount || isError) && (
          <div className="inspo-card-classify">
            {isError && <p className="inspo-card-classify-error">{pin.detectError || "Detection failed."}</p>}
            <button
              className="inspo-classify-btn"
              type="button"
              onClick={handleDetect}
              disabled={detecting || isProcessing}
            >
              {(detecting || isProcessing)
                ? <><SpinnerGap size={12} className="inspo-classify-spinner" aria-hidden="true" /> Detecting items…</>
                : <><MagicWand size={12} weight="bold" aria-hidden="true" /> {isError ? "Retry detect" : "Detect items"}</>}
            </button>
          </div>
        )}
        {isProcessing && !detecting && !isError && (
          <div className="inspo-card-classify">
            <button className="inspo-classify-btn" type="button" disabled>
              <SpinnerGap size={12} className="inspo-classify-spinner" aria-hidden="true" /> Detecting items…
            </button>
          </div>
        )}
        {!!wishlistCount && !isProcessing && !isError && (
          <div className="inspo-card-classify">
            <span className="inspo-card-wishlist-count">{wishlistCount} in Wishlist</span>
            <button className="inspo-classify-btn" type="button" onClick={handleDetect} disabled={detecting}>
              <MagicWand size={12} weight="bold" aria-hidden="true" /> Re-detect
            </button>
          </div>
        )}

        <div className="inspo-card-footer">
          <p className={`inspo-card-name${!pin.name ? " empty" : ""}`}>
            {pin.name || (isUnclassified ? "Tap detect to identify" : "Unnamed")}
          </p>
          <div className="inspo-card-actions">
            <button type="button" onClick={() => onEdit(pin)} aria-label={`Edit ${pin.name || "pin"}`}>
              <PencilSimple size={13} weight="regular" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => onDelete(pin.id)} aria-label={`Delete ${pin.name || "pin"}`}>
              <Trash size={13} weight="regular" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Inspo (main page) ────────────────────────────────────────────────────────
export function Inspo() {
  const [pins, setPins] = useState([]);
  const [wishlistCounts, setWishlistCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [showImporter, setShowImporter] = useState(false);
  const [editingPin, setEditingPin] = useState(null);

  const refreshWishlistCounts = useCallback(() => {
    api("/api/wishlist")
      .then((wishlistItems) => {
        const counts = {};
        for (const item of wishlistItems) {
          if (item.sourcePinId) counts[item.sourcePinId] = (counts[item.sourcePinId] || 0) + 1;
        }
        setWishlistCounts(counts);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api("/api/inspo")
      .then(setPins)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    refreshWishlistCounts();
  }, [refreshWishlistCounts]);

  // Poll while any pin is detecting items
  useEffect(() => {
    if (!pins.some((p) => p.detectStatus === "processing")) return undefined;
    const timer = setInterval(() => {
      api("/api/inspo")
        .then((fresh) => {
          const freshById = Object.fromEntries(fresh.map((p) => [p.id, p]));
          setPins((current) => current.map((p) => {
            const next = freshById[p.id];
            return next ? { ...p, category: next.category, name: next.name, colors: next.colors, detectStatus: next.detectStatus, detectError: next.detectError } : p;
          }));
          refreshWishlistCounts();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [pins, refreshWishlistCounts]);

  const visiblePins = pins.filter((p) => {
    if (activeCategory === "all") return true;
    if (activeCategory === "unclassified") return !p.category;
    return p.category === activeCategory;
  });

  const unclassifiedCount = pins.filter((p) => !p.category).length;

  const handleImported = (created) => {
    setPins((current) => [...current, ...created]);
  };

  const handleDetect = async (id) => {
    const updated = await api(`/api/inspo/${id}/detect`, { method: "POST" });
    setPins((current) => current.map((p) => p.id === id ? updated : p));
    return updated;
  };

  const handleUpdate = (updated) => {
    setPins((current) => current.map((p) => p.id === updated.id ? updated : p));
  };

  const handleDelete = async (id) => {
    try {
      await api(`/api/inspo/${id}`, { method: "DELETE" });
      setPins((current) => current.filter((p) => p.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <main className="gallery-pane">
      <header className="gallery-header">
        <div className="gallery-meta-row">
          <p className="piece-count">{pins.length} {pins.length === 1 ? "pin" : "pins"}</p>
          <button type="button" className="color-profile-trigger" onClick={() => setShowImporter(true)}>
            + Add inspo
          </button>
        </div>

        <nav className="category-nav" aria-label="Filter inspo by category">
          {CATEGORIES.map((cat) => {
            // skip "unclassified" if none exist
            if (cat.id === "unclassified" && unclassifiedCount === 0 && activeCategory !== "unclassified") return null;
            return (
              <button
                key={cat.id}
                type="button"
                className={activeCategory === cat.id ? "active" : ""}
                onClick={() => setActiveCategory(cat.id)}
                aria-pressed={activeCategory === cat.id}
              >
                {cat.label}
                {cat.id === "unclassified" && unclassifiedCount > 0 && ` (${unclassifiedCount})`}
              </button>
            );
          })}
        </nav>
      </header>

      {error && <p className="status error">{error}</p>}
      {!error && loading && <p className="status">Loading inspo</p>}
      {!error && !loading && !pins.length && (
        <p className="status empty">No inspo yet — add a Pinterest link or drop an image to start your board.</p>
      )}
      {!error && !loading && !!pins.length && !visiblePins.length && (
        <p className="status empty">No pins in this category.</p>
      )}

      {!!visiblePins.length && (
        <section className="inspo-grid">
          {visiblePins.map((pin) => (
            <InspoCard
              key={pin.id}
              pin={pin}
              onEdit={setEditingPin}
              onDelete={handleDelete}
              onDetect={handleDetect}
              onUpdate={handleUpdate}
              wishlistCount={wishlistCounts[pin.id] || 0}
            />
          ))}
        </section>
      )}

      {showImporter && (
        <InspoImporter
          onClose={() => setShowImporter(false)}
          onImported={handleImported}
        />
      )}

      {editingPin && (
        <InspoEditor
          pin={editingPin}
          onClose={() => setEditingPin(null)}
          onSave={(updated) => { handleUpdate(updated); setEditingPin(null); }}
        />
      )}
    </main>
  );
}
