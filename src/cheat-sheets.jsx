import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CornersOut, DownloadSimple, Minus, Plus, Sparkle, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import { PencilSimple } from "@phosphor-icons/react";
import { api } from "./api.js";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { PiecePicker } from "./components/PiecePicker.jsx";
import { ConfirmDialog } from "./components/ConfirmDialog.jsx";
import { GenerateButton, useRememberedTier } from "./components/ModelPhotoControls.jsx";
import { useIsPhone } from "./hooks/useIsPhone.js";
import { initialVariantForPiece, variantImage, variantOwnImage } from "../shared/wardrobe-model.mjs";
import { reconcileSheetPieces } from "../shared/cheat-sheet-pieces.mjs";
import { cheatSheetSourceFingerprint, renderCheatSheet } from "./cheat-sheet-renderer.js";
import { CHEAT_SHEET_LAYOUT_VERSION, CHEAT_SHEET_MAX_PIECE_SCALE, CHEAT_SHEET_MIN_PIECE_SCALE, CHEAT_SHEET_PIECE_SCALE_STEP, normalizeCheatSheetScale } from "../shared/cheat-sheet-layout.mjs";
import { CHEAT_SHEET_DESCRIPTION_LIMIT, CHEAT_SHEET_PROMPT_LIMIT, DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT } from "../shared/cheat-sheet-prompt.mjs";
import { OptimizedImage } from "./OptimizedImage.jsx";
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
        <span className="cheat-card__cover"><OptimizedImage src={sheet.aiThumbnailImage || sheet.thumbnailImage} alt="" loading="lazy" /></span>
        <span className="cheat-card__title">{sheet.title}</span>
        <span className="cheat-card__meta">{opening ? "Opening…" : <>{sheet.pieces?.length || 0} {(sheet.pieces?.length || 0) === 1 ? "piece" : "pieces"}{sheet.beautifyStatus === "processing" ? " · Beautifying…" : sheet.aiImage ? " · AI finish" : ""}</>}</span>
      </button>
      <button type="button" className="icon-button button--on-media cheat-card__edit" onClick={onEdit} aria-label={`Edit cheat sheet: ${sheet.title || "Untitled"}`} aria-haspopup="dialog" title={`Edit ${sheet.title || "cheat sheet"}`}>
        <PencilSimple size={19} weight="regular" aria-hidden="true" />
      </button>
    </article>
  );
}

const CREATE_BLOCKED_HINT = "Add pieces to your wardrobe first";

