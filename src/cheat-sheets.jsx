import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, DownloadSimple, Plus, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import { api } from "./api.js";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { CATEGORY_LABEL, WARDROBE_TYPES } from "./categories.js";
import { useIsPhone } from "./hooks/useIsPhone.js";
import { initialVariantForPiece, variantImage, variantOwnImage } from "../shared/wardrobe-model.mjs";
import { buildOverviewIndex, filterOverviewIndex } from "../shared/overview-index.mjs";
import { cheatSheetSourceFingerprint, renderCheatSheet } from "./cheat-sheet-renderer.js";
import "./cheat-sheets.css";

const sortSheets = (sheets) => [...sheets].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
const draftShape = (title, pieces) => JSON.stringify({ title: String(title || "").trim(), pieces });

function fileSlug(title) {
  const slug = String(title || "cheat-sheet").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${slug || "cheat-sheet"}.png`;
}

function triggerDownload(url, title) {
  const name = fileSlug(title);
  const downloadUrl = `${url}${url.includes("?") ? "&" : "?"}download=1&name=${encodeURIComponent(name)}`;
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function focusIfVisible(element) {
  if (!element?.isConnected || element.getClientRects().length === 0 || element.closest("[hidden], [inert]")) return false;
  element.focus({ preventScroll: true });
  return true;
}

function SheetCard({ sheet, onOpen }) {
  return (
    <button id={`cheat-sheet-card-${sheet.id}`} type="button" className="cheat-card" onClick={onOpen}>
      <span className="cheat-card__cover"><img src={sheet.thumbnailImage} alt="" loading="lazy" /></span>
      <span className="cheat-card__title">{sheet.title}</span>
      <span className="cheat-card__meta">{sheet.pieces?.length || 0} {(sheet.pieces?.length || 0) === 1 ? "piece" : "pieces"}</span>
    </button>
  );
}

function SheetCollection({ sheets, loading, error, onNew, onOpen }) {
  return (
    <section className="cheat-collection" aria-labelledby="cheat-collection-title">
      <header className="cheat-collection__header">
        <div><span className="cheat-collection__eyebrow">Overview</span><h2 id="cheat-collection-title">Cheat sheets <span>{sheets.length}</span></h2></div>
        <button type="button" className="cheat-new-button" onClick={onNew}><Plus size={16} weight="bold" aria-hidden="true" /> New cheat sheet</button>
      </header>
      {error && <p className="cheat-message cheat-message--error" role="alert">{error}</p>}
      {loading ? <p className="cheat-collection__empty">Loading cheat sheets…</p> : sheets.length ? (
        <div className="cheat-collection__grid">{sortSheets(sheets).map((sheet) => <SheetCard key={sheet.id} sheet={sheet} onOpen={(event) => onOpen(sheet, event)} />)}</div>
      ) : (
        <div className="cheat-collection__empty">
          <strong>Your collection starts here.</strong>
          <span>Create a cheat sheet from selected wardrobe pieces or start with a blank sheet.</span>
          <button type="button" className="secondary-button" onClick={onNew}>Create your first cheat sheet</button>
        </div>
      )}
    </section>
  );
}

const PiecePicker = forwardRef(function PiecePicker({ items, selected, onToggle, query, onQuery, category, onCategory, disabled }, searchRef) {
  const index = useMemo(() => buildOverviewIndex(items), [items]);
  const filtered = useMemo(() => filterOverviewIndex(index, query), [index, query]);
  const visible = category === "all" ? filtered : filtered.filter(({ item }) => item.part === category);
  return (
    <div className="cheat-picker">
      <div className="cheat-picker__heading"><span className="cheat-editor__eyebrow">Wardrobe</span><h3>Add pieces</h3></div>
      <label className="sr-only" htmlFor="cheat-picker-search">Search the wardrobe</label>
      <input ref={searchRef} id="cheat-picker-search" className="cheat-picker__search" type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search your wardrobe" autoComplete="off" disabled={disabled} />
      <div className="cheat-picker__categories" role="group" aria-label="Filter by category">
        {WARDROBE_TYPES.map((entry) => <button key={entry.id} type="button" className={category === entry.id ? "is-active" : ""} onClick={() => onCategory(entry.id)} disabled={disabled}>{entry.label}</button>)}
      </div>
      <div className="cheat-picker__list" aria-label="Wardrobe pieces">
        {visible.length ? visible.map(({ item }) => {
          const checked = selected.has(item.id);
          const image = variantImage(item, item.defaultVariantId);
          return (
            <label key={item.id} className={`cheat-picker__item${checked ? " is-selected" : ""}`}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(item)} />
              <span className="cheat-picker__checkbox" aria-hidden="true">{checked && <Check size={13} weight="bold" />}</span>
              <span className="cheat-picker__thumb">{image && <img src={image} alt="" loading="lazy" />}</span>
              <span className="cheat-picker__name"><strong>{item.name || "Untitled piece"}</strong><small>{CATEGORY_LABEL[item.part] || "Other"}</small></span>
            </label>
          );
        }) : <p className="cheat-picker__empty">No pieces match this search.</p>}
      </div>
    </div>
  );
});

function CheatSheetEditor({ items, entry, onClose, onSaved, onSheetUpdate }) {
  const [savedSheet, setSavedSheet] = useState(entry.sheet || null);
  const [title, setTitle] = useState(entry.sheet?.title || "");
  const [selected, setSelected] = useState(() => new Map(
    entry.sheet?.pieces?.map((piece) => [piece.itemId, piece.variantId])
      || (entry.initialPieces || []).flatMap((piece) => {
        const item = items.find((candidate) => candidate.id === piece.itemId);
        return item ? [[piece.itemId, piece.variantId || initialVariantForPiece(item)]] : [];
      }),
  ));
  const [mode, setMode] = useState("pieces");
  const [mobileView, setMobileView] = useState("pieces");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [renderVersion, setRenderVersion] = useState(0);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [visualViewport, setVisualViewport] = useState(null);
  const isPhone = useIsPhone();
  const titleInputRef = useRef(null);
  const closeKeepRef = useRef(null);
  const closeButtonRef = useRef(null);
  const closeConfirmReturnRef = useRef(null);
  const deleteTriggerRef = useRef(null);
  const deleteKeepRef = useRef(null);
  const pickerSearchRef = useRef(null);
  const mobilePiecesTabRef = useRef(null);
  const mobilePreviewTabRef = useRef(null);
  const renderCache = useRef(new Map());
  const draftPieces = useMemo(() => [...selected].map(([itemId, variantId]) => ({ itemId, variantId })), [selected]);
  const key = useMemo(() => draftShape(title, draftPieces), [title, draftPieces]);
  const baseKey = savedSheet ? draftShape(savedSheet.title, savedSheet.pieces || []) : null;
  const dirty = savedSheet ? key !== baseKey : Boolean(title.trim() || selected.size);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const selectedEntries = useMemo(() => draftPieces.map((piece) => ({
    ...piece,
    item: itemsById.get(piece.itemId) || null,
    variant: itemsById.get(piece.itemId)?.variants?.find((candidate) => candidate.id === piece.variantId) || null,
  })), [draftPieces, itemsById]);
  const renderReady = Boolean(preview && preview.key === key);
  const renderIssue = previewError?.key === key ? previewError.error : null;
  const selectedCount = selected.size;
  const busy = saving || deleting;
  const canSave = Boolean(title.trim() && selectedCount && renderReady && !renderIssue && !busy);
  const canDownload = Boolean(!busy && ((dirty && canSave) || savedSheet?.originalImage));
  const modalOpen = closeConfirm || deleteConfirm;
  const overlayStyle = visualViewport ? { top: `${visualViewport.offsetTop}px`, height: `${visualViewport.height}px`, bottom: "auto" } : undefined;
  const entryStyle = visualViewport ? { "--cheat-viewport-height": `${visualViewport.height}px` } : undefined;

  const restoreCloseConfirmFocus = useCallback(() => {
    const candidates = [
      closeConfirmReturnRef.current,
      mode === "picker" ? pickerSearchRef.current : null,
      isPhone && mobileView === "preview" ? mobilePreviewTabRef.current : null,
      isPhone ? mobilePiecesTabRef.current : null,
      titleInputRef.current,
      closeButtonRef.current,
    ];
    for (const candidate of candidates) if (focusIfVisible(candidate)) return;
  }, [isPhone, mode, mobileView]);

  useEffect(() => { titleInputRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    if (!isPhone || !window.visualViewport) { setVisualViewport(null); return undefined; }
    const viewport = window.visualViewport;
    const syncViewport = () => {
      const next = { height: viewport.height, offsetTop: viewport.offsetTop };
      setVisualViewport((current) => current
        && Math.abs(current.height - next.height) < 1
        && Math.abs(current.offsetTop - next.offsetTop) < 1
        ? current
        : next);
    };
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, [isPhone]);

  useEffect(() => {
    if (mode !== "picker") return undefined;
    const frame = requestAnimationFrame(() => pickerSearchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  useEffect(() => {
    if (closeConfirm) requestAnimationFrame(() => closeKeepRef.current?.focus({ preventScroll: true }));
  }, [closeConfirm, deleteConfirm]);

  useEffect(() => {
    if (deleteConfirm) requestAnimationFrame(() => deleteKeepRef.current?.focus({ preventScroll: true }));
  }, [deleteConfirm]);

  useEffect(() => {
    const controller = new AbortController();
    if (!title.trim()) {
      setPreview(null);
      setPreviewError(null);
      return () => controller.abort();
    }
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      renderCheatSheet({ title, items, selectedPieces: draftPieces, cache: renderCache.current, signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) setPreview({ ...result, key });
        })
        .catch((error) => {
          if (!controller.signal.aborted && error.name !== "AbortError") setPreviewError({ key, error });
        });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [title, items, draftPieces, key, renderVersion]);

  const toggleItem = (item) => setSelected((current) => {
    const next = new Map(current);
    if (next.has(item.id)) next.delete(item.id);
    else next.set(item.id, initialVariantForPiece(item));
    return next;
  });

  const removePiece = (itemId) => setSelected((current) => {
    const next = new Map(current);
    next.delete(itemId);
    return next;
  });

  const setVariant = (itemId, variantId) => setSelected((current) => new Map(current).set(itemId, variantId));

  const reportSaved = (sheet) => {
    setSavedSheet(sheet);
    onSheetUpdate(sheet);
  };

  const persistDraft = async () => {
    if (!canSave) throw new Error(renderIssue?.message || "Add a title and at least one piece, then wait for the preview.");
    setActionError("");
    setSaving(true);
    try {
      const fingerprint = await cheatSheetSourceFingerprint(title, draftPieces, preview.source);
      const payload = { title: title.trim(), pieces: draftPieces, sourceFingerprint: fingerprint, bands: preview.bands };
      const result = savedSheet
        ? await api(`/api/cheat-sheets/${encodeURIComponent(savedSheet.id)}`, { method: "PUT", body: JSON.stringify({ ...payload, expectedRevision: savedSheet.revision }) })
        : await api("/api/cheat-sheets", { method: "POST", body: JSON.stringify(payload) });
      reportSaved(result.sheet);
      return result.sheet;
    } catch (error) {
      setActionError(error.message || "Could not save the cheat sheet. Your draft is still here.");
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const saveAndClose = async () => {
    try { onSaved(await persistDraft()); }
    catch { /* retain the editable draft, including conflicts */ }
  };

  const saveAndDownload = async () => {
    try {
      const sheet = dirty && canSave ? await persistDraft() : savedSheet;
      if (sheet?.originalImage) triggerDownload(sheet.originalImage, sheet.title);
    } catch { /* errors appear beside the footer actions */ }
  };

  const requestClose = useCallback(() => {
    if (busy || modalOpen) return false;
    if (dirty) { closeConfirmReturnRef.current = document.activeElement; setCloseConfirm(true); return false; }
    return true;
  }, [busy, dirty, modalOpen]);

  useEffect(() => {
    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      if (deleteConfirm) { setDeleteConfirm(false); requestAnimationFrame(() => deleteTriggerRef.current?.focus({ preventScroll: true })); return; }
      if (closeConfirm) { setCloseConfirm(false); requestAnimationFrame(restoreCloseConfirmFocus); return; }
      if (mode === "picker") { setMode("pieces"); requestAnimationFrame(() => titleInputRef.current?.focus({ preventScroll: true })); return; }
      if (requestClose()) onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [busy, closeConfirm, deleteConfirm, mode, mobileView, restoreCloseConfirmFocus, requestClose, onClose]);

  const confirmDiscard = () => { setCloseConfirm(false); onClose(); };

  const deleteSheet = async () => {
    if (!savedSheet || busy) return;
    setDeleting(true);
    try {
      await api(`/api/cheat-sheets/${encodeURIComponent(savedSheet.id)}`, { method: "DELETE" });
      onSheetUpdate(null, savedSheet.id);
      onClose();
    } catch (error) {
      setActionError(error.message || "Could not delete this cheat sheet.");
      setDeleteConfirm(false);
      setDeleting(false);
    }
  };

  const retryPreview = () => { setPreviewError(null); setRenderVersion((value) => value + 1); };
  const displayPreview = (interactive = true) => {
    if (!dirty && savedSheet?.originalImage) return <img className="cheat-preview__saved-image" src={savedSheet.originalImage} alt={`${savedSheet.title}, saved cheat sheet`} />;
    if (renderReady) return <div className="cheat-preview__bands">{preview.bands.map((band, index) => <img key={`${band.kind}-${band.groupId || "title"}-${index}`} src={band.dataUrl} alt="" draggable="false" />)}</div>;
    if (savedSheet?.originalImage) return <div className="cheat-preview__stale"><img className="cheat-preview__saved-image" src={savedSheet.originalImage} alt={`${savedSheet.title}, last saved cheat sheet`} /><span>Last saved version</span></div>;
    return (
      <div className="cheat-preview__placeholder">
        <span className="cheat-preview__placeholder-mark" aria-hidden="true" />
        <strong>{title ? (renderIssue ? "Preview needs attention" : "Preparing preview") : "Your sheet preview"}</strong>
        <span>{title ? (renderIssue?.message || "The preview is composed from your approved cutouts.") : "Add a title and pieces to start composing."}</span>
        {renderIssue && interactive && <button type="button" className="secondary-button" onClick={retryPreview}>Retry preview</button>}
      </div>
    );
  };

  const handleMobileTab = (view) => { if (mode !== "picker") setMobileView(view); };
  const controlsDisabled = busy || modalOpen;
  const pickMode = mode === "picker";
  return (
    <ViewerPanel
      ariaLabel={savedSheet ? `Edit cheat sheet: ${savedSheet.title}` : "Create a cheat sheet"}
      onClose={onClose}
      onRequestClose={requestClose}
      closeRef={closeButtonRef}
      overlayClassName="cheat-editor-overlay"
      entryClassName="cheat-editor-entry"
      panelClassName="cheat-editor-panel"
      overlayStyle={overlayStyle}
      entryStyle={entryStyle}
      swipeToClose={!dirty && !busy && !modalOpen}
      swipeHandleOnly
      closeDisabled={busy || modalOpen}
      focusTrap
    >
      <div className="cheat-editor" inert={modalOpen ? true : undefined}>
        <div className="cheat-editor__handle" data-sheet-grab aria-hidden="true"><span /></div>
        <header className="cheat-editor__header">
          {pickMode ? (
            <>
              <button type="button" className="cheat-editor__back" onClick={() => setMode("pieces")} disabled={controlsDisabled} aria-label="Back to selected pieces"><ArrowLeft size={18} /> Back</button>
              <div><span className="cheat-editor__eyebrow">Wardrobe</span><h2>Add pieces</h2></div>
    <button type="button" className="cheat-editor__done" onClick={() => setMode("pieces")} disabled={controlsDisabled}>Done</button>
            </>
          ) : (
            <>
              <div><span className="cheat-editor__eyebrow">{savedSheet ? "Collection" : "Overview"}</span><h2>{savedSheet ? "Edit cheat sheet" : "Create cheat sheet"}</h2></div>
              <span className="cheat-editor__header-count">{selectedCount} {selectedCount === 1 ? "piece" : "pieces"}</span>
            </>
          )}
          <span className="cheat-editor__close-spacer" />
        </header>

        {isPhone && !pickMode && (
          <div className="cheat-editor__mobile-tabs" role="tablist" aria-label="Cheat sheet editor">
            <button ref={mobilePiecesTabRef} type="button" role="tab" aria-selected={mobileView === "pieces"} className={mobileView === "pieces" ? "is-active" : ""} onClick={() => handleMobileTab("pieces")}>Pieces ({selectedCount})</button>
            <button ref={mobilePreviewTabRef} type="button" role="tab" aria-selected={mobileView === "preview"} className={mobileView === "preview" ? "is-active" : ""} onClick={() => handleMobileTab("preview")}>Preview</button>
          </div>
        )}

        <div className={`cheat-editor__main${pickMode ? " is-picker" : ""}${mobileView === "preview" ? " is-mobile-preview" : ""}`}>
          <section className={`cheat-editor__left-pane${pickMode ? " is-picker" : ""}`} aria-label={pickMode ? "Choose wardrobe pieces" : "Cheat sheet pieces"}>
            {pickMode ? (
              <PiecePicker ref={pickerSearchRef} items={items} selected={selected} onToggle={toggleItem} query={query} onQuery={setQuery} category={category} onCategory={setCategory} disabled={controlsDisabled} />
            ) : (
              <>
                <section className="cheat-editor__pieces-pane" aria-label="Cheat sheet pieces">
                  {isPhone && <button type="button" className="cheat-editor__mini-preview" onClick={() => setMobileView("preview")} aria-label="Open full cheat sheet preview">{displayPreview(false)}</button>}
                  <div className="cheat-editor__piece-controls">
                    <label className="cheat-title-field">
                      <span>Title</span>
                      <input ref={titleInputRef} type="text" value={title} onChange={(event) => setTitle(event.target.value.slice(0, 120))} maxLength={120} placeholder="e.g. Summer in the city" disabled={controlsDisabled} />
                      <small>{title.length}/120</small>
                    </label>
                    <div className="cheat-piece-count"><strong>{selectedCount} {selectedCount === 1 ? "piece" : "pieces"}</strong><button type="button" onClick={() => setMode("picker")} disabled={controlsDisabled}><Plus size={15} weight="bold" /> Add pieces</button></div>
                  </div>
                  <div className="cheat-selected-list">
                    {selectedEntries.length ? selectedEntries.map(({ itemId, variantId, item, variant }) => {
                      const unavailable = !item || !variant || !variantOwnImage(item, variantId);
                      const issueForItem = renderIssue?.itemId === itemId;
                      return (
                        <article key={itemId} className={`cheat-selected-piece${unavailable || issueForItem ? " is-error" : ""}`}>
                          <span className="cheat-selected-piece__image">{item && variantImage(item, variantId) && <img src={variantImage(item, variantId)} alt="" />}</span>
                          <div className="cheat-selected-piece__details">
                            <strong>{item?.name || "Missing wardrobe piece"}</strong>
                            {item && item.variants?.length > 1 ? <label className="sr-only" htmlFor={`cheat-variant-${itemId}`}>Variant for {item.name}</label> : <small>{variant?.name || "Reference missing"}</small>}
                            {item && item.variants?.length > 1 && (
                              <select id={`cheat-variant-${itemId}`} value={variantId || ""} onChange={(event) => setVariant(itemId, event.target.value)} disabled={controlsDisabled}>
                                {item.variants.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                              </select>
                            )}
                          </div>
                          <button type="button" className="cheat-selected-piece__remove" aria-label={`Remove ${item?.name || "missing piece"}`} onClick={() => removePiece(itemId)} disabled={controlsDisabled}><X size={17} /></button>
                          {(unavailable || issueForItem) && <div className="cheat-selected-piece__issue" role="alert"><span>{issueForItem ? renderIssue.message : `${item?.name || "This piece"} needs an approved cutout.`}</span><button type="button" onClick={retryPreview} disabled={controlsDisabled}>Retry</button><button type="button" onClick={() => removePiece(itemId)} disabled={controlsDisabled}>Remove</button></div>}
                        </article>
                      );
                    }) : <p className="cheat-selected-list__empty">Add pieces from your wardrobe to get started.</p>}
                  </div>
                </section>
              </>
            )}
          </section>
          <section className={`cheat-editor__preview-pane${mobileView === "preview" && !pickMode ? " is-visible" : ""}`} aria-label="Preview">
            <div className="cheat-editor__preview-scroll" key={`${preview?.key || "none"}-${savedSheet?.revision || 0}`}>
              {displayPreview()}
            </div>
            {previewError?.key === key && previewError.error?.itemId && <div className="cheat-render-error" role="alert"><span>{previewError.error.message}</span><button type="button" onClick={retryPreview} disabled={controlsDisabled}>Retry</button><button type="button" onClick={() => removePiece(previewError.error.itemId)} disabled={controlsDisabled}>Remove</button></div>}
          </section>
        </div>

        <footer className="cheat-editor__footer">
          <div className="cheat-editor__footer-leading">
            {savedSheet && <button ref={deleteTriggerRef} type="button" className="cheat-editor__delete" onClick={() => setDeleteConfirm(true)} disabled={busy || modalOpen}><Trash size={15} /> Delete</button>}
            {dirty && !canSave && !actionError && <span className="cheat-editor__status">{renderIssue?.message || (title.trim() ? "Preparing preview…" : "Add a title to save")}</span>}
          </div>
          <div className="cheat-editor__footer-actions">
            <button type="button" className="cheat-editor__download" onClick={saveAndDownload} disabled={!canDownload}>
              <DownloadSimple size={16} aria-hidden="true" />{saving ? "Saving…" : dirty && canSave ? "Save & download" : dirty && savedSheet?.originalImage ? "Download saved" : dirty ? "Save & download" : "Download"}
            </button>
            <button type="button" className="cheat-editor__save" onClick={saveAndClose} disabled={!canSave || !dirty}><Check size={16} weight="bold" /> Save</button>
          </div>
          {actionError && <p className="cheat-editor__action-error" role="alert">{actionError}</p>}
        </footer>
      </div>

      {closeConfirm && (
        <div className="cheat-confirm-layer" role="presentation">
          <div className="cheat-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cheat-close-title" aria-describedby="cheat-close-copy">
            <span className="cheat-confirm__eyebrow">Unsaved changes</span><h2 id="cheat-close-title">Leave this cheat sheet?</h2><p id="cheat-close-copy">Your changes haven’t been saved yet.</p>
            <div className="cheat-confirm__actions"><button ref={closeKeepRef} type="button" className="cheat-confirm__keep" onClick={() => { setCloseConfirm(false); requestAnimationFrame(restoreCloseConfirmFocus); }}>Keep editing</button><button type="button" className="cheat-confirm__discard" onClick={confirmDiscard}>Discard changes</button></div>
          </div>
        </div>
      )}
      {deleteConfirm && (
        <div className="cheat-confirm-layer" role="presentation">
          <div className="cheat-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cheat-delete-title" aria-describedby="cheat-delete-copy">
            <span className="cheat-confirm__eyebrow">Delete sheet</span><h2 id="cheat-delete-title">Delete “{savedSheet?.title}”?</h2><p id="cheat-delete-copy">This permanently removes the saved cheat sheet and its PNG.</p>
            <div className="cheat-confirm__actions"><button ref={deleteKeepRef} type="button" className="cheat-confirm__keep" onClick={() => { setDeleteConfirm(false); requestAnimationFrame(() => deleteTriggerRef.current?.focus({ preventScroll: true })); }} disabled={deleting}>Keep sheet</button><button type="button" className="cheat-confirm__discard" onClick={deleteSheet} disabled={deleting}>{deleting ? <><SpinnerGap size={15} className="cheat-spinner" /> Deleting…</> : "Delete sheet"}</button></div>
          </div>
        </div>
      )}
    </ViewerPanel>
  );
}

export function CheatSheetsArea({ items, active, createRequest, returnFocusRef, onSaved }) {
  const [sheets, setSheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const requestSeen = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api("/api/cheat-sheets");
      setSheets(sortSheets(result.sheets || [])); setError(""); setLoading(false);
      return result.sheets || [];
    } catch (requestError) {
      setError(requestError.message || "Could not load your cheat sheets."); setLoading(false); return [];
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!createRequest || requestSeen.current === createRequest.id) return;
    requestSeen.current = createRequest.id;
    setEntry({ key: createRequest.id, sheet: null, initialPieces: createRequest.pieces || [] });
  }, [createRequest]);

  const updateSheet = useCallback((sheet, removedId = null) => {
    setSheets((current) => sortSheets(removedId ? current.filter((item) => item.id !== removedId) : [sheet, ...current.filter((item) => item.id !== sheet.id)]));
  }, []);

  const newSheet = (event) => {
    event?.currentTarget?.focus?.({ preventScroll: true });
    if (returnFocusRef) returnFocusRef.current = event?.currentTarget || null;
    setEntry({ key: crypto.randomUUID(), sheet: null, initialPieces: [] });
  };

  const openSheet = async (sheet, event) => {
    event?.currentTarget?.focus?.({ preventScroll: true });
    if (returnFocusRef) returnFocusRef.current = event?.currentTarget || null;
    setOpeningId(sheet.id); setError("");
    try {
      const result = await api(`/api/cheat-sheets/${encodeURIComponent(sheet.id)}`);
      setEntry({ key: crypto.randomUUID(), sheet: result.sheet, initialPieces: [] });
    } catch (requestError) { setError(requestError.message || "Could not open this cheat sheet."); }
    finally { setOpeningId(null); }
  };

  const saved = (sheet) => {
    updateSheet(sheet); setEntry(null); onSaved?.(); void refresh();
    requestAnimationFrame(() => document.getElementById(`cheat-sheet-card-${sheet.id}`)?.focus({ preventScroll: true }));
  };

  const closeEditor = () => {
    setEntry(null);
    requestAnimationFrame(() => {
      const trigger = returnFocusRef?.current;
      if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
      else document.querySelector(".cheat-new-button")?.focus({ preventScroll: true });
    });
  };

  if (!active && !entry) return null;
  return <>{active && <SheetCollection sheets={sheets} loading={loading || Boolean(openingId)} error={error} onNew={newSheet} onOpen={openSheet} />}{entry && <CheatSheetEditor key={entry.key} items={items} entry={entry} onClose={closeEditor} onSaved={saved} onSheetUpdate={updateSheet} />}</>;
}
