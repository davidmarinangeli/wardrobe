// PROTOTYPE — throwaway. Three answers to one question:
//
//   "The critique reads as a wall of text. What gives it hierarchy, and is a
//    score a safe way to make it speak clearly?"
//
// Rendered inside the real Mirror panel on the real route, against a real
// critique, gated on ?mirrorVariant=. Nothing here is production code: no
// tests, no error handling, and the score in variant C is deliberately
// fabricated so it can be judged rather than argued about.
//
//   A — Lede      hierarchy only, no verdict device. The honest baseline.
//   B — Read      the register as a headline. A characterisation, not a rating.
//   C — Scored    an actual number, so the danger is visible rather than theoretical.

import { OptimizedImage } from "../../OptimizedImage.jsx";
import "./proto-mirror.css";

// ---------------------------------------------------------------------------
// Shared: emphasise the garments a sentence is actually about
// ---------------------------------------------------------------------------

// The single biggest cause of the wall-of-text feeling is that every word in a
// summary carries the same weight, including the two or three words naming the
// pieces the sentence is about. The critique now ships the garment list, so the
// nouns can be found in the prose and lifted out of it.
//
// FINDING (first run): emphasising every CITED garment was worse than none. A
// sentence naming five pieces came back with five bold nouns in it, which is
// the same undifferentiated wall one weight louder. Only the garment the
// finding is actually pinned to gets emphasis now — one anchor per sentence,
// and it happens to be the piece you would act on.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A summary rarely repeats a garment's description word for word — the judge
// writes "the mesh tank" for a "mesh tank top", "suede boots" for "suede work
// boots". So each description contributes every contiguous phrase of two or
// more words plus its head noun, longest first, and the first one that appears
// in the sentence wins.
function phrasesFor(description) {
  const words = description.toLowerCase().split(/\s+/).filter(Boolean);
  const phrases = [];
  for (let size = words.length; size >= 2; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) phrases.push(words.slice(start, start + size).join(" "));
  }
  const head = words[words.length - 1];
  if (head && head.length > 3) phrases.push(head);
  return phrases;
}

function Emphasised({ text, garments = [], indices = [] }) {
  const names = [...new Set(indices.flatMap((index) => (garments[index]?.description ? phrasesFor(garments[index].description) : [])))]
    .sort((a, b) => b.length - a.length);
  if (!names.length) return text;

  const pattern = new RegExp(`(${names.map(escapeRe).join("|")})`, "gi");
  return text.split(pattern).map((part, index) =>
    names.some((name) => name.toLowerCase() === part.toLowerCase())
      ? <b key={index}>{part}</b>
      : <span key={index}>{part}</span>,
  );
}

