import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, MagicWand, SpinnerGap, UploadSimple, X } from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { api } from "./api.js";
import { INSPO_CATEGORIES as CATEGORIES, CATEGORY_LABEL } from "./categories.js";
import { GalleryItem, ItemViewer } from "./item-editor.jsx";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { PanelActions } from "./components/PanelActions.jsx";
import { PageShell } from "./components/PageShell.jsx";
import { PageStatus } from "./components/PageStatus.jsx";
import { ModeledHero } from "./components/ModeledHero.jsx";
import { EditableTitle } from "./components/EditableTitle.jsx";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import { useTypeFilteredItems } from "./hooks/useTypeFilteredItems.js";
import "./inspo.css";
import "./wishlist.css";

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });

// ─── InspoImporter ────────────────────────────────────────────────────────────
function InspoImporter({ onClose, onImported }) {
  const closeButtonRef = useRef(null);
  const [tab, setTab] = useState("url"); // "url" | "drop"
  const [urlText, setUrlText] = useState("");
  const [dropQueue, setDropQueue] = useState([]); // [{ name, dataUrl }]
  const [over, setOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const fileInputRef = useRef(null);

  useViewerKeyboard(onClose, closeButtonRef);

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
    <ViewerPanel title="Add Inspo" ariaLabel="Add inspiration" onClose={onClose} closeRef={closeButtonRef} entryClassName="inspo-importer-entry">
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
                    <button className="icon-button inspo-queue-remove" type="button" onClick={() => removeQueued(index)} aria-label={`Remove ${item.name}`}>
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
            {importing ? <><SpinnerGap size={14} className="top-action__spinner" aria-hidden="true" /> Importing…</> : <><Check size={14} weight="bold" aria-hidden="true" /> Import</>}
          </button>
        </PanelActions>
      </div>
    </ViewerPanel>
  );
}

// ─── PinCard ──────────────────────────────────────────────────────────────────
// Styled identically to GalleryItem (title outside the card, no inline
// actions) so a pin and a wardrobe/wishlist piece read as the same family in
// one mixed grid — the only difference is a cover-fit photo instead of a
// contain-fit cutout. Detect/re-detect and editing live in PinViewer now,
// not as buttons sitting in the grid.
function PinCard({ pin, index, wishlistCount, onOpen }) {
  const categoryLabel = pin.category ? (CATEGORY_LABEL[pin.category] || pin.category) : "Unclassified";
  const isProcessing = pin.detectStatus === "processing";

  return (
    <button
      className="gallery-item"
      type="button"
      onClick={() => onOpen(pin.id)}
      aria-label={`View ${pin.name || "inspo pin"}`}
      style={{ "--stagger-index": Math.min(index, 11) }}
      data-testid={`inspo-pin-${pin.id}`}
    >
      <span className="gallery-item__art gallery-item__art--photo">
        <OptimizedImage
          src={pin.image}
          alt=""
          sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 220px"
          breakpoints={[220, 320, 440]}
        />
      </span>
      <span className="gallery-item__label">
        <span className="gallery-item__name">{pin.name || (pin.category ? "Unnamed" : "Tap to identify")}</span>
        <span className="gallery-item__type">
          {isProcessing ? "Detecting…" : categoryLabel}
          {!!wishlistCount && !isProcessing && ` · ${wishlistCount} saved`}
        </span>
      </span>
    </button>
  );
}

