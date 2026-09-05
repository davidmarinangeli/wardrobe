import { useCallback, useEffect, useRef } from "react";
import { animate } from "motion";
import { rubberband, verdictFor } from "../../shared/deck-physics.mjs";

// ─── Physics ──────────────────────────────────────────────────────────────────
// The deck is the one surface in this app with a real gesture, so it is the one
// place where physics is information rather than decoration: how hard you threw
// the card is the answer, and the card has to behave as if it knows that.

// Movement before a gesture is a gesture at all. Below this it's a tap, or the
// tremor at the start of a scroll.
const DEADZONE = 6;

// Degrees of tilt per pixel of horizontal travel, and how far the card sags as
// it goes. Both are small: the card is being weighed, not thrown across a room.
const ROTATION_PER_PX = 0.045;
const SAG_PER_PX = 0.06;

// The verdict stamp is fully legible by this much travel, so the gesture is
// never a guess about which way it will resolve.
const STAMP_FULL_AT = 90;

// Springs. Bounce is *earned* here — a flick preceded it, which is exactly the
// case the standards carve out for overshoot; a card that springs home after a
// hesitant drag gets the same slight elasticity because the hand did move it.
const SPRING_HOME = { type: "spring", bounce: 0.22, duration: 0.42 };
const SPRING_FLING = { type: "spring", bounce: 0.1, duration: 0.42 };

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Pointer-driven physics for the top card of the suggestion deck.
 *
 * Everything here writes to the DOM node directly. Routing a drag through React
 * state re-renders the whole panel on every pointermove, which is both the
 * slowest way to move an element and the one the repo's animation standards
 * name explicitly — the transform is set on the element, not published as state
 * and not handed down as a custom property for children to inherit.
 *
 * The card's exit is a continuation of the drag, not a replacement for it: the
 * spring starts at the exact velocity the finger let go at, so there is no seam
 * between the gesture and the animation. This is why the old CSS keyframe had
 * to go — a keyframe restarts from zero and cannot inherit anything.
 *
 * @param {object}   options
 * @param {{current: HTMLElement|null}} options.cardRef  - the top card.
 * @param {{current: HTMLElement|null}} options.deckRef  - measured for width.
 * @param {boolean}  options.enabled                     - false while a card leaves.
 * @param {(verdict: "like"|"pass") => void} options.onCommit
 * @returns {{dragHandlers: object, fling: (verdict: string) => void, exitMs: number}}
 */
