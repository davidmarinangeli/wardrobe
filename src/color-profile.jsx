import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard.js";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Sparkle,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import "./color-profile.css";
import { ViewerPanel } from "./components/ViewerPanel.jsx";
import { ModeledHero } from "./components/ModeledHero.jsx";
import { PanelActions } from "./components/PanelActions.jsx";
import { buildDrapePath, drapeDefs } from "../shared/draping.mjs";
import {
  SEASONS,
  getSeasonAsset,
  getSeasonDisplayNames,
  itemMatchesPalette,
  colorDistance,
  rgbToHex,
} from "../shared/color-seasons.mjs";

export { SEASONS, getSeasonAsset, getSeasonDisplayNames, itemMatchesPalette };

const PROFILE_STORAGE_KEY = "open-wardrobe-color-profile-v1";

const QUESTIONS = [
  {
    id: "veins",
    axis: "undertone",
    prompt: "The veins on the inside of your wrist look mostly:",
    options: [
      { label: "Green or olive", value: "warm" },
      { label: "Blue or purple", value: "cool" },
    ],
  },
  {
    id: "metal",
    axis: "undertone",
    prompt: "Which jewellery metal flatters your skin more?",
    options: [
      { label: "Gold or brass", value: "warm" },
      { label: "Silver or white gold", value: "cool" },
    ],
  },
  {
    id: "sun",
    axis: "undertone",
    prompt: "In the sun, you tend to:",
    options: [
      { label: "Tan easily, rarely burn", value: "warm" },
      { label: "Burn easily, tan slowly", value: "cool" },
    ],
  },
  {
    id: "contrast",
    axis: "clarity",
    prompt: "The contrast between your hair, eyes and skin is:",
    options: [
      { label: "High — clearly different in depth", value: "clear" },
      { label: "Soft — blended, gentle transitions", value: "muted" },
    ],
  },
  {
    id: "compliments",
    axis: "clarity",
    prompt: "You get the most compliments wearing:",
    options: [
      { label: "Bright, saturated or crisp colours", value: "clear" },
      { label: "Soft, smoky or heathered colours", value: "muted" },
    ],
  },
  {
    id: "eyes",
    axis: "clarity",
    prompt: "Your eye colour is:",
    options: [
      { label: "Deep or bright, distinct iris pattern", value: "clear" },
      { label: "Soft and hazy, blended tones", value: "muted" },
    ],
  },
];

const SEASON_BY_AXES = {
  "warm-clear": "spring-warm",
  "warm-muted": "autumn-warm",
  "cool-clear": "winter-cool",
  "cool-muted": "summer-cool",
};

function resolveSeason(answers) {
  const undertoneVotes = QUESTIONS.filter(
    (question) => question.axis === "undertone" && answers[question.id] === "warm"
  ).length;
  const clarityVotes = QUESTIONS.filter(
    (question) => question.axis === "clarity" && answers[question.id] === "clear"
  ).length;
  const undertone = undertoneVotes >= 2 ? "warm" : "cool";
  const clarity = clarityVotes >= 2 ? "clear" : "muted";
  return SEASON_BY_AXES[`${undertone}-${clarity}`] || "winter-cool";
}

export function readColorProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    if (!profile) return null;
    const resolvedSeason =
      SEASONS[profile.season] || SEASONS[profile.parentSeason] || SEASONS["winter-cool"];
    return {
      ...profile,
      season: resolvedSeason.id,
      palette: Array.isArray(profile.palette) ? profile.palette : resolvedSeason.palette || [],
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

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });

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
          .map((bucket) => ({
            red: Math.round(bucket.red / bucket.count),
            green: Math.round(bucket.green / bucket.count),
            blue: Math.round(bucket.blue / bucket.count),
            count: bucket.count,
          }))
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

/**
 * The portrait under one fabric. The drape is drawn in the browser from the
 * same geometry the server uses, so changing colour is instant and costs
 * nothing — no round trip, no image to regenerate.
 */
