import { useLayoutEffect, useRef, useState } from "react";
import { useWardrobe, ProtoGrid } from "../transitions/shared.jsx";
import { ProtoHeader, ProtoNav, ProtoActionBar, useChromeScroll, FpsMeter } from "./shared.jsx";
import { useGlassRefraction } from "../../hooks/useGlassRefraction.js";
import { GlassFilter } from "../../components/GlassFilter.jsx";

/**
 * Slightly frosted, genuinely refracted, and meant to hold 60fps on a phone.
 *
 * This is the third attempt at the material and the first one with a budget.
 * What went wrong before, in order of cost:
 *
 *   1. The lens variant filtered the whole scrolling page — a 375x812 region —
 *      on every frame. Here the filter is a backdrop-filter on the bar, so it
 *      touches only the strip the bar covers.
 *   2. The blur radius was 29px with a `saturate()` pass behind it. Blur cost
 *      grows with the square of the radius and again with device pixel ratio,
 *      so on a DPR-3.5 phone that was a ~100px kernel. It is 10px here and the
 *      saturate is gone.
 *   3. The compact title bar animated its blur radius per frame, which defeats
 *      any caching the compositor could have done. It animates opacity and
 *      scale now.
 *
 * The displacement map depends only on the bar's shape, so it is generated once
 * and never regenerated while scrolling.
 *
 * Compare against variant 2 (solid, no filters) with the FPS meter visible. If
 * this holds within a few frames of that on the Pixel, the material is
 * affordable and the earlier verdict was about my numbers, not the technique.
 */
export function RefractedVariant() {
  const items = useWardrobe(14);
  const [view, setView] = useState("wardrobe");
  const navRef = useRef(null);
  const actionRef = useRef(null);
  const [box, setBox] = useState(null);
  useChromeScroll(navRef, actionRef);

  // The filter is declared in user space, so it has to match the bar's real box.
  useLayoutEffect(() => {
    const measure = () => {
      const nav = navRef.current;
      if (!nav) return;
      const r = nav.getBoundingClientRect();
      setBox((current) => {
        const next = { width: Math.round(r.width), height: Math.round(r.height) };
        return current && current.width === next.width && current.height === next.height ? current : next;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const { filterId, svg } = useGlassRefraction(box, { depth: 11, strength: 16 });

  return (
    <div className="proto-mobile proto-mobile--refracted">
      <GlassFilter svg={svg} />
      <ProtoHeader title="Wardrobe" subtitle="Frosted + refracted · watch the fps" onSettings={() => {}} refracted />
      <ProtoGrid items={items} onOpen={() => {}} />

      <ProtoActionBar view={view} barRef={actionRef} onAction={() => {}} refracted />
      <ProtoNav
        active={view}
        onSelect={setView}
        navRef={navRef}
        refracted={filterId}
      />
      <FpsMeter />
    </div>
  );
}
