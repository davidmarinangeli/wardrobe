import { useEffect } from "react";
import { useViewerOpenClass } from "./useViewerOpenClass.js";

/**
 * Wires up keyboard / body-scroll behaviour for a slide-in viewer panel.
 *
 * - Pressing Escape calls `onClose({ instant: true })` — keyboard-initiated
 *   closes skip the exit animation (see useDismiss).
 * - Holds `viewer-open` on `document.body` for the lifetime of the panel, via
 *   useViewerOpenClass. Kept here for the popovers that use this hook WITHOUT
 *   ViewerPanel (Mirror, the import tray); every real panel now gets it from
 *   ViewerPanel itself, and the shared counter makes the overlap safe.
 * - Auto-focuses `closeRef` when the panel mounts.
 *
 * @param {function} onClose  - Called when Escape is pressed.
 * @param {React.RefObject} [closeRef] - Ref attached to the close button.
 * @param {boolean} [enabled] - Pass `false` to disable everything below (no
 *   listener, no body-scroll lock, no autofocus). For panels that mount once
 *   and toggle their own open/closed state internally (Mirror, the import
 *   tray's popover) rather than being conditionally rendered by a parent —
 *   without this they'd bind Escape and lock body scroll for the component's
 *   entire lifetime, not just while actually open. Defaults to `true`, which
 *   matches every conditionally-rendered caller's existing behaviour.
 */
export function useViewerKeyboard(onClose, closeRef, enabled = true) {
  useViewerOpenClass(enabled);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event) => { if (event.key === "Escape") onClose({ instant: true }); };
    document.addEventListener("keydown", onKeyDown);
    closeRef?.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, closeRef, enabled]);
}