function DrapePortrait({ subject, color }) {
  const rawId = useId();
  const uid = `dp${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const outline = useMemo(
    () => buildDrapePath(subject.width, subject.height, subject.neck),
    [subject.width, subject.height, subject.neck]
  );

  return (
    <div
      className="drape-portrait"
      style={{ background: subject.hasCutout ? subject.ground : "transparent" }}
    >
      <img src={subject.url} alt="" className="drape-portrait-photo" />
      <svg
        className="drape-portrait-fabric"
        viewBox={`0 0 ${subject.width} ${subject.height}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs
          dangerouslySetInnerHTML={{
            __html: `${drapeDefs(uid)}<clipPath id="${uid}-clip"><path d="${outline}"/></clipPath>`,
          }}
        />
        <path d={outline} fill={color} filter={`url(#${uid}-lift)`} />
        <g clipPath={`url(#${uid}-clip)`}>
          <rect width={subject.width} height={subject.height} fill={color} />
          <rect width={subject.width} height={subject.height} fill={`url(#${uid}-sheen)`} />
          <rect width={subject.width} height={subject.height} fill={`url(#${uid}-fold)`} />
        </g>
      </svg>
    </div>
  );
}

const TEST_ORDER = ["temperature", "sisterDeep", "sisterSoft", "macro"];

/**
 * Side-by-side draping. A physical consultant holds two fabrics up at once
 * because the eye can only judge colour by comparison — so both candidates are
 * always on screen, the user's own pick is the primary action, and the AI is
 * offered as a second opinion rather than the only way to get an answer.
 */
