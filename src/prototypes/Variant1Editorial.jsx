import { useState, useRef } from "react";
import {
  ArrowRight,
  Camera,
  Check,
  GenderFemale,
  GenderMale,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import "./proto-styles.css";

export function Variant1Editorial({ onSave, onClose }) {
  const [gender, setGender] = useState("man");
  const [showUploader, setShowUploader] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null);
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
      setPhotoPreview(dataUrl);
      // POST to single source of truth
      await fetch("/api/setup/reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "face", imageDataUrl: dataUrl }),
      });
      setShowUploader(false);
    } catch (e) {
      console.error(e);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="proto-modal-surface">
      {/* Header */}
      <div className="proto-header">
        <h2 className="proto-header-title">My Colors &amp; Armocromia</h2>
        <button type="button" className="proto-close-btn" onClick={onClose} aria-label="Close">
          <X size={14} weight="bold" />
        </button>
      </div>

      {/* Body with consistent 16px rhythm */}
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Editorial Macro Card */}
        <div
          style={{
            borderRadius: "14px",
            border: "1px solid rgba(0, 0, 0, 0.08)",
            background: "var(--paper-raised, #ffffff)",
            overflow: "hidden",
            boxShadow: "0 2px 10px rgba(0, 0, 0, 0.04)",
          }}
        >
          {/* Media Header */}
          <div style={{ position: "relative", width: "100%", aspectRatio: "16/9", background: "#f0ede6" }}>
            <img
              src={gender === "man" ? "/seasons/autumn_man.jpg" : "/seasons/autumn.jpg"}
              alt="Deep Autumn macro detail"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            {/* Top-Right Gender Toggle Pill */}
            <div style={{ position: "absolute", top: "10px", right: "10px" }}>
              <button
                type="button"
                className="proto-btn"
                style={{
                  background: "rgba(255, 255, 255, 0.85)",
                  backdropFilter: "blur(10px)",
                  padding: "0 10px",
                  height: "28px",
                  fontSize: "11px",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
                }}
                onClick={() => setGender(gender === "man" ? "woman" : "man")}
              >
                {gender === "man" ? <GenderMale size={13} weight="bold" /> : <GenderFemale size={13} weight="bold" />}
                {gender === "man" ? "Man" : "Woman"}
              </button>
            </div>
          </div>

          {/* Card Info Content (Strict 16px Padding) */}
          <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                <h3 style={{ margin: 0, fontSize: "20px", fontWeight: 600, color: "var(--ink, #1a1a1a)" }}>
                  Autunno Deep
                </h3>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 500,
                    letterSpacing: "0.04em",
                    color: "var(--muted, #737373)",
                    background: "rgba(0,0,0,0.04)",
                    padding: "2px 6px",
                    borderRadius: "999px",
                  }}
                >
                  Deep Autumn
                </span>
              </div>
              <span style={{ fontSize: "11px", color: "var(--accent-warm, #b5541a)", fontWeight: 550 }}>
                High Contrast • Warm Undertone
              </span>
            </div>

            <p style={{ margin: 0, fontSize: "12.5px", lineHeight: "1.45", color: "var(--muted, #666)" }}>
              Deep Autumn's rich, spiced, and opulent palette complements your dark espresso hair and warm brown eyes.
            </p>

            {/* Personal Pigment Receipts Strip */}
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "10px",
                background: "rgba(0,0,0,0.025)",
                border: "1px solid rgba(0,0,0,0.06)",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <span style={{ fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted, #888)" }}>
                Sampled Natural Pigments
              </span>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", background: "#fff", padding: "3px 8px", borderRadius: "999px", border: "1px solid rgba(0,0,0,0.08)" }}>
                  <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: "#D2A58D", display: "inline-block" }} />
                  Skin: Neutral Warm Beige
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", background: "#fff", padding: "3px 8px", borderRadius: "999px", border: "1px solid rgba(0,0,0,0.08)" }}>
                  <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: "#4E2E1A", display: "inline-block" }} />
                  Eyes: Chestnut Brown
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", background: "#fff", padding: "3px 8px", borderRadius: "999px", border: "1px solid rgba(0,0,0,0.08)" }}>
                  <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: "#2B201A", display: "inline-block" }} />
                  Hair: Dark Espresso
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Palette Section */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted, #888)" }}>
              Flattering Signature Colors (8)
            </span>
            <span style={{ fontSize: "11px", color: "var(--muted, #888)" }}>Tap to inspect</span>
          </div>
          <div className="proto-palette-row">
            {samplePalette.map((hex) => (
              <span key={hex} className="proto-swatch" style={{ backgroundColor: hex }} title={hex} />
            ))}
          </div>
        </div>

        {/* Change Reference Photo Drawer / Action */}
        {!showUploader ? (
          <button
            type="button"
            className="proto-btn proto-btn-secondary"
            style={{ width: "100%", justifyContent: "center" }}
            onClick={() => setShowUploader(true)}
          >
            <Camera size={14} /> Change Face Reference Photo
          </button>
        ) : (
          <div
            className="proto-dropzone"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => handleFileUpload(e.target.files?.[0])}
            />
            <div className="proto-dropzone-icon">
              <UploadSimple size={18} />
            </div>
            <div className="proto-dropzone-text">
              <p className="proto-dropzone-title">
                {uploading ? "Saving face reference…" : "Upload new face photo"}
              </p>
              <p className="proto-dropzone-hint">
                Updates model reference on disk &amp; re-derives palette
              </p>
            </div>
            <button
              type="button"
              className="proto-close-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowUploader(false);
              }}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(0,0,0,0.06)", background: "rgba(0,0,0,0.02)", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button type="button" className="proto-btn proto-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="proto-btn proto-btn-primary" onClick={onSave}>
          <Check size={14} weight="bold" /> Save Profile
        </button>
      </div>
    </div>
  );
}
