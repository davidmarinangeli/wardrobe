import { useEffect, useId, useState } from "react";
import { renderDisplacementMap } from "liquid-glass-web-react";

/**
 * Real refraction on a *backdrop*, cheaply.
 *
 * The difference between this and the lens component the same library ships is
 * area, and area is the whole performance story.
 *
 * `<LiquidGlass>` filters its own children, so refracting the page behind a nav
 * bar meant putting the entire scrolling page inside the lens — the filter then
 * ran over a full 375x812 viewport on every scrolled frame. Here the filter is
 * a `backdrop-filter` on the bar itself, so it only ever touches the ~351x58
 * strip the bar covers: roughly a nintieth of the pixels, and it does not care
 * how much content scrolls past underneath.
 *
 * The other half is that the displacement map is generated once and reused. It
 * only depends on the bar's shape, so scrolling never regenerates it; the
 * expensive thing in the earlier attempt was a blur radius that *changed* every
 * frame, which can never be cached.
 *
 * Support: `backdrop-filter: url()` is Chromium-only. Safari and Firefox get
 * the blur and skip the displacement, which is a graceful degradation rather
 * than a broken surface — the bar is still frosted, just not refracting.
 *
 * @param {{width: number, height: number}|null} size  The surface's box in CSS px.
 * @param {object} [options]
 * @returns {{filterId: string|null, svg: object|null}} `svg` is the <svg> props
 *   and children to render; `filterId` goes in the CSS `backdrop-filter`.
 */
export function useGlassRefraction(size, options = {}) {
  const {
    depth = 11,
    strength = 16,
    curvature = 0.75,
    splay = 0.55,
    glow = 0.28,
    edgeHighlight = 0.75,
    edgeWidth = 5,
    specularAngle = 135,
    quality = 256,
  } = options;

  const id = `glass-${useId().replace(/[:]/g, "")}`;
  const [mapUrl, setMapUrl] = useState(null);

  // Exact box for the filter region; rounded box for the map, so small size
  // changes during a transition reuse the map instead of rebuilding it.
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const mapWidth = size?.mapWidth ?? width;
  const mapHeight = size?.mapHeight ?? height;

  useEffect(() => {
    if (!mapWidth || !mapHeight) return;
    // Pure computation, no DOM: safe to run in an effect and cache by shape.
    setMapUrl(renderDisplacementMap({
      size: quality,
      halfWidth: mapWidth / 2,
      halfHeight: mapHeight / 2,
      // A pill: the corner radius is simply half the short side.
      radius: Math.min(mapWidth, mapHeight) / 2,
      depth,
      domeDepth: depth * curvature,
      splay,
      glow,
      glowSpread: 0.5,
      glowExponent: 2,
      edgeHighlight,
      edgeWidth,
      edgeExponent: 2,
      specularAngle,
    }));
  }, [mapWidth, mapHeight, depth, curvature, splay, glow, edgeHighlight, edgeWidth, specularAngle, quality]);

  if (!mapUrl || !width || !height) return { filterId: null, svg: null };

  return {
    filterId: id,
    svg: {
      id,
      width,
      height,
      mapUrl,
      // How far a pixel is pushed at the rim. The map's red/green channels are
      // offsets around a neutral 128, so this is the multiplier on that.
      scale: strength,
    },
  };
}
