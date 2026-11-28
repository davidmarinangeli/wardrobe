import { useEffect, useRef, useState } from "react";
import { Trash } from "@phosphor-icons/react";

/**
 * The object's Delete, far left in a panel footer. With a `confirmLabel` it
 * takes two taps, the way the ⋯ menu's destructive entries always have: the
 * first turns the button into its own confirmation (solid, the one place a
 * destructive button is filled), the second deletes. Leaving it alone for a
 * few seconds, or moving focus away, puts it back.
 */
export function DeleteButton({ label = "Delete", confirmLabel, ariaLabel, onConfirm, disabled = false }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const reset = () => {
    clearTimeout(timerRef.current);
    setConfirming(false);
  };

  return (
    <button
      className={`danger-button${confirming ? " danger-button--solid" : ""}`}
      type="button"
      disabled={disabled}
      aria-label={confirming ? undefined : ariaLabel}
      onBlur={reset}
      onClick={() => {
        if (confirmLabel && !confirming) {
          setConfirming(true);
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setConfirming(false), 4000);
          return;
        }
        reset();
        onConfirm();
      }}
    >
      <Trash size={15} weight={confirming ? "bold" : "regular"} aria-hidden="true" />
      <span aria-live="polite">{confirming ? confirmLabel : label}</span>
    </button>
  );
}

/**
 * Standard panel footer action row.
 *
 * Layout:  [Delete] [Leading actions]  ···spacer···  [Cancel]  [Confirm]
 *
 * All slots are optional — pass only what the panel needs.
 *
 * Props
 * ─────
 * onDelete        fn     – Renders a left-aligned .danger-button, kept apart
 *                          from the confirm by the spacer.
 * deleteLabel     string – Its accessible name when it says more than "Delete"
 *                          (e.g. "Delete outfit").
 * deleteConfirmLabel string – Makes Delete a two-tap action (see DeleteButton).
 * leadingActions  node   – Extra buttons rendered beside the delete button.
 * onCancel        fn     – Renders a secondary "Cancel" button.
 * cancelLabel     string – Override "Cancel" (e.g. "Done").
 * onConfirm       fn     – Renders the primary action button.
 * confirmLabel    string – Label for the primary button (default "Save").
 * confirmIcon     node   – Icon prepended to the confirm label.
 * confirmDisabled bool   – Disables the confirm button.
 * children        node   – Extra buttons rendered between cancel and confirm.
 */
export function PanelActions({
  onDelete,
  deleteLabel,
  deleteConfirmLabel,
  leadingActions,
  onCancel,
  cancelLabel = "Cancel",
  onConfirm,
  confirmLabel = "Save",
  confirmIcon,
  confirmDisabled,
  children,
}) {
  return (
    <div className="viewer-actions">
      {onDelete && <DeleteButton ariaLabel={deleteLabel} confirmLabel={deleteConfirmLabel} onConfirm={onDelete} />}
      {leadingActions}
      <span className="action-spacer" />
      {children}
      {onCancel && (
        <button className="secondary-button" type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
      )}
      {onConfirm && (
        <button
          className="primary-button"
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {confirmIcon}
          {confirmLabel}
        </button>
      )}
    </div>
  );
}
