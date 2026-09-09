import { useCallback, useEffect, useRef } from "react";
import { animate } from "motion";
import { sheetOffset, shouldDismiss, scrimFor } from "../../shared/sheet-physics.mjs";

// ─── Physics ──────────────────────────────────────────────────────────────────
// Sibling to useDeckGesture. The constants that describe the *hand* — how much
// movement counts as a gesture, how much history a velocity is measured over —
// are the same numbers deliberately: the two surfaces are operated by the same
// thumb, and a deck that answers at 6px next to a sheet that answers at 12px
// reads as two apps.

const DEADZONE = 6;

// Springs, same pair as the deck. Bounce is earned on the way home — the hand
// moved it, so it may overshoot slightly coming back — and spent on the way
// out, where a bouncing exit would read as the sheet being unsure it left.
const SPRING_HOME = { type: "spring", bounce: 0.22, duration: 0.42 };
const SPRING_EXIT = { type: "spring", bounce: 0.1, duration: 0.42 };

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Pointer-driven dismissal for a bottom sheet.
 *
 * Everything writes to the DOM node directly, for the reason spelled out in
 * useDeckGesture: routing a drag through React state re-renders the panel on
 * every pointermove, and the standards name that explicitly. The scrim opacity
 * is written as a custom property (--scrim-opacity) rather than straight to
 * overlay.style.opacity, because the overlay element wraps the sheet — opacity
 * on it would fade the sheet along with the scrim while dragging. The property
 * is read only by the overlay's ::before, which is the actual scrim.
 *
 * The hard part here is not the physics, it's deciding whether the gesture
 * belongs to this hook at all. A sheet contains a scroller, and a downward drag
 * means "scroll up" everywhere except at the very top of that scroller, where
 * it means "leave". That is resolved once, at the moment the axis resolves, and
 * never revisited — a claim that can be handed back mid-gesture is worse than
 * either answer, which is the same conclusion the deck's axis lock reached.
 *
 * @param {object} options
 * @param {{current: HTMLElement|null}} options.sheetRef    - the panel that moves.
 * @param {{current: HTMLElement|null}} options.overlayRef  - the scrim behind it.
 * @param {{current: HTMLElement|null}} options.scrollRef   - the panel's scroller.
 *   Defaults to sheetRef when the panel scrolls itself.
 * @param {boolean}  options.enabled    - false on desktop, where this is a side panel.
 * @param {() => void} options.onDismiss
 * @returns {{dragHandlers: object}}
 */
