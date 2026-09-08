import { useEffect } from "react";

/**
 * Floating chrome that gets out of the way as you read.
 *
 * Two behaviours, deliberately driven by different signals.
 *
 * The nav *shrinks* — labels collapse, the bar contracts on both axes — and it
 * never leaves. review-animations/STANDARDS.md puts navigation in the "tens of
 * times a day" band where motion should be reduced rather than added, and
 * hiding it outright would move every tap target out from under the thumb
 * already reaching for it.
 *
 * The action bar *hides*, because it is occasional and worth trading for
 * reading room. Costing a scroll-up to recover it is a fair price for a
 * secondary control and would not be for navigation.
 *
 * Both are asymmetric in the same direction: contracting is something the
 * interface does to get out of your way, so it waits until you are past a
 * threshold and still heading down; expanding is a response to you asking for
 * it back, so any upward movement at all restores it immediately.
 *
 * Written straight to the nodes from a passive listener. Routing a scroll
 * position through React state re-renders the page on every frame of a scroll.
 *
 * @param {{current: HTMLElement|null}} navRef
 * @param {{current: HTMLElement|null}} [actionRef]
 */
export function useChromeScroll(navRef, actionRef) {
  useEffect(() => {
    let lastY = window.scrollY;
    let compact = false;
    let hidden = false;

    const paint = () => {
      const y = window.scrollY;
      const delta = y - lastY;
      const nav = navRef.current;
      const action = actionRef?.current;

      let nextCompact = compact;
      if (y <= 40) nextCompact = false;
      else if (delta < -2) nextCompact = false;
      else if (delta > 2) nextCompact = true;

      if (nextCompact !== compact && nav) {
        compact = nextCompact;
        nav.dataset.compact = String(compact);
      }

      // A coarser decision — it leaves entirely — so it keeps a dead band, or a
      // 2px tremor at the top of a flick would flap it.
      if (action && Math.abs(delta) > 6) {
        const nextHidden = delta > 0 && y > 60;
        if (nextHidden !== hidden) {
          hidden = nextHidden;
          action.dataset.hidden = String(hidden);
        }
      }

      if (Math.abs(delta) > 2) lastY = y;
    };

    paint();
    window.addEventListener("scroll", paint, { passive: true });
    return () => window.removeEventListener("scroll", paint);
  }, [navRef, actionRef]);
}
