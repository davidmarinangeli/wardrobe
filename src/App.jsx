import { useCallback, useEffect, useMemo, useState } from "react";
import { Gear } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { ColorProfileModal, SEASONS, itemMatchesPalette, readColorProfile } from "./color-profile.jsx";
import { Outfits } from "./outfits.jsx";
import { Inspo } from "./inspo.jsx";
import { Wishlist } from "./wishlist.jsx";
import { GalleryItem, ItemViewer, TYPE_MAP, TYPE_ORDER, TYPES } from "./item-editor.jsx";
import { DISMISS_KEY as ONBOARDING_DISMISS_KEY, Onboarding, RESUME_KEY as ONBOARDING_RESUME_KEY } from "./onboarding.jsx";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";

function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}


function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function AiModeToggle({ setup, onChange }) {
  if (!setup || setup.provider !== "gemini") return null;
  const mode = setup.mode;
  const missingKey = mode === "test" ? !setup.hasTestKey : !setup.hasProdKey;
  return (
    <div className="ai-mode-switch">
      <span className="ai-mode-switch__label">Gemini key</span>
      <div className="ai-mode-switch__pill" role="radiogroup" aria-label="Gemini API mode">
        <button type="button" className={mode === "test" ? "active" : ""} aria-pressed={mode === "test"} onClick={() => onChange("test")}>Test</button>
        <button type="button" className={mode === "prod" ? "active" : ""} aria-pressed={mode === "prod"} onClick={() => onChange("prod")}>Prod</button>
      </div>
      {missingKey && (
        <p className="ai-mode-switch__warning" role="alert">
          {mode === "test" ? "Add GEMINI_API_KEY_TEST to .env, then restart." : "Add GEMINI_API_KEY_PROD (or GEMINI_API_KEY) to .env, then restart."}
        </p>
      )}
    </div>
  );
}