// ─── PinViewer ────────────────────────────────────────────────────────────────
// One panel does everything a pin needs: view the photo large, rename it
// inline, see/change its category, jot notes, run detection, and delete —
// replacing the old split between an edit-only modal and CTAs sitting in the
// grid. Every field auto-saves on its own (like the outfit viewer's rename),
// so there's no separate Save/Cancel to track.
function PinViewer({ pin, wishlistCount, onClose, onSave, onDelete, onDetect }) {
  const closeButtonRef = useRef(null);
  const [notes, setNotes] = useState(pin.notes || "");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");

  useViewerKeyboard(onClose, closeButtonRef);

  const isProcessing = pin.detectStatus === "processing";
  const isError = pin.detectStatus === "error";
  const categoryLabel = pin.category ? (CATEGORY_LABEL[pin.category] || pin.category) : null;

  const patch = async (fields) => {
    setError("");
    try {
      const updated = await api(`/api/inspo/${pin.id}`, { method: "PATCH", body: JSON.stringify(fields) });
      onSave(updated);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const updated = await onDetect(pin.id);
      onSave(updated);
    } catch {
      // surfaces via pin.detectError once the poll settles
    } finally {
      setDetecting(false);
    }
  };

  const detectLabel = (detecting || isProcessing)
    ? "Detecting items…"
    : wishlistCount ? "Re-detect items" : isError ? "Retry detect" : "Detect items";

  return (
    <ViewerPanel ariaLabel={`Inspo pin: ${pin.name || "untitled"}`} onClose={onClose} closeRef={closeButtonRef}>
      <ModeledHero src={pin.image} alt={pin.name || "Inspiration photo"} showHeading={false} />

      <div className="viewer-details editing">
        <EditableTitle
          value={pin.name || ""}
          placeholder="Unnamed"
          ariaLabel="Pin name"
          onChange={(name) => patch({ name })}
        />
        <p className="details-label">
          {categoryLabel || "Unclassified"}{!!wishlistCount && ` · ${wishlistCount} in wishlist`}
        </p>

        <div className="pin-detect">
          {isError && <p className="pin-detect__error">{pin.detectError || "Detection failed."}</p>}
          <button className="secondary-button" type="button" onClick={handleDetect} disabled={detecting || isProcessing}>
            {(detecting || isProcessing)
              ? <SpinnerGap size={14} className="top-action__spinner" aria-hidden="true" />
              : <MagicWand size={14} weight="bold" aria-hidden="true" />}
            {detectLabel}
          </button>
        </div>

        <label className="field">
          <span>Category</span>
          <select value={pin.category || ""} onChange={(e) => patch({ category: e.target.value || null })}>
            <option value="">— unclassified —</option>
            {CATEGORIES.slice(1, -1).map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>

        <label className="field inspo-notes-field">
          <span>Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => { if (notes !== (pin.notes || "")) patch({ notes }); }}
            placeholder="What you like about it, where you saw it…"
          />
        </label>

        {error && <p className="status error" role="alert">{error}</p>}

        <PanelActions onDelete={() => onDelete(pin.id)} onCancel={onClose} cancelLabel="Close" />
      </div>
    </ViewerPanel>
  );
}

