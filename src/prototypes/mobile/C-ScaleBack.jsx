import { useState } from "react";
import { useWardrobe, ProtoGrid } from "../transitions/shared.jsx";
import { ProtoHeader, ProtoNav, ProtoSheet, useReadout } from "./shared.jsx";

/**
 * The page receding as the sheet rises — and the trap that comes with it.
 *
 * This is the single biggest "premium" move available, and also the one most
 * likely to break something silently, so it gets its own variant rather than
 * being folded into A.
 *
 * The trap: `transform` on an element makes it a containing block for every
 * `position: fixed` descendant. Those descendants stop being fixed to the
 * viewport and start being fixed to the transformed box — so they scale, drift
 * and clip along with it, with no error anywhere. styles.css documents this
 * exact failure above .app-top-bar, where it forced the blur onto a
 * pseudo-element. Scaling .app-shell would walk straight back into it, because
 * the bottom nav and both top-bar popovers are fixed descendants of the shell.
 *
 * So the variant ships both wirings and lets you switch between them:
 *
 *  · "shell"   — the naive version. The nav is inside the scaled box. Open the
 *                sheet and watch the nav shrink and lift away from the bottom
 *                edge with the page. This is the bug, on purpose.
 *  · "wrapper" — the fix. Only the scrolling page sits inside .proto-stage; the
 *                nav is a sibling. The page recedes, the nav stays welded to
 *                the bottom edge where a thumb expects it.
 *
 * If "wrapper" feels right on a phone, the port is: wrap the view branch in
 * App.jsx in a .app-shell__page div and scale that, never .app-shell itself.
 */
export function ScaleBackVariant() {
  const items = useWardrobe(8);
  const [open, setOpen] = useState(null);
  const [view, setView] = useState("wardrobe");
  const [wiring, setWiring] = useState("wrapper");
  const { onDrag, readout } = useReadout();

  const receded = open ? "true" : "false";

  const page = (
    <>
      <ProtoHeader
        title="Wardrobe"
        subtitle={(
          <button type="button" className="proto-toggle" onClick={() => setWiring((current) => (current === "shell" ? "wrapper" : "shell"))}>
            {wiring === "shell" ? "Scaling shell (broken) ⇄" : "Scaling wrapper ⇄"}
          </button>
        )}
      />
      <ProtoGrid items={items} onOpen={(item) => setOpen(item)} />
    </>
  );

  const nav = <ProtoNav active={view} onSelect={setView} />;

  return (
    <>
      {wiring === "shell" ? (
        // Nav inside the scaled box — the containing-block trap, demonstrated.
        <div className="proto-mobile proto-stage" data-receded={receded}>
          {page}
          {nav}
        </div>
      ) : (
        <div className="proto-mobile">
          <div className="proto-stage" data-receded={receded}>{page}</div>
          {nav}
        </div>
      )}

      <ProtoSheet item={open} onClose={() => setOpen(null)} onDrag={onDrag} />
      {readout}
    </>
  );
}
