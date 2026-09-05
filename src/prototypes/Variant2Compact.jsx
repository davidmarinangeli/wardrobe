import { useState, useRef } from "react";
import {
  Check,
  GenderFemale,
  GenderMale,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import "./proto-styles.css";

export function Variant2Compact({ onSave, onClose }) {
  const [gender, setGender] = useState("man");
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
    <div className="proto-modal-surface" style={{ maxWidth: "440px" }}>
      {/* Header */}
      <div className="proto-header">
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#b5541a" }} />
          <h2 className="proto-header-title">Color Harmony Studio</h2>
        </div>
        <button type="button" className="proto-close-btn" onClick={onClose} aria-label="Close">
          <X size={14} weight="bold" />
        </button>
      </div>

      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
        {/* Compact Split Header: 100px Thumbnail + Season Stats */}
        <div
          style={{
            display: "flex",
            gap: "14px",
            alignItems: "stretch",
            padding: "12px",
            borderRadius: "12px",
            background: "rgba(0, 0, 0, 0.025)",
            border: "1px solid rgba(0, 0, 0, 0.06)",
          }}
        >
          {/* Macro Thumbnail with Gender Badge */}
          <div style={{ position: "relative", width: "110px", borderRadius: "8px", overflow: "hidden", flex: "none" }}>
            <img
              src={gender === "man" ? "/seasons/autumn_man.jpg" : "/seasons/autumn.jpg"}
              alt="Season crop"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            <button
              type="button"
              onClick={() => setGender(gender === "man" ? "woman" : "man")}
              style={{
                position: "absolute",
                bottom: "4px",
                right: "4px",
                padding: "2px 6px",
                borderRadius: "999px",
                background: "rgba(0,0,0,0.65)",
                color: "#fff",
                border: 0,
                fontSize: "10px",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                cursor: "pointer",
              }}
            >
              {gender === "man" ? <GenderMale size={11} /> : <GenderFemale size={11} />}
              {gender === "man" ? "M" : "W"}
            </button>
          </div>

          {/* Season Details */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600, color: "var(--ink, #1a1a1a)" }}>
                  Autunno Deep
                </h3>
                <span style={{ fontSize: "11px", color: "var(--muted, #666)" }}>
                  (Deep Autumn)
                </span>
              </div>
              <p style={{ margin: "2px 0 0", fontSize: "11.5px", color: "var(--accent-warm, #b5541a)", fontWeight: 520 }}>
                Warm Undertone • High Contrast
              </p>
            </div>

            {/* Micro Pigment Indicators */}
            <div style={{ display: "flex", gap: "4px", marginTop: "6px" }}>
              <span title="Skin: Neutral Warm Beige" style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", background: "#fff", padding: "2px 6px", borderRadius: "4px", border: "1px solid rgba(0,0,0,0.06)" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#D2A58D" }} />
                Skin
              </span>
              <span title="Eyes: Chestnut Brown" style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", background: "#fff", padding: "2px 6px", borderRadius: "4px", border: "1px solid rgba(0,0,0,0.06)" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#4E2E1A" }} />
                Eyes
              </span>
              <span title="Hair: Dark Espresso" style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", background: "#fff", padding: "2px 6px", borderRadius: "4px", border: "1px solid rgba(0,0,0,0.06)" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#2B201A" }} />
                Hair
              </span>
            </div>
          </div>
        </div>

        {/* 8 Signature Palette Swatches */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted, #888)" }}>
              Recommended Palette
            </span>
            <span style={{ fontSize: "10.5px", color: "var(--muted, #888)" }}>8 Colors</span>
          </div>
          <div className="proto-palette-row">
            {samplePalette.map((hex) => (
              <span key={hex} className="proto-swatch" style={{ backgroundColor: hex }} title={hex} />
            ))}
          </div>
        </div>

        {/* Permanent Inline Dropzone: Change Reference Photo */}
        <div
          className="proto-dropzone"
          style={{ padding: "10px 12px" }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => handleFileUpload(e.target.files?.[0])}
          />
          <div className="proto-dropzone-icon" style={{ width: "30px", height: "30px" }}>
            <UploadSimple size={15} />
          </div>
          <div className="proto-dropzone-text">
            <p className="proto-dropzone-title" style={{ fontSize: "12px" }}>
              {uploading ? "Updating reference on disk…" : "Replace face reference"}
            </p>
            <p className="proto-dropzone-hint" style={{ fontSize: "10.5px" }}>
              Drop a photo to re-derive your seasonal palette
            </p>
          </div>
        </div>
      </div>

      {/* Footer Actions */}
      <div style={{ padding: "10px 16px", borderTop: "1px solid rgba(0,0,0,0.06)", background: "rgba(0,0,0,0.02)", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button type="button" className="proto-btn proto-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="proto-btn proto-btn-primary" onClick={onSave}>
          <Check size={14} weight="bold" /> Apply Season
        </button>
      </div>
    </div>
  );
}
