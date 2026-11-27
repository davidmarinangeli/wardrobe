import { useCallback, useMemo, useRef, useState } from "react";
import { updateWornTodayMembership, useBrowserState } from "../browser-state.js";

/** Local midnight, so "today" means the user's today and not UTC's. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The wear signal is history; browser state keeps today's cross-browser checkmarks. */
export function useWornToday() {
  const [error, setError] = useState("");
  const browserState = useBrowserState();
  const pending = useRef(new Set());
  const worn = useMemo(() => browserState.state?.wornToday.day === today()
    ? new Set(browserState.state.wornToday.ids)
    : new Set(), [browserState.state?.wornToday]);

  const logWear = useCallback(async (outfit) => {
    if (!browserState.ready || !outfit?.itemIds?.length || pending.current.has(outfit.id)) return;
    if (browserState.state?.wornToday.day === today() && browserState.state.wornToday.ids.includes(outfit.id)) return;
    pending.current.add(outfit.id);
    setError("");
    try {
      await updateWornTodayMembership(outfit.id, today(), true, { itemIds: outfit.itemIds, name: outfit.name });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      pending.current.delete(outfit.id);
    }
  }, [browserState.ready, browserState.state]);

  return {
    isWornToday: useCallback((id) => worn.has(id), [worn]),
    logWear,
    error: error || browserState.error?.message || "",
    ready: browserState.ready,
  };
}
