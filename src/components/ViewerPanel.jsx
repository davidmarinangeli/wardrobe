import { X } from "@phosphor-icons/react";
import { useDismiss } from "../hooks/useDismiss.js";

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
  children,
}) {
  const { closing, dismiss } = useDismiss(onClose);

  return (
    <div
      className={`viewer-overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
      role="presentation"
      data-closing={closing}
      onMouseDown={(e) => e.target === e.currentTarget && dismiss()}
    >
      <div
        className={`viewer-entry${entryClassName ? ` ${entryClassName}` : ""}`}
        style={entryStyle}
      >
        <aside
          className={`viewer${panelClassName ? ` ${panelClassName}` : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel ?? title}
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
}