export function useSheetGesture({ sheetRef, overlayRef, scrollRef, enabled = true, onDismiss }) {
  const gesture = useRef(null);
  const running = useRef(null);
  const committed = useRef(false);

  const stopAnimation = useCallback(() => {
    running.current?.stop();
    running.current = null;
  }, []);

  useEffect(() => stopAnimation, [stopAnimation]);

  // The browser has to be told, per frame, to keep its hands off.
  //
  // touch-action alone is not enough here. The sheet's body must stay
  // `pan-y` or its content cannot scroll — but that also means the moment a
  // finger moves vertically, the browser may claim the touch as a scroll,
  // fire pointercancel at us, and take the gesture away mid-drag. On a page
  // that is already at its top it goes further and runs pull-to-refresh,
  // which is why dragging the sheet reloaded the tab instead of moving it.
  //
  // preventDefault on a *non-passive* touchmove is the only thing that stops
  // both. React attaches its listeners passively for touch events, so this
  // one is attached natively. It also suppresses the synthetic mouse events
  // the browser replays after a touch — the ghost click that was landing on
  // the card underneath and immediately reopening the sheet.
  //
  // Bound to the document rather than to the sheet, because callers render
  // the sheet conditionally: on the render where this effect first runs the
  // node does not exist yet, and `sheetRef` is a stable object, so a
  // sheet-bound listener would never re-attach once it did. Guarding on an
  // in-flight claim makes the document binding inert the rest of the time.
  useEffect(() => {
    if (!enabled) return undefined;
    const block = (event) => {
      if (gesture.current?.moved) event.preventDefault();
    };
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [enabled]);

  // One place that knows how a vertical offset becomes a pose, so the drag, the
  // spring home and the exit cannot drift apart.
  //
  // Takes its nodes as arguments rather than reading the refs, so an animation
  // can be pinned to the element it started on. Callers here render the sheet
  // conditionally while keeping this hook mounted, which means the ref is
  // re-pointed at a *new* node as soon as the next sheet opens — an exit spring
  // still in flight would then start writing its transform into that new sheet,
  // which arrives already shoved halfway off the screen.
  const paintOn = useCallback((sheet, overlay, dy) => {
    if (!sheet) return;
    const height = sheet.offsetHeight || 1;
    const offset = sheetOffset(dy, height);

    // The class carries the grabbed state and switches the transform transition
    // off — a transition here would smooth every frame the pointer produces and
    // leave the sheet permanently trailing the finger.
    sheet.classList.add("is-dragging");

    // Retire the entry keyframe for good on both the sheet and its .viewer-entry
    // wrapper. The keyframe animation was declared on .viewer-entry; setting
    // animation = 'none' directly on both elements ensures that when .is-dragging
    // is dropped at the end of a spring home, the browser does NOT restart sheet-in
    // from 0% (which was the cause of the re-inflating bug).
    const entry = sheet.closest?.(".viewer-entry") || sheet.parentElement;
    if (entry) {
      entry.style.animation = "none";
      entry.style.transform = "none";
    }
    sheet.style.animation = "none";
    sheet.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;

    // A custom property, not overlay.style.opacity directly: the overlay itself
    // is transparent (styles.css) and only its ::before scrim paints — setting
    // opacity on the overlay element fades that whole subtree, sheet included,
    // which is exactly the "sheet fades while you drag it" bug this replaced.
    if (overlay) overlay.style.setProperty("--scrim-opacity", scrimFor(offset, height).toFixed(3));
  }, []);

  const paint = useCallback(
    (dy) => paintOn(sheetRef.current, overlayRef.current, dy),
    [paintOn, sheetRef, overlayRef],
  );

  const clearPose = useCallback(() => {
    const sheet = sheetRef.current;
    if (sheet) {
      sheet.classList.remove("is-dragging");
      sheet.style.transform = "";
      const entry = sheet.closest?.(".viewer-entry") || sheet.parentElement;
      if (entry) {
        entry.style.animation = "none";
        entry.style.transform = "none";
      }
    }
    if (overlayRef.current) overlayRef.current.style.removeProperty("--scrim-opacity");
  }, [sheetRef, overlayRef]);

  /**
   * Push the sheet the rest of the way off. The spring starts at the velocity
   * the finger let go at, so there is no seam between the gesture and the
   * animation — the reason this can't be a keyframe, which would restart from
   * zero and inherit nothing.
   *
   * Both springs animate the *raw* pointer distance, never the damped offset:
   * paint() is the only thing allowed to apply resistance, so feeding it an
   * already-damped value would damp it a second time and the sheet would crawl
   * home from an upward lift.
   */
  const exit = useCallback((dy, velocity) => {
    const sheet = sheetRef.current;
    if (!sheet || prefersReducedMotion()) {
      onDismiss();
      return;
    }
    stopAnimation();

    // Pinned to this sheet and this scrim: by the time the spring finishes,
    // the ref may already point at the next sheet the user opened.
    const scrim = overlayRef.current;
    running.current = animate(dy, sheet.offsetHeight || 1, {
      ...SPRING_EXIT,
      velocity: velocity * 1000,
      onUpdate: (value) => paintOn(sheet, scrim, value),
    });
    // Handed over immediately rather than on completion: the decision is made,
    // and waiting for the spring to settle before telling the app about it is
    // how a dismissal ends up feeling 400ms slow.
    onDismiss();
  }, [sheetRef, overlayRef, onDismiss, paintOn, stopAnimation]);

  const dragHandlers = {
    onPointerDown: (event) => {
      if (!enabled) return;
      if (event.button !== 0 && event.pointerType === "mouse") return;
      // Multi-touch protection: a second finger landing mid-drag must not
      // retarget the gesture, or the sheet jumps to the new contact point.
      if (gesture.current) return;
      stopAnimation();
      committed.current = false;

      const scroller = scrollRef?.current ?? sheetRef.current;
      // A grab handle is a promise that this area is never the scroller's, at
      // any scroll position — which is the whole reason to have one. Marked
      // with a data attribute rather than a class so the hook owes nothing to
      // anyone's stylesheet.
      const fromHandle = !!event.target.closest?.("[data-sheet-grab]");
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        fromHandle,
        // Where the scroller stood when the finger landed. Read once: within a
        // single gesture starting at the top, nothing can scroll it away.
        scrollTop: scroller?.scrollTop ?? 0,
        moved: false,
        aborted: false,
        // A short history, not just the last point: one sample is noise at
        // 120Hz, and the release frame is often the slowest of the gesture.
        history: [{ y: event.clientY, t: event.timeStamp }],
      };
    },

    onPointerMove: (event) => {
      const state = gesture.current;
      if (!state || state.id !== event.pointerId || state.aborted || committed.current) return;

      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;

      if (!state.moved) {
        if (Math.abs(dx) < DEADZONE && Math.abs(dy) < DEADZONE) return;
        // Ways to not be ours, all decided here and never revisited: horizontal
        // intent, an upward drag (the scroller's), and — unless the gesture
        // started on a grab handle — any drag that began with content scrolled
        // above the fold, which is also the scroller's.
        if (Math.abs(dy) <= Math.abs(dx)) { state.aborted = true; return; }
        if (dy <= 0) { state.aborted = true; return; }
        if (!state.fromHandle && state.scrollTop > 0) { state.aborted = true; return; }
        state.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      state.history.push({ y: event.clientY, t: event.timeStamp });
      if (state.history.length > 6) state.history.shift();

      paint(dy);
    },

    onPointerUp: (event) => {
      const state = gesture.current;
      gesture.current = null;
      if (!state || state.id !== event.pointerId || !state.moved) return;

      const dy = event.clientY - state.y;
      const height = sheetRef.current?.offsetHeight || 1;

      // Velocity over the tail of the gesture, not over the whole of it — a
      // long slow drag that ends in a flick should read as a flick.
      const history = state.history;
      const first = history[0];
      const last = history[history.length - 1];
      const elapsed = last.t - first.t;
      const velocity = elapsed > 0 ? (last.y - first.y) / elapsed : 0;

      if (shouldDismiss(dy, velocity, height)) {
        committed.current = true;
        exit(dy, velocity);
        return;
      }

      // Under the bar: home, carrying the velocity so the return is continuous
      // with the drag rather than a fresh animation that happens to start here.
      // Dragging itself stays available under reduced motion — the sheet moving
      // with the finger is the user's own hand, not motion done at them — but
      // the unattended spring back does not.
      stopAnimation();
      if (prefersReducedMotion()) { clearPose(); return; }
      running.current = animate(dy, 0, {
        ...SPRING_HOME,
        velocity: velocity * 1000,
        onUpdate: paint,
        onComplete: clearPose,
      });
    },

    onPointerCancel: () => {
      const state = gesture.current;
      gesture.current = null;
      if (!state?.moved || committed.current) return;
      stopAnimation();
      clearPose();
    },
  };

  return { dragHandlers, clearPose };
}
