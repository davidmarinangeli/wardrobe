import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Broom, Gear, Lightbulb, Palette } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { api } from "./api.js";
import { buildOutfitIndex } from "../shared/outfit-index.mjs";
import { ColorProfileModal, SEASONS, itemMatchesPalette, readColorProfile } from "./color-profile.jsx";
import { Outfits } from "./outfits.jsx";
import { Mirror } from "./mirror.jsx";
import { Inspo } from "./inspo.jsx";
import { GalleryItem, ItemViewer } from "./item-editor.jsx";
import { WARDROBE_TYPES as TYPES, TYPE_MAP } from "./categories.js";
import { PageShell } from "./components/PageShell.jsx";
import { HotCards } from "./components/HotCards.jsx";
import { DeclutterPanel } from "./declutter.jsx";
import "./components/hot-cards.css";
import { PageStatus } from "./components/PageStatus.jsx";
import { useTypeFilteredItems } from "./hooks/useTypeFilteredItems.js";
import { BottomNav } from "./components/BottomNav.jsx";
import { MobileCompactBar, MobileHeadRow, useMobileHeaderScroll } from "./components/MobileHeader.jsx";
import { useChromeScroll } from "./hooks/useChromeScroll.js";
import "./components/mobile-chrome.css";
import { DISMISS_KEY as ONBOARDING_DISMISS_KEY, Onboarding, RESUME_KEY as ONBOARDING_RESUME_KEY } from "./onboarding.jsx";

