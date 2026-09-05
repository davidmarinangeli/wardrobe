import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { Picker } from "./prototypes/Picker.jsx";
import { Variant1Editorial } from "./prototypes/Variant1Editorial.jsx";
import { Variant2Compact } from "./prototypes/Variant2Compact.jsx";
import { Variant3Draping } from "./prototypes/Variant3Draping.jsx";
import "./styles.css";
import "./prototypes/proto-styles.css";

const VARIANTS = [
  {
    name: "Editorial Luxe",
    axis: "Editorial immersion & spacious typography",
    component: Variant1Editorial,
  },
  {
    name: "Studio Compact",
    axis: "Utility density & inline reference dropzone",
    component: Variant2Compact,
  },
  {
    name: "Draping Studio",
    axis: "Interactive color harmony & realtime drape testing",
    component: Variant3Draping,
  },
];

function PrototypeApp() {
  const getInitialIndex = () => {
    const params = new URLSearchParams(window.location.search);
    const v = Number.parseInt(params.get("v"), 10);
    return v >= 1 && v <= VARIANTS.length ? v - 1 : 0;
  };

  const [activeIndex, setActiveIndex] = useState(getInitialIndex);
  const [mountKey, setMountKey] = useState(0);

  const handleSelect = (index) => {
    setActiveIndex(index);
    setMountKey((k) => k + 1);
    const url = new URL(window.location);
    url.searchParams.set("v", index + 1);
    window.history.replaceState(null, "", url);
  };

  const handleReplay = () => {
    setMountKey((k) => k + 1);
  };

  const ActiveComponent = VARIANTS[activeIndex].component;

  return (
    <div className="proto-backdrop">
      {/* Context banner informing how to interact with the prototype */}
      <div
        style={{
          marginBottom: "20px",
          textAlign: "center",
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          fontSize: "12px",
          color: "var(--muted, #666)",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--ink, #1a1a1a)" }}>
          Prototype {activeIndex + 1} of {VARIANTS.length}: {VARIANTS[activeIndex].name}
        </span>
        <span style={{ margin: "0 8px" }}>•</span>
        <span>{VARIANTS[activeIndex].axis}</span>
      </div>

      {/* Render the active variant in full size */}
      <div key={mountKey} style={{ animation: "protoEnter 180ms cubic-bezier(0.23, 1, 0.32, 1) forwards" }}>
        <ActiveComponent
          onSave={() => alert("Simulated save: Single source of truth updated & profile persisted!")}
          onClose={() => alert("Simulated close")}
        />
      </div>

      <style>{`
        @keyframes protoEnter {
          from {
            opacity: 0;
            transform: scale(0.97) translateY(4px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
      `}</style>

      {/* Verbatim Picker */}
      <Picker
        variants={VARIANTS}
        activeIndex={activeIndex}
        onSelect={handleSelect}
        onReplay={handleReplay}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PrototypeApp />
  </React.StrictMode>
);
