import { useEffect } from "react";

/**
 * Wires up keyboard / body-scroll behaviour for a slide-in viewer panel.
 *
 * - Pressing Escape calls `onClose`.
 * - Adds `viewer-open` to `document.body` (prevents background scroll) for the
 *   lifetime of the panel.
 * - Auto-focuses `closeRef` when the panel mounts.
 *
 * @param {function} onClose  - Called when Escape is pressed.
 * @param {React.RefObject} [closeRef] - Ref attached to the close button.
 */
export function useViewerKeyboard(onClose, closeRef) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeRef?.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
    };
  }, [onClose, closeRef]);
}
