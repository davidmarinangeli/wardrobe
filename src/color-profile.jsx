import { useRef, useState } from "react";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import { Check, X } from "@phosphor-icons/react";
import "./color-profile.css";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { PanelActions } from "./components/PanelActions.jsx";

const PROFILE_STORAGE_KEY = "open-wardrobe-color-profile-v1";
const MATCH_THRESHOLD = 60;

export const SEASONS = {
  spring: {
    id: "spring",
    label: "Spring",
    description: "Warm and clear — think golden light, peach, coral, and grass green.",
    accent: "#F5B700",
    palette: ["#FF6F59", "#F5B700", "#7AC74F", "#2FC3B2", "#FFB27A", "#C68954", "#3FBAC2", "#F2542D"],
  },
  summer: {
    id: "summer",
    label: "Summer",
    description: "Cool and soft — think lavender, powder blue, dusty rose, and seafoam.",
    accent: "#7E93AC",
    palette: ["#A9C6D8", "#B7A6D9", "#D69AA6", "#7E93AC", "#9C7E93", "#8FBFAE", "#A8547A", "#B7B4B8"],
  },
  autumn: {
    id: "autumn",
    label: "Autumn",
    description: "Warm and muted — think rust, olive, mustard, and chocolate brown.",
    accent: "#B5541A",
    palette: ["#B5541A", "#6B6B2A", "#D3A02C", "#5A3A22", "#C1602A", "#3F5B39", "#C1663D", "#A9793D"],
  },
  winter: {
    id: "winter",
    label: "Winter",
    description: "Cool and clear — think true red, emerald, royal blue, and black.",
    accent: "#1B3F8B",
    palette: ["#C8102E", "#00693E", "#1B3F8B", "#101010", "#C6017E", "#A9D6E5", "#FFFFFF", "#2B2B2E"],
  },
};

const QUESTIONS = [
  { id: "veins", axis: "undertone", prompt: "The veins on the inside of your wrist look mostly:", options: [
    { label: "Green", value: "warm" },
    { label: "Blue or purple", value: "cool" },
  ] },
  { id: "metal", axis: "undertone", prompt: "Which metal flatters you more?", options: [
    { label: "Gold", value: "warm" },
    { label: "Silver", value: "cool" },
  ] },
  { id: "sun", axis: "undertone", prompt: "In the sun, you tend to:", options: [
    { label: "Tan easily, rarely burn", value: "warm" },
    { label: "Burn easily, tan slowly", value: "cool" },
  ] },
  { id: "contrast", axis: "clarity", prompt: "The contrast between your hair and skin is:", options: [
    { label: "High — they're quite different in depth", value: "clear" },
    { label: "Low — they blend closely together", value: "muted" },
  ] },
  { id: "compliments", axis: "clarity", prompt: "You get the most compliments wearing:", options: [
    { label: "Bright, vivid, saturated colors", value: "clear" },
    { label: "Soft, dusty, muted colors", value: "muted" },
  ] },
  { id: "eyes", axis: "clarity", prompt: "Your eyes are:", options: [
    { label: "Bright and clear, high contrast in the iris", value: "clear" },
    { label: "Soft and gentle, blended tones", value: "muted" },
  ] },
];

const SEASON_BY_AXES = {
  "warm-clear": "spring",
  "warm-muted": "autumn",
  "cool-clear": "winter",
  "cool-muted": "summer",
};

function resolveSeason(answers) {
  const undertoneVotes = QUESTIONS.filter((question) => question.axis === "undertone" && answers[question.id] === "warm").length;
  const clarityVotes = QUESTIONS.filter((question) => question.axis === "clarity" && answers[question.id] === "clear").length;
  const undertone = undertoneVotes >= 2 ? "warm" : "cool";
  const clarity = clarityVotes >= 2 ? "clear" : "muted";
  return SEASON_BY_AXES[`${undertone}-${clarity}`];
}

export function readColorProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    if (!profile) return null;
    return {
      ...profile,
      palette: Array.isArray(profile.palette) ? profile.palette : (SEASONS[profile.season]?.palette || []),
      showBadges: profile.showBadges !== false,
    };
  } catch {
    return null;
  }
}

function persistColorProfile(profile) {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

export function clearColorProfile() {
  localStorage.removeItem(PROFILE_STORAGE_KEY);
}

function hexToRgb(hex) {
  const value = (hex || "").replace("#", "");
  return {
    red: Number.parseInt(value.slice(0, 2), 16) || 0,
    green: Number.parseInt(value.slice(2, 4), 16) || 0,
    blue: Number.parseInt(value.slice(4, 6), 16) || 0,
  };
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(((first.red - second.red) ** 2) + ((first.green - second.green) ** 2) + ((first.blue - second.blue) ** 2));
}

export function itemMatchesPalette(item, profile) {
  if (!profile?.palette?.length) return false;
  const colors = [item.color, item.secondaryColor].filter(Boolean);
  return colors.some((hex) => profile.palette.some((paletteHex) => colorDistance(hexToRgb(hex), hexToRgb(paletteHex)) <= MATCH_THRESHOLD));
}

function extractColorsFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const size = 72;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        const buckets = new Map();
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] < 200) continue;
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
          const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
          current.red += red;
          current.green += green;
          current.blue += blue;
          current.count += 1;
          buckets.set(key, current);
        }
        const ranked = [...buckets.values()]
          .map((bucket) => ({ red: Math.round(bucket.red / bucket.count), green: Math.round(bucket.green / bucket.count), blue: Math.round(bucket.blue / bucket.count), count: bucket.count }))
          .sort((a, b) => b.count - a.count);
        const selected = [];
        for (const color of ranked) {
          if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
          if (selected.length === 8) break;
        }
        resolve(selected.map((color) => rgbToHex(color.red, color.green, color.blue)));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    image.src = url;
  });
}