function SheetCollection({ sheets, loading, error, canCreate, onNew, onOpen, onEdit, openingId }) {
  return (
    <section className="cheat-collection" aria-labelledby="cheat-collection-title">
      <header className="cheat-collection__header overview-panel-head">
        <h2 id="cheat-collection-title">Cheat sheets <span>{sheets.length}</span></h2>
        {/* Keep cheat-new-button: saved/closeEditor fall back to it for focus. */}
        <button
          type="button"
          className="primary-button cheat-new-button overview-panel-head__add"
          onClick={onNew}
          aria-haspopup="dialog"
          disabled={!canCreate}
          title={canCreate ? undefined : CREATE_BLOCKED_HINT}
          aria-label={canCreate ? "New cheat sheet" : `New cheat sheet, ${CREATE_BLOCKED_HINT}`}
        ><Plus size={16} weight="bold" aria-hidden="true" /> Cheat sheet</button>
      </header>
      {error && <p className="cheat-message cheat-message--error" role="alert">{error}</p>}
      {loading ? <p className="cheat-collection__empty">Loading cheat sheets…</p> : sheets.length ? (
        <div className="cheat-collection__grid">{sortSheets(sheets).map((sheet) => <SheetCard key={sheet.id} sheet={sheet} opening={openingId === sheet.id} onOpen={(event) => onOpen(sheet, event)} onEdit={(event) => onEdit(sheet, event)} />)}</div>
      ) : (
        <div className="cheat-collection__empty">
          <strong>Your collection starts here.</strong>
          <span>Pick pieces from your wardrobe to lay them out on a sheet.</span>
          <button type="button" className="secondary-button" onClick={onNew} aria-haspopup="dialog" disabled={!canCreate} title={canCreate ? undefined : CREATE_BLOCKED_HINT}>Create your first cheat sheet</button>
          {!canCreate && <small className="cheat-collection__hint">{CREATE_BLOCKED_HINT}.</small>}
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

// The picker's preview: a strip of the selected pieces' thumbnails.
function SheetPieceTray({ pieces }) {
  if (!pieces.length) return <p className="cheat-tray__empty">Pick pieces to lay out on the sheet.</p>;
  return (
    <ul className="cheat-tray" aria-label="Selected pieces">
      {pieces.map((piece) => (
        <li key={piece.id} className="cheat-tray__piece">
          <span className="cheat-tray__art">{piece.thumbnail && <OptimizedImage src={piece.thumbnail} alt="" sizes="72px" breakpoints={[80, 160]} />}</span>
          <span className="cheat-tray__name">{piece.name || "Untitled piece"}</span>
        </li>
      ))}
    </ul>
  );
}

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
  const [mobileView, setMobileView] = useState("pieces");
  const [piecePickerOpen, setPiecePickerOpen] = useState(false);
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
  const { tier, tiers, chooseTier, tierReady, tierStateError } = useRememberedTier(provider, premiumAllowed);
  const titleInputRef = useRef(null);
  const closeKeepRef = useRef(null);
  const closeButtonRef = useRef(null);
  const closeConfirmReturnRef = useRef(null);
  const deleteTriggerRef = useRef(null);
  const deleteKeepRef = useRef(null);
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
      isPhone && mobileView === "preview" ? mobilePreviewTabRef.current : null,
      isPhone ? mobilePiecesTabRef.current : null,
      titleInputRef.current,
      closeButtonRef.current,
    ];
    for (const candidate of candidates) if (focusIfVisible(candidate)) return;
  }, [isPhone, mobileView]);

  // A frame later, not synchronously: on create, the picker unmounts in the
  // commit that mounts this editor, and its ViewerPanel cleanup queues a frame
  // that refocuses "+ Cheat sheet" behind us. Passive unmounts run before
  // mounts, so this frame is queued after that one and wins.
  useEffect(() => {
    const frame = requestAnimationFrame(() => titleInputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

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

  // The picker's ViewerPanel captures Edit pieces (focused by the click) and
  // returns focus to it on close.
  const openPiecePicker = () => setPiecePickerOpen(true);
  const closePiecePicker = () => setPiecePickerOpen(false);

  // Synchronous and never throws: the picker unmounts on success.
  const applyPickedPieces = (pieces) => {
    const next = reconcileSheetPieces(draftPieces, pieces, new Set(itemsById.keys()));
    // An unchanged Done must not replace `selected`: a new Map would re-run the preview render for nothing.
    if (draftShape("", next) !== draftShape("", draftPieces)) {
      setSelected(new Map(next.map(({ itemId, variantId, scale }) => [itemId, { variantId, scale }])));
    }
    closePiecePicker();
  };

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
      if (requestClose()) onClose();
    };
    // Document capture: the piece picker's window-capture listener runs first
    // and stops the event, so Escape over the picker never reaches this.
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [busy, closeConfirm, deleteConfirm, fullscreenOpen, mobileView, restoreCloseConfirmFocus, requestClose, onClose]);

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
    if (showingAi) return <OptimizedImage className="cheat-preview__saved-image" src={savedSheet.aiImage} alt={`${savedSheet.title}, AI finish`} />;
    if (!dirty && savedSheet?.originalImage) return <OptimizedImage className="cheat-preview__saved-image" src={savedSheet.originalImage} alt={`${savedSheet.title}, saved cheat sheet`} />;
    if (renderReady || (dirty && title.trim() && preview?.bands?.length)) {
      return renderPreviewSurface(renderPreviewBands(preview.bands), previewUpdating);
    }
    if (savedSheet?.originalImage) return renderPreviewSurface(<div className="cheat-preview__stale"><OptimizedImage className="cheat-preview__saved-image" src={savedSheet.originalImage} alt={`${savedSheet.title}, last saved cheat sheet`} /><span>Last saved version</span></div>, previewUpdating);
    return (
      renderPreviewSurface(<div className="cheat-preview__placeholder" role={renderIssue ? "alert" : undefined}>
        <span className="cheat-preview__placeholder-mark" aria-hidden="true" />
        <strong>{title ? (renderIssue ? "Preview needs attention" : "Preparing preview") : "Your sheet preview"}</strong>
        <span>{title ? (renderIssue?.message || "The preview is composed from your approved cutouts.") : "Add a title and pieces to start composing."}</span>
        {renderIssue && interactive && <button type="button" className="secondary-button" onClick={retryPreview}>Retry preview</button>}
      </div>, previewUpdating)
    );
  };

  const handleMobileTab = (view) => setMobileView(view);
  const controlsDisabled = busy || modalOpen;
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
      swipeToClose={!dirty && !busy && !modalOpen && !piecePickerOpen}
      swipeHandleOnly
      closeDisabled={busy || modalOpen || piecePickerOpen}
      // Off while a stacked panel traps focus: both traps listen on document,
      // and ours would pull Tab back into this (inert) editor. Turning it off
      // runs ViewerPanel's restore for one frame before the stacked panel's
      // own initial focus wins; don't reorder those frames.
      focusTrap={!fullscreenOpen && !piecePickerOpen}
    >
      <div className="cheat-editor" inert={modalOpen || fullscreenOpen || piecePickerOpen ? true : undefined} aria-hidden={fullscreenOpen || piecePickerOpen || undefined}>
        {previewUpdating && <span className="sr-only" role="status">Updating cheat sheet preview.</span>}
        <div className="cheat-editor__handle" data-sheet-grab aria-hidden="true"><span /></div>
        <header className="cheat-editor__header">
          <div><span className="cheat-editor__eyebrow">{savedSheet ? "Collection" : "Overview"}</span><h2>{savedSheet ? "Edit cheat sheet" : "Create cheat sheet"}</h2></div>
          <span className="cheat-editor__header-count">{selectedCount} {selectedCount === 1 ? "piece" : "pieces"}</span>
          <span className="cheat-editor__close-spacer" />
        </header>

        {isPhone && (
          <div className="cheat-editor__mobile-tabs tabs" role="tablist" aria-label="Cheat sheet editor">
            <button ref={mobilePiecesTabRef} type="button" role="tab" aria-selected={mobileView === "pieces"} className={mobileView === "pieces" ? "is-active" : ""} onClick={() => handleMobileTab("pieces")}>Pieces <span className="tabs__count">{selectedCount}</span></button>
            <button ref={mobilePreviewTabRef} type="button" role="tab" aria-selected={mobileView === "preview"} className={mobileView === "preview" ? "is-active" : ""} onClick={() => handleMobileTab("preview")}>Preview</button>
          </div>
        )}

        <div className={`cheat-editor__main${mobileView === "preview" ? " is-mobile-preview" : ""}`}>
          <section className="cheat-editor__left-pane" aria-label="Cheat sheet pieces">
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
                <div className="cheat-piece-count"><strong>{selectedCount} {selectedCount === 1 ? "piece" : "pieces"}</strong><button type="button" className="ghost-button" aria-haspopup="dialog" onClick={openPiecePicker} disabled={controlsDisabled}><PencilSimple size={15} weight="bold" aria-hidden="true" /> Edit pieces</button></div>
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
                  <button type="button" className="ghost-button button--sm cheat-beautify__reset" onClick={() => setBeautifyPrompt(DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT)} disabled={controlsDisabled}>Restore suggested prompt</button>
                </details>
                <GenerateButton
                  block
                  tone="secondary"
                  icon={<Sparkle size={16} aria-hidden="true" />}
                  label={dirty || !savedSheet ? "Save & beautify" : savedSheet.aiImage ? "Generate another finish" : "Beautify"}
                  busy={busy || beautifying}
                  busyLabel={beautifying ? "Beautifying…" : saving ? "Saving…" : deleting ? "Deleting…" : "Starting…"}
                  disabled={!tierReady || controlsDisabled || !beautifyPrompt.trim() || (dirty || !savedSheet ? !canSave : !savedSheet.originalImage)}
                  onGenerate={beautify}
                  tier={tier}
                  tiers={tiers}
                  onTierChange={chooseTier}
                  premiumAllowed={premiumAllowed}
                  tierStateError={tierStateError}
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
                      <span className="cheat-selected-piece__image">{item && variantImage(item, variantId) && <OptimizedImage src={variantImage(item, variantId)} alt="" />}</span>
                      <div className="cheat-selected-piece__details">
                        <strong>{item?.name || "Missing wardrobe piece"}</strong>
                        {item && item.variants?.length > 1 ? <label className="sr-only" htmlFor={`cheat-variant-${itemId}`}>Variant for {item.name}</label> : <small>{variant?.name || "Reference missing"}</small>}
                        {item && item.variants?.length > 1 && (
                          <select id={`cheat-variant-${itemId}`} value={variantId || ""} onChange={(event) => setVariant(itemId, event.target.value)} disabled={controlsDisabled}>
                            {item.variants.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                          </select>
                        )}
                        <div className="cheat-selected-piece__scale" role="group" aria-label={`Thumbnail size for ${item?.name || "this piece"}`}>
                          <button type="button" className="icon-button icon-button--outlined" aria-label={`Reduce size of ${item?.name || "this piece"}`} onClick={() => adjustPieceScale(itemId, -1)} disabled={controlsDisabled || !item || scale <= CHEAT_SHEET_MIN_PIECE_SCALE}><Minus size={14} weight="bold" /></button>
                          <output aria-live="polite">{Math.round(scale * 100)}%</output>
                          <button type="button" className="icon-button icon-button--outlined" aria-label={`Increase size of ${item?.name || "this piece"}`} onClick={() => adjustPieceScale(itemId, 1)} disabled={controlsDisabled || !item || scale >= CHEAT_SHEET_MAX_PIECE_SCALE}><Plus size={14} weight="bold" /></button>
                        </div>
                      </div>
                      <button type="button" className="icon-button cheat-selected-piece__remove" aria-label={`Remove ${item?.name || "missing piece"}`} onClick={() => removePiece(itemId)} disabled={controlsDisabled}><X size={17} /></button>
                      {(unavailable || issueForItem) && <div className="cheat-selected-piece__issue" role="alert"><span>{issueForItem ? renderIssue.message : `${item?.name || "This piece"} needs an approved cutout.`}</span><button type="button" className="secondary-button button--sm" onClick={retryPreview} disabled={controlsDisabled}>Retry</button><button type="button" className="secondary-button button--sm" onClick={() => removePiece(itemId)} disabled={controlsDisabled}>Remove</button></div>}
                    </article>
                  );
                }) : <p className="cheat-selected-list__empty">Choose pieces with Edit pieces to get started.</p>}
              </div>
            </section>
          </section>
          <section className={`cheat-editor__preview-pane${mobileView === "preview" ? " is-visible" : ""}`} aria-label="Preview">
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
              <button type="button" className="secondary-button cheat-preview__fullscreen" onClick={openFullscreen} aria-label="Open cheat sheet fullscreen" title="Open fullscreen" disabled={!hasFullscreenPreview}><CornersOut size={17} aria-hidden="true" /><span>Fullscreen</span></button>
            </div>
            {beautifying && <p className="cheat-preview__progress" role="status"><SpinnerGap size={16} className="cheat-spinner" aria-hidden="true" />{pollError || "Creating your AI finish. You can close this sheet and come back."}</p>}
            <div className="cheat-editor__preview-scroll" aria-busy={previewUpdating || undefined}>
              {displayPreview()}
            </div>
            {renderIssue && !renderIssue.itemId && (savedSheet?.originalImage || (dirty && preview?.bands?.length)) && <div className="cheat-render-error" role="alert"><span>{renderIssue.message}</span><button type="button" className="secondary-button button--sm" onClick={retryPreview} disabled={controlsDisabled}>Retry preview</button></div>}
            {previewError?.key === key && previewError.error?.itemId && <div className="cheat-render-error" role="alert"><span>{previewError.error.message}</span><button type="button" className="secondary-button button--sm" onClick={retryPreview} disabled={controlsDisabled}>Retry</button><button type="button" className="secondary-button button--sm" onClick={() => removePiece(previewError.error.itemId)} disabled={controlsDisabled}>Remove</button></div>}
          </section>
        </div>

        <footer className="cheat-editor__footer">
          <div className="cheat-editor__footer-leading">
            {savedSheet && <button ref={deleteTriggerRef} type="button" className="danger-button cheat-editor__delete" onClick={() => setDeleteConfirm(true)} disabled={busy || modalOpen}><Trash size={15} /> Delete</button>}
            {dirty && !canSave && !actionError && !renderIssue && <span className="cheat-editor__status">{title.trim() ? "Preparing preview…" : "Add a title to save"}</span>}
          </div>
          <div className="cheat-editor__footer-actions">
            <button type="button" className="secondary-button cheat-editor__download" onClick={saveAndDownload} disabled={!canDownload}>
              <DownloadSimple size={16} aria-hidden="true" />{saving ? "Saving…" : dirty && canSave ? "Save & download" : dirty && savedSheet?.originalImage ? "Download saved" : dirty ? "Save & download" : showingAi ? "Download AI finish" : "Download original"}
            </button>
            <button type="button" className="primary-button cheat-editor__save" onClick={saveAndClose} disabled={!canSave || !dirty}><Check size={16} weight="bold" />{savedSheet && !dirty ? "Saved" : "Save"}</button>
          </div>
          {actionError && <p className="cheat-editor__action-error" role="alert">{actionError}</p>}
        </footer>
      </div>

      {closeConfirm && (
        <ConfirmDialog
          eyebrow="Unsaved changes"
          title="Leave this cheat sheet?"
          description="Your changes haven’t been saved yet."
          keepLabel="Keep editing"
          discardLabel="Discard changes"
          keepRef={closeKeepRef}
          onKeep={() => { setCloseConfirm(false); requestAnimationFrame(restoreCloseConfirmFocus); }}
          onDiscard={confirmDiscard}
        />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          eyebrow="Delete sheet"
          title={`Delete “${savedSheet?.title}”?`}
          description="This permanently removes the saved cheat sheet and all its images."
          keepLabel="Cancel"
          discardLabel={deleting ? <><SpinnerGap size={15} className="cheat-spinner" /> Deleting…</> : <><Trash size={15} aria-hidden="true" /> Delete sheet</>}
          keepRef={deleteKeepRef}
          busy={deleting}
          solid
          onKeep={() => { setDeleteConfirm(false); requestAnimationFrame(() => deleteTriggerRef.current?.focus({ preventScroll: true })); }}
          onDiscard={deleteSheet}
        />
      )}
    </ViewerPanel>
    {/* After the editor's panel: both overlays share z-index 40, so the later portal paints on top. */}
    {piecePickerOpen && <PiecePicker
      title="Edit pieces"
      items={items}
      initialSelection={draftPieces}
      rules={null}
      confirmLabel="Done"
      minPieces={1}
      renderPreview={(pieces) => <SheetPieceTray pieces={pieces} />}
      onConfirm={applyPickedPieces}
      onClose={closePiecePicker}
    />}
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

