import { useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwise, SpinnerGap } from "@phosphor-icons/react";
import { GalleryItem, ItemViewer, TYPE_MAP, TYPE_ORDER, TYPES } from "./item-editor.jsx";
import "./wishlist.css";

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "Request failed.");
  return value;
}

export function Wishlist() {
  const [items, setItems] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryingId, setRetryingId] = useState(null);

  useEffect(() => {
    api("/api/wishlist")
      .then(setItems)
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!items.some((item) => item.generateStatus === "processing")) return undefined;
    const timer = setInterval(() => {
      api("/api/wishlist")
        .then((fresh) => {
          const freshById = Object.fromEntries(fresh.map((item) => [item.id, item]));
          setItems((current) => current.map((item) => freshById[item.id] || item));
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [items]);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    const filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items]);

  const saveItem = async (updatedItem) => {
    const saved = await api(`/api/wishlist/${updatedItem.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: updatedItem.name, part: updatedItem.part, color: updatedItem.color, secondaryColor: updatedItem.secondaryColor, tags: updatedItem.tags }),
    });
    setItems((current) => current.map((item) => item.id === saved.id ? saved : item));
  };

  const deleteItem = async (id) => {
    try {
      await api(`/api/wishlist/${id}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== id));
      setSelectedId(null);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const retryItem = async (event, id) => {
    event.stopPropagation();
    setRetryingId(id);
    try {
      const updated = await api(`/api/wishlist/${id}/retry`, { method: "POST" });
      setItems((current) => current.map((item) => item.id === id ? updated : item));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <main className="gallery-pane">
      <header className="gallery-header">
        <div className="gallery-meta-row">
          <p className="piece-count">{items.length} {items.length === 1 ? "piece" : "pieces"}</p>
        </div>
        <nav className="category-nav" aria-label="Filter wishlist by item type">
          {TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              className={activeType === type.id ? "active" : ""}
              onClick={() => setActiveType(type.id)}
              aria-pressed={activeType === type.id}
            >
              {type.label}
            </button>
          ))}
        </nav>
      </header>

      {error && <p className="status error">{error}</p>}
      {!error && loading && <p className="status">Loading wishlist</p>}
      {!error && !loading && !items.length && (
        <p className="status empty">Detect items from your Inspo board to start your wishlist.</p>
      )}

      {!!visibleItems.length && (
        <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wishlist items`}>
          {visibleItems.map((item) => (
            <div className="wishlist-grid-item" key={item.id}>
              <GalleryItem item={item} selected={selectedId === item.id} onOpen={setSelectedId} />
              {item.generateStatus === "error" && (
                <button
                  type="button"
                  className="wishlist-retry-badge"
                  onClick={(event) => retryItem(event, item.id)}
                  disabled={retryingId === item.id}
                  aria-label={`Retry generating a clean image for ${item.name || "this item"}`}
                  title={item.generateError || "Cutout generation failed"}
                >
                  {retryingId === item.id || item.generateStatus === "processing"
                    ? <SpinnerGap size={13} className="wishlist-retry-spinner" aria-hidden="true" />
                    : <ArrowCounterClockwise size={13} aria-hidden="true" />}
                  Retry
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {selectedItem && (
        <ItemViewer
          item={selectedItem}
          onClose={() => setSelectedId(null)}
          onSave={saveItem}
          onDelete={deleteItem}
          showModeledPhoto={false}
        />
      )}
    </main>
  );
}
