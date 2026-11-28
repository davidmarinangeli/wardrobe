import { Gear } from "@phosphor-icons/react";

/**
 * The head of every top-level view, at both widths.
 *
 * Variant A ("the tabs are the title"): the top nav (desktop) and the bottom
 * nav (phone) already say which page this is, so the page name is the h1 for
 * the outline only. What shows is the page's own navigation: Overview's and
 * Inspo's section tabs, each with its count. A page with no sections
 * (Wardrobe) shows nothing here; its count and filters open the page instead
 * (see PageShell), and on a phone the gear floats beside them.
 *
 * title       string – The page name, for the h1 (visually hidden).
 * nav         node   – The page's section tabs (PageTabs), or nothing.
 * onSettings  fn     – Opens Settings (phone only; desktop has the top-bar gear).
 * badge       node   – The Gemini mode badge for the gear.
 */
export function PageHeader({ title, nav, onSettings, badge }) {
  return (
    <div className={`page-head${nav ? " has-nav" : ""}`}>
      <h1 className="sr-only">{title}</h1>
      {nav && <div className="page-head__nav">{nav}</div>}
      <button
        type="button"
        className="icon-button icon-button--outlined page-head__settings"
        onClick={onSettings}
        aria-label="Open settings"
      >
        <Gear size={19} aria-hidden="true" />
        {badge}
      </button>
    </div>
  );
}
