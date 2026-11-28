/**
 * Standard page layout shell shared by the grid views (Wardrobe, Inspo).
 *
 * Renders:
 *   <main.gallery-pane>
 *     <header.gallery-header>
 *       <div.gallery-meta-row>   count label · filter pills   (one row)
 *     </header>
 *     {beforeContent}
 *     {children}   — grid / content area
 *   </main>
 *
 * The page name is not repeated here: PageHeader owns the h1 and any section
 * tabs (see MobileHeader.jsx).
 *
 * Props
 * ─────
 * count           number – Item count shown before the filters. Omit when the page's
 *                           section tabs already carry it (Inspo).
 * noun            string – Singular noun (e.g. "piece").
 * nounPlural      string – Plural override. Defaults to noun + "s".
 * categories      array  – [{ id, label }] for the filter nav. Omit to hide nav.
 * activeCategory  string – Currently active category id.
 * onCategory      fn     – Called with (id) when a pill is clicked.
 * renderCategory  fn     – Optional: (cat) => node, for pills that need a custom label.
 * navLabel        string – aria-label on the <nav>. Defaults to "Filter by category".
 * navExtra        node   – Extra content appended after the category pills (e.g. a standalone toggle
 *                           that doesn't fit the single-select activeCategory/onCategory contract).
 * beforeContent   node   – Rendered between the header and the grid. This is where a page puts a
 *                           strip of cards leading somewhere else (see HotCards). Secondary
 *                           features belong here rather than in the nav: BottomNav is three
 *                           destinations by decision, and a feature used a few times a year should
 *                           not hold permanent nav weight.
 * children        node   – The grid or content area below the header.
 */
export function PageShell({
  count,
  noun,
  nounPlural,
  categories,
  activeCategory,
  onCategory,
  renderCategory,
  navLabel = "Filter by category",
  navExtra,
  beforeContent,
  children,
}) {
  const plural = nounPlural ?? `${noun}s`;
  const countLabel = count == null ? null : `${count} ${count === 1 ? noun : plural}`;

  return (
    <main className="gallery-pane">
      {(countLabel || categories) && (
        <header className="gallery-header">
          <div className="gallery-meta-row">
            {countLabel && <p className="piece-count">{countLabel}</p>}

            {categories && (
              <nav className="category-nav" aria-label={navLabel}>
                {categories.map((cat) => cat && (
                  <button
                    key={cat.id}
                    type="button"
                    className={activeCategory === cat.id ? "active" : ""}
                    onClick={() => onCategory(cat.id)}
                    aria-pressed={activeCategory === cat.id}
                  >
                    {renderCategory ? renderCategory(cat) : cat.label}
                  </button>
                ))}
                {navExtra}
              </nav>
            )}
          </div>
        </header>
      )}

      {beforeContent}

      {children}
    </main>
  );
}