const EMPTY_OUTFIT_INDEX = { outfits: {}, byItem: {} };
const VIEW_TITLES = {
  wardrobe: "Wardrobe",
  outfits: "Outfits",
  inspo: "Inspo",
};

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
  const { barRef, largeRef } = useMobileHeaderScroll(VIEW_TITLES[view] || "Wardrobe");
  // Mobile chrome: the bottom nav contracts and the relocated action row hides
  // as you scroll. Both are no-ops above 860px, where CSS leaves the desktop
  // top bar alone and the nav is not rendered at all.
  const bottomNavRef = useRef(null);
  const topActionsRef = useRef(null);
  useChromeScroll(bottomNavRef, topActionsRef);
  const [items, setItems] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  // The card the viewer should grow out of. The element itself, not its
  // coordinates — opening the viewer reflows the page behind it, so the rect is
  // read later, once that has settled. See useExpandOrigin.
  const [openedFrom, setOpenedFrom] = useState(null);
  // Stable, so memo(GalleryItem) can skip every card whose `selected` did not change.
  const openItem = useCallback((id, element) => { setOpenedFrom(element); setSelectedId(id); }, []);
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
  // Which saved outfits use each piece. Lives here rather than in Outfits
  // because the wardrobe grid is the surface that asks the question, and that
  // tab must not have to mount Outfits (or wait on the full outfit list) to
  // answer it. Refetched on every return to the wardrobe so an outfit built in
  // the meantime is reflected.
  const [outfitIndex, setOutfitIndex] = useState(EMPTY_OUTFIT_INDEX);
  const [openOutfitId, setOpenOutfitId] = useState(null);
  // Pieces triaged out of the wardrobe. Held apart from `items` so that every
  // existing consumer of `items` keeps meaning "the wardrobe you dress from"
  // without a single call site having to learn about status.
  const [retiredItems, setRetiredItems] = useState([]);
  const [wear, setWear] = useState(null);
  const [showDeclutter, setShowDeclutter] = useState(false);

  useEffect(() => {
    if (view !== "wardrobe") return undefined;
    let cancelled = false;
    // Silent on failure: the count is an enrichment, and a piece with no
    // outfits looks exactly like a piece whose index didn't load — neither is
    // an error worth putting in front of someone.
    api("/api/outfits/index")
      .then((payload) => { if (!cancelled) setOutfitIndex(buildOutfitIndex(payload.outfits)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [view]);

  // Refetched whenever it is missing — on mount, on returning to the wardrobe,
  // and after a triage decision nulls it. Silent on failure: the hot card simply
  // does not appear, which is the same thing the user sees when there is nothing
  // to say, and neither is an error worth interrupting them for.
  const refreshWear = useCallback(() => api("/api/preferences/wear")
    .then(setWear)
    .catch(() => {}), []);

  useEffect(() => {
    if (wear || view !== "wardrobe") return undefined;
    refreshWear();
    return undefined;
  }, [wear, view, refreshWear]);

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
        const visibleItems = loadedItems
          .filter((item) => !deleted.has(item.id))
          .map((item) => ({ ...item, ...(edits[item.id] || {}) }));
        // No status at all is the same fact as "active": an item that was never
        // triaged and one triaged back are indistinguishable, by design.
        setItems(visibleItems.filter((item) => !item.status || item.status === "active"));
        setRetiredItems(visibleItems.filter((item) => item.status && item.status !== "active"));
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  // Sync color profile from server database on mount
  useEffect(() => {
    fetch("/api/color-profile/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.hasProfile && data.profile?.season) {
          const resolvedSeason = SEASONS[data.profile.season] || SEASONS[data.profile.parentSeason] || SEASONS["autumn-deep"];
          const fullProfile = {
            ...data.profile,
            season: resolvedSeason.id,
            parentSeason: resolvedSeason.parentSeason,
            palette: Array.isArray(data.profile.palette) && data.profile.palette.length ? data.profile.palette : (resolvedSeason.palette || []),
          };
          setColorProfile(fullProfile);
          try {
            localStorage.setItem("open-wardrobe-color-profile-v1", JSON.stringify(fullProfile));
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const itemsById = useMemo(() => Object.fromEntries(items.map((item) => [item.id, item])), [items]);
  // Declutter is the one surface that has to see both: a candidate still in the
  // wardrobe, and a piece already moved to a pile whose photo it still renders.
  const declutterItemsById = useMemo(
    () => Object.fromEntries([...items, ...retiredItems].map((item) => [item.id, item])),
    [items, retiredItems],
  );

  // Resolved here (not in the viewer) because the piece images the thumbnails
  // are built from are already in this component's state — the index only
  // carries ids.
  const selectedItemOutfits = useMemo(() => {
    if (!selectedId) return [];
    return (outfitIndex.byItem[selectedId] || [])
      .map((id) => outfitIndex.outfits[id])
      .filter(Boolean)
      .map((outfit) => ({ ...outfit, pieces: outfit.itemIds.map((id) => itemsById[id]).filter(Boolean) }));
  }, [selectedId, outfitIndex, itemsById]);

  const openOutfit = useCallback((outfitId) => {
    setSelectedId(null);
    setOpenOutfitId(outfitId);
    setView("outfits");
  }, []);

  // Your palette, as a card that actually shows the palette. It used to be a
  // pill in the header reading "DEEP AUTUMN", which named a season to someone
  // who had already taken the quiz and meant nothing to anyone who hadn't. The
  // strip has room to show the colours themselves.
  const colorCard = useMemo(() => {
    const season = colorProfile && (SEASONS[colorProfile.season] || SEASONS[colorProfile.parentSeason]);

    if (!season) {
      return {
        id: "colors",
        icon: <Palette size={15} weight="regular" />,
        eyebrow: "My colours",
        title: "Find your colours",
        body: "Match every suggestion to your skin tone.",
        onOpen: () => setShowColorQuiz(true),
      };
    }

    return {
      id: "colors",
      icon: <Palette size={15} weight="regular" />,
      accent: season.accent,
      eyebrow: "My colours",
      title: season.label,
      swatches: colorProfile.palette?.length ? colorProfile.palette : season.palette,
      onOpen: () => setShowColorQuiz(true),
    };
  }, [colorProfile]);

  // The declutter card ships in both states. Locked, it is the reveal path: it
  // says plainly that the app cannot answer yet and shows how far off it is.
  // Unlocked, it is the way into the deck. It is never a countdown to something
  // that will not arrive — with nothing to review, it does not render at all.
  const declutterCard = useMemo(() => {
    if (!wear) return null;
    const retired = retiredItems.length;

    if (wear.unlocked) {
      if (!wear.candidates.length) {
        return retired ? {
          id: "declutter",
          icon: <Broom size={15} weight="regular" />,
          eyebrow: "Declutter",
          title: `${retired} ${retired === 1 ? "piece" : "pieces"} set aside`,
          body: "Nothing else is going unworn right now.",
          onOpen: () => setShowDeclutter(true),
        } : null;
      }
      return {
        id: "declutter",
        icon: <Broom size={15} weight="regular" />,
        eyebrow: "Declutter",
        title: `${wear.candidates.length} ${wear.candidates.length === 1 ? "piece you haven't" : "pieces you haven't"} worn`,
        body: "Decide what to keep, sell, or give away.",
        onOpen: () => setShowDeclutter(true),
      };
    }

    // Nothing to learn from yet and nothing to preview: an empty wardrobe does
    // not need to be told it is not being worn.
    if (!wear.provisional.length && !wear.loggedDays) return null;

    return {
      id: "declutter",
      icon: <Broom size={15} weight="regular" />,
      eyebrow: "Declutter",
      title: "Learning what you actually wear",
      body: "Log what you wear and I can tell you what's worth letting go.",
      progress: { value: wear.loggedDays, total: wear.daysNeeded },
      onOpen: () => setShowDeclutter(true),
    };
  }, [wear, retiredItems.length]);

  const paletteFilter = useCallback(
    (item) => itemMatchesPalette(item, colorProfile),
    [colorProfile],
  );
  const visibleItems = useTypeFilteredItems(items, activeType, onlyMatches && colorProfile ? paletteFilter : undefined);

  // The vocabulary covers garments this wardrobe may not own (nobody's closet
  // has every category), so a type only earns a filter pill once something is
  // filed under it — otherwise widening the vocabulary just adds dead chips.
  // "All", and whatever is currently selected, always stay so the nav can't
  // drop the pill you're standing on.
  const availableTypes = useMemo(() => {
    const filled = new Set(items.map((item) => item.part));
    return TYPES.filter((type) => type.id === "all" || type.id === activeType || filled.has(type.id));
  }, [items, activeType]);

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

  /**
   * Move a piece between the wardrobe and a pile. Never deletes: the photos stay
   * on disk and every outfit the piece appears in is left exactly as it was,
   * because those outfits are history and history does not change when you sell
   * a jacket. Reversible in one tap from the piles.
   */
  const setItemStatus = useCallback(async (id, status) => {
    let updated;
    try {
      updated = await api(`/api/import/wardrobe/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    } catch (requestError) {
      setError(requestError.message);
      return;
    }

    const active = !updated.status || updated.status === "active";
    // Local edits are an overlay the server knows nothing about, so they have to
    // be re-applied here or a rename would silently revert on the way to a pile.
    const merged = { ...updated, ...(readEdits()[id] || {}) };

    setItems((current) => {
      const without = current.filter((item) => item.id !== id);
      return active ? [...without, merged] : without;
    });
    setRetiredItems((current) => {
      const without = current.filter((item) => item.id !== id);
      return active ? without : [...without, merged];
    });
    // Advance the deck now rather than after a round trip, then reconcile. The
    // previous version nulled `wear` to force a refetch, which pulled the state
    // out from under the panel still rendering it.
    setWear((current) => (current ? {
      ...current,
      candidates: current.candidates.filter((entry) => entry.id !== id),
      provisional: current.provisional.filter((entry) => entry.id !== id),
    } : current));
    refreshWear();
  }, [refreshWear]);

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
      <MobileCompactBar
        title={VIEW_TITLES[view] || "Wardrobe"}
        barRef={barRef}
      />
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
          <div className="top-actions" ref={topActionsRef} data-hidden="false">
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

      <div className="app-shell__page">
        <MobileHeadRow
          title={VIEW_TITLES[view] || "Wardrobe"}
          onSettings={() => setShowOnboarding(true)}
          badge={<AiModeBadge setup={aiSetup} />}
          largeRef={largeRef}
        />

        {view === "inspo" ? (
        <Inspo showImporter={showInspoImporter} onImporterClose={() => setShowInspoImporter(false)} />
      ) : view === "outfits" ? (
        <Outfits
          items={items}
          premiumAllowed={premiumAllowed}
          provider={aiSetup?.provider ?? null}
          colorProfile={colorProfile}
          onOpenColorQuiz={() => setShowColorQuiz(true)}
          showBuilder={showOutfitBuilder}
          onOpenBuilder={() => setShowOutfitBuilder(true)}
          onCloseBuilder={() => setShowOutfitBuilder(false)}
          showSuggestions={showOutfitSuggestions}
          onCloseSuggestions={() => setShowOutfitSuggestions(false)}
          openOutfitId={openOutfitId}
          onOutfitOpened={() => setOpenOutfitId(null)}
        />
      ) : (
        <PageShell
          count={onlyMatches ? visibleItems.length : items.length}
          noun={onlyMatches && colorProfile ? `${(SEASONS[colorProfile.season] || SEASONS[colorProfile.parentSeason])?.label || "palette"} match` : "piece"}
          categories={availableTypes}
          activeCategory={activeType}
          onCategory={chooseType}
          navLabel="Filter wardrobe by item type"
          navExtra={colorProfile && (
            <button
              type="button"
              className={`color-filter-btn${onlyMatches ? " active" : ""}`}
              onClick={() => setOnlyMatches((current) => !current)}
              aria-pressed={onlyMatches}
              title={onlyMatches ? "Show all pieces" : `Show only pieces matching your ${(SEASONS[colorProfile.season] || SEASONS[colorProfile.parentSeason])?.label || "palette"}`}
            >
              <span
                className="season-dot"
                style={{ backgroundColor: (SEASONS[colorProfile.season] || SEASONS[colorProfile.parentSeason])?.accent }}
                aria-hidden="true"
              />
              Matches my colors
            </button>
          )}
          beforeContent={<HotCards cards={[colorCard, declutterCard].filter(Boolean)} label="Wardrobe shortcuts" />}
        >
          <PageStatus
            loading={loading}
            error={error}
            empty={!items.length}
            emptyMessage="Drop, paste, or add a photo to import your first piece."
            noun="wardrobe"
          />

          {!!items.length && (
            visibleItems.length === 0 ? (
              <p className="empty" style={{ margin: "48px 0", textAlign: "center" }}>
                No pieces match your {(SEASONS[colorProfile?.season] || SEASONS[colorProfile?.parentSeason])?.label || "seasonal"} palette.
              </p>
            ) : (
              <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "All"} wardrobe items`}>
                {visibleItems.map((item, index) => (
                  <GalleryItem
                    key={item.id}
                    item={item}
                    index={index}
                    selected={selectedId === item.id}
                    outfitCount={outfitIndex.byItem[item.id]?.length || 0}
                    onOpen={openItem}
                  />
                ))}
              </section>
            )
          )}
        </PageShell>
      )}
      </div>

      <BottomNav view={view} onSelect={setView} navRef={bottomNavRef} />

      {selectedItem && <ItemViewer item={selectedItem} openedFrom={openedFrom} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} onGenerateModeled={generateModeledPhoto} premiumAllowed={premiumAllowed} provider={aiSetup?.provider ?? null} outfits={selectedItemOutfits} onOpenOutfit={openOutfit} />}
      {showColorQuiz && (
        <ColorProfileModal
          initialProfile={colorProfile}
          onClose={() => setShowColorQuiz(false)}
          onSave={(profile) => { setColorProfile(profile); setShowColorQuiz(false); }}
        />
      )}
      {showDeclutter && (
        <DeclutterPanel
          wear={wear}
          itemsById={declutterItemsById}
          retiredItems={retiredItems}
          onSetStatus={setItemStatus}
          onClose={() => setShowDeclutter(false)}
          onGoToOutfits={() => { setShowDeclutter(false); setView("outfits"); }}
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