// ─── Inspo (main page) ────────────────────────────────────────────────────────
// Inspo pins and Wishlist pieces are one pipeline, not two features: a piece
// can only ever come from detecting it out of a pin (see
// detectAndCreateWishlistItems in scripts/wishlist-api.mjs — there is no
// standalone "add to wishlist" route). This view is the single categorized
// board for both: "Full Look" and "Unclassified" show pins, every garment
// category shows the wishlist pieces detected from them (plus any pin whose
// own aggregate category landed there too), and "All" shows everything.
export function Inspo({ showImporter, onImporterClose }) {
  const [pins, setPins] = useState([]);
  const [wishlistItems, setWishlistItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [selectedPinId, setSelectedPinId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);

  useEffect(() => {
    Promise.all([api("/api/inspo"), api("/api/wishlist")])
      .then(([loadedPins, loadedItems]) => { setPins(loadedPins); setWishlistItems(loadedItems); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Poll while a pin is detecting or a piece is still generating its cutout
  useEffect(() => {
    const pinsBusy = pins.some((p) => p.detectStatus === "processing");
    const itemsBusy = wishlistItems.some((item) => item.generateStatus === "processing");
    if (!pinsBusy && !itemsBusy) return undefined;
    const timer = setInterval(() => {
      Promise.all([api("/api/inspo"), api("/api/wishlist")])
        .then(([freshPins, freshItems]) => {
          const freshPinsById = Object.fromEntries(freshPins.map((p) => [p.id, p]));
          setPins((current) => current.map((p) => {
            const next = freshPinsById[p.id];
            return next ? { ...p, category: next.category, name: next.name, colors: next.colors, detectStatus: next.detectStatus, detectError: next.detectError } : p;
          }));
          const freshItemsById = Object.fromEntries(freshItems.map((item) => [item.id, item]));
          setWishlistItems((current) => {
            const currentIds = new Set(current.map((item) => item.id));
            const updated = current.map((item) => freshItemsById[item.id] || item);
            const created = freshItems.filter((item) => !currentIds.has(item.id));
            return created.length ? [...updated, ...created] : updated;
          });
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [pins, wishlistItems]);

  const selectedPin = pins.find((p) => p.id === selectedPinId) || null;
  const selectedItem = wishlistItems.find((item) => item.id === selectedItemId) || null;

  const wishlistCounts = {};
  for (const item of wishlistItems) {
    if (item.sourcePinId) wishlistCounts[item.sourcePinId] = (wishlistCounts[item.sourcePinId] || 0) + 1;
  }

  const visiblePins = pins.filter((p) => {
    if (activeCategory === "all") return true;
    if (activeCategory === "unclassified") return !p.category;
    return p.category === activeCategory;
  });
  // Wishlist pieces never carry "full_look" or "unclassified" as a part, so
  // those two categories fall through to a sentinel that matches nothing —
  // "all" passes straight through and still shows every piece.
  const itemFilterKey = activeCategory === "unclassified" || activeCategory === "full_look" ? "__none__" : activeCategory;
  const visibleItems = useTypeFilteredItems(wishlistItems, itemFilterKey);

  const unclassifiedCount = pins.filter((p) => !p.category).length;

  const handleImported = (created) => {
    setPins((current) => [...current, ...created]);
  };

  const handleDetect = async (id) => {
    const updated = await api(`/api/inspo/${id}/detect`, { method: "POST" });
    setPins((current) => current.map((p) => p.id === id ? updated : p));
    return updated;
  };

  const handlePinSave = (updated) => {
    setPins((current) => current.map((p) => p.id === updated.id ? updated : p));
  };

  const handlePinDelete = async (id) => {
    try {
      await api(`/api/inspo/${id}`, { method: "DELETE" });
      setPins((current) => current.filter((p) => p.id !== id));
      setSelectedPinId(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const saveItem = async (updatedItem) => {
    const saved = await api(`/api/wishlist/${updatedItem.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: updatedItem.name, part: updatedItem.part, color: updatedItem.color, secondaryColor: updatedItem.secondaryColor, tags: updatedItem.tags }),
    });
    setWishlistItems((current) => current.map((item) => item.id === saved.id ? saved : item));
  };

  const deleteItem = async (id) => {
    try {
      await api(`/api/wishlist/${id}`, { method: "DELETE" });
      setWishlistItems((current) => current.filter((item) => item.id !== id));
      setSelectedItemId(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const retryItem = async (event, id) => {
    event.stopPropagation();
    setRetryingId(id);
    try {
      const updated = await api(`/api/wishlist/${id}/retry`, { method: "POST" });
      setWishlistItems((current) => current.map((item) => item.id === id ? updated : item));
    } catch (e) {
      setError(e.message);
    } finally {
      setRetryingId(null);
    }
  };

  const totalCount = pins.length + wishlistItems.length;

  return (
    <PageShell
      count={totalCount}
      noun="item"
      categories={CATEGORIES.filter((cat) => cat.id !== "unclassified" || unclassifiedCount > 0 || activeCategory === "unclassified")}
      activeCategory={activeCategory}
      onCategory={setActiveCategory}
      renderCategory={(cat) => cat.id === "unclassified" && unclassifiedCount > 0 ? `${cat.label} (${unclassifiedCount})` : cat.label}
      navLabel="Filter inspo by category"
    >
      <PageStatus
        loading={loading}
        error={error}
        empty={!totalCount}
        emptyMessage="Drop, paste, or add a photo to start your board — individual pieces get detected automatically."
        filterEmpty={!!totalCount && !visiblePins.length && !visibleItems.length}
        filterEmptyMessage="Nothing in this category yet."
        noun="inspo"
      />

      {(!!visiblePins.length || !!visibleItems.length) && (
        <section className="gallery-grid" aria-label={`${CATEGORY_LABEL[activeCategory] || "All"} inspo`}>
          {visiblePins.map((pin, index) => (
            <PinCard
              key={pin.id}
              pin={pin}
              index={index}
              wishlistCount={wishlistCounts[pin.id] || 0}
              onOpen={setSelectedPinId}
            />
          ))}
          {visibleItems.map((item, index) => (
            <div className="wishlist-grid-item" key={item.id}>
              <GalleryItem item={item} index={visiblePins.length + index} selected={selectedItemId === item.id} onOpen={setSelectedItemId} />
              {item.generateStatus === "error" && (
                <button
                  type="button"
                  className="wishlist-retry-badge"
                  onClick={(event) => retryItem(event, item.id)}
                  disabled={retryingId === item.id}
                  aria-label={`Retry generating a clean image for ${item.name || "this item"}`}
                  title={item.generateError || "Cutout generation failed"}
                >
                  {retryingId === item.id
                    ? <SpinnerGap size={13} className="wishlist-retry-spinner" aria-hidden="true" />
                    : <ArrowCounterClockwise size={13} aria-hidden="true" />}
                  Retry
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {showImporter && (
        <InspoImporter
          onClose={onImporterClose}
          onImported={handleImported}
        />
      )}

      {selectedPin && (
        <PinViewer
          pin={selectedPin}
          wishlistCount={wishlistCounts[selectedPin.id] || 0}
          onClose={() => setSelectedPinId(null)}
          onSave={handlePinSave}
          onDelete={handlePinDelete}
          onDetect={handleDetect}
        />
      )}

      {selectedItem && (
        <ItemViewer
          item={selectedItem}
          onClose={() => setSelectedItemId(null)}
          onSave={saveItem}
          onDelete={deleteItem}
          showModeledPhoto={false}
        />
      )}
    </PageShell>
  );
}
