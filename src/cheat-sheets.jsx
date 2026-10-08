import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CornersOut, DownloadSimple, Minus, Plus, Sparkle, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import { PencilSimple } from "@phosphor-icons/react";
import { api } from "./api.js";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { GenerateButton, useRememberedTier } from "./components/ModelPhotoControls.jsx";
import { CATEGORY_LABEL, WARDROBE_TYPES } from "./categories.js";
import { useIsPhone } from "./hooks/useIsPhone.js";
import { initialVariantForPiece, variantImage, variantOwnImage } from "../shared/wardrobe-model.mjs";
import { buildOverviewIndex, filterOverviewIndex } from "../shared/overview-index.mjs";
import { cheatSheetSourceFingerprint, renderCheatSheet } from "./cheat-sheet-renderer.js";
import { CHEAT_SHEET_LAYOUT_VERSION, CHEAT_SHEET_MAX_PIECE_SCALE, CHEAT_SHEET_MIN_PIECE_SCALE, CHEAT_SHEET_PIECE_SCALE_STEP, normalizeCheatSheetScale } from "../shared/cheat-sheet-layout.mjs";
import { CHEAT_SHEET_DESCRIPTION_LIMIT, CHEAT_SHEET_PROMPT_LIMIT, DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT } from "../shared/cheat-sheet-prompt.mjs";
import "./cheat-sheets.css";

const sortSheets = (sheets) => [...sheets].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
const draftShape = (title, pieces, description = "") => JSON.stringify({
  title: String(title || "").trim(),
  description: description.trim(),
  pieces: pieces.map(({ itemId, variantId, scale }) => ({ itemId, variantId, scale: normalizeCheatSheetScale(scale) })),
});

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

