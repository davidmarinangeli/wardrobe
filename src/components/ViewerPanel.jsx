import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { useDismiss } from "../hooks/useDismiss.js";
import { useExpandOrigin } from "../hooks/useExpandOrigin.js";
import { useSheetGesture } from "../hooks/useSheetGesture.js";
import { useIsPhone } from "../hooks/useIsPhone.js";
import { useViewerOpenClass } from "../hooks/useViewerOpenClass.js";
import { useScrollEdges } from "../hooks/useScrollEdges.js";

// The footer element of the nearest ViewerPanel, for <ViewerFooter>. `null`
// outside a panel; `{ element: null }` for the one render before it mounts.
const FooterSlot = createContext(null);

/**
 * Puts its children in the enclosing ViewerPanel's fixed footer, wherever in
 * the panel's tree it is rendered. For action rows that live deep inside a
 * step or a mode (the setup wizard's Back / Continue) and would otherwise
 * scroll away with the content. A portal, so React events, context and state
 * stay where the row was written. Outside a ViewerPanel it renders in place.
 */
export function ViewerFooter({ children }) {
  const slot = useContext(FooterSlot);
  if (!slot) return children;
  return slot.element ? createPortal(children, slot.element) : null;
}

/**
 * Standard slide-in panel shell used by every modal/drawer in the app.
 *
 * Renders:  viewer-overlay  >  viewer-entry  >  aside.viewer  >  header  (title + close; fixed)
 *                                                              +  .viewer-body  (children; the only scroller)
 *                                                              +  footer  (actions; fixed, only when present)
 *
 * The aside is a frame that never scrolls: the header and footer stay put and
 * only the body moves. Three kinds of header:
 *   - a title (or headerContent): one row, title left, close right. Gets a
 *     hairline once the body scrolls under it.
 *   - compactTitle (photo-led panels with the name further down): a glass top
 *     bar over the photo that shows the name once it has scrolled away.
 *   - neither: the close floats in the top-right corner (panels that draw
 *     their own header, like the piece picker and the cheat sheet editor).
 *
 * Props
 * ─────
 * title          string   – If provided, renders a <div.viewer-heading><h2> in the fixed header.
 *                           Omit when the heading is rendered inside children (e.g. modeled-hero mode).
 * headerContent  node     – Rendered in the header row instead of a title (e.g. wizard progress).
 * headerBelow    node     – A second, full-width header row under the title (e.g. tabs).
 * compactTitle   string   – For panels without a title: the name shown in the top bar once
 *                           the element matching compactTitleSelector scrolls under it.
 * headerActions  node     – Controls placed just before the close button in the top bar
 *                           (compactTitle panels), e.g. a ⋯ menu, as on the item sheet.
 * The action row goes in the fixed footer through <ViewerFooter>, rendered anywhere
 * inside the panel's children (there is deliberately no `footer` prop: one way in).
 * ariaLabel      string   – `aria-label` on the <aside>. Defaults to `title`.
 * onClose        fn       – Called when the close button or overlay is clicked. The panel
 *                           plays its exit animation first (see useDismiss).
 * closeRef       ref      – Forwarded to the close button (for initial focus).
 * overlayClassName string – Extra class(es) on viewer-overlay (e.g. to recenter a dialog-style panel).
 * entryClassName string   – Extra class(es) on viewer-entry (controls panel width via CSS).
 * panelClassName string   – Extra class(es) on the <aside> (e.g. "has-modeled-image", "editing").
 * entryStyle     object   – Inline styles on viewer-entry (for one-off widths like SuggestionPanel).
 * openedFrom     Element  – The card that opened this panel (event.currentTarget from its
 *                           click). Given one, the panel grows out of that card instead of
 *                           sliding in from the right edge. Omit for panels nothing on
 *                           screen opened — a modal, a keyboard shortcut — which keep the
 *                           edge-anchored entry.
 * children       node     – Panel body content.
 */
