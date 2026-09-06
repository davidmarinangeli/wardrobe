import { useLayoutEffect } from "react";

/**
 * Makes a panel grow out of the card that opened it, rather than slide in from
 * an edge that has nothing to do with what was clicked.
 *
 * This is the same claim the top-bar popovers make — "this came out of that" —
 * and it is made the same way: transform-origin sits on the trigger, so the
 * panel's own scale carries it back to its source. The difference is that a
 * popover is always mounted and can be measured before it opens, while a viewer
 * mounts on open, so the measurement happens in a layout effect instead.
 *
 * Both boxes are measured here, in the same frame, on purpose. Capturing the
 * card's coordinates back in the click handler and reusing them looks simpler
 * and is quietly wrong: opening a viewer adds `body.viewer-open`, which sets
 * `overflow: hidden`, which takes the scrollbar away and reflows the grid
 * underneath. Coordinates read before that reflow describe a layout that no
 * longer exists by the time the animation plays — about 16px of horizontal
 * drift on a scrollbar-bearing platform, more once the page shifts. The element
 * is still on screen behind the scrim, so it can simply be measured again.
 *
 * transform-origin is relative to the panel's own box rather than the viewport,
 * so the card's centre is rebased onto the panel. The panel is already carrying
 * its entry animation's transform by the time this runs, which would poison the
 * rect — so the animation comes off for one measurement and goes straight back
 * on. Layout effects run before paint, so no frame is drawn in that state.
 *
 * A panel opened without a source element is left alone: the CSS fallback keeps
 * the edge-anchored entry, which stays the right answer for the panels that
 * genuinely have no trigger on screen — a modal, a keyboard shortcut.
 *
 * @param {{current: HTMLElement|null}} entryRef - the .viewer-entry element.
 * @param {Element|null} openedFrom - the card that was clicked, or null.
 */
export function useExpandOrigin(entryRef, openedFrom) {
  useLayoutEffect(() => {
    const entry = entryRef.current;
    if (!entry || !openedFrom?.isConnected) return undefined;

    const measure = () => {
      if (!openedFrom.isConnected) return;
      const card = openedFrom.getBoundingClientRect();
      if (!card.width && !card.height) return;

      const animation = entry.style.animation;
      entry.style.animation = "none";
      const box = entry.getBoundingClientRect();
      entry.style.animation = animation;

      // Negative values are expected and correct: the grid sits to the left of
      // a right-hand drawer, so its cards are outside the panel's own box.
      entry.style.setProperty("--card-x", `${Math.round(card.left + card.width / 2 - box.left)}px`);
      entry.style.setProperty("--card-y", `${Math.round(card.top + card.height / 2 - box.top)}px`);
    };

    measure();

    // The vars outlive the entry animation — the exit reuses them to collapse
    // back into the same card — so a resize while the panel is open would
    // otherwise send it home to where the card used to be.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [entryRef, openedFrom]);
}
