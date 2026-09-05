import { useEffect, useState } from "react";
import { OptimizedImage } from "../../OptimizedImage.jsx";

/**
 * Real wardrobe items, from the same endpoint the app uses. A transition
 * prototype judged on placeholder rectangles is worthless: the whole question
 * is what happens to a garment cutout with transparent edges, an aspect ratio
 * that varies by category, and a decode that may not have finished — and none
 * of those exist in a grey box.
 */
export function useWardrobe(limit = 12) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    fetch("/api/import/wardrobe", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((loaded) => setItems(loaded.slice(0, limit)))
      .catch(() => setItems([]));
  }, [limit]);
  return items;
}

/** The production grid card, reduced to what the transition actually touches. */
export function ProtoGrid({ items, onOpen, cardProps = () => ({}) }) {
  return (
    <section className="gallery-grid proto-grid">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className="gallery-item"
          data-part={item.part}
          style={{ "--stagger-index": Math.min(index, 11) }}
          onClick={(event) => onOpen(item, event.currentTarget)}
          {...cardProps(item)}
        >
          <span className="gallery-item__art">
            <OptimizedImage
              src={item.thumbnail || item.image}
              alt={item.name || ""}
              sizes="(max-width: 860px) 45vw, 220px"
            />
          </span>
          <span className="gallery-item__label">
            <span className="gallery-item__name">{item.name || "Untitled"}</span>
            <span className="gallery-item__type">{item.part || "piece"}</span>
          </span>
        </button>
      ))}
    </section>
  );
}

/** The production viewer, reduced the same way. */
export function ProtoViewer({ item, onClose, artProps = {}, overlayProps = {}, entryProps = {} }) {
  if (!item) return null;
  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()} {...overlayProps}>
      <div className="viewer-entry" {...entryProps}>
        <aside className="viewer editing" role="dialog" aria-modal="true" aria-label={item.name || "Garment"}>
          <div className="viewer-art" {...artProps}>
            <OptimizedImage src={item.image || item.thumbnail} alt={item.name || ""} sizes="34vw" />
          </div>
          <h2 style={{ margin: "18px 0 4px", font: "500 clamp(20px, 3vw, 26px)/1.1 inherit", letterSpacing: "var(--track-tight)" }}>
            {item.name || "Untitled"}
          </h2>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 11, letterSpacing: "var(--track-caps)", textTransform: "uppercase" }}>
            {item.part || "piece"}
          </p>
          <button type="button" className="secondary-button" style={{ marginTop: "auto" }} onClick={onClose}>Close</button>
        </aside>
      </div>
    </div>
  );
}
