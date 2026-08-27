import { Trash } from "@phosphor-icons/react";

/**
 * Standard panel footer action row.
 *
 * Layout:  [Delete]  ···spacer···  [Cancel]  [Confirm]
 *
 * All slots are optional — pass only what the panel needs.
 *
 * Props
 * ─────
 * onDelete        fn     – Renders a left-aligned delete button.
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
      {onDelete && (
        <button className="delete-button" type="button" onClick={onDelete}>
          <Trash size={15} weight="regular" aria-hidden="true" /> Delete
        </button>
      )}
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