async function decodePreviewBands(bands, signal) {
  const images = bands.map((band) => {
    const image = new Image();
    image.src = band.dataUrl;
    if (typeof image.decode === "function") return image.decode();
    return new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Could not decode the preview image."));
      if (image.complete) image.naturalWidth ? resolve() : reject(new Error("Could not decode the preview image."));
    });
  });
  const decoding = Promise.all(images);
  if (!signal) return decoding;
  if (signal.aborted) throw new DOMException("Preview rendering cancelled", "AbortError");
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(new DOMException("Preview rendering cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([decoding, aborted]);
    if (signal.aborted) throw new DOMException("Preview rendering cancelled", "AbortError");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function SheetCard({ sheet, onOpen, onEdit, opening }) {
  return (
    <article className="cheat-card">
      <button id={`cheat-sheet-card-${sheet.id}`} type="button" className="cheat-card__open" onClick={onOpen} aria-label={`View cheat sheet fullscreen: ${sheet.title || "Untitled"}`} aria-haspopup="dialog" aria-busy={opening || undefined}>
        <span className="cheat-card__cover"><img src={sheet.aiThumbnailImage || sheet.thumbnailImage} alt="" loading="lazy" /></span>
        <span className="cheat-card__title">{sheet.title}</span>
        <span className="cheat-card__meta">{opening ? "Opening…" : <>{sheet.pieces?.length || 0} {(sheet.pieces?.length || 0) === 1 ? "piece" : "pieces"}{sheet.beautifyStatus === "processing" ? " · Beautifying…" : sheet.aiImage ? " · AI finish" : ""}</>}</span>
      </button>
      <button type="button" className="cheat-card__edit" onClick={onEdit} aria-label={`Edit cheat sheet: ${sheet.title || "Untitled"}`} aria-haspopup="dialog" title={`Edit ${sheet.title || "cheat sheet"}`}>
        <PencilSimple size={19} weight="regular" aria-hidden="true" />
      </button>
    </article>
  );
}

function SheetCollection({ sheets, loading, error, onNew, onOpen, onEdit, openingId }) {
  return (
    <section className="cheat-collection" aria-labelledby="cheat-collection-title">
      <header className="cheat-collection__header">
        <div><span className="cheat-collection__eyebrow">Overview</span><h2 id="cheat-collection-title">Cheat sheets <span>{sheets.length}</span></h2></div>
        <button type="button" className="cheat-new-button" onClick={onNew}><Plus size={16} weight="bold" aria-hidden="true" /> New cheat sheet</button>
      </header>
      {error && <p className="cheat-message cheat-message--error" role="alert">{error}</p>}
      {loading ? <p className="cheat-collection__empty">Loading cheat sheets…</p> : sheets.length ? (
        <div className="cheat-collection__grid">{sortSheets(sheets).map((sheet) => <SheetCard key={sheet.id} sheet={sheet} opening={openingId === sheet.id} onOpen={(event) => onOpen(sheet, event)} onEdit={(event) => onEdit(sheet, event)} />)}</div>
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

const CHEAT_SHEET_FULLSCREEN_LONG_THRESHOLD = 2200;

function FullscreenCheatSheetViewer({ title, versionLabel, isDraft, children, onClose, openedFrom }) {
  const closeRef = useRef(null);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const [fitBounds, setFitBounds] = useState({ width: 0, height: 0 });
  const [contentWidth, setContentWidth] = useState(null);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return undefined;
    const measure = () => {
      const style = getComputedStyle(scroll);
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const next = {
        width: Math.max(0, scroll.clientWidth - horizontalPadding),
        height: Math.max(0, scroll.clientHeight - verticalPadding),
      };
      setFitBounds((current) => Math.abs(current.width - next.width) < 1 && Math.abs(current.height - next.height) < 1 ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const images = [...content.querySelectorAll("img")];
    setContentWidth(null);
    const fit = () => {
      if (!fitBounds.width || !fitBounds.height || !images.length || images.some((image) => !image.complete || !image.naturalWidth || !image.naturalHeight)) return;
      const logicalHeight = images.reduce((height, image) => height + (image.naturalHeight / image.naturalWidth) * 1200, 0);
      const maxWidth = Math.min(1200, fitBounds.width);
      const width = logicalHeight > CHEAT_SHEET_FULLSCREEN_LONG_THRESHOLD
        ? maxWidth
        : Math.min(maxWidth, (fitBounds.height / logicalHeight) * 1200);
      setContentWidth(width);
    };
    images.forEach((image) => image.addEventListener("load", fit));
    fit();
    return () => images.forEach((image) => image.removeEventListener("load", fit));
  }, [fitBounds, children]);

  useEffect(() => {
    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [onClose]);

  return <ViewerPanel
    ariaLabel={`Cheat sheet preview: ${title || "Untitled"}`}
    onClose={onClose}
    closeRef={closeRef}
    overlayClassName="cheat-preview-overlay"
    entryClassName="cheat-preview-entry"
    panelClassName="cheat-preview-panel"
    swipeToClose={false}
    focusTrap
    openedFrom={openedFrom}
  >
    <div className="cheat-fullscreen">
      <header className="cheat-fullscreen__header">
        <div>
          <span className="cheat-fullscreen__eyebrow">{versionLabel}</span>
          <h2>{title || "Cheat sheet preview"}</h2>
        </div>
        {isDraft && <span className="cheat-fullscreen__draft">Unsaved preview</span>}
      </header>
      <div ref={scrollRef} className="cheat-fullscreen__scroll" role="region" aria-label={`${versionLabel} image`} tabIndex={0}>
        <div ref={contentRef} className="cheat-fullscreen__content" style={contentWidth ? { width: `${contentWidth}px` } : undefined}>
          {children}
        </div>
      </div>
    </div>
  </ViewerPanel>;
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

function CheatSheetEditor({ items, entry, onClose, onSaved, onSheetUpdate, premiumAllowed, provider }) {
  const [savedSheet, setSavedSheet] = useState(entry.sheet || null);
  const [title, setTitle] = useState(entry.sheet?.title || "");
  const [description, setDescription] = useState(entry.sheet?.description || "");
  const [beautifyPrompt, setBeautifyPrompt] = useState(entry.sheet?.beautifyPrompt || DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT);
  const [previewVersion, setPreviewVersion] = useState(entry.sheet?.aiImage ? "ai" : "original");
  const [startingBeautify, setStartingBeautify] = useState(false);
  const [pollError, setPollError] = useState("");
  const [selected, setSelected] = useState(() => new Map(
    entry.sheet?.pieces?.map((piece) => [piece.itemId, { variantId: piece.variantId, scale: normalizeCheatSheetScale(piece.scale) }])
      || (entry.initialPieces || []).flatMap((piece) => {
        const item = items.find((candidate) => candidate.id === piece.itemId);
        return item ? [[piece.itemId, { variantId: piece.variantId || initialVariantForPiece(item), scale: normalizeCheatSheetScale(piece.scale) }]] : [];
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
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [visualViewport, setVisualViewport] = useState(null);
  const isPhone = useIsPhone();
  const { tier, tiers, chooseTier } = useRememberedTier(provider, premiumAllowed);
  const titleInputRef = useRef(null);
  const closeKeepRef = useRef(null);
  const closeButtonRef = useRef(null);
  const closeConfirmReturnRef = useRef(null);
  const deleteTriggerRef = useRef(null);
  const deleteKeepRef = useRef(null);
  const pickerSearchRef = useRef(null);
  const mobilePiecesTabRef = useRef(null);
  const mobilePreviewTabRef = useRef(null);
  const fullscreenTriggerRef = useRef(null);
  const hasOpenedFullscreenRef = useRef(false);
  const renderCache = useRef(new Map());
  const draftPieces = useMemo(() => [...selected].map(([itemId, selection]) => ({
    itemId,
    variantId: typeof selection === "string" ? selection : selection.variantId,
    scale: normalizeCheatSheetScale(typeof selection === "string" ? undefined : selection.scale),
  })), [selected]);
  const key = useMemo(() => draftShape(title, draftPieces), [title, draftPieces]);
  const draftKey = useMemo(() => draftShape(title, draftPieces, description), [title, draftPieces, description]);
  const baseKey = savedSheet ? draftShape(savedSheet.title, savedSheet.pieces || [], savedSheet.description || "") : null;
  const dirty = savedSheet ? draftKey !== baseKey || savedSheet.layoutVersion !== CHEAT_SHEET_LAYOUT_VERSION : Boolean(title.trim() || description.trim() || selected.size);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const selectedEntries = useMemo(() => draftPieces.map((piece) => ({
    ...piece,
    item: itemsById.get(piece.itemId) || null,
    variant: itemsById.get(piece.itemId)?.variants?.find((candidate) => candidate.id === piece.variantId) || null,
  })), [draftPieces, itemsById]);
  const renderReady = Boolean(preview && preview.key === key);
  const renderIssue = previewError?.key === key ? previewError.error : null;
  const previewUpdating = Boolean(title.trim() && dirty && !renderReady && !renderIssue);
  const selectedCount = selected.size;
  const busy = saving || deleting || startingBeautify;
  const beautifying = savedSheet?.beautifyStatus === "processing";
  const aiAvailable = Boolean(!dirty && savedSheet?.aiImage);
  const showingAi = aiAvailable && previewVersion === "ai";
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
    if (fullscreenOpen || !hasOpenedFullscreenRef.current) return undefined;
    const frame = requestAnimationFrame(() => focusIfVisible(fullscreenTriggerRef.current));
    return () => cancelAnimationFrame(frame);
  }, [fullscreenOpen]);

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
    if (!beautifying || !savedSheet?.id) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const { sheet } = await api(`/api/cheat-sheets/${encodeURIComponent(savedSheet.id)}`);
        if (stopped) return;
        setSavedSheet(sheet);
        onSheetUpdate(sheet);
        setPollError("");
        if (sheet.beautifyStatus !== "processing") {
          if (sheet.beautifyStatus === "ready") setPreviewVersion("ai");
          return;
        }
      } catch {
        if (stopped) return;
        setPollError("Could not refresh the AI finish. Retrying…");
      }
      timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [beautifying, savedSheet?.id, onSheetUpdate]);

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
        .then(async (result) => {
          await decodePreviewBands(result.bands, controller.signal);
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
    else next.set(item.id, { variantId: initialVariantForPiece(item), scale: 1 });
    return next;
  });

  const removePiece = (itemId) => setSelected((current) => {
    const next = new Map(current);
    next.delete(itemId);
    return next;
  });

  const setVariant = (itemId, variantId) => setSelected((current) => {
    const next = new Map(current);
    const selection = current.get(itemId);
    next.set(itemId, { ...(typeof selection === "string" ? { variantId: selection, scale: 1 } : selection), variantId });
    return next;
  });

  const adjustPieceScale = (itemId, direction) => setSelected((current) => {
    const next = new Map(current);
    const selection = current.get(itemId);
    if (!selection || typeof selection === "string") return current;
    const scale = normalizeCheatSheetScale(selection.scale);
    const adjustedScale = Math.round((scale + direction * CHEAT_SHEET_PIECE_SCALE_STEP) * 10) / 10;
    next.set(itemId, { ...selection, scale: Math.max(CHEAT_SHEET_MIN_PIECE_SCALE, Math.min(CHEAT_SHEET_MAX_PIECE_SCALE, adjustedScale)) });
    return next;
  });

  const reportSaved = (sheet) => {
    setSavedSheet(sheet);
    onSheetUpdate(sheet);
  };

  const persistDraft = async () => {
    if (!canSave) throw new Error(renderIssue?.message || "Add a title and at least one piece, then wait for the preview.");
    setActionError("");
    setSaving(true);
    try {
      const fingerprint = await cheatSheetSourceFingerprint(title, draftPieces, preview.source, description);
      const payload = { title: title.trim(), description: description.trim(), pieces: draftPieces, sourceFingerprint: fingerprint, bands: preview.bands };
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
    if (!dirty && savedSheet) { onSaved(savedSheet); return; }
    try { onSaved(await persistDraft()); }
    catch { /* retain the editable draft, including conflicts */ }
  };

  const saveAndDownload = async () => {
    try {
      const sheet = dirty && canSave ? await persistDraft() : savedSheet;
      const image = !dirty && showingAi ? sheet?.aiImage : sheet?.originalImage;
      if (image) triggerDownload(image, showingAi ? `${sheet.title} AI` : sheet.title);
    } catch { /* errors appear beside the footer actions */ }
  };

  const beautify = async (chosenTier) => {
    if (busy || beautifying || !beautifyPrompt.trim()) return;
    setActionError("");
    try {
      const sheet = dirty || !savedSheet ? await persistDraft() : savedSheet;
      setStartingBeautify(true);
      const result = await api(`/api/cheat-sheets/${encodeURIComponent(sheet.id)}/beautify`, {
        method: "POST", body: JSON.stringify({ expectedRevision: sheet.revision, prompt: beautifyPrompt.trim(), tier: chosenTier }),
      });
      reportSaved(result.sheet);
      setMobileView("preview");
    } catch (error) {
      setActionError(error.message || "Could not start the AI finish. Your original is saved.");
    } finally {
      setStartingBeautify(false);
    }
  };

  const requestClose = useCallback(() => {
    if (busy || modalOpen) return false;
    if (dirty) { closeConfirmReturnRef.current = document.activeElement; setCloseConfirm(true); return false; }
    return true;
  }, [busy, dirty, modalOpen]);

  useEffect(() => {
    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (fullscreenOpen) {
        event.stopImmediatePropagation();
        setFullscreenOpen(false);
        return;
      }
      if (busy) return;
      if (deleteConfirm) { setDeleteConfirm(false); requestAnimationFrame(() => deleteTriggerRef.current?.focus({ preventScroll: true })); return; }
      if (closeConfirm) { setCloseConfirm(false); requestAnimationFrame(restoreCloseConfirmFocus); return; }
      if (mode === "picker") { setMode("pieces"); requestAnimationFrame(() => titleInputRef.current?.focus({ preventScroll: true })); return; }
      if (requestClose()) onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [busy, closeConfirm, deleteConfirm, fullscreenOpen, mode, mobileView, restoreCloseConfirmFocus, requestClose, onClose]);

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
  const openFullscreen = (event) => {
    fullscreenTriggerRef.current = event.currentTarget;
    hasOpenedFullscreenRef.current = true;
    setFullscreenOpen(true);
  };
  const renderPreviewSurface = (content, updating = false) => (
    <div className="cheat-preview__render-surface" aria-busy={updating || undefined}>
      {content}
      {updating && <div className="cheat-preview__surface-skeleton" aria-hidden="true" />}
    </div>
  );
  const renderPreviewBands = (bands) => (
    <div className="cheat-preview__bands">
      {bands.map((band, index) => <div key={`${band.kind}-${band.groupId || "title"}-${index}`} className="cheat-preview__band">
        <img src={band.dataUrl} alt="" draggable="false" />
      </div>)}
    </div>
  );
  const displayPreview = (interactive = true) => {
    if (showingAi) return <img className="cheat-preview__saved-image" src={savedSheet.aiImage} alt={`${savedSheet.title}, AI finish`} />;
    if (!dirty && savedSheet?.originalImage) return <img className="cheat-preview__saved-image" src={savedSheet.originalImage} alt={`${savedSheet.title}, saved cheat sheet`} />;
    if (renderReady || (dirty && title.trim() && preview?.bands?.length)) {
      return renderPreviewSurface(renderPreviewBands(preview.bands), previewUpdating);
    }
    if (savedSheet?.originalImage) return renderPreviewSurface(<div className="cheat-preview__stale"><img className="cheat-preview__saved-image" src={savedSheet.originalImage} alt={`${savedSheet.title}, last saved cheat sheet`} /><span>Last saved version</span></div>, previewUpdating);
    return (
      renderPreviewSurface(<div className="cheat-preview__placeholder" role={renderIssue ? "alert" : undefined}>
        <span className="cheat-preview__placeholder-mark" aria-hidden="true" />
        <strong>{title ? (renderIssue ? "Preview needs attention" : "Preparing preview") : "Your sheet preview"}</strong>
        <span>{title ? (renderIssue?.message || "The preview is composed from your approved cutouts.") : "Add a title and pieces to start composing."}</span>
        {renderIssue && interactive && <button type="button" className="secondary-button" onClick={retryPreview}>Retry preview</button>}
      </div>, previewUpdating)
    );
  };

  const handleMobileTab = (view) => { if (mode !== "picker") setMobileView(view); };
  const controlsDisabled = busy || modalOpen;
  const pickMode = mode === "picker";
  const hasFullscreenPreview = Boolean(savedSheet?.originalImage || renderReady);
  const fullscreenVersion = dirty ? (savedSheet?.originalImage && !renderReady ? "Last saved version" : "Draft preview") : savedSheet ? "Saved sheet" : "Draft preview";
  return (
    <>
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
      focusTrap={!fullscreenOpen}
    >
      <div className="cheat-editor" inert={modalOpen || fullscreenOpen ? true : undefined} aria-hidden={fullscreenOpen || undefined}>
        {previewUpdating && <span className="sr-only" role="status">Updating cheat sheet preview.</span>}
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
                  {isPhone && <button type="button" className="cheat-editor__mini-preview" onClick={() => setMobileView("preview")} aria-label="Open full cheat sheet preview" aria-busy={previewUpdating || undefined}>{displayPreview(false)}</button>}
                  <div className="cheat-editor__piece-controls">
                    <label className="cheat-title-field">
                      <span>Title</span>
                      <input ref={titleInputRef} type="text" value={title} onChange={(event) => setTitle(event.target.value.slice(0, 120))} maxLength={120} placeholder="e.g. Summer in the city" disabled={controlsDisabled} />
                      <small>{title.length}/120</small>
                    </label>
                    <label className="cheat-title-field cheat-description-field">
                      <span>Description <em>optional</em></span>
                      <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={CHEAT_SHEET_DESCRIPTION_LIMIT} rows={3} placeholder="e.g. Weekend hikes in the Dolomites, earthy tones and fresh alpine air" disabled={controlsDisabled} />
                      <small>Helps the AI choose a theme · {description.length}/{CHEAT_SHEET_DESCRIPTION_LIMIT}</small>
                    </label>
                    <div className="cheat-piece-count"><strong>{selectedCount} {selectedCount === 1 ? "piece" : "pieces"}</strong><button type="button" onClick={() => setMode("picker")} disabled={controlsDisabled}><Plus size={15} weight="bold" /> Add pieces</button></div>
                  </div>
                  <section className="cheat-beautify" aria-labelledby="cheat-beautify-title">
                    <h3 id="cheat-beautify-title"><Sparkle size={18} aria-hidden="true" /> Beautify</h3>
                    <p>A themed background and subtle, context-aware title typography, with harmonious light and shadows. Your clothes stay recognizable.</p>
                    <details className="cheat-beautify__prompt">
                      <summary>Customize the prompt</summary>
                      <label className="cheat-title-field">
                        <span>Art direction</span>
                        <textarea value={beautifyPrompt} onChange={(event) => setBeautifyPrompt(event.target.value)} maxLength={CHEAT_SHEET_PROMPT_LIMIT} rows={9} disabled={controlsDisabled} />
                        <small>Title, description and sheet image are included automatically.</small>
                      </label>
                      <button type="button" className="cheat-beautify__reset" onClick={() => setBeautifyPrompt(DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT)} disabled={controlsDisabled}>Restore suggested prompt</button>
                    </details>
                    <GenerateButton
                      block
                      icon={<Sparkle size={16} aria-hidden="true" />}
                      label={dirty || !savedSheet ? "Save & beautify" : savedSheet.aiImage ? "Generate another finish" : "Beautify"}
                      busy={busy || beautifying}
                      busyLabel={beautifying ? "Beautifying…" : saving ? "Saving…" : deleting ? "Deleting…" : "Starting…"}
                      disabled={controlsDisabled || !beautifyPrompt.trim() || (dirty || !savedSheet ? !canSave : !savedSheet.originalImage)}
                      onGenerate={beautify}
                      tier={tier}
                      tiers={tiers}
                      onTierChange={chooseTier}
                      premiumAllowed={premiumAllowed}
                    />
                    <small>The original is kept. Uses your configured AI provider.</small>
                    {savedSheet?.beautifyStatus === "error" && <p className="cheat-message--error" role="alert">{savedSheet.beautifyError}</p>}
                  </section>
                  <div className="cheat-selected-list">
                    {selectedEntries.length ? selectedEntries.map(({ itemId, variantId, scale, item, variant }) => {
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
                            <div className="cheat-selected-piece__scale" role="group" aria-label={`Thumbnail size for ${item?.name || "this piece"}`}>
                              <button type="button" aria-label={`Reduce size of ${item?.name || "this piece"}`} onClick={() => adjustPieceScale(itemId, -1)} disabled={controlsDisabled || !item || scale <= CHEAT_SHEET_MIN_PIECE_SCALE}><Minus size={14} weight="bold" /></button>
                              <output aria-live="polite">{Math.round(scale * 100)}%</output>
                              <button type="button" aria-label={`Increase size of ${item?.name || "this piece"}`} onClick={() => adjustPieceScale(itemId, 1)} disabled={controlsDisabled || !item || scale >= CHEAT_SHEET_MAX_PIECE_SCALE}><Plus size={14} weight="bold" /></button>
                            </div>
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
            <div className="cheat-preview__toolbar">
              <div
                className={`cheat-preview__versions${aiAvailable ? "" : " is-empty"}`}
                role={aiAvailable ? "group" : undefined}
                aria-label={aiAvailable ? "Preview version" : undefined}
                aria-hidden={!aiAvailable || undefined}
              >
                {aiAvailable && <>
                  <button type="button" aria-pressed={!showingAi} onClick={() => setPreviewVersion("original")}>Original</button>
                  <button type="button" aria-pressed={showingAi} onClick={() => setPreviewVersion("ai")}><Sparkle size={14} aria-hidden="true" /> AI finish</button>
                </>}
              </div>
              <button type="button" className="cheat-preview__fullscreen" onClick={openFullscreen} aria-label="Open cheat sheet fullscreen" title="Open fullscreen" disabled={!hasFullscreenPreview}><CornersOut size={17} aria-hidden="true" /><span>Fullscreen</span></button>
            </div>
            {beautifying && <p className="cheat-preview__progress" role="status"><SpinnerGap size={16} className="cheat-spinner" aria-hidden="true" />{pollError || "Creating your AI finish. You can close this sheet and come back."}</p>}
            <div className="cheat-editor__preview-scroll" aria-busy={previewUpdating || undefined}>
              {displayPreview()}
            </div>
            {renderIssue && !renderIssue.itemId && (savedSheet?.originalImage || (dirty && preview?.bands?.length)) && <div className="cheat-render-error" role="alert"><span>{renderIssue.message}</span><button type="button" onClick={retryPreview} disabled={controlsDisabled}>Retry preview</button></div>}
            {previewError?.key === key && previewError.error?.itemId && <div className="cheat-render-error" role="alert"><span>{previewError.error.message}</span><button type="button" onClick={retryPreview} disabled={controlsDisabled}>Retry</button><button type="button" onClick={() => removePiece(previewError.error.itemId)} disabled={controlsDisabled}>Remove</button></div>}
          </section>
        </div>

        <footer className="cheat-editor__footer">
          <div className="cheat-editor__footer-leading">
            {savedSheet && <button ref={deleteTriggerRef} type="button" className="cheat-editor__delete" onClick={() => setDeleteConfirm(true)} disabled={busy || modalOpen}><Trash size={15} /> Delete</button>}
            {dirty && !canSave && !actionError && !renderIssue && <span className="cheat-editor__status">{title.trim() ? "Preparing preview…" : "Add a title to save"}</span>}
          </div>
          <div className="cheat-editor__footer-actions">
            <button type="button" className="cheat-editor__download" onClick={saveAndDownload} disabled={!canDownload}>
              <DownloadSimple size={16} aria-hidden="true" />{saving ? "Saving…" : dirty && canSave ? "Save & download" : dirty && savedSheet?.originalImage ? "Download saved" : dirty ? "Save & download" : showingAi ? "Download AI finish" : "Download original"}
            </button>
            <button type="button" className="cheat-editor__save" onClick={saveAndClose} disabled={!canSave || !dirty}><Check size={16} weight="bold" />{savedSheet && !dirty ? "Saved" : "Save"}</button>
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
            <span className="cheat-confirm__eyebrow">Delete sheet</span><h2 id="cheat-delete-title">Delete “{savedSheet?.title}”?</h2><p id="cheat-delete-copy">This permanently removes the saved cheat sheet and all its images.</p>
            <div className="cheat-confirm__actions"><button ref={deleteKeepRef} type="button" className="cheat-confirm__keep" onClick={() => { setDeleteConfirm(false); requestAnimationFrame(() => deleteTriggerRef.current?.focus({ preventScroll: true })); }} disabled={deleting}>Keep sheet</button><button type="button" className="cheat-confirm__discard" onClick={deleteSheet} disabled={deleting}>{deleting ? <><SpinnerGap size={15} className="cheat-spinner" /> Deleting…</> : "Delete sheet"}</button></div>
          </div>
        </div>
      )}
    </ViewerPanel>
    {fullscreenOpen && <FullscreenCheatSheetViewer
      title={title.trim() || savedSheet?.title || "Cheat sheet preview"}
      versionLabel={fullscreenVersion}
      isDraft={dirty}
      onClose={() => setFullscreenOpen(false)}
    >
      {displayPreview(false)}
    </FullscreenCheatSheetViewer>}
    </>
  );
}

export function CheatSheetsArea({ items, premiumAllowed = true, provider = null, active, createRequest, returnFocusRef, onSaved }) {
  const [sheets, setSheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [collectionViewer, setCollectionViewer] = useState(null);
  const openRequestId = useRef(0);
  const collectionViewerMounted = useRef(false);
  const editorReturnFocus = useRef(null);
  const editorMounted = useRef(false);
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
    if (!entry) return undefined;
    editorMounted.current = true;
    return () => { editorMounted.current = false; };
  }, [entry]);

  useEffect(() => {
    if (active) return;
    openRequestId.current += 1;
    setOpeningId(null);
    setCollectionViewer(null);
  }, [active]);

  useEffect(() => {
    if (!collectionViewer) return undefined;
    collectionViewerMounted.current = true;
    return () => {
      collectionViewerMounted.current = false;
      const trigger = collectionViewer.trigger;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!collectionViewerMounted.current) focusIfVisible(trigger);
      }));
    };
  }, [collectionViewer]);

  const hasProcessingSheet = sheets.some((sheet) => sheet.beautifyStatus === "processing");
  useEffect(() => {
    if (!hasProcessingSheet) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const result = await api("/api/cheat-sheets");
        if (stopped) return;
        setSheets(sortSheets(result.sheets || []));
        if (!result.sheets?.some((sheet) => sheet.beautifyStatus === "processing")) return;
      } catch { /* keep polling transient connection failures */ }
      if (!stopped) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [hasProcessingSheet]);

  useEffect(() => {
    if (!createRequest || requestSeen.current === createRequest.id) return;
    requestSeen.current = createRequest.id;
    editorReturnFocus.current = returnFocusRef?.current || document.activeElement;
    openRequestId.current += 1;
    setOpeningId(null);
    setCollectionViewer(null);
    setEntry({ key: createRequest.id, sheet: null, initialPieces: createRequest.pieces || [] });
  }, [createRequest, returnFocusRef]);

  const updateSheet = useCallback((sheet, removedId = null) => {
    setSheets((current) => sortSheets(removedId ? current.filter((item) => item.id !== removedId) : [sheet, ...current.filter((item) => item.id !== sheet.id)]));
  }, []);

  const newSheet = (event) => {
    const trigger = event?.currentTarget || null;
    openRequestId.current += 1;
    setOpeningId(null);
    setCollectionViewer(null);
    trigger?.focus?.({ preventScroll: true });
    editorReturnFocus.current = trigger;
    if (returnFocusRef) returnFocusRef.current = trigger;
    setEntry({ key: crypto.randomUUID(), sheet: null, initialPieces: [] });
  };

  const openSheetViewer = async (sheet, event) => {
    const requestId = ++openRequestId.current;
    const trigger = event?.currentTarget || null;
    trigger?.focus?.({ preventScroll: true });
    setOpeningId(sheet.id); setError(""); setEntry(null); setCollectionViewer(null);
    try {
      const result = await api(`/api/cheat-sheets/${encodeURIComponent(sheet.id)}`);
      if (requestId !== openRequestId.current) return;
      const previewSheet = result.sheet;
      if (!previewSheet) throw new Error("Could not load this cheat sheet.");
      const image = previewSheet.aiImage || previewSheet.originalImage;
      if (!image) throw new Error("This cheat sheet has no saved preview image.");
      setCollectionViewer({ sheet: previewSheet, image, versionLabel: previewSheet.aiImage ? "AI finish" : "Original", trigger });
    } catch (requestError) {
      if (requestId === openRequestId.current) setError(requestError.message || "Could not open this cheat sheet.");
    } finally {
      if (requestId === openRequestId.current) setOpeningId(null);
    }
  };

  const openSheetEditor = async (sheet, event) => {
    const requestId = ++openRequestId.current;
    const trigger = event?.currentTarget || null;
    trigger?.focus?.({ preventScroll: true });
    editorReturnFocus.current = trigger;
    if (returnFocusRef) returnFocusRef.current = trigger;
    setOpeningId(sheet.id); setError(""); setCollectionViewer(null);
    try {
      const result = await api(`/api/cheat-sheets/${encodeURIComponent(sheet.id)}`);
      if (requestId !== openRequestId.current) return;
      setEntry({ key: crypto.randomUUID(), sheet: result.sheet, initialPieces: [] });
    } catch (requestError) {
      if (requestId === openRequestId.current) setError(requestError.message || "Could not open this cheat sheet.");
    } finally {
      if (requestId === openRequestId.current) setOpeningId(null);
    }
  };

  const closeCollectionViewer = useCallback(() => setCollectionViewer(null), []);

  const restoreEditorFocus = (target, fallback) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (editorMounted.current) return;
      const targetElement = typeof target === "function" ? target() : target;
      const fallbackElement = typeof fallback === "function" ? fallback() : fallback;
      if (!focusIfVisible(targetElement)) focusIfVisible(fallbackElement);
    }));
  };

  const saved = (sheet) => {
    openRequestId.current += 1;
    editorReturnFocus.current = null;
    updateSheet(sheet); setEntry(null); onSaved?.(); void refresh();
    restoreEditorFocus(() => document.getElementById(`cheat-sheet-card-${sheet.id}`), () => document.querySelector(".cheat-new-button"));
  };

  const closeEditor = () => {
    const trigger = editorReturnFocus.current || returnFocusRef?.current;
    editorReturnFocus.current = null;
    openRequestId.current += 1;
    setOpeningId(null);
    setEntry(null);
    restoreEditorFocus(trigger, () => document.querySelector(".cheat-new-button"));
  };

  if (!active && !entry) return null;
  return <>
    {active && <SheetCollection sheets={sheets} loading={loading} error={error} onNew={newSheet} onOpen={openSheetViewer} onEdit={openSheetEditor} openingId={openingId} />}
    {active && collectionViewer && <FullscreenCheatSheetViewer title={collectionViewer.sheet.title} versionLabel={collectionViewer.versionLabel} isDraft={false} onClose={closeCollectionViewer} openedFrom={collectionViewer.trigger}>
      <img className="cheat-preview__saved-image" src={collectionViewer.image} alt={`${collectionViewer.sheet.title || "Cheat sheet"}, ${collectionViewer.versionLabel.toLowerCase()}`} />
    </FullscreenCheatSheetViewer>}
    {entry && <CheatSheetEditor key={entry.key} items={items} entry={entry} onClose={closeEditor} onSaved={saved} onSheetUpdate={updateSheet} premiumAllowed={premiumAllowed} provider={provider} />}
  </>;
}
