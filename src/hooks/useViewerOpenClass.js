import { useEffect } from "react";

/**
 * Holds `viewer-open` on <body> while a panel is mounted.
 *
 * That class does two jobs: it locks background scroll, and on a phone it
 * scales the page back behind the sheet (see mobile-chrome.css). It used to
 * live inside useViewerKeyboard, which meant a panel got the sheet treatment
 * only if it also happened to want Escape handling — so DeclutterPanel and
 * Onboarding, both real panels, silently rendered over an unscaled page.
 *
 * Counted rather than a plain add/remove: a popover can sit over a panel, and
 * whichever unmounts first must not strip the class from the one still open.
 */
let openCount = 0;

export function useViewerOpenClass(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    openCount += 1;
    document.body.classList.add("viewer-open");
    return () => {
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) document.body.classList.remove("viewer-open");
    };
  }, [active]);
}
