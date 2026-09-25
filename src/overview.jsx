import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MagnifyingGlass, Plus, SpinnerGap, X } from "@phosphor-icons/react";
import { api } from "./api.js";
import { GalleryItem } from "./item-editor.jsx";
import { PageStatus } from "./components/PageStatus.jsx";
import { buildOverviewIndex, buildOverviewSections, commonOverviewTags, filterOverviewIndex, overviewSuggestions } from "../shared/overview-index.mjs";
import "./overview.css";

function TagEditor({ selected, tags, suggestions, inputRef, inputId, listId, disabled, saving, error, status, value, onValue, onSubmit, onRemove }) {
  const selectedCount = selected.length;
  return (
    <div className="overview-selection__body">
      <div className="overview-selection__summary">
        <strong>{selectedCount} selected</strong>
        <span>{tags.length} {tags.length === 1 ? "tag" : "tags"} in common</span>
      </div>
      <div className="overview-tag-list" aria-label="Tags common to all selected pieces">
        {tags.length ? tags.map(({ tag, key }) => (
          <div className="overview-tag-row" key={key}>
            <span className="overview-tag-row__name">{tag}</span>
            <button type="button" className="overview-tag-row__remove" onClick={() => onRemove(tag)} disabled={disabled} aria-label={`Remove ${tag} from all selected pieces`}>
              Remove from all
            </button>
          </div>
        )) : <p className="overview-tag-list__empty">No tags in common.</p>}
      </div>
      <form className="overview-tag-form" onSubmit={onSubmit}>
        <label htmlFor={inputId}>Add a tag to all selected</label>
        <div className="overview-tag-form__controls">
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={value}
            onChange={(event) => onValue(event.target.value)}
            list={listId}
            maxLength={40}
            placeholder="e.g. linen, work, summer"
            disabled={disabled}
            autoComplete="off"
          />
          <datalist id={listId}>{suggestions.map(({ tag }) => <option key={tag} value={tag} />)}</datalist>
          <button type="submit" aria-label="Add tag to every selected item" disabled={disabled || !value.trim()}>
            {saving ? <SpinnerGap size={17} className="overview-spinner" aria-hidden="true" /> : <Plus size={17} weight="bold" aria-hidden="true" />}
            <span>Add</span>
          </button>
        </div>
      </form>
      {error && <p className="overview-selection__error" role="alert">{error}</p>}
      <p className="overview-selection__status" role="status" aria-live="polite">{saving ? "Saving tags…" : status}</p>
    </div>
  );
}