const Remedy = ({ remedy, itemMap }) => {
  if (!remedy) return null;
  if (remedy.action === "none") {
    return <p className="pm-guidance">{remedy.guidance || "Nothing in your wardrobe swaps in cleanly for this one."}</p>;
  }
  if (remedy.action === "remove") {
    return <p className="pm-guidance"><b>Leave the {remedy.target} off.</b> {remedy.reason}</p>;
  }
  const item = itemMap[remedy.itemId];
  if (!item) return null;
  return (
    <div className="pm-swap">
      <div className="pm-swap__thumb">
        <OptimizedImage src={item.thumbnail || item.image} alt="" sizes="44px" breakpoints={[44, 88]} />
      </div>
      <div>
        <p className="pm-swap__name"><b>{item.name}</b></p>
        <p className="pm-swap__reason">{remedy.reason}</p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// A — Lede
// ---------------------------------------------------------------------------
// Hierarchy from typography alone, no new device. One large opening line with
// the finding names lifted out of it, then the findings as headed blocks. Tests
// whether the wall of text was ever a structure problem or only a weight one.

export function VariantLede({ critique, itemMap }) {
  return (
    <div className="pm pm--lede">
      <p className="pm-lede">
        {critique.issues.length === 0
          ? <>This works — <b>nothing here is fighting itself.</b></>
          : <>{critique.issues.length === 1 ? "One thing" : `${critique.issues.length} things`} worth a look: {critique.issues.map((issue, index) => (
              <span key={issue.id}>{index > 0 && (index === critique.issues.length - 1 ? " and " : ", ")}<b>{issue.label.toLowerCase()}</b></span>
            ))}.</>}
      </p>

      {critique.issues.map((issue) => (
        <section className="pm-block" key={issue.id}>
          <h3 className="pm-block__title">{issue.label}</h3>
          <p className="pm-block__body">
            <Emphasised text={issue.summary} garments={critique.garments} indices={[issue.targetIndex]} />
          </p>
          <Remedy remedy={issue.remedy} itemMap={itemMap} />
        </section>
      ))}

      <section className="pm-block pm-block--quiet">
        <h3 className="pm-block__title">What's working</h3>
        {critique.works.map((work, index) => (
          <p className="pm-block__body" key={index}>
{work}
          </p>
        ))}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B — Read
// ---------------------------------------------------------------------------
// The register as the headline. The engine already decides how an outfit reads
// and has never shown it, and it is the one big confident thing it can say that
// is a characterisation rather than a rating — it names your style instead of
// grading it. Findings drop to a tight list beneath.

const REGISTER_GLOSS = {
  minimal: "Restrained palette, plain shapes, nothing shouting.",
  classic: "Conventional pieces, worn the way they were drawn.",
  sporty: "Athletic and technical pieces worn off the pitch.",
  workwear: "Utility cloth and hard-wearing shapes.",
  eclectic: "Deliberate mixing — the combinations are the point.",
  formal: "Tailoring, pitched for an occasion.",
};

export function VariantRead({ critique, itemMap }) {
  return (
    <div className="pm pm--read">
      <header className="pm-read__head">
        <p className="pm-read__eyebrow">This reads as</p>
        <h2 className="pm-read__register">{critique.register}</h2>
        <p className="pm-read__gloss">{REGISTER_GLOSS[critique.register] || ""}</p>
      </header>

      {critique.works.map((work, index) => (
        <p className="pm-read__praise" key={index}>
{work}
        </p>
      ))}

      {!!critique.issues.length && (
        <ol className="pm-read__list">
          {critique.issues.map((issue) => (
            <li key={issue.id}>
              <p className="pm-read__label"><b>{issue.label}</b></p>
              <p className="pm-read__summary">
                <Emphasised text={issue.summary} garments={critique.garments} indices={[issue.targetIndex]} />
              </p>
              <Remedy remedy={issue.remedy} itemMap={itemMap} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// C — Scored
// ---------------------------------------------------------------------------
// A real number, built so the objection can be seen rather than argued.
//
// There is no honest way to compute this. Findings are capped at three, gated
// by register and designed to abstain, so the input is a truncated count of
// things that are not comparable to each other — two findings on a maximalist
// outfit are not two findings on a suit. The arithmetic below is invented, and
// the caption says so out loud, because the point of this variant is to look at
// a number sitting above a photograph of a person and decide whether it belongs.

function fabricateScore(critique) {
  const weight = { high: 12, medium: 8, low: 4 };
  const penalty = critique.issues.reduce((sum, issue) => sum + (weight[issue.confidence] || 8), 0);
  return Math.max(1, Math.min(10, Math.round((100 - penalty) / 10)));
}

export function VariantScored({ critique, itemMap }) {
  const score = fabricateScore(critique);
  return (
    <div className="pm pm--scored">
      <div className="pm-score">
        <div className="pm-score__dial" style={{ "--fill": `${score * 10}%` }}>
          <span className="pm-score__number">{score}</span>
          <span className="pm-score__out">/10</span>
        </div>
        <div>
          <p className="pm-score__verdict">{score >= 8 ? "Strong fit" : score >= 6 ? "Nearly there" : "Needs work"}</p>
          <p className="pm-score__basis">Invented for this prototype: 100 minus a weight per finding. Nothing in the engine can produce an honest version of this.</p>
        </div>
      </div>

      {critique.issues.map((issue) => (
        <div className="pm-scored__row" key={issue.id}>
          <span className="pm-scored__cost">−{{ high: 12, medium: 8, low: 4 }[issue.confidence] || 8}</span>
          <div>
            <p className="pm-scored__label"><b>{issue.label}</b></p>
            <p className="pm-scored__summary">
              <Emphasised text={issue.summary} garments={critique.garments} indices={[issue.targetIndex]} />
            </p>
            <Remedy remedy={issue.remedy} itemMap={itemMap} />
          </div>
        </div>
      ))}

      <div className="pm-scored__row pm-scored__row--plus">
        <span className="pm-scored__cost pm-scored__cost--plus">+</span>
        <div>{critique.works.map((work, index) => <p className="pm-scored__summary" key={index}>{work}</p>)}</div>
      </div>
    </div>
  );
}

export const MIRROR_VARIANTS = [
  { key: "lede", name: "Lede", axis: "Hierarchy from type alone — no verdict device", component: VariantLede },
  { key: "read", name: "Read", axis: "Names your style instead of grading it", component: VariantRead },
  { key: "scored", name: "Scored", axis: "An actual number, so the risk is visible", component: VariantScored },
];