export function CheatSheetsArea({ items, premiumAllowed = true, provider = null, active, onSaved }) {
  const [sheets, setSheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [collectionViewer, setCollectionViewer] = useState(null);
  const [creating, setCreating] = useState(false);
  const createTriggerRef = useRef(null);
  const openRequestId = useRef(0);
  const collectionViewerMounted = useRef(false);
  const editorReturnFocus = useRef(null);
  const editorMounted = useRef(false);

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
    setCreating(false);
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

  const updateSheet = useCallback((sheet, removedId = null) => {
    setSheets((current) => sortSheets(removedId ? current.filter((item) => item.id !== removedId) : [sheet, ...current.filter((item) => item.id !== sheet.id)]));
  }, []);

  const newSheet = (event) => {
    if (!items.length) return;
    const trigger = event?.currentTarget || null;
    openRequestId.current += 1;
    setOpeningId(null);
    setCollectionViewer(null);
    createTriggerRef.current = trigger;
    setCreating(true);
  };

  // Synchronous: the picker unmounts in the commit that mounts the editor.
  const confirmNewSheet = (pieces) => {
    const trigger = createTriggerRef.current;
    editorReturnFocus.current = trigger;
    setCreating(false);
    setEntry({ key: crypto.randomUUID(), sheet: null, initialPieces: pieces });
  };

  // The picker's ViewerPanel returns focus to the trigger it captured.
  const cancelNewSheet = () => setCreating(false);

  const openSheetViewer = async (sheet, event) => {
    const requestId = ++openRequestId.current;
    const trigger = event?.currentTarget || null;
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
    editorReturnFocus.current = trigger;
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
    const trigger = editorReturnFocus.current;
    editorReturnFocus.current = null;
    openRequestId.current += 1;
    setOpeningId(null);
    setEntry(null);
    restoreEditorFocus(trigger, () => document.querySelector(".cheat-new-button"));
  };

  if (!active && !entry && !creating) return null;
  return <>
    {active && <SheetCollection sheets={sheets} loading={loading} error={error} canCreate={items.length > 0} onNew={newSheet} onOpen={openSheetViewer} onEdit={openSheetEditor} openingId={openingId} />}
    {active && collectionViewer && <FullscreenCheatSheetViewer title={collectionViewer.sheet.title} versionLabel={collectionViewer.versionLabel} isDraft={false} onClose={closeCollectionViewer} openedFrom={collectionViewer.trigger}>
      <OptimizedImage className="cheat-preview__saved-image" src={collectionViewer.image} alt={`${collectionViewer.sheet.title || "Cheat sheet"}, ${collectionViewer.versionLabel.toLowerCase()}`} />
    </FullscreenCheatSheetViewer>}
    {creating && <PiecePicker
      title="New cheat sheet"
      items={items}
      rules={null}
      confirmLabel="Next"
      minPieces={1}
      renderPreview={(pieces) => <SheetPieceTray pieces={pieces} />}
      onConfirm={confirmNewSheet}
      onClose={cancelNewSheet}
    />}
    {entry && <CheatSheetEditor key={entry.key} items={items} entry={entry} onClose={closeEditor} onSaved={saved} onSheetUpdate={updateSheet} premiumAllowed={premiumAllowed} provider={provider} />}
  </>;
}