function QuizStep({ question, value, onAnswer }) {
  return (
    <fieldset className="color-quiz-step">
      <legend>{question.prompt}</legend>
      <div className="color-quiz-options">
        {question.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "active" : ""}
            onClick={() => onAnswer(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function PaletteEditor({ palette, onRemove, onAdd }) {
  const fileInputRef = useRef(null);
  const [candidates, setCandidates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const extracted = await extractColorsFromFile(file);
      setCandidates(extracted.filter((hex) => !palette.some((existing) => existing.toLowerCase() === hex.toLowerCase())));
    } catch (extractError) {
      setError(extractError.message);
    } finally {
      setBusy(false);
    }
  };

  const addCandidate = (color) => {
    onAdd(color);
    setCandidates((current) => current.filter((existing) => existing !== color));
  };

  return (
    <div className="palette-editor">
      <div className="palette-editor-heading">
        <span>Your palette</span>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
          {busy ? "Reading photo…" : "Add colors from a photo"}
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFile} />
      </div>

      <div className="palette-swatches">
        {palette.map((color) => (
          <span className="palette-swatch" key={color} style={{ backgroundColor: color }}>
            <button type="button" onClick={() => onRemove(color)} aria-label={`Remove ${color}`}>
              <X size={10} weight="bold" aria-hidden="true" />
            </button>
          </span>
        ))}
        {!palette.length && <p className="palette-empty">No colors yet — add some from a photo.</p>}
      </div>

      {error && <p className="status error palette-error">{error}</p>}

      {!!candidates.length && (
        <div className="palette-candidates">
          <p className="palette-candidates-label">Tap a color to add it:</p>
          <div className="palette-swatches">
            {candidates.map((color) => (
              <button key={color} type="button" className="palette-candidate" style={{ backgroundColor: color }} onClick={() => addCandidate(color)} aria-label={`Add ${color}`} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ColorProfileModal({ onClose, onSave, initialProfile }) {
  const closeButtonRef = useRef(null);
  useViewerKeyboard(onClose, closeButtonRef);
  const [answers, setAnswers] = useState(initialProfile?.answers || {});
  const [result, setResult] = useState(initialProfile?.season || null);
  const [palette, setPalette] = useState(() => initialProfile?.palette || (initialProfile?.season ? SEASONS[initialProfile.season].palette : []));
  const [showBadges, setShowBadges] = useState(initialProfile?.showBadges ?? true);

  const answerQuestion = (id, value) => {
    const next = { ...answers, [id]: value };
    setAnswers(next);
    if (QUESTIONS.every((question) => next[question.id])) {
      const season = resolveSeason(next);
      setResult(season);
      setPalette([...SEASONS[season].palette]);
    }
  };

  const restart = () => {
    setAnswers({});
    setResult(null);
  };

  const removeColor = (color) => setPalette((current) => current.filter((existing) => existing !== color));
  const addColor = (color) => setPalette((current) => current.some((existing) => existing.toLowerCase() === color.toLowerCase()) ? current : [...current, color]);

  const applyResult = () => {
    const profile = { season: result, answers, palette, showBadges };
    persistColorProfile(profile);
    onSave(profile);
  };

  const answeredCount = QUESTIONS.filter((question) => answers[question.id]).length;

  return (
    <ViewerPanel title="My Colors" ariaLabel="My Colors" onClose={onClose} closeRef={closeButtonRef} entryClassName="color-quiz-entry" panelClassName="color-quiz">
      {!result ? (
        <div className="color-quiz-body">
          <p className="color-quiz-intro">Answer a few quick questions about your natural coloring to find your season palette. {answeredCount}/{QUESTIONS.length} answered.</p>
          {QUESTIONS.map((question) => (
            <QuizStep key={question.id} question={question} value={answers[question.id]} onAnswer={(value) => answerQuestion(question.id, value)} />
          ))}
        </div>
      ) : (
        <div className="color-quiz-result">
          <div className="season-result">
            <h3>{SEASONS[result].label}</h3>
            <p>{SEASONS[result].description}</p>
          </div>

          <PaletteEditor palette={palette} onRemove={removeColor} onAdd={addColor} />

          <label className="palette-toggle">
            <input type="checkbox" checked={showBadges} onChange={(event) => setShowBadges(event.target.checked)} />
            <span>Show palette matches on wardrobe items</span>
          </label>

          <PanelActions onCancel={restart} cancelLabel="Retake quiz" onConfirm={applyResult} confirmIcon={<Check size={15} weight="bold" aria-hidden="true" />} confirmLabel="Save" />
        </div>
      )}
    </ViewerPanel>
  );
}
