/**
 * Section tabs for a top-level page (Overview: Outfits / Cheat sheets / Pieces;
 * Inspo: Pieces / Sources). One component so every page's sections look and
 * behave the same.
 *
 * Automatic activation: arrows, Home and End select the tab they land on.
 *
 * idPrefix  string – Tab ids are `${idPrefix}-tab-${id}`; the panel is `${idPrefix}-panel`.
 * label     string – aria-label of the tablist.
 * tabs      array  – [{ id, label, count }]. A count of null/undefined is not shown.
 * active    string – The selected tab id.
 * onChange  fn     – Called with the id of the tab to select.
 * controls  bool   – Whether `${idPrefix}-panel` exists to point aria-controls at.
 */
export function PageTabs({ idPrefix, label, tabs, active, onChange, controls = false }) {
  const handleKeyDown = (event) => {
    const current = tabs.findIndex(({ id }) => id === active);
    let next;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const { id } = tabs[next];
    onChange(id);
    document.getElementById(`${idPrefix}-tab-${id}`)?.focus();
  };

  return (
    <div className="page-tabs" role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
      {tabs.map(({ id, label: tabLabel, count }) => {
        const selected = id === active;
        return (
          <button
            key={id}
            id={`${idPrefix}-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={controls ? `${idPrefix}-panel` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
          >
            {tabLabel}
            {count != null && <span className="page-tabs__count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
