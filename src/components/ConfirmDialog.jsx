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
 *                                discardLabel may be a node (e.g. a spinner while busy).
 * onKeep, onDiscard            – Called by the buttons. The caller owns Escape.
 * keepRef                      – Optional ref forwarded to the Keep button.
 * busy                         – Disables both buttons while the discard is running.
 *
 * Same anatomy as every panel: eyebrow and title on top, the explanation, then
 * the action row with the primary (Keep, filled) rightmost and the destructive
 * Discard to its left.
 */
export function ConfirmDialog({ eyebrow, title, description, keepLabel, discardLabel, onKeep, onDiscard, keepRef, busy = false }) {
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
        <header className="confirm-dialog__header">
          {eyebrow && <span className="confirm-dialog__eyebrow">{eyebrow}</span>}
          <h2 id={titleId}>{title}</h2>
        </header>
        {description && <p id={descriptionId}>{description}</p>}
        <footer className="confirm-dialog__actions">
          <button type="button" className="confirm-dialog__discard" onClick={onDiscard} disabled={busy}>{discardLabel}</button>
          <button ref={keepButtonRef} type="button" className="confirm-dialog__keep" onClick={onKeep} disabled={busy}>{keepLabel}</button>
        </footer>
      </div>
    </div>
  );
}
