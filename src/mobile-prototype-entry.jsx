import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Picker } from "./prototypes/Picker.jsx";
import { SheetDismissVariant } from "./prototypes/mobile/A-SheetDismiss.jsx";
import { NavPillVariant } from "./prototypes/mobile/B-NavPill.jsx";
import { ScaleBackVariant } from "./prototypes/mobile/C-ScaleBack.jsx";
import { GlassLensVariant } from "./prototypes/mobile/D-GlassLens.jsx";
import { RefractedVariant } from "./prototypes/mobile/E-Refracted.jsx";
import "./styles.css";
import "./prototypes/mobile/proto-mobile.css";

// Three questions the mobile overhaul cannot answer from a diff, separated so
// each can be judged without the other two confusing it. Flip with 1/2/3 or
// ←/→, remount with R.
//
// The dev server is bound to loopback, so this is reachable only on this Mac,
// at http://localhost:5173/prototype-mobile.html. Judge the gestures in a
// responsive-mode window with touch emulation on; note that
// review-animations/STANDARDS.md asks for real hardware before a gesture is
// called finished, so a device pass is still owed before any of this ships.
const VARIANTS = [
  {
    name: "Sheet dismiss",
    axis: "The gesture alone · real hook, real physics · nothing else moving",
    component: SheetDismissVariant,
  },
  {
    name: "Nav indicator",
    axis: "Sliding pill vs. weight swap · does the pill earn itself",
    component: NavPillVariant,
  },
  {
    name: "Scale back",
    axis: "Page recedes behind the sheet · and the containing-block trap",
    component: ScaleBackVariant,
  },
  {
    name: "Glass lens",
    axis: "Real SVG refraction under the nav · what CSS cannot do",
    component: GlassLensVariant,
  },
  {
    name: "Refracted",
    axis: "Frosted + refracted on the backdrop only · with an fps readout",
    component: RefractedVariant,
  },
];

function MobilePrototypes() {
  const initial = () => {
    const v = Number.parseInt(new URLSearchParams(window.location.search).get("v"), 10);
    return v >= 1 && v <= VARIANTS.length ? v - 1 : 0;
  };

  const [activeIndex, setActiveIndex] = useState(initial);
  const [mountKey, setMountKey] = useState(0);

  const select = (index) => {
    setActiveIndex(index);
    setMountKey((key) => key + 1);
    const url = new URL(window.location);
    url.searchParams.set("v", index + 1);
    window.history.replaceState(null, "", url);
  };

  useEffect(() => {
    document.title = `${VARIANTS[activeIndex].name} — mobile overhaul`;
  }, [activeIndex]);

  const Active = VARIANTS[activeIndex].component;

  return (
    <>
      <Active key={mountKey} />
      <Picker
        variants={VARIANTS}
        activeIndex={activeIndex}
        onSelect={select}
        onReplay={() => setMountKey((key) => key + 1)}
      />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<MobilePrototypes />);
