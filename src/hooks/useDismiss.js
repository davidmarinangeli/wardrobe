import { useCallback, useEffect, useRef, useState } from "react";

const EXIT_MS = 160;

/**
 * Animated dismissal for overlay panels.
 *
 * A panel that animates in but vanishes on close reads as broken — enter and
 * exit should travel the same path. This defers `onClose` until the exit
 * animation has run, and exposes the phase as a `data-closing` attribute the
 * stylesheet keys off.
 *
 * Escape is special. Keyboard actions are repeated often and are always faster
 * than an animation, so a key-initiated close reports `"instant"` and skips the
 * exit entirely rather than making the user wait 160ms they did not ask for.
 *
 * @param {function} onClose - Called once the exit has finished.
 * @returns {{ closing: string|undefined, dismiss: (opts?: {instant?: boolean}) => void }}
 */
export function useDismiss(onClose) {
  const [closing, setClosing] = useState(undefined);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const dismiss = useCallback(({ instant = false } = {}) => {
    if (timerRef.current) return;          // already leaving
    if (instant) {
      setClosing("instant");
      onClose();
      return;
    }
    setClosing("true");
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onClose();
    }, EXIT_MS);
  }, [onClose]);

  return { closing, dismiss };
}
