import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MagicWand, PencilSimple, SpinnerGap, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { api } from "./api.js";
import { INSPO_CATEGORIES as CATEGORIES, CATEGORY_LABEL } from "./categories.js";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { PanelActions } from "./components/PanelActions.jsx";
import { PageShell } from "./components/PageShell.jsx";
import { PageStatus } from "./components/PageStatus.jsx";
import "./inspo.css";

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
    <ViewerPanel title="Add Inspo" ariaLabel="Add inspiration" onClose={onClose} entryClassName="inspo-importer-entry">
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

        <PanelActions onCancel={onClose}>
          <button className="primary-button" type="button" onClick={submit} disabled={importing || !canSubmit}>
            {importing ? <><SpinnerGap size={14} className="inspo-classify-spinner" aria-hidden="true" /> Importing…</> : <><Check size={14} weight="bold" aria-hidden="true" /> Import</>}
          </button>
        </PanelActions>
      </div>
    </ViewerPanel>
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
    <ViewerPanel title="Edit Pin" ariaLabel="Edit pin" onClose={onClose} entryClassName="inspo-editor-entry">
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

        <PanelActions onCancel={onClose} onConfirm={save} confirmIcon={<Check size={14} weight="bold" aria-hidden="true" />} confirmDisabled={saving} />
      </div>
    </ViewerPanel>
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
        {(!wishlistCount || isError) && !isProcessing && (
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
    <PageShell
      count={pins.length}
      noun="pin"
      actions={(
        <button type="button" className="header-action-btn" onClick={() => setShowImporter(true)}>
          + Add inspo
        </button>
      )}
      categories={CATEGORIES.filter((cat) => cat.id !== "unclassified" || unclassifiedCount > 0 || activeCategory === "unclassified")}
      activeCategory={activeCategory}
      onCategory={setActiveCategory}
      renderCategory={(cat) => cat.id === "unclassified" && unclassifiedCount > 0 ? `${cat.label} (${unclassifiedCount})` : cat.label}
      navLabel="Filter inspo by category"
    >
      <PageStatus
        loading={loading}
        error={error}
        empty={!pins.length}
        emptyMessage="No inspo yet — add a Pinterest link or drop an image to start your board."
        filterEmpty={!!pins.length && !visiblePins.length}
        filterEmptyMessage="No pins in this category."
        noun="inspo"
      />

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
    </PageShell>
  );
}
