import { useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { useDismiss } from "../hooks/useDismiss.js";
import { useExpandOrigin } from "../hooks/useExpandOrigin.js";
import { useSheetGesture } from "../hooks/useSheetGesture.js";
import { useIsPhone } from "../hooks/useIsPhone.js";

/**
 * Standard slide-in panel shell used by every modal/drawer in the app.
 *
 * Renders:  viewer-overlay  >  viewer-entry  >  aside.viewer  >  close button
 *                                                              +  optional heading
 *                                                              +  {children}
 *
 * Props
 * ─────
 * title          string   – If provided, renders a <div.viewer-heading><h2> above children.
 *                           Omit when the heading is rendered inside children (e.g. modeled-hero mode).
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
  entryStyle,
  openedFrom,
  children,
}) {
  const { closing, dismiss } = useDismiss(onClose);
  const entryRef = useRef(null);
  const sheetRef = useRef(null);
  const overlayRef = useRef(null);
  useExpandOrigin(entryRef, openedFrom);

  // On a phone this panel is a bottom sheet, and a sheet you cannot push away
  // is a dialog wearing a sheet's clothes. The gesture is only wired up below
  // the chrome breakpoint: at desktop widths this is a right-edge drawer, where
  // a downward drag means nothing and the pointer handlers are pure overhead.
  const isPhone = useIsPhone();
  const { dragHandlers } = useSheetGesture({
    sheetRef,
    overlayRef,
    enabled: isPhone,
    // Straight to onClose, not through dismiss(): the gesture has already
    // carried the sheet off the bottom of the screen under the user's own
    // thumb, so playing the 160ms exit on top of it would animate it a second
    // time from a place it has already left.
    onDismiss: onClose,
  });

  const content = (
    <div
      ref={overlayRef}
      className={`viewer-overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
      role="presentation"
      data-closing={closing}
      // pointerdown rather than mousedown. After a touch the browser replays a
      // synthetic mousedown at the release point — which lands on the overlay
      // once the sheet has moved out from under the finger, dismissing a panel
      // the user was only dragging.
      onPointerDown={(e) => e.target === e.currentTarget && dismiss()}
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

          <button
            className="icon-button viewer-icon-close"
            type="button"
            onClick={() => dismiss()}
            aria-label="Close"
            ref={closeRef}
          >
            <X size={24} weight="light" aria-hidden="true" />
          </button>

          {title && (
            <div className="viewer-heading">
              <h2>{title}</h2>
            </div>
          )}

          {children}
        </aside>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
