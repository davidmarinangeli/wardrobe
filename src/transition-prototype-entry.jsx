import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Picker } from "./prototypes/Picker.jsx";
import { ViewTransitionVariant } from "./prototypes/transitions/A-ViewTransition.jsx";
import { FlipCloneVariant } from "./prototypes/transitions/B-FlipClone.jsx";
import { ExpandInPlaceVariant } from "./prototypes/transitions/C-ExpandInPlace.jsx";
import "./styles.css";
import "./prototypes/transitions/proto-transitions.css";

// Three genuinely different answers to "what happens when you open a garment",
// not three tunings of one answer. Flip between them with 1/2/3 or ←/→, replay
// with R, and promote whichever one survives being used rather than watched.
const VARIANTS = [
  {
    name: "View Transition",
    axis: "Browser owns the morph · cheapest · not interruptible",
    component: ViewTransitionVariant,
  },
  {
    name: "FLIP Clone",
    axis: "One element genuinely travels · works everywhere · real machinery",
    component: FlipCloneVariant,
  },
  {
    name: "Expand in Place",
    axis: "Panel grows from the card · same mechanism as the top-bar popovers",
    component: ExpandInPlaceVariant,
  },
];

function TransitionPrototypes() {
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
    document.title = `${VARIANTS[activeIndex].name} — card → viewer`;
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

ReactDOM.createRoot(document.getElementById("root")).render(<TransitionPrototypes />);
