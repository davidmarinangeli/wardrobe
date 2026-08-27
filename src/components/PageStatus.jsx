/**
 * Inline loading / error / empty state used inside every page view.
 *
 * Renders at most one <p className="status …"> at a time, in priority order:
 *   error > loading > empty (when no items) > empty-filter (visible items but not when filtered)
 *
 * Props
 * ─────
 * loading         bool   – Show "Loading {noun}…" while fetching.
 * error           string – Show error message (accent colour).
 * empty           bool   – Show emptyMessage when there is genuinely nothing.
 * emptyMessage    string – Text for the truly-empty state.
 * filterEmpty     bool   – Show filterEmptyMessage when a category filter hides everything.
 * filterEmptyMessage string – Text when the filtered view is empty (default "No items in this category.").
 * noun            string – Used in the default loading string (e.g. "inspo", "outfits").
 */
export function PageStatus({
  loading,
  error,
  empty,
  emptyMessage,
  filterEmpty,
  filterEmptyMessage = "No items in this category.",
  noun = "items",
}) {
  if (error) return <p className="status error">{error}</p>;
  if (!error && loading) return <p className="status">Loading {noun}</p>;
  if (!error && !loading && empty) return <p className="status empty">{emptyMessage}</p>;
  if (!error && !loading && filterEmpty) return <p className="status empty">{filterEmptyMessage}</p>;
  return null;
}
