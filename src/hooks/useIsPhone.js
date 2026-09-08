import { useEffect, useState } from "react";

// The one breakpoint the chrome changes shape at. Kept here so the JS that has
// to agree with mobile-chrome.css has a single place to read it from.
export const PHONE_QUERY = "(max-width: 860px)";

/**
 * Whether the viewport is phone-shaped, as a reactive boolean.
 *
 * Used for behaviour CSS cannot express — a panel is a right-edge drawer on a
 * desktop and a swipe-dismissable sheet on a phone, and that is a difference in
 * which event handlers exist, not in styling.
 *
 * Initialised from a real match rather than `false`, so a panel opened on a
 * phone is a sheet on its first frame instead of becoming one after an effect.
 */
export function useIsPhone() {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return undefined;
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isPhone;
}