export function Overview({ items, loading = false, error = "", selectedItemId = null, onOpenItem, onItemsUpdated, onSelectionChange }) {
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const mobileToggleRef = useRef(null);
  const mobileInputRef = useRef(null);
  const mobileGesture = useRef(null);
  const suppressToggleClick = useRef(false);

  const index = useMemo(() => buildOverviewIndex(items), [items]);
  const results = useMemo(() => filterOverviewIndex(index, query, facet), [index, query, facet]);
  const sections = useMemo(() => buildOverviewSections(index, query, facet), [index, query, facet]);
  const suggestions = useMemo(() => overviewSuggestions(items), [items]);
  const visibleIds = useMemo(() => new Set(results.map((entry) => entry.id)), [results]);
  const selected = useMemo(() => index.filter((entry) => selectedIds.has(entry.id)), [index, selectedIds]);
  const hiddenSelectedCount = selected.filter((entry) => !visibleIds.has(entry.id)).length;
  const selectedTags = useMemo(() => commonOverviewTags(selected), [selected]);
  const activeFilter = facet ? `${facet.label} · ${facet.itemIds?.length ?? ""}` : "";

  useEffect(() => {
    setSelectedIds((current) => {
      const available = new Set(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  useEffect(() => {
    onSelectionChange?.(selectedIds.size);
  }, [selectedIds.size, onSelectionChange]);

  useEffect(() => {
    if (selectedIds.size === 0) setMobileExpanded(false);
  }, [selectedIds.size]);

  useEffect(() => {
    if (!mobileExpanded) return undefined;
    mobileInputRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileExpanded(false);
      requestAnimationFrame(() => mobileToggleRef.current?.focus());
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileExpanded]);

  const toggleFacet = (evidence) => {
    setFacet((current) => current?.subtype === evidence.subtype
      && current?.featureKind === evidence.featureKind
      && current?.featureValue === evidence.featureValue
      ? null
      : evidence);
  };

  const addSelection = (entries) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      entries.forEach((entry) => next.add(entry.id));
      return next;
    });
  };

  const applyTagOperation = async ({ addTags = [], removeTags = [] }) => {
    if (saving || !selectedIds.size) return;
    setSaving(true);
    setSaveError("");
    setSaveStatus("");
    try {
      const result = await api("/api/wardrobe/items/bulk-tags", {
        method: "PATCH",
        body: JSON.stringify({ itemIds: [...selectedIds], addTags, removeTags }),
      });
      onItemsUpdated(result.items);
      setSaveStatus(`Updated tags on ${result.items.length} selected ${result.items.length === 1 ? "piece" : "pieces"}.`);
      if (addTags.length) setTagDraft("");
    } catch (requestError) {
      setSaveError(requestError.message || "Could not update tags. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const submitTag = (event) => {
    event.preventDefault();
    const tag = tagDraft.trim().toLocaleLowerCase("en");
    if (!tag) return;
    void applyTagOperation({ addTags: [tag] });
  };

  const selectAllResults = () => addSelection(results);
  const selectSection = (section) => addSelection(section.entries);
  const selectedCount = selectedIds.size;

  const panel = (mobile = false) => (
    <TagEditor
      selected={selected}
      tags={selectedTags}
      suggestions={suggestions}
      inputRef={mobile ? mobileInputRef : undefined}
      inputId={mobile ? "overview-mobile-tag" : "overview-desktop-tag"}
      listId={mobile ? "overview-mobile-tag-suggestions" : "overview-desktop-tag-suggestions"}
      disabled={saving}
      saving={saving}
      error={saveError}
      status={saveStatus}
      value={tagDraft}
      onValue={setTagDraft}
      onSubmit={submitTag}
      onRemove={(tag) => void applyTagOperation({ removeTags: [tag.toLocaleLowerCase("en")] })}
    />
  );

  let cardIndex = 0;
  return (
    <main className="overview-page">
      <header className="overview-header">
        <h1 className="overview-title">Overview</h1>
        <div className="overview-search" role="search">
          <MagnifyingGlass size={19} weight="regular" aria-hidden="true" />
          <label className="sr-only" htmlFor="overview-search-input">Search your wardrobe</label>
          <input
            id="overview-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by garment, color, fabric…"
            autoComplete="off"
            spellCheck="false"
          />
          {query && <button type="button" className="overview-search__clear" aria-label="Clear search" onClick={() => setQuery("")}><X size={17} aria-hidden="true" /></button>}
        </div>
        <div className="overview-result-row">
          <div className="overview-result-row__count" aria-live="polite" aria-atomic="true">
            <strong>{results.length}</strong> {results.length === 1 ? "piece" : "pieces"}
          </div>
          <div className="overview-result-row__actions">
            <button type="button" onClick={selectAllResults} disabled={!results.length}>Select results</button>
            {selectedCount > 0 && <button type="button" onClick={() => setSelectedIds(new Set())}>Clear selection <span>{selectedCount}</span></button>}
          </div>
        </div>
        {facet && (
          <div className="overview-active-filter">
            <span>Filtered by</span>
            <strong>{activeFilter.split(" · ")[0]}</strong>
            <button type="button" aria-label="Remove evidence filter" onClick={() => setFacet(null)}><X size={14} aria-hidden="true" /></button>
          </div>
        )}
        {hiddenSelectedCount > 0 && <p className="overview-hidden-selection" aria-live="polite">{hiddenSelectedCount} selected {hiddenSelectedCount === 1 ? "piece is" : "pieces are"} hidden by current filters.</p>}
      </header>

      <div className="overview-layout">
        <div className="overview-main">
          <PageStatus loading={loading} error={error} empty={!items.length} emptyMessage="Your active wardrobe is empty." noun="wardrobe" />
          {items.length > 0 && results.length === 0 && (
            <div className="overview-no-results">
              <p>No pieces match your search.</p>
              {(query || facet) && <button type="button" onClick={() => { setQuery(""); setFacet(null); }}>Clear search and filters</button>}
            </div>
          )}

          {sections.map((section) => (
            <section className="overview-section" key={section.id} aria-labelledby={`overview-section-${section.id}`}>
              <header className="overview-section__header">
                <div className="overview-section__heading">
                  <h2 id={`overview-section-${section.id}`}>{section.label}</h2>
                  <span>{section.count} {section.count === 1 ? "piece" : "pieces"}</span>
                </div>
                <button type="button" className="overview-section__select" onClick={() => selectSection(section)}>
                  Select area
                </button>
              </header>
              {section.evidence.length > 0 && (
                <div className="overview-evidence" aria-label={`${section.label} highlights`}>
                  {section.evidence.map((evidence) => {
                    const active = facet?.subtype === evidence.subtype && facet?.featureKind === evidence.featureKind && facet?.featureValue === evidence.featureValue;
                    return (
                      <button
                        type="button"
                        key={`${evidence.subtype}:${evidence.featureKind || "all"}:${evidence.featureValue || ""}`}
                        className={active ? "is-active" : ""}
                        onClick={() => toggleFacet(evidence)}
                        aria-pressed={active}
                      >
                        <span>{evidence.count}</span> {evidence.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="overview-grid" aria-label={`${section.label} items`}>
                {section.entries.map((entry) => {
                  const item = entry.item;
                  const indexForCard = cardIndex++;
                  const checked = selectedIds.has(item.id);
                  return (
                    <article className={`overview-card${checked ? " is-checked" : ""}`} key={item.id}>
                      <label className="overview-card__select">
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`Select ${item.name || entry.subtype.label}`}
                          onChange={(event) => setSelectedIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(item.id); else next.delete(item.id);
                            return next;
                          })}
                        />
                        <span className="overview-card__check" aria-hidden="true"><Check size={13} weight="bold" /></span>
                      </label>
                      <GalleryItem
                        item={item}
                        index={indexForCard}
                        selected={selectedItemId === item.id}
                        onOpen={onOpenItem}
                      />
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        {selectedCount > 0 && (
          <aside className="overview-selection overview-selection--desktop" aria-label="Manage selected item tags">
            <div className="overview-selection__header">
              <div><span className="overview-selection__eyebrow">Selection</span><h2>Manage tags</h2></div>
              <button type="button" aria-label="Clear selection" onClick={() => setSelectedIds(new Set())}><X size={17} aria-hidden="true" /></button>
            </div>
            {hiddenSelectedCount > 0 && <p className="overview-selection__hidden">{hiddenSelectedCount} selected {hiddenSelectedCount === 1 ? "piece is" : "pieces are"} hidden by filters.</p>}
            {panel()}
          </aside>
        )}
      </div>

      {selectedCount > 0 && (
        <section className={`overview-drawer${mobileExpanded ? " is-expanded" : ""}`} aria-label="Manage selected item tags">
          <button
            ref={mobileToggleRef}
            type="button"
            className="overview-drawer__toggle"
            aria-expanded={mobileExpanded}
            aria-controls="overview-mobile-panel"
            aria-label={mobileExpanded ? "Collapse tag manager" : `${selectedCount} selected. Expand tag manager`}
            onClick={() => {
              if (suppressToggleClick.current) {
                suppressToggleClick.current = false;
                return;
              }
              setMobileExpanded((current) => !current);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 && event.pointerType === "mouse") return;
              mobileGesture.current = { pointerId: event.pointerId, startY: event.clientY, moved: false };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              const gesture = mobileGesture.current;
              if (!gesture || gesture.pointerId !== event.pointerId) return;
              const delta = event.clientY - gesture.startY;
              if (!gesture.moved && Math.abs(delta) < 6) return;
              gesture.moved = true;
              event.currentTarget.closest(".overview-drawer")?.style.setProperty("--overview-drag-y", `${delta}px`);
            }}
            onPointerUp={(event) => {
              const gesture = mobileGesture.current;
              mobileGesture.current = null;
              const drawer = event.currentTarget.closest(".overview-drawer");
              if (drawer) drawer.style.removeProperty("--overview-drag-y");
              if (!gesture || gesture.pointerId !== event.pointerId || !gesture.moved) return;
              suppressToggleClick.current = true;
              const delta = event.clientY - gesture.startY;
              if (delta < -28) setMobileExpanded(true);
              if (delta > 28) setMobileExpanded(false);
              window.setTimeout(() => { suppressToggleClick.current = false; }, 0);
            }}
            onPointerCancel={(event) => {
              mobileGesture.current = null;
              event.currentTarget.closest(".overview-drawer")?.style.removeProperty("--overview-drag-y");
            }}
          >
            {mobileExpanded ? <span className="overview-drawer__grab" aria-hidden="true" /> : <span>{selectedCount} selected</span>}
          </button>
          <div id="overview-mobile-panel" className="overview-drawer__panel" hidden={!mobileExpanded}>
              <div className="overview-selection__header">
                <div><span className="overview-selection__eyebrow">Selection</span><h2>Manage tags</h2></div>
                <button type="button" aria-label="Collapse selection panel" onClick={() => { setMobileExpanded(false); requestAnimationFrame(() => mobileToggleRef.current?.focus()); }}><X size={17} aria-hidden="true" /></button>
              </div>
              {hiddenSelectedCount > 0 && <p className="overview-selection__hidden">{hiddenSelectedCount} selected {hiddenSelectedCount === 1 ? "piece is" : "pieces are"} hidden by filters.</p>}
              {panel(true)}
          </div>
        </section>
      )}
    </main>
  );
}