export function useDeckGesture({ cardRef, deckRef, enabled, onCommit }) {
  // Mutable gesture state. Never rendered, so never state.
  const gesture = useRef(null);
  const running = useRef(null);
  const committed = useRef(false);

  const stopAnimation = useCallback(() => {
    running.current?.stop();
    running.current = null;
  }, []);

  useEffect(() => stopAnimation, [stopAnimation]);

  // One place that knows how a horizontal offset turns into a pose, so the
  // drag, the spring home and the fling can't drift apart.
  const paint = useCallback((dx, dy) => {
    const card = cardRef.current;
    if (!card) return;
    // The class carries the grab cursor and the lifted shadow, and switches the
    // transform transition off — a transition here would smooth every frame the
    // pointer produces and leave the card permanently trailing the finger.
    card.classList.add("is-dragging");
    card.style.transform =
      `translate3d(${dx.toFixed(2)}px, ${(dy + Math.abs(dx) * SAG_PER_PX).toFixed(2)}px, 0)` +
      ` rotate(${(dx * ROTATION_PER_PX).toFixed(3)}deg)`;

    const stamp = Math.min(1, Math.abs(dx) / STAMP_FULL_AT);
    const like = card.querySelector("[data-stamp='like']");
    const pass = card.querySelector("[data-stamp='pass']");
    if (like) like.style.opacity = dx > 0 ? stamp : 0;
    if (pass) pass.style.opacity = dx < 0 ? stamp : 0;
  }, [cardRef]);

  const clearPose = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    card.classList.remove("is-dragging");
    card.style.transform = "";
    card.style.opacity = "";
    card.querySelectorAll("[data-stamp]").forEach((node) => { node.style.opacity = ""; });
  }, [cardRef]);

  /**
   * Throw the card off the deck. Called by the gesture on commit, and by the
   * ♥/✕ buttons and the arrow keys with no velocity — those are keyboard-rate
   * actions, so they get the shortest honest version of the same move rather
   * than a bespoke one.
   */
  const fling = useCallback((verdict, velocity = 0, from = { dx: 0, dy: 0 }) => {
    const card = cardRef.current;
    const width = deckRef.current?.offsetWidth || 320;
    if (!card || prefersReducedMotion()) {
      onCommit(verdict);
      return;
    }
    stopAnimation();

    const target = (verdict === "like" ? 1 : -1) * width * 1.35;
    const startY = from.dy;

    running.current = animate(from.dx, target, {
      ...SPRING_FLING,
      // px/ms at the finger becomes px/s for the spring — this is the handoff.
      velocity: velocity * 1000,
      onUpdate: (value) => {
        paint(value, startY);
        const progress = Math.min(1, Math.abs(value) / (width * 0.9));
        card.style.opacity = String(1 - progress);
      },
    });
    onCommit(verdict);
  }, [cardRef, deckRef, onCommit, paint, stopAnimation]);

  const dragHandlers = {
    onPointerDown: (event) => {
      if (!enabled) return;
      if (event.button !== 0 && event.pointerType === "mouse") return;
      // Multi-touch protection: a second finger landing mid-drag must not
      // retarget the gesture, or the card jumps to the new contact point.
      if (gesture.current) return;
      // Grabbing a card that is already moving takes it over at its current
      // on-screen value rather than snapping it back to zero first.
      stopAnimation();
      committed.current = false;
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        aborted: false,
        // A short history, not just the last point: one sample is noise at
        // 120Hz, and the release frame is often the slowest of the gesture.
        history: [{ x: event.clientX, t: event.timeStamp }],
      };
    },

    onPointerMove: (event) => {
      const state = gesture.current;
      if (!state || state.id !== event.pointerId || state.aborted || committed.current) return;

      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;

      if (!state.moved) {
        if (Math.abs(dx) < DEADZONE && Math.abs(dy) < DEADZONE) return;
        // Vertical intent belongs to the scroller, not to us. Decided once, at
        // the threshold, and not revisited — a lock that keeps changing its
        // mind mid-gesture is worse than either answer.
        if (Math.abs(dx) <= Math.abs(dy)) { state.aborted = true; return; }
        state.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      state.history.push({ x: event.clientX, t: event.timeStamp });
      if (state.history.length > 6) state.history.shift();

      // Horizontal is the answer, so it tracks 1:1. Vertical isn't, so it
      // resists — the card can be lifted a little, but it will not be dragged
      // off the top of the deck.
      const height = cardRef.current?.offsetHeight || 400;
      paint(dx, rubberband(dy, height));
    },

    onPointerUp: (event) => {
      const state = gesture.current;
      gesture.current = null;
      if (!state || state.id !== event.pointerId || !state.moved) return;

      const dx = event.clientX - state.x;
      const dy = rubberband(event.clientY - state.y, cardRef.current?.offsetHeight || 400);
      const width = deckRef.current?.offsetWidth || 320;

      // Velocity over the tail of the gesture, not over the whole of it — a
      // long slow drag that ends in a flick should read as a flick.
      const history = state.history;
      const first = history[0];
      const last = history[history.length - 1];
      const elapsed = last.t - first.t;
      const velocity = elapsed > 0 ? (last.x - first.x) / elapsed : 0;

      // Decide from where the throw is *going*, not from where it was let go.
      // This is the whole point: a fast flick across a short distance commits,
      // and a slow crawl across a long one does not.
      const verdict = verdictFor(dx, velocity, width);
      if (verdict) {
        committed.current = true;
        fling(verdict, velocity, { dx, dy });
        return;
      }

      // Under the bar: home, carrying the velocity so the return is continuous
      // with the drag rather than a fresh animation that happens to start here.
      // Dragging itself stays available under reduced motion — the card moving
      // with the finger is the user's own hand, not motion done at them — but
      // the unattended spring back does not.
      stopAnimation();
      if (prefersReducedMotion()) { clearPose(); return; }
      running.current = animate(dx, 0, {
        ...SPRING_HOME,
        velocity: velocity * 1000,
        onUpdate: (value) => paint(value, dy * (Math.abs(value) / (Math.abs(dx) || 1))),
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

  return { dragHandlers, fling, clearPose };
}
