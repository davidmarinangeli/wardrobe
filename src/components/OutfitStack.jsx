import { useMemo } from "react";
import { OptimizedImage } from "../OptimizedImage.jsx";
import "../outfits.css";

// Groups garments into worn-order zones (top of the body first) so a picked
// tee and a picked jacket read as layered rather than as an unordered pile.
// A full-coverage garment spans the top and bottom zones, so it sits in the top
// one — leaving it out of every zone would silently drop a dress from the very
// picture of the outfit it anchors.
const STACK_ZONES = [
  { id: "top", parts: ["accessories_up", "upperbody", "bodysuit", "wholebody_up", "dress", "jumpsuit"] },
  { id: "bottom", parts: ["lowerbody", "skirt", "shorts"] },
  { id: "feet", parts: ["socks", "shoes"] },
];

/**
 * The flat-lay of an outfit's pieces, laid out in worn order.
 *
 * Lives here rather than in outfits.jsx because both the outfit builder and the
 * suggestion deck draw it, and suggestions.jsx is imported *by* outfits.jsx —
 * keeping it there would make the two files import each other.
 *
 * Props
 * ─────
 * items    array – Garments, each with { id, part, thumbnail|image }.
 * compact  bool  – Smaller cells, for dense contexts like the builder preview.
 * emptyMessage string|null – Shown when there is nothing to lay out. Pass null
 *                           for callers that guarantee a non-empty outfit.
 */
export function OutfitStack({ items, compact = false, emptyMessage = "Add pieces below to build the look." }) {
  const byPart = useMemo(() => {
    const groups = {};
    for (const item of items) (groups[item.part] ||= []).push(item);
    return groups;
  }, [items]);

  return (
    <div className={`outfit-stack${compact ? " compact" : ""}`}>
      {STACK_ZONES.map((zone) => {
        const zoneItems = zone.parts.flatMap((part) => byPart[part] || []);
        if (!zoneItems.length) return null;
        return (
          <div className="outfit-stack-zone" key={zone.id}>
            {zoneItems.map((item, index) => (
              <div
                key={item.id}
                className="outfit-stack-item"
                style={{ transform: `translateX(${index * 12}px) rotate(${index ? (index * 4) - 2 : 0}deg)`, zIndex: index + 1 }}
              >
                <OptimizedImage src={item.thumbnail || item.image} alt="" sizes={compact ? "70px" : "96px"} breakpoints={[70, 96, 140]} />
              </div>
            ))}
          </div>
        );
      })}
      {!items.length && emptyMessage && <p className="status empty">{emptyMessage}</p>}
    </div>
  );
}
