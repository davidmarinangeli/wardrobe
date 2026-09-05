import { Fragment } from "react";

/**
 * Standard page layout shell shared by every top-level view
 * (Wardrobe, Outfits, Inspo, Wishlist).
 *
 * Renders:
 *   <main.gallery-pane>
 *     <header.gallery-header>
 *       <div.gallery-meta-row>   count label  |  actions slot
 *       <nav.category-nav>       filter pills
 *     </header>
 *     {children}   — grid / content area
 *   </main>
 *
 * Props
 * ─────
 * count           number – Item count shown in the top-left label.
 * noun            string – Singular noun (e.g. "piece", "outfit", "pin").
 * nounPlural      string – Plural override. Defaults to noun + "s".
 * actions         node   – CTAs rendered in the top-right of the meta row.
 * categories      array  – [{ id, label }] for the filter nav. Omit to hide nav. An entry
 *                           may carry `dividerBefore: true` to open a new group of pills.
 * activeCategory  string – Currently active category id.
 * onCategory      fn     – Called with (id) when a pill is clicked.
 * renderCategory  fn     – Optional: (cat) => node, for pills that need a custom label (e.g. counts).
 * navLabel        string – aria-label on the <nav>. Defaults to "Filter by category".
 * navExtra        node   – Extra content appended after the category pills (e.g. a standalone toggle
 *                           that doesn't fit the single-select activeCategory/onCategory contract).
 * children        node   – The grid or content area below the header.
 */
export function PageShell({
  count,
  noun,
  nounPlural,
  actions,
  categories,
  activeCategory,
  onCategory,
  renderCategory,
  navLabel = "Filter by category",
  navExtra,
  children,
}) {
  const plural = nounPlural ?? `${noun}s`;
  const countLabel = `${count} ${count === 1 ? noun : plural}`;

  return (
    <main className="gallery-pane">
      <header className="gallery-header">
        <div className="gallery-meta-row">
          <p className="piece-count">{countLabel}</p>
          {actions}
        </div>

        {categories && (
          <nav className="category-nav" aria-label={navLabel}>
            {categories.map((cat) => {
              if (!cat) return null;
              return (
                <Fragment key={cat.id}>
                  {/* A category can open a new group (Inspo's sources vs. the
                      pieces detected out of them). The rule is decoration for
                      a split the pills already carry, so it stays out of the
                      accessibility tree. */}
                  {cat.dividerBefore && <span className="category-nav__divider" aria-hidden="true" />}
                  <button
                    type="button"
                    className={activeCategory === cat.id ? "active" : ""}
                    onClick={() => onCategory(cat.id)}
                    aria-pressed={activeCategory === cat.id}
                  >
                    {renderCategory ? renderCategory(cat) : cat.label}
                  </button>
                </Fragment>
              );
            })}
            {navExtra}
          </nav>
        )}
      </header>

      {children}
    </main>
  );
}