export function App() {
  const [view, setView] = useState("wardrobe");
  const [items, setItems] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [colorProfile, setColorProfile] = useState(() => readColorProfile());
  const [showColorQuiz, setShowColorQuiz] = useState(false);
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [aiSetup, setAiSetup] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    fetch("/api/import/config", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then(setAiSetup)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!aiSetup || loading) return;
    if (aiSetup.ready) return;
    const resuming = sessionStorage.getItem(ONBOARDING_RESUME_KEY) === "1";
    const dismissed = localStorage.getItem(ONBOARDING_DISMISS_KEY) === "1";
    if (resuming || (!dismissed && items.length === 0)) setShowOnboarding(true);
  }, [aiSetup, loading, items.length]);

  const setAiMode = useCallback(async (mode) => {
    const response = await fetch("/api/import/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) return;
    const configResponse = await fetch("/api/import/config", { cache: "no-store" });
    if (configResponse.ok) setAiSetup(await configResponse.json());
  }, []);

  useEffect(() => {
    fetch("/api/import/wardrobe", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the wardrobe.");
        return response.json();
      })
      .then((loadedItems) => {
        const edits = readEdits();
        const deleted = readDeletedItems();
        const visibleItems = loadedItems.filter((item) => !deleted.has(item.id));
        setItems(visibleItems.map((item) => ({ ...item, ...(edits[item.id] || {}) })));
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    let filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    if (onlyMatches && colorProfile) filtered = filtered.filter((item) => itemMatchesPalette(item, colorProfile));
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items, onlyMatches, colorProfile]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
  };

  const saveItem = (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    persistEdit(updatedItem);
  };

  const deleteItem = async (id) => {
    if (id.startsWith("import-")) {
      try {
        const response = await fetch(`/api/import/wardrobe/${id}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new Error("Could not delete the imported item.");
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const generateModeledPhoto = useCallback(async (item, tier) => {
    const response = await fetch(`/api/import/wardrobe/${item.id}/modeled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Could not start generating a model photo.");
    setItems((current) => current.map((existing) => existing.id === item.id
      ? { ...existing, modeledStatus: value.modeledStatus, modeledError: value.modeledError, modeledTier: value.modeledTier }
      : existing));
  }, []);

  useEffect(() => {
    if (!items.some((item) => item.modeledStatus === "processing")) return undefined;
    const timer = setInterval(() => {
      fetch("/api/import/wardrobe", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not refresh the wardrobe.")))
        .then((freshItems) => {
          const freshById = Object.fromEntries(freshItems.map((item) => [item.id, item]));
          setItems((current) => current.map((item) => {
            const fresh = freshById[item.id];
            return fresh ? { ...item, modeledImage: fresh.modeledImage, modeledStatus: fresh.modeledStatus, modeledError: fresh.modeledError, modeledTier: fresh.modeledTier } : item;
          }));
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [items]);

  const premiumAllowed = !aiSetup || aiSetup.provider !== "gemini" || aiSetup.mode === "prod";

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}`}>
      <div className="app-top-bar">
        <nav className="app-view-switch" aria-label="Switch between wardrobe, outfits, inspo, and wishlist">
          <button type="button" className={view === "wardrobe" ? "active" : ""} onClick={() => setView("wardrobe")} aria-pressed={view === "wardrobe"}>Wardrobe</button>
          <button type="button" className={view === "outfits" ? "active" : ""} onClick={() => setView("outfits")} aria-pressed={view === "outfits"}>Outfits</button>
          <button type="button" className={view === "inspo" ? "active" : ""} onClick={() => setView("inspo")} aria-pressed={view === "inspo"}>Inspo</button>
          <button type="button" className={view === "wishlist" ? "active" : ""} onClick={() => setView("wishlist")} aria-pressed={view === "wishlist"}>Wishlist</button>
        </nav>
        <div className="app-top-bar__right">
          <AiModeToggle setup={aiSetup} onChange={setAiMode} />
          <button type="button" className="setup-trigger" onClick={() => setShowOnboarding(true)} aria-label="Open setup guide">
            <Gear size={16} />
          </button>
        </div>
      </div>

      {view === "inspo" ? (
        <Inspo />
      ) : view === "wishlist" ? (
        <Wishlist />
      ) : view === "outfits" ? (
        <Outfits items={items} premiumAllowed={premiumAllowed} />
      ) : (
        <main className="gallery-pane">
          <header className="gallery-header">
            <div className="gallery-meta-row">
              <p className="piece-count">{items.length} {items.length === 1 ? "piece" : "pieces"}</p>
              <button type="button" className="color-profile-trigger" onClick={() => setShowColorQuiz(true)}>
                {colorProfile ? <><span className="season-dot" style={{ backgroundColor: SEASONS[colorProfile.season].accent }} />{SEASONS[colorProfile.season].label}</> : "My Colors"}
              </button>
            </div>
            <nav className="category-nav" aria-label="Filter wardrobe by item type">
              {TYPES.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  className={activeType === type.id ? "active" : ""}
                  onClick={() => chooseType(type.id)}
                  aria-pressed={activeType === type.id}
                >
                  {type.label}
                </button>
              ))}
              {colorProfile && (
                <button
                  type="button"
                  className={onlyMatches ? "active" : ""}
                  onClick={() => setOnlyMatches((current) => !current)}
                  aria-pressed={onlyMatches}
                >
                  Matches my colors
                </button>
              )}
            </nav>
          </header>

          {error && <p className="status error">{error}</p>}
          {!error && loading && <p className="status">Loading wardrobe</p>}
          {!error && !loading && !items.length && <p className="status empty">Drop, paste, or add a photo to import your first piece.</p>}

          {!!items.length && (
            <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
              {visibleItems.map((item) => (
                <GalleryItem
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  onOpen={setSelectedId}
                  seasonMatch={colorProfile?.showBadges && itemMatchesPalette(item, colorProfile) ? SEASONS[colorProfile.season] : null}
                />
              ))}
            </section>
          )}
        </main>
      )}

      {selectedItem && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} onGenerateModeled={generateModeledPhoto} premiumAllowed={premiumAllowed} />}
      {showColorQuiz && (
        <ColorProfileModal
          initialProfile={colorProfile}
          onClose={() => setShowColorQuiz(false)}
          onSave={(profile) => { setColorProfile(profile); setShowColorQuiz(false); }}
        />
      )}
      <WardrobeImportFlow onGarmentApproved={addImportedItem} externalSetup={aiSetup} />
      {showOnboarding && (
        <Onboarding
          setup={aiSetup}
          onSetupChange={setAiSetup}
          onClose={() => setShowOnboarding(false)}
        />
      )}
    </div>
  );
}
