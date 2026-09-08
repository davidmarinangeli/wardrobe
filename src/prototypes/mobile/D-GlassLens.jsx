import { useLayoutEffect, useRef, useState } from "react";
import { LiquidGlass } from "liquid-glass-web-react";
import { useWardrobe, ProtoGrid } from "../transitions/shared.jsx";
import { ProtoHeader, ProtoNav, ProtoActionBar, useChromeScroll } from "./shared.jsx";

/**
 * Real refraction under the nav, via liquid-glass-web-react.
 *
 * Why this variant exists at all: `backdrop-filter` has no function that
 * displaces pixels, so no amount of CSS produces refraction — the other
 * variants are frosted glass, which is a different material. Actual Liquid
 * Glass needs an SVG feDisplacementMap, and that is what this library builds.
 *
 * The architectural catch, and the reason this is a variant rather than a
 * patch: `<LiquidGlass>` is a lens over *its own children*, not a backdrop
 * filter over whatever happens to be behind it. To refract the wardrobe grid,
 * the grid has to be inside it — so the lens wraps the scroller, and the nav
 * renders on top with no background of its own, the glass being supplied
 * underneath rather than by the bar.
 *
 * Two consequences worth knowing before this goes app-wide:
 *   · The page can no longer scroll on `window`. The lens is positioned in
 *     fractions of its container, so the container must be the fixed-size
 *     thing and the scrolling must happen inside it, or the lens drifts up the
 *     screen as you scroll.
 *   · The chrome stops owning its own material. Anything that wants glass has
 *     to be a lens region of a common container, which is a real constraint on
 *     how the shell is composed — on desktop as much as here.
 */
export function GlassLensVariant() {
  const items = useWardrobe(14);
  const [view, setView] = useState("wardrobe");
  const navRef = useRef(null);
  const hostRef = useRef(null);
  const actionRef = useRef(null);
  const [lens, setLens] = useState(null);
  useChromeScroll(navRef, actionRef);

  // The lens is described in px for its size and in fractions of the container
  // for its centre, so it has to be measured from the nav's real box rather
  // than guessed — the nav is inset 12px and safe-area aware, and neither is
  // known here.
  useLayoutEffect(() => {
    const measure = () => {
      const nav = navRef.current;
      const host = hostRef.current;
      if (!nav || !host) return;
      const n = nav.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      setLens({
        width: Math.round(n.width),
        height: Math.round(n.height),
        x: (n.left + n.width / 2 - h.left) / h.width,
        y: (n.top + n.height / 2 - h.top) / h.height,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const content = (
    <div className="proto-lens-scroller">
      <ProtoHeader title="Wardrobe" subtitle="Real refraction — scroll a garment under the bar" onSettings={() => {}} />
      <ProtoGrid items={items} onOpen={() => {}} />
    </div>
  );

  return (
    <div className="proto-mobile proto-mobile--lens" ref={hostRef}>
      {lens ? (
        <LiquidGlass
          width={lens.width}
          height={lens.height}
          x={lens.x}
          y={lens.y}
          radius="auto"
          // Restrained on purpose. This is chrome that sits under the thumb all
          // day, not a hero moment: enough displacement to read as a material,
          // not enough to make the garment behind it unrecognisable.
          strength={0.09}
          chromaticAberration={0.05}
          blur={3}
          depth={14}
          curvature={0.7}
          glow={0.35}
          edgeHighlight={0.6}
          specular={0.9}
          shadow={false}
        >
          {content}
        </LiquidGlass>
      ) : content}

      <ProtoActionBar view={view} barRef={actionRef} onAction={() => {}} />
      {/* data-lens strips the bar's own ::before material: the glass is the
          lens underneath it now, and stacking a second translucent layer on
          top of it would only muddy what the refraction is doing. */}
      <ProtoNav active={view} onSelect={setView} navRef={navRef} lens />
    </div>
  );
}
