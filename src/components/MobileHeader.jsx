import { Gear } from "@phosphor-icons/react";

/**
 * The head of every top-level view, at both widths.
 *
 * Variant B ("title + segmented"): one h1 per view naming what you are looking
 * at (Wardrobe; on Overview the open section, "Outfits"; Inspo), its count in
 * muted figures beside it, and, where the page has sections, a segmented
 * control next to the title: the same component as the main nav, in small.
 * The section's actions sit at the right end of the same row on desktop (see
 * overview.css). On a phone the gear closes the title row and the segmented
 * control takes the full width below it.
 *
 * title       string – The h1.
 * count       number – Shown beside the title; null/undefined while unknown.
 * nav         node   – The page's segmented control (PageTabs), or nothing.
 * titles      array  – Every title this head can show (Overview's three section
 *                      names). The title keeps the width of the longest, so the
 *                      segmented control beside it does not move under the
 *                      pointer when a section is chosen.
 * onSettings  fn     – Opens Settings (phone only; desktop has the top-bar gear).
 * badge       node   – The Gemini mode badge for the gear.
 */
export function PageHeader({ title, count, nav, titles, onSettings, badge }) {
  return (
    <div className={`page-head${nav ? " has-nav" : ""}`}>
      <h1 className="page-head__title">
        <span className="page-head__label">
          <span>{title}</span>
          {titles?.filter((entry) => entry !== title).map((entry) => (
            <span key={entry} className="page-head__ghost" aria-hidden="true">{entry}</span>
          ))}
        </span>
        {count != null && <span className="page-head__count">{count}</span>}
      </h1>
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
