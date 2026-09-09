import { useCallback, useState } from "react";
import { api } from "../api.js";

const KEY = "open-wardrobe-worn-today-v1";

/** Local midnight, so "today" means the user's today and not UTC's. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function read() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || "{}");
    // Only today's entry survives a read: yesterday's checkmarks are not state,
    // they are clutter, and keeping them would make the button lie every morning.
    return stored.day === today() ? new Set(stored.ids || []) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Which outfits the user has already logged as worn today.
 *
 * The server is the record — every wear is a signal in the append-only log, and
 * deriveWearStats collapses repeats of the same combination on the same day. This
 * only remembers which buttons should already look pressed, which is why a stale
 * or missing value is harmless: the worst case is a second tap that derivation
 * discards. It is per-browser for the same reason it is allowed to be wrong —
 * logging on a phone leaves the laptop's checkmark unfilled, and nothing about
 * the underlying data is affected.
 */
export function useWornToday() {
  const [worn, setWorn] = useState(read);

  const logWear = useCallback(async (outfit) => {
    if (!outfit?.itemIds?.length) return;

    setWorn((current) => {
      const next = new Set(current).add(outfit.id);
      try { localStorage.setItem(KEY, JSON.stringify({ day: today(), ids: [...next] })); } catch { /* private mode */ }
      return next;
    });

    try {
      await api("/api/preferences/signal", {
        method: "POST",
        body: JSON.stringify({ type: "outfit_worn", itemIds: outfit.itemIds, name: outfit.name, source: "outfits" }),
      });
    } catch {
      // Deliberately silent, and deliberately not rolled back. recordSignal's own
      // contract is that recording a preference never fails the action the user
      // asked for; a wear they logged is not worth an error dialog, and undoing
      // the checkmark would tell them their tap did nothing when it may well have.
    }
  }, []);

  return { isWornToday: useCallback((id) => worn.has(id), [worn]), logWear };
}
