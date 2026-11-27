import { useEffect, useId, useRef } from "react";
import "./confirm-dialog.css";

/**
 * A small Keep / Discard alert dialog laid over the panel it belongs to.
 *
 * Render it inside a ViewerPanel's children, next to an `inert` wrapper around
 * the rest of the panel, so the panel's focus trap cycles only these two
 * buttons. The layer sits above the panel's close button (z 8).
 *
 * Props
 * ─────
 * eyebrow, title, description  – The copy. `title` names the decision.
 * keepLabel, discardLabel      – Button labels. Keep is the safe default and gets focus.
 * onKeep, onDiscard            – Called by the buttons. The caller owns Escape.
 * keepRef                      – Optional ref forwarded to the Keep button.
 */
export function ConfirmDialog({ eyebrow, title, description, keepLabel, discardLabel, onKeep, onDiscard, keepRef }) {
  const titleId = useId();
  const descriptionId = useId();
  const ownKeepRef = useRef(null);
  const keepButtonRef = keepRef || ownKeepRef;

  useEffect(() => {
    const frame = requestAnimationFrame(() => keepButtonRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [keepButtonRef]);

  return (
    <div className="confirm-layer" role="presentation">
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
        {eyebrow && <span className="confirm-dialog__eyebrow">{eyebrow}</span>}
        <h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}
        <div className="confirm-dialog__actions">
          <button ref={keepButtonRef} type="button" className="confirm-dialog__keep" onClick={onKeep}>{keepLabel}</button>
          <button type="button" className="confirm-dialog__discard" onClick={onDiscard}>{discardLabel}</button>
        </div>
      </div>
    </div>
  );
}
