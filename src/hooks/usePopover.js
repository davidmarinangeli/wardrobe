import { useEffect } from "react";

// A pointer landing outside an open popover closes it. Escape is handled by the
// popover's own onKeyDown instead: focus is inside it while it is open, and
// stopping the key there keeps it from also reaching a viewer's document-level
// Escape-to-close (useViewerKeyboard) — the same arrangement EditableTitle uses.
export function useDismissOnOutsidePointer(open, rootRef, onDismiss) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, rootRef, onDismiss]);
}

// Arrow keys walk a menu's enabled entries, wrapping at the ends.
export function moveMenuFocus(event, menu) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const entries = [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
  if (!entries.length) return;
  event.preventDefault();
  const index = entries.indexOf(document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  entries[(index + step + entries.length) % entries.length].focus();
}
