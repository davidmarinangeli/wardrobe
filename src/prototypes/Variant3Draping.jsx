import { useState, useRef } from "react";
import {
  Camera,
  Check,
  GenderFemale,
  GenderMale,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import "./proto-styles.css";

export function Variant3Draping({ onSave, onClose }) {
  const [gender, setGender] = useState("man");
  const [selectedColor, setSelectedColor] = useState("#9E472A");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const samplePalette = [
    "#2D4739", "#9E472A", "#C08A3E", "#1A535C",
    "#5C1D24", "#556B2F", "#3B2319", "#E6D7C3",
  ];

  const handleFileUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise((res, rej) => {
        reader.onload = () => res(reader.result);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      await fetch("/api/setup/reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "face", imageDataUrl: dataUrl }),
      });
    } catch (e) {
      console.error(e);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="proto-modal-surface" style={{ maxWidth: "450px" }}>
      {/* Header */}
      <div className="proto-header">
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <Sparkle size={16} weight="fill" color="#b5541a" />
          <h2 className="proto-header-title">Virtual Draping Mirror</h2>
        </div>
        <button type="button" className="proto-close-btn" onClick={onClose} aria-label="Close">
          <X size={14} weight="bold" />
        </button>
      </div>

      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Interactive Drape Stage: Background color responds to selected palette color! */}
        <div
          style={{
            position: "relative",
            borderRadius: "16px",
            padding: "20px 16px",
            background: `radial-gradient(circle at 50% 50%, ${selectedColor}33 0%, ${selectedColor}11 100%)`,
            border: `1.5px solid ${selectedColor}55`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
            transition: "background 350ms var(--ease-out, ease-out), border-color 350ms var(--ease-out, ease-out)",
          }}
        >
          {/* Central Macro Detail */}
          <div
            style={{
              position: "relative",
              width: "100%",
              aspectRatio: "16/9",
              borderRadius: "12px",
              overflow: "hidden",
              boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
              border: "1px solid rgba(255,255,255,0.8)",
            }}
          >
            <img
              src={gender === "man" ? "/seasons/autumn_man.jpg" : "/seasons/autumn.jpg"}
              alt="Draping preview"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            {/* Quick Swap Photo Button overlay */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Replace face reference on disk"
              style={{
                position: "absolute",
                top: "8px",
                left: "8px",
                background: "rgba(0,0,0,0.65)",
                color: "#fff",
                border: 0,
                borderRadius: "999px",
                padding: "3px 8px",
                fontSize: "10.5px",
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                cursor: "pointer",
              }}
            >
              <Camera size={12} /> {uploading ? "Saving…" : "New Photo"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => handleFileUpload(e.target.files?.[0])}
            />

            {/* Gender Toggle */}
            <button
              type="button"
              onClick={() => setGender(gender === "man" ? "woman" : "man")}
              style={{
                position: "absolute",
                top: "8px",
                right: "8px",
                background: "rgba(255,255,255,0.85)",
                backdropFilter: "blur(8px)",
                color: "#1a1a1a",
                border: 0,
                borderRadius: "999px",
                padding: "3px 8px",
                fontSize: "10.5px",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                cursor: "pointer",
              }}
            >
              {gender === "man" ? <GenderMale size={12} /> : <GenderFemale size={12} />}
              {gender === "man" ? "Man" : "Woman"}
            </button>
          </div>

          {/* Draping Status Pill */}
          <div style={{ textAlign: "center" }}>
            <span style={{ fontSize: "14px", fontWeight: 650, color: "var(--ink, #1a1a1a)" }}>
              Autunno Deep
            </span>
            <span style={{ fontSize: "12px", color: "var(--muted, #666)", marginLeft: "6px" }}>
              (Deep Autumn)
            </span>
            <p style={{ margin: "2px 0 0", fontSize: "11px", color: "var(--muted, #777)" }}>
              Testing drape color: <strong style={{ color: selectedColor }}>{selectedColor}</strong>
            </p>
          </div>
        </div>

        {/* Tactile Swatch Bar: Tap to drape! */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted, #888)" }}>
              Tap a color to test drape
            </span>
            <span style={{ fontSize: "11px", color: "var(--accent-warm, #b5541a)", fontWeight: 500 }}>
              Harmonious
            </span>
          </div>
          <div className="proto-palette-row">
            {samplePalette.map((hex) => (
              <span
                key={hex}
                className="proto-swatch"
                style={{
                  backgroundColor: hex,
                  transform: selectedColor === hex ? "scale(1.18)" : undefined,
                  boxShadow: selectedColor === hex ? "0 0 0 2px #fff, 0 0 0 4px #1a1a1a" : undefined,
                  zIndex: selectedColor === hex ? 2 : 1,
                }}
                onClick={() => setSelectedColor(hex)}
                title={hex}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(0,0,0,0.06)", background: "rgba(0,0,0,0.02)", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button type="button" className="proto-btn proto-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="proto-btn proto-btn-primary" onClick={onSave}>
          <Check size={14} weight="bold" /> Save Palette
        </button>
      </div>
    </div>
  );
}
