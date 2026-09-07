// PROTOTYPE — throwaway. The switcher that sits inside the real Mirror panel.
//
// Deliberately mounted on the real route rather than on a page of its own: a
// critique layout looks fine in a vacuum, and the question here is whether it
// reads well at the panel's actual width, against the app's real type and the
// gallery behind it.
//
// Active only when the URL carries ?mirrorVariant=, and only in dev, so a stray
// merge cannot ship any of this. Upload a photo and it renders the real
// critique; without one it falls back to a saved critique of the maximalist
// photo, so the variants can be compared without spending an API call each time.

import { useEffect, useState } from "react";
import { Picker } from "../Picker.jsx";
import { MIRROR_VARIANTS } from "./variants.jsx";
import sampleCritique from "./sample-critique.json";
import "../picker.css";

export const PROTOTYPE_PARAM = "mirrorVariant";

/** The variant key in the URL, or null when the prototype is not running. */
export function useMirrorVariant() {
  const [key, setKey] = useState(() => new URLSearchParams(window.location.search).get(PROTOTYPE_PARAM));
  useEffect(() => {
    const sync = () => setKey(new URLSearchParams(window.location.search).get(PROTOTYPE_PARAM));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return import.meta.env.DEV ? key : null;
}

export function MirrorVariantHost({ variantKey, critique, itemMap }) {
  const index = Math.max(0, MIRROR_VARIANTS.findIndex((variant) => variant.key === variantKey));
  const [active, setActive] = useState(index);
  const shown = critique || sampleCritique;
  const Variant = MIRROR_VARIANTS[active].component;

  const select = (next) => {
    setActive(next);
    const url = new URL(window.location);
    url.searchParams.set(PROTOTYPE_PARAM, MIRROR_VARIANTS[next].key);
    window.history.replaceState(null, "", url);
  };

  return (
    <>
      <div className="pm-banner">
        <strong>Prototype {active + 1}/{MIRROR_VARIANTS.length} · {MIRROR_VARIANTS[active].name}</strong>
        <span>{MIRROR_VARIANTS[active].axis}</span>
        <span>{critique ? "· your photo" : "· saved critique, upload a photo to use your own"}</span>
      </div>
      <Variant critique={shown} itemMap={itemMap} />
      <Picker
        variants={MIRROR_VARIANTS}
        activeIndex={active}
        onSelect={select}
        onReplay={() => setActive(active)}
      />
    </>
  );
}