export function ViewerPanel({
  title,
  ariaLabel,
  onClose,
  closeRef,
  overlayClassName,
  entryClassName,
  panelClassName,
  overlayStyle,
  entryStyle,
  openedFrom,
  onRequestClose,
  swipeToClose = true,
  swipeHandleOnly = false,
  closeDisabled = false,
  focusTrap = false,
  headerContent,
  headerBelow,
  headerActions,
  compactTitle,
  compactTitleSelector = ".viewer-title, .viewer-title-input",
  bodyClassName,
  children,
}) {
  // Every panel is a panel: the body class that locks scroll and scales the page
  // behind a sheet belongs to this component, not to whether a caller remembered
  // to also ask for Escape handling.
  useViewerOpenClass();

  const { closing, dismiss } = useDismiss(onClose);
  const entryRef = useRef(null);
  const sheetRef = useRef(null);
  const overlayRef = useRef(null);
  const bodyRef = useRef(null);
  const [footerElement, setFooterElement] = useState(null);
  useExpandOrigin(entryRef, openedFrom);
  useScrollEdges(bodyRef, sheetRef, { titleSelector: compactTitle ? compactTitleSelector : undefined });

  // On a phone this panel is a bottom sheet, and a sheet you cannot push away
  // is a dialog wearing a sheet's clothes. The gesture is only wired up below
  // the chrome breakpoint: at desktop widths this is a right-edge drawer, where
  // a downward drag means nothing and the pointer handlers are pure overhead.
  const isPhone = useIsPhone();
  const requestClosePermission = () => {
    if (closeDisabled) return Promise.resolve(false);
    try {
      return Promise.resolve(onRequestClose?.()).then((allowed) => allowed !== false).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  };
  const requestDismiss = (options) => {
    void requestClosePermission().then((allowed) => {
      if (allowed) dismiss(options);
    });
  };
  const { dragHandlers } = useSheetGesture({
    sheetRef,
    overlayRef,
    // The body scrolls, not the sheet: a drag only belongs to the sheet when
    // the body is at its top (or it starts on the header, a grab handle).
    scrollRef: bodyRef,
    enabled: isPhone && swipeToClose && !closeDisabled,
    handleOnly: swipeHandleOnly,
    // Straight to onClose, not through dismiss(): the gesture has already
    // carried the sheet off the bottom of the screen under the user's own
    // thumb, so playing the 160ms exit on top of it would animate it a second
    // time from a place it has already left.
    onDismiss: () => {
      void requestClosePermission().then((allowed) => {
        if (allowed) onClose();
      });
    },
  });

  useEffect(() => {
    if (!focusTrap || typeof document === "undefined") return undefined;
    const previousFocus = document.activeElement;
    const dialog = sheetRef.current;
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const trapTab = (event) => {
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll(focusableSelector)].filter((element) => {
        if (!element.isConnected || element.getClientRects().length === 0 || element.getAttribute("aria-hidden") === "true") return false;
        return !element.closest("[hidden], [inert]");
      });
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", trapTab);
    return () => {
      document.removeEventListener("keydown", trapTab);
      if (previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus?.({ preventScroll: true }));
    };
  }, [focusTrap]);

  const hasHeaderRow = Boolean(title || headerContent);
  // Memoized: every <ViewerFooter> reads this, and a fresh object per render
  // would re-render each of them whenever the panel does.
  const footerSlot = useMemo(() => ({ element: footerElement }), [footerElement]);
  const closeButton = (
    <button
      className="icon-button viewer-icon-close"
      type="button"
      onClick={() => requestDismiss()}
      aria-label="Close"
      ref={closeRef}
      disabled={closeDisabled}
    >
      <X size={24} weight="light" aria-hidden="true" />
    </button>
  );

  const content = (
    <div
      ref={overlayRef}
      className={`viewer-overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
      style={overlayStyle}
      role="presentation"
      data-closing={closing}
      // pointerdown rather than mousedown. After a touch the browser replays a
      // synthetic mousedown at the release point — which lands on the overlay
      // once the sheet has moved out from under the finger, dismissing a panel
      // the user was only dragging.
      onPointerDown={(e) => e.target === e.currentTarget && requestDismiss()}
    >
      <div
        ref={entryRef}
        className={`viewer-entry${openedFrom ? " viewer-entry--from-card" : ""}${entryClassName ? ` ${entryClassName}` : ""}`}
        style={entryStyle}
      >
        <aside
          ref={sheetRef}
          className={`viewer${panelClassName ? ` ${panelClassName}` : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel ?? title}
          {...(isPhone ? dragHandlers : null)}
        >

          <header
            className={`viewer-header${hasHeaderRow ? " viewer-header--row" : compactTitle ? " viewer-topbar" : " viewer-header--floating"}`}
          >
            {hasHeaderRow ? (
              // The title row never scrolls, so it is always a safe place to
              // pull the sheet down from, whatever the body's scroll position.
              // Only the row: a drag that starts on the tabs below it is not
              // a request to close.
              <div className="viewer-header__row" data-sheet-grab="">
                {title ? (
                  <div className="viewer-heading">
                    <h2>{title}</h2>
                  </div>
                ) : (
                  <div className="viewer-header__content">{headerContent}</div>
                )}
                {closeButton}
              </div>
            ) : compactTitle ? (
              // The real name is in the body (an editable title); this is its
              // shadow for once it has scrolled away, so it stays out of the
              // accessibility tree.
              <div className="viewer-heading viewer-topbar__title" aria-hidden="true">
                <h2>{compactTitle}</h2>
              </div>
            ) : null}
            {!hasHeaderRow && headerActions}
            {!hasHeaderRow && closeButton}
            {headerBelow && <div className="viewer-header__below">{headerBelow}</div>}
          </header>

          <div ref={bodyRef} className={`viewer-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>
            <FooterSlot.Provider value={footerSlot}>
              {children}
            </FooterSlot.Provider>
          </div>

          <footer ref={setFooterElement} className="viewer-footer" />
        </aside>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