function DrapeTest({ initialSetId = "sisterDeep", onApply, onBack }) {
  const [subject, setSubject] = useState(null);
  const [sets, setSets] = useState(null);
  const [setId, setSetId] = useState(initialSetId);
  const [fabricIndex, setFabricIndex] = useState(0);
  const [picked, setPicked] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAllTests, setShowAllTests] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/color-profile/drapes")
      .then((res) => {
        if (!res.ok) throw new Error("Could not prepare your photo for draping.");
        return res.json();
      })
      .then((data) => {
        if (!active) return;
        setSubject(data.subject);
        setSets(data.sets);
      })
      .catch((err) => active && setError(err.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const currentSet = sets?.[setId] || null;
  const candidates = currentSet?.candidates || [];
  const fabricCount = candidates[0]?.fabrics?.length || 1;
  const pickedCandidate = candidates.find((c) => c.id === picked) || null;

  const switchSet = (nextId) => {
    setSetId(nextId);
    setPicked(null);
    setVerdict(null);
    setFabricIndex(0);
    setError("");
    setShowAllTests(false);
  };

  const askForSecondOpinion = async () => {
    setAnalyzing(true);
    setError("");
    try {
      const res = await fetch("/api/color-profile/drapes/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setId, fabricIndex }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "The second opinion didn't come through.");
      setVerdict(result);
      if (result.winnerId) setPicked(result.winnerId);
    } catch (err) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return (
      <div className="drape-loading">
        <SpinnerGap size={24} className="color-spinner" />
        <p>Hanging the fabrics…</p>
      </div>
    );
  }

  if (!subject || !currentSet) {
    return (
      <div className="drape-empty">
        <p className="status error">{error || "Draping needs a photo of your face on file."}</p>
        <button className="secondary-button" type="button" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>
      </div>
    );
  }

  return (
    <div className="drape-test">
      <header className="drape-test-header">
        <h3>{currentSet.title}</h3>
        <p className="drape-question">{currentSet.question}</p>
      </header>

      <div className={`drape-grid ${candidates.length > 2 ? "is-quad" : "is-pair"}`}>
        {candidates.map((candidate) => {
          const isPicked = picked === candidate.id;
          const note = verdict?.candidateNotes?.find((n) => n.drapeId === candidate.id);
          return (
            <div key={candidate.id} className={`drape-option ${isPicked ? "is-picked" : ""}`}>
              <button
                type="button"
                className="drape-option-stage"
                onClick={() => setPicked(isPicked ? null : candidate.id)}
                aria-pressed={isPicked}
                aria-label={`${candidate.name} — ${candidate.subtitle}`}
                style={{ "--pick-accent": candidate.accent }}
              >
                <DrapePortrait
                  subject={subject}
                  color={candidate.fabrics[fabricIndex] || candidate.fabrics[0]}
                />
                {isPicked && (
                  <span className="drape-picked-flag">
                    <Check size={12} weight="bold" aria-hidden="true" />
                  </span>
                )}
              </button>
              <div className="drape-option-meta">
                <span className="drape-option-name">{candidate.name}</span>
                <span className="drape-option-sub">{candidate.subtitle}</span>
              </div>
              {note && <p className="drape-option-note">{note.reaction}</p>}
            </div>
          );
        })}
      </div>

      {fabricCount > 1 && (
        <div className="drape-fabric-row">
          <span className="drape-fabric-label">Fabric</span>
          <div className="drape-fabric-dots" role="group" aria-label="Swap fabric">
            {Array.from({ length: fabricCount }, (_, index) => (
              <button
                key={index}
                type="button"
                className={`drape-fabric-dot ${fabricIndex === index ? "is-active" : ""}`}
                onClick={() => setFabricIndex(index)}
                aria-label={`Fabric ${index + 1} of ${fabricCount}`}
                aria-pressed={fabricIndex === index}
              >
                <span className="drape-fabric-chip">
                  {candidates.map((candidate) => (
                    <span
                      key={candidate.id}
                      style={{ backgroundColor: candidate.fabrics[index] }}
                    />
                  ))}
                </span>
              </button>
            ))}
          </div>
          <span className="drape-fabric-names">
            {candidates.map((c) => c.fabricNames?.[fabricIndex]).filter(Boolean).join(" · ")}
          </span>
        </div>
      )}

      <p className="drape-hint">{currentSet.hint}</p>

      {verdict && (
        <div className="drape-verdict">
          <span className="drape-verdict-badge">
            <Sparkle size={11} weight="fill" aria-hidden="true" /> Second opinion
          </span>
          <p>{verdict.explanation}</p>
        </div>
      )}

      {error && <p className="status error drape-error">{error}</p>}

      <div className="drape-decide">
        {pickedCandidate?.seasonId ? (
          <button
            className="primary-button drape-apply"
            type="button"
            onClick={() => onApply(pickedCandidate.seasonId, verdict)}
          >
            <Check size={15} weight="bold" aria-hidden="true" />
            Use {pickedCandidate.name}
          </button>
        ) : pickedCandidate?.narrowsTo ? (
          <div className="drape-narrowed">
            <p>
              Your skin reads <strong>{pickedCandidate.narrowsTo}</strong>. That halves the
              twelve seasons — now find the depth.
            </p>
            <button className="primary-button" type="button" onClick={() => switchSet("macro")}>
              Compare the four seasons <ArrowRight size={14} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <p className="drape-decide-prompt">Pick the one that looks better on you.</p>
        )}

        {!verdict && (
          <button
            className="secondary-button drape-second-opinion"
            type="button"
            disabled={analyzing}
            onClick={askForSecondOpinion}
          >
            {analyzing ? (
              <>
                <SpinnerGap size={14} className="color-spinner" aria-hidden="true" /> Reading your
                skin…
              </>
            ) : (
              <>
                <Sparkle size={14} weight="fill" aria-hidden="true" /> Ask for a second opinion
              </>
            )}
          </button>
        )}
      </div>

      <div className="drape-other-tests">
        <button
          type="button"
          className="drape-disclosure"
          onClick={() => setShowAllTests((open) => !open)}
          aria-expanded={showAllTests}
        >
          Compare something else
          <span className={`drape-disclosure-caret ${showAllTests ? "is-open" : ""}`} aria-hidden="true" />
        </button>
        {showAllTests && (
          <div className="drape-test-list">
            {TEST_ORDER.filter((id) => sets[id] && id !== setId).map((id) => (
              <button key={id} type="button" className="drape-test-link" onClick={() => switchSet(id)}>
                {sets[id].title}
                <ArrowRight size={12} weight="bold" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="drape-footer">
        <button className="secondary-button" type="button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to my colours
        </button>
      </div>
    </div>
  );
}

const PARENT_GROUPS = [
  { id: "winter", label: "Winter", labelIt: "Inverno", accent: "#1B3F8B", seasons: ["winter-cool", "winter-deep", "winter-bright", "winter-true"] },
  { id: "autumn", label: "Autumn", labelIt: "Autunno", accent: "#9A3324", seasons: ["autumn-deep", "autumn-warm", "autumn-soft", "autumn-true"] },
  { id: "summer", label: "Summer", labelIt: "Estate", accent: "#7E93AC", seasons: ["summer-light", "summer-cool", "summer-soft", "summer-true"] },
  { id: "spring", label: "Spring", labelIt: "Primavera", accent: "#FF6F59", seasons: ["spring-bright", "spring-warm", "spring-light", "spring-true"] },
];

function CertifiedSeasonPicker({ onSelect, onCancel }) {
  return (
    <div className="certified-picker">
      <header className="certified-picker-header">
        <h3>Pick your season</h3>
        <p>
          If you've had an in-person consultation, choose what you were given and we'll use that
          palette instead of ours.
        </p>
      </header>

      <div className="certified-groups">
        {PARENT_GROUPS.map((group) => (
          <section key={group.id} className="certified-group">
            <h4 className="certified-group-title" style={{ color: group.accent }}>
              {group.label} <span className="certified-group-alt">{group.labelIt}</span>
            </h4>
            <div className="certified-grid">
              {group.seasons.map((seasonId) => {
                const season = SEASONS[seasonId];
                if (!season) return null;
                const { primary, secondary } = getSeasonDisplayNames(season);
                return (
                  <button
                    key={seasonId}
                    type="button"
                    className="certified-card"
                    onClick={() => onSelect(seasonId)}
                  >
                    <span className="certified-card-name">{primary}</span>
                    <span className="certified-card-sub">{secondary}</span>
                    <span className="certified-strip">
                      {season.palette.map((color) => (
                        <span key={color} style={{ backgroundColor: color }} />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="certified-footer">
        <button className="secondary-button" type="button" onClick={onCancel}>
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
      </div>
    </div>
  );
}

/**
 * The palette is the answer the user came for, so it reads as a finished object
 * by default. Editing is real but opt-in — otherwise eight delete badges and an
 * extract control shout louder than the colours themselves.
 */
function PaletteSection({ palette, onRemove, onAdd }) {
  const fileInputRef = useRef(null);
  const [editing, setEditing] = useState(false);
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
      setCandidates(
        extracted.filter(
          (hex) => !palette.some((existing) => existing.toLowerCase() === hex.toLowerCase())
        )
      );
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
    <section className="palette-section">
      <div className="palette-head">
        <p className="details-label">Your palette</p>
        <button
          type="button"
          className="palette-edit-toggle"
          onClick={() => {
            setEditing((open) => !open);
            setCandidates([]);
          }}
          aria-expanded={editing}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>

      <div className={`palette-swatches ${editing ? "is-editing" : ""}`}>
        {palette.map((color) => (
          <span className="palette-swatch" key={color} style={{ backgroundColor: color }} title={color}>
            {editing && (
              <button type="button" onClick={() => onRemove(color)} aria-label={`Remove ${color}`}>
                <X size={10} weight="bold" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        {!palette.length && <p className="palette-empty">No colours yet.</p>}
      </div>

      {editing && (
        <div className="palette-edit-body">
          <button
            type="button"
            className="palette-extract"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            {busy ? "Reading photo…" : "Add colours from a photo"}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFile} />

          {error && <p className="status error palette-error">{error}</p>}

          {!!candidates.length && (
            <div className="palette-candidates">
              <p className="palette-candidates-label">Tap to add:</p>
              <div className="palette-swatches">
                {candidates.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="palette-candidate"
                    style={{ backgroundColor: color }}
                    onClick={() => addCandidate(color)}
                    aria-label={`Add ${color}`}
                    title={color}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function ColorProfileModal({ onClose, onSave, initialProfile }) {
  const closeButtonRef = useRef(null);
  const faceUploadRef = useRef(null);
  useViewerKeyboard(onClose, closeButtonRef);

  const [mode, setMode] = useState(() => (initialProfile?.season ? "result" : "checking"));
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [answers, setAnswers] = useState(initialProfile?.answers || {});
  const [resultSeason, setResultSeason] = useState(initialProfile?.season || null);
  const [profileData, setProfileData] = useState(initialProfile || null);
  const [genderView, setGenderView] = useState(initialProfile?.gender || "woman");
  const [palette, setPalette] = useState(() => {
    if (initialProfile?.palette?.length) return initialProfile.palette;
    if (initialProfile?.season && SEASONS[initialProfile.season]) {
      return SEASONS[initialProfile.season].palette;
    }
    return [];
  });
  const [openQuestion, setOpenQuestion] = useState(null);

  useEffect(() => {
    let active = true;
    fetch("/api/color-profile/status")
      .then((res) => res.json())
      .then((status) => active && setOpenQuestion(status.openQuestion || null))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (initialProfile?.season) {
      applyProfile(initialProfile);
      setMode("result");
      return;
    }

    let active = true;
    async function checkAndAnalyze() {
      setMode("checking");
      setAnalysisError("");
      try {
        const statusRes = await fetch("/api/color-profile/status");
        if (!statusRes.ok) throw new Error("Could not check status");
        const status = await statusRes.json();
        if (!active) return;

        if (status.hasProfile && status.profile?.season) {
          applyProfile(status.profile);
          setMode("result");
          return;
        }

        if (status.hasReference) {
          setMode("analyzing");
          setAnalyzing(true);
          const analyzeRes = await fetch("/api/color-profile/analyze");
          if (!analyzeRes.ok) {
            const err = await analyzeRes.json().catch(() => ({}));
            throw new Error(err.error || "Colour analysis failed");
          }
          const data = await analyzeRes.json();
          if (!active) return;
          applyProfile(data.profile);
          setMode("result");
        } else {
          setMode("quiz");
        }
      } catch (err) {
        if (!active) return;
        setAnalysisError(err.message);
        setMode("quiz");
      } finally {
        if (active) setAnalyzing(false);
      }
    }

    checkAndAnalyze();
    return () => {
      active = false;
    };
  }, [initialProfile]);

  const applyProfile = (data) => {
    setProfileData(data);
    const seasonId = data.season || data.parentSeason || "winter-cool";
    const resolved = SEASONS[seasonId] || SEASONS["winter-cool"];
    setResultSeason(resolved.id);
    if (data.gender) setGenderView(data.gender);
    setPalette(data.palette?.length ? [...data.palette] : [...resolved.palette]);
  };

  const handleUpdateFacePhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setMode("analyzing");
    setAnalyzing(true);
    setAnalysisError("");
    try {
      const imageDataUrl = await fileToDataUrl(file);
      const saveRes = await fetch("/api/setup/reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "face", imageDataUrl }),
      });
      if (!saveRes.ok) throw new Error("Could not save that photo.");

      const analyzeRes = await fetch("/api/color-profile/analyze");
      if (!analyzeRes.ok) {
        const err = await analyzeRes.json().catch(() => ({}));
        throw new Error(err.error || "Analysis failed");
      }
      const data = await analyzeRes.json();
      applyProfile(data.profile);
      setMode("result");
    } catch (err) {
      setAnalysisError(err.message);
      setMode("result");
    } finally {
      setAnalyzing(false);
    }
  };

  const answerQuestion = (id, value) => {
    const next = { ...answers, [id]: value };
    setAnswers(next);
    if (QUESTIONS.every((question) => next[question.id])) {
      const season = resolveSeason(next);
      const resolved = SEASONS[season] || SEASONS["winter-cool"];
      setResultSeason(resolved.id);
      setPalette([...resolved.palette]);
      setMode("result");
    }
  };

  const removeColor = (color) =>
    setPalette((current) => current.filter((existing) => existing !== color));
  const addColor = (color) =>
    setPalette((current) =>
      current.some((existing) => existing.toLowerCase() === color.toLowerCase())
        ? current
        : [...current, color]
    );

  /**
   * Picking a season from a drape test or the certified list stages the change
   * and drops the user back on their result, where they can see what it did.
   * Nothing is written until Save, so Cancel still cancels.
   */
  const applySeasonId = (seasonId, verdict) => {
    const season = SEASONS[seasonId] || SEASONS["winter-cool"];
    applyProfile({
      ...(profileData || {}),
      season: season.id,
      parentSeason: season.parentSeason,
      palette: [...season.palette],
      description: verdict?.explanation || season.description,
    });
    setOpenQuestion(null);
    setMode("result");
  };

  const applyResult = async () => {
    const resolved = SEASONS[resultSeason] || SEASONS["winter-cool"];
    const profile = {
      ...profileData,
      season: resolved.id,
      parentSeason: resolved.parentSeason,
      gender: genderView,
      answers,
      palette,
    };
    persistColorProfile(profile);
    try {
      await fetch("/api/color-profile/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
    } catch {}
    onSave(profile);
  };

  const currentSeason =
    resultSeason && SEASONS[resultSeason] ? SEASONS[resultSeason] : SEASONS["winter-cool"];
  const { primary: titlePrimary, secondary: titleSecondary } = getSeasonDisplayNames(currentSeason);
  const userTones = profileData?.userTones;
  const answeredCount = QUESTIONS.filter((question) => answers[question.id]).length;

  const panelTitle =
    mode === "result"
      ? undefined
      : mode === "drapes"
        ? "Drape test"
        : mode === "certified"
          ? "Pick your season"
          : "My colours";

  return (
    <ViewerPanel
      title={panelTitle}
      ariaLabel="My colours"
      onClose={onClose}
      closeRef={closeButtonRef}
      entryClassName={`color-quiz-entry${mode === "drapes" ? " is-wide" : ""}`}
      panelClassName={
        mode === "result" ? "has-modeled-image color-viewer-panel" : "color-viewer-panel"
      }
    >
      {mode === "certified" ? (
        <CertifiedSeasonPicker
          onSelect={(seasonId) => applySeasonId(seasonId)}
          onCancel={() => setMode("result")}
        />
      ) : mode === "drapes" ? (
        <DrapeTest
          initialSetId={openQuestion?.setId || "sisterDeep"}
          onApply={applySeasonId}
          onBack={() => setMode("result")}
        />
      ) : mode === "analyzing" || mode === "checking" ? (
        <div className="color-analyzing-state">
          <div className="color-scanner-pulse">
            <Sparkle size={28} weight="fill" className="color-scanner-icon" aria-hidden="true" />
          </div>
          <h3>Reading your colouring</h3>
          <p>Sampling skin undertone, eye clarity and hair depth from your photo…</p>
        </div>
      ) : mode === "quiz" ? (
        <div className="color-quiz-body">
          {analysisError && (
            <div className="color-quiz-alert">
              <span>{analysisError}</span>
            </div>
          )}
          <div className="color-quiz-header-banner">
            <p className="color-quiz-intro">
              Six questions to place your undertone and seasonal palette. {answeredCount} of{" "}
              {QUESTIONS.length} answered.
            </p>
          </div>
          {QUESTIONS.map((question) => (
            <QuizStep
              key={question.id}
              question={question}
              value={answers[question.id]}
              onAnswer={(value) => answerQuestion(question.id, value)}
            />
          ))}
          <PanelActions
            onCancel={onClose}
            cancelLabel="Cancel"
            onConfirm={applyResult}
            confirmDisabled={!resultSeason}
            confirmLabel="Save"
          />
        </div>
      ) : (
        <>
          <ModeledHero
            src={getSeasonAsset(currentSeason.id, genderView)}
            alt={`${titlePrimary} editorial macro detail`}
            showHeading={false}
          />

          <div className="viewer-details editing color-viewer-details">
            {analysisError && <p className="status error">{analysisError}</p>}

            <div className="color-title-row">
              <div className="color-title-names">
                <h2 className="color-season-title">{titlePrimary}</h2>
                {titleSecondary && <span className="color-season-alt">{titleSecondary}</span>}
              </div>
              <div
                className="ai-mode-switch__pill"
                role="radiogroup"
                aria-label="Reference model presentation"
              >
                <button
                  type="button"
                  className={genderView === "man" ? "active" : ""}
                  aria-pressed={genderView === "man"}
                  onClick={() => setGenderView("man")}
                >
                  Man
                </button>
                <button
                  type="button"
                  className={genderView === "woman" ? "active" : ""}
                  aria-pressed={genderView === "woman"}
                  onClick={() => setGenderView("woman")}
                >
                  Woman
                </button>
              </div>
            </div>

            <p className="color-season-description">
              {profileData?.description || currentSeason.description}
            </p>

            <PaletteSection palette={palette} onRemove={removeColor} onAdd={addColor} />

            {/* Only shown when the reading is genuinely unsettled — a neutral
                undertone, or a season sitting on a sister boundary. */}
            {openQuestion && (
              <button
                type="button"
                className="color-open-question"
                onClick={() => setMode("drapes")}
              >
                <span className="color-open-question-body">
                  <span className="color-open-question-label">Still an open question</span>
                  <span className="color-open-question-text">{openQuestion.reason}</span>
                </span>
                <span className="color-open-question-cta">
                  Try the drape test <ArrowRight size={13} weight="bold" aria-hidden="true" />
                </span>
              </button>
            )}

            {userTones && (
              <section className="color-details-section">
                <p className="details-label">Your colouring</p>
                <div className="color-pigments-row">
                  {userTones.skin && (
                    <span className="color-pigment-chip" title={userTones.skin.hex}>
                      <span
                        className="color-pigment-dot"
                        style={{ backgroundColor: userTones.skin.hex }}
                      />
                      Skin {userTones.skin.name}
                    </span>
                  )}
                  {userTones.eyes && (
                    <span className="color-pigment-chip" title={userTones.eyes.hex}>
                      <span
                        className="color-pigment-dot"
                        style={{ backgroundColor: userTones.eyes.hex }}
                      />
                      Eyes {userTones.eyes.name}
                    </span>
                  )}
                  {userTones.hair && (
                    <span className="color-pigment-chip" title={userTones.hair.hex}>
                      <span
                        className="color-pigment-dot"
                        style={{ backgroundColor: userTones.hair.hex }}
                      />
                      Hair {userTones.hair.name}
                    </span>
                  )}
                </div>
              </section>
            )}

            {/* Escape hatches. Text links, because none of these is the thing
                most people open this panel to do. */}
            <div className="color-more-actions">
              {!openQuestion && (
                <button type="button" onClick={() => setMode("drapes")}>
                  <Sparkle size={13} weight="fill" aria-hidden="true" /> Drape test
                </button>
              )}
              <button type="button" onClick={() => faceUploadRef.current?.click()} disabled={analyzing}>
                <Camera size={13} aria-hidden="true" /> Change photo
              </button>
              <input
                ref={faceUploadRef}
                type="file"
                accept="image/*"
                hidden
                onChange={handleUpdateFacePhoto}
              />
              <button type="button" onClick={() => setMode("certified")}>
                I know my season
              </button>
              <button type="button" onClick={() => setMode("quiz")}>
                Take the quiz
              </button>
            </div>

            <PanelActions
              onCancel={onClose}
              cancelLabel="Cancel"
              onConfirm={applyResult}
              confirmIcon={<Check size={15} weight="bold" aria-hidden="true" />}
              confirmLabel="Save"
            />
          </div>
        </>
      )}
    </ViewerPanel>
  );
}
