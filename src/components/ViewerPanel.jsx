import { X } from "@phosphor-icons/react";

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
 * onClose        fn       – Called when the close button or overlay is clicked.
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
  return (
    <div
      className={`viewer-overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
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
            className="viewer-icon-close"
            type="button"
            onClick={onClose}
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
