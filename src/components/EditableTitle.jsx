import { useEffect, useRef, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";

/**
 * Click-to-rename title used in viewer side panels (wardrobe items, outfits).
 * Renders as plain text with a pencil icon; clicking either swaps in a text
 * input that commits on blur/Enter and reverts on Escape.
 *
 * Props
 * ─────
 * value       string   – Current name.
 * placeholder string   – Shown when value is empty, and as the input placeholder.
 * onChange    function – Called with the trimmed new name once it actually changes.
 * ariaLabel   string   – Optional accessible label for the input (defaults to "Name").
 */
export function EditableTitle({ value, placeholder, onChange, ariaLabel = "Name" }) {
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(value);
  const inputRef = useRef(null);

  useEffect(() => setDraftValue(value), [value]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draftValue.trim();
    if (trimmed !== value) onChange(trimmed);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="viewer-title-input"
        value={draftValue}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          // Both keys must stop propagation, not just preventDefault — the viewer panel this
          // title lives in listens for Escape on `document` to close itself (useViewerKeyboard),
          // so an unstopped Escape here would cancel the rename AND close the whole panel.
          if (event.key === "Enter") { event.stopPropagation(); event.preventDefault(); commit(); }
          if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setDraftValue(value); setEditing(false); }
        }}
      />
    );
  }

  return (
    <button type="button" className="viewer-title" onClick={() => setEditing(true)}>
      <h2>{value || placeholder}</h2>
      <PencilSimple size={14} weight="bold" aria-hidden="true" />
    </button>
  );
}
