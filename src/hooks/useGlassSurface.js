import { useLayoutEffect, useRef, useState } from "react";
import { useGlassRefraction } from "./useGlassRefraction.js";

// Only the *map generation* is quantised, never the filter region.
//
// The bar changes size when it compacts, and regenerating a displacement map on
// every frame of that transition is the expensive part, so the generator is fed
// a rounded size and its result is reused across small changes.
//
// The filter region and the feImage placement must stay exact. Rounding those
// down leaves a strip on the right and bottom the filter never covers; rounding
// them up is worse, because the map is a rounded-rect lens sized to the region,
// so an oversized region puts the lens rim outside the element and the element's
// own right edge samples the map's neutral surround — unglassed either way, for
// opposite reasons. The map is stretched to the exact box instead
// (preserveAspectRatio="none"), which costs a sub-pixel of aspect error and
// nothing else.
const QUANTUM = 8;
const quantize = (n) => Math.max(QUANTUM, Math.round(n / QUANTUM) * QUANTUM);

/**
 * Refracting glass for any floating surface, measured automatically.
 *
 * Attach `ref` to the element and spread `style` onto it; render `filter`
 * somewhere in the tree. The surface then refracts whatever passes behind it.
 *
 * When it is worth using — the cost is `backdrop-filter` re-sampling the region
 * behind the element on every frame that region changes, so:
 *
 *   · Small floating chrome that content scrolls under: yes. A nav bar, a
 *     toolbar, a floating action pill. Tens of thousands of pixels.
 *   · Large surfaces — sheets, viewer panels, full-screen overlays: no. Cost
 *     scales with area, and a sheet covering the viewport costs what the failed
 *     lens attempt cost. Those keep a solid material.
 *   · Anything over a static or empty background: pointless. Refraction needs
 *     something behind it to bend, or it is an expensive no-op.
 *   · Anything with `position: fixed` descendants: no. A backdrop-filter makes
 *     its element a containing block and would break them — this is why
 *     .app-top-bar puts its blur on a pseudo-element instead.
 *
 * @param {object} [options]
 * @param {number} [options.blur=10]  Frost radius in px. Cost grows with the
 *   square of this and again with device pixel ratio; 10 is the ceiling that
 *   held 60fps on a mid-range Android, 29 was not close.
 * @param {boolean} [options.enabled=true]
 */
export function useGlassSurface({ blur = 10, enabled = true, ...options } = {}) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;

    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = {
        // Exact, for the filter region and the feImage box.
        width: Math.round(r.width),
        height: Math.round(r.height),
        // Rounded, for the map the generator has to build.
        mapWidth: quantize(r.width),
        mapHeight: quantize(r.height),
      };
      setBox((current) =>
        current
        && current.width === next.width
        && current.height === next.height
        && current.mapWidth === next.mapWidth
        && current.mapHeight === next.mapHeight
          ? current
          : next);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    // A surface sized by its own text is measured before the webfont arrives,
    // and reflows narrower when it does. ResizeObserver catches that in a tab
    // that is compositing, but its callbacks are delivered before paint and a
    // backgrounded or throttled tab may never deliver them — leaving the filter
    // region a few px wider than the element, which is exactly the case that
    // strands the lens rim outside it and unglasses the right edge.
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) measure(); });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [enabled]);

  const { filterId, svg } = useGlassRefraction(enabled ? box : null, options);

  return {
    ref,
    filterId,
    svg,
    // Safari and Firefox do not support url() in backdrop-filter, so they get
    // the frost and skip the displacement rather than losing the surface.
    style: enabled
      ? {
          backdropFilter: filterId ? `blur(${blur}px) url(#${filterId})` : `blur(${blur}px)`,
          WebkitBackdropFilter: `blur(${blur}px)`,
        }
      : undefined,
  };
}
