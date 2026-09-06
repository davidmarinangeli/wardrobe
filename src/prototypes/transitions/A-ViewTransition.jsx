import { flushSync } from "react-dom";
import { useCallback, useState } from "react";
import { ProtoGrid, ProtoViewer, useWardrobe } from "./shared.jsx";

/**
 * A — Native View Transitions.
 *
 * The browser owns the morph. Both images claim the same `view-transition-name`
 * (only ever one at a time, or the API throws), the state change is wrapped in
 * startViewTransition, and the engine snapshots both ends and tweens between
 * them off the main thread.
 *
 * Cheapest by a mile: no measuring, no cloning, no cleanup. The costs are that
 * it is all-or-nothing per browser, the tween is a cross-fade of two snapshots
 * rather than one element genuinely moving (visible when the two crops differ),
 * and it cannot be interrupted or reversed mid-flight — which is the standard
 * this repo is otherwise held to.
 */
const NAME = "garment-hero";

export function ViewTransitionVariant() {
  const items = useWardrobe();
  const [active, setActive] = useState(null);

  const transition = useCallback((update) => {
    if (!document.startViewTransition) { update(); return; }
    document.startViewTransition(() => flushSync(update));
  }, []);

  return (
    <div className="proto-transition-stage">
      <ProtoGrid
        items={items}
        onOpen={(item) => transition(() => setActive(item))}
        cardProps={(item) => ({
          style: {
            "--stagger-index": 0,
            // Only the card being opened may carry the name — two elements
            // sharing one is a runtime error, not a degraded transition.
            viewTransitionName: active?.id === item.id ? NAME : "none",
          },
        })}
      />
      <ProtoViewer
        item={active}
        onClose={() => transition(() => setActive(null))}
        artProps={{ style: { viewTransitionName: NAME } }}
      />
    </div>
  );
}
