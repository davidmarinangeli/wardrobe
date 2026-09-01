import { useCallback, useEffect, useState } from "react";
import { Gear, Lightbulb } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { ColorProfileModal, SEASONS, itemMatchesPalette, readColorProfile } from "./color-profile.jsx";
import { Outfits } from "./outfits.jsx";
import { Mirror } from "./mirror.jsx";
import { Inspo } from "./inspo.jsx";
import { GalleryItem, ItemViewer } from "./item-editor.jsx";
import { WARDROBE_TYPES as TYPES, TYPE_MAP } from "./categories.js";
import { PageShell } from "./components/PageShell.jsx";
import { PageStatus } from "./components/PageStatus.jsx";
import { useTypeFilteredItems } from "./hooks/useTypeFilteredItems.js";
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

// A developer setting, findable but quiet: a small dot on the gear button
// reporting the current Gemini mode, nothing more. The actual switch lives in
// Settings (Onboarding's DoneStep) — see AiModeToggle there.
function AiModeBadge({ setup }) {
  if (!setup || setup.provider !== "gemini") return null;
  const missingKey = setup.mode === "test" ? !setup.hasTestKey : !setup.hasProdKey;
  return (
    <span
      className={`setup-trigger__badge${missingKey ? " is-warning" : ""}`}
      aria-hidden="true"
      title={`Gemini: ${setup.mode === "prod" ? "Prod" : "Test"}${missingKey ? " (key missing)" : ""}`}
    >
      {setup.mode === "prod" ? "P" : "T"}
    </span>
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
  const [showInspoImporter, setShowInspoImporter] = useState(false);
  const [showOutfitBuilder, setShowOutfitBuilder] = useState(false);
  const [showOutfitSuggestions, setShowOutfitSuggestions] = useState(false);

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

  const paletteFilter = useCallback(
    (item) => itemMatchesPalette(item, colorProfile),
    [colorProfile],
  );
  const visibleItems = useTypeFilteredItems(items, activeType, onlyMatches && colorProfile ? paletteFilter : undefined);

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

  const generateModeledPhoto = useCallback(async (item, tier, prompt) => {
    const response = await fetch(`/api/import/wardrobe/${item.id}/modeled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, prompt }),
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
        <nav className="app-view-switch" aria-label="Switch between wardrobe, outfits, and inspo">
          <button type="button" className={view === "wardrobe" ? "active" : ""} onClick={() => setView("wardrobe")} aria-pressed={view === "wardrobe"}>Wardrobe</button>
          <button type="button" className={view === "outfits" ? "active" : ""} onClick={() => setView("outfits")} aria-pressed={view === "outfits"}>Outfits</button>
          <button type="button" className={view === "inspo" ? "active" : ""} onClick={() => setView("inspo")} aria-pressed={view === "inspo"}>Inspo</button>
        </nav>
        <div className="app-top-bar__right">
          {/* Global tools, always in the same place — but each view gets
              exactly one "add" and one "AI action" button, not a duplicate
              pair layered on top of the page's own. The primary action's
              idle state relabels to whatever the current view actually adds;
              the second slot swaps between Mirror (Wardrobe/Inspo) and
              Suggest outfit (Outfits) entirely, since those aren't the same
              action wearing a different label. */}
          <div className="top-actions">
            <WardrobeImportFlow
              onGarmentApproved={addImportedItem}
              externalSetup={aiSetup}
              idleLabel={view === "inspo" ? "Add Inspo" : view === "outfits" ? "Add outfit" : undefined}
              onIdleActivate={
                view === "inspo" ? () => setShowInspoImporter(true)
                : view === "outfits" ? () => setShowOutfitBuilder(true)
                : undefined
              }
            />
            {view === "outfits" ? (
              <button
                type="button"
                className="top-action top-action--secondary ai-action"
                onClick={() => setShowOutfitSuggestions(true)}
                disabled={items.length < 5}
              >
                <Lightbulb size={17} weight="bold" aria-hidden="true" />
                <span className="top-action__label">Suggest outfit</span>
                <span className="ai-action-beam-mask" aria-hidden="true">
                  <span className="ai-action-beam" />
                </span>
              </button>
            ) : (
              // Remounts on every view change (key={view}) so the spark
              // animation replays on arrival, same as a fresh Suggest-outfit
              // button does when its whole branch mounts.
              <Mirror key={view} items={items} />
            )}
          </div>
          <button type="button" className="setup-trigger" onClick={() => setShowOnboarding(true)} aria-label="Open setup guide">
            <Gear size={16} />
            <AiModeBadge setup={aiSetup} />
          </button>
        </div>
      </div>

      {view === "inspo" ? (
        <Inspo showImporter={showInspoImporter} onImporterClose={() => setShowInspoImporter(false)} />
      ) : view === "outfits" ? (
        <Outfits
          items={items}
          premiumAllowed={premiumAllowed}
          showBuilder={showOutfitBuilder}
          onOpenBuilder={() => setShowOutfitBuilder(true)}
          onCloseBuilder={() => setShowOutfitBuilder(false)}
          showSuggestions={showOutfitSuggestions}
          onCloseSuggestions={() => setShowOutfitSuggestions(false)}
        />
      ) : (
        <PageShell
          count={items.length}
          noun="piece"
          actions={(
            // A profile setting ("what's my season?"), not a filter — it belongs
            // up here with the page-level actions, not among the category-nav
            // pills below. "Matches my colors" stays there since it IS a filter.
            <button type="button" className="header-action-btn" onClick={() => setShowColorQuiz(true)}>
              {colorProfile ? <><span className="season-dot" style={{ backgroundColor: SEASONS[colorProfile.season].accent }} />{SEASONS[colorProfile.season].label}</> : "My Colors"}
            </button>
          )}
          categories={TYPES}
          activeCategory={activeType}
          onCategory={chooseType}
          navLabel="Filter wardrobe by item type"
          navExtra={colorProfile && (
            <button
              type="button"
              className={onlyMatches ? "active" : ""}
              onClick={() => setOnlyMatches((current) => !current)}
              aria-pressed={onlyMatches}
            >
              Matches my colors
            </button>
          )}
        >
          <PageStatus
            loading={loading}
            error={error}
            empty={!items.length}
            emptyMessage="Drop, paste, or add a photo to import your first piece."
            noun="wardrobe"
          />

          {!!items.length && (
            <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
              {visibleItems.map((item, index) => (
                <GalleryItem
                  key={item.id}
                  item={item}
                  index={index}
                  selected={selectedId === item.id}
                  onOpen={setSelectedId}
                  seasonMatch={colorProfile?.showBadges && itemMatchesPalette(item, colorProfile) ? SEASONS[colorProfile.season] : null}
                />
              ))}
            </section>
          )}
        </PageShell>
      )}

      {selectedItem && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} onGenerateModeled={generateModeledPhoto} premiumAllowed={premiumAllowed} />}
      {showColorQuiz && (
        <ColorProfileModal
          initialProfile={colorProfile}
          onClose={() => setShowColorQuiz(false)}
          onSave={(profile) => { setColorProfile(profile); setShowColorQuiz(false); }}
        />
      )}
      {showOnboarding && (
        <Onboarding
          setup={aiSetup}
          onSetupChange={setAiSetup}
          onModeChange={setAiMode}
          onClose={() => setShowOnboarding(false)}
        />
      )}
    </div>
  );
}
