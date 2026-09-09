// The taste profile the app builds from behaviour, never from a survey.
//
// Two hard rules govern everything in this file:
//
// 1. Only signals a user actually produced. A suggestion that was never saved
//    may simply never have been looked at — there is no impression tracking, so
//    "the user ignored this" is not measurable and is never inferred. Inventing
//    a negative from an absence is how a personalization loop poisons itself.
// 2. Raw log in, derived profile out. Signals are stored append-only with
//    timestamps and rolled up on read, never accumulated into a running score.
//    A log can be recomputed when this derivation improves; a score cannot.
//
// Everything here is pure — I/O and HTTP live in preferences-api.mjs — so the
// derivation can be tested against a synthetic log at any point in time.

import { classifyColor } from "./style-rules.mjs";
import { GARMENT_PART_MAP } from "../shared/garments.mjs";

export const SIGNAL_TYPES = new Set([
  "outfit_saved",     // strong positive on that combination
  "outfit_liked",     // "good suggestion" — weaker than saved, still positive
  "outfit_passed",    // explicit negative, the only negative we can honestly record
  "wishlist_added",   // buy intent
  "wishlist_removed", // its reversal
  "inspo_added",      // aesthetic reference
  "mirror_submitted", // a wear happened on this date; it cannot name the garments
  "outfit_worn",      // the only signal about what was worn, not what was intended
]);

// How much each signal counts before decay. Wearing an outfit outranks saving it:
// saving is a statement that it will be worn, wearing is the fact that it was.
// Liking one only says the suggestion was good.
const SIGNAL_WEIGHTS = {
  outfit_worn: 4,
  outfit_saved: 3,
  outfit_liked: 1.5,
  outfit_passed: -2,
  wishlist_added: 1,
  wishlist_removed: -1,
  inspo_added: 1,
  mirror_submitted: 0.5,
};

// Taste moves. A profile that never forgets pins someone to what they liked
// eighteen months ago — exactly the failure this app exists to avoid. A signal
// is worth half as much once it is this old.
export const HALF_LIFE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function decayWeight(signalDate, now = Date.now(), halfLifeDays = HALF_LIFE_DAYS) {
  const ageDays = (now - new Date(signalDate).getTime()) / DAY_MS;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return 0.5 ** (ageDays / halfLifeDays);
}

/** An item is dead stock only after the wardrobe has had a fair chance to use it. */
export const DEAD_STOCK_AFTER_DAYS = 60;

/** ...and only once the user builds outfits at all, so "unworn" means something. */
export const MIN_OUTFITS_FOR_DEAD_STOCK = 3;

function topEntries(scores, limit, { min = 0 } = {}) {
  return Object.entries(scores)
    .filter(([, weight]) => weight > min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, weight]) => ({ name, weight: Math.round(weight * 100) / 100 }));
}

function bump(scores, key, amount) {
  if (!key) return;
  scores[key] = (scores[key] || 0) + amount;
}

/**
 * Rolls the raw signal log, the wardrobe and the saved outfits into the compact
 * profile that gets injected into prompts.
 *
 * @param {Array} signals - raw append-only log
 * @param {{items?: Array, outfits?: Array, now?: number}} context
 */
export function derivePreferences(signals = [], { items = [], outfits = [], now = Date.now() } = {}) {
  const itemById = new Map(items.map((item) => [item.id, item]));

  const colorScores = {};
  const partScores = {};
  const pairScores = {};
  const rejectedColors = {};
  const rejectedPairs = {};
  const tagScores = {};

  let positiveCount = 0;
  let negativeCount = 0;
  let earliest = null;

  const describeOutfit = (itemIds = []) => {
    const garments = itemIds.map((id) => itemById.get(id)).filter(Boolean);
    const colors = garments.map((garment) => classifyColor(garment.color).name).filter(Boolean);
    return { garments, colors };
  };

  for (const signal of signals) {
    if (!signal || !SIGNAL_TYPES.has(signal.type)) continue;
    const base = SIGNAL_WEIGHTS[signal.type] ?? 0;
    if (!base) continue;

    const weight = base * decayWeight(signal.at, now);
    if (base > 0) positiveCount += 1; else negativeCount += 1;
    if (!earliest || new Date(signal.at) < new Date(earliest)) earliest = signal.at;

    if (signal.type === "outfit_saved" || signal.type === "outfit_worn" || signal.type === "outfit_liked" || signal.type === "outfit_passed") {
      const { garments, colors } = describeOutfit(signal.itemIds);
      const target = weight > 0 ? colorScores : rejectedColors;
      const pairTarget = weight > 0 ? pairScores : rejectedPairs;
      const magnitude = Math.abs(weight);

      for (const color of colors) bump(target, color, magnitude);
      for (const garment of garments) {
        if (weight > 0) bump(partScores, garment.part, magnitude);
        for (const tag of garment.tags || []) if (weight > 0) bump(tagScores, tag, magnitude * 0.5);
      }
      // Pairings are what actually distinguishes taste: two people can own the
      // same colors and combine them completely differently.
      const unique = [...new Set(colors)].sort();
      for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) bump(pairTarget, `${unique[i]} + ${unique[j]}`, magnitude);
      }
      continue;
    }

    if (signal.type === "wishlist_added" || signal.type === "wishlist_removed") {
      const color = signal.color ? classifyColor(signal.color).name : null;
      bump(weight > 0 ? colorScores : rejectedColors, color, Math.abs(weight));
      if (weight > 0) bump(partScores, signal.part, Math.abs(weight));
      continue;
    }

    if (signal.type === "inspo_added") {
      for (const hex of signal.colors || []) bump(colorScores, classifyColor(hex).name, weight);
      bump(partScores, signal.category, weight);
    }
  }

  // Core wardrobe vs dead stock, derived from saved outfits rather than signals:
  // this is a fact about the wardrobe, available even with an empty log.
  const outfitCounts = new Map();
  for (const outfit of outfits) {
    for (const id of outfit.itemIds || []) outfitCounts.set(id, (outfitCounts.get(id) || 0) + 1);
  }

  const coreItems = [...outfitCounts.entries()]
    .filter(([id, count]) => count >= 2 && itemById.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, count]) => ({ id, name: itemById.get(id).name, outfitCount: count }));

  // Dead stock is only meaningful once the user actually builds outfits. With
  // no outfits saved, every garment is "unworn" — but that says they haven't
  // used the feature, not that they are avoiding their clothes. Calling a whole
  // wardrobe dead stock on an absence of data is exactly the inference this
  // file refuses to make.
  const deadStock = outfits.length < MIN_OUTFITS_FOR_DEAD_STOCK ? [] : items
    .filter((item) => !outfitCounts.has(item.id))
    .filter((item) => {
      const added = item.createdAt || item.addedAt;
      if (!added) return false;
      return (now - new Date(added).getTime()) / DAY_MS >= DEAD_STOCK_AFTER_DAYS;
    })
    .slice(0, 8)
    .map((item) => ({ id: item.id, name: item.name }));

  return {
    signalCount: positiveCount + negativeCount,
    positiveCount,
    negativeCount,
    since: earliest,
    favouredColors: topEntries(colorScores, 6),
    favouredParts: topEntries(partScores, 4),
    favouredPairings: topEntries(pairScores, 4),
    favouredTags: topEntries(tagScores, 6),
    rejectedColors: topEntries(rejectedColors, 4),
    rejectedPairings: topEntries(rejectedPairs, 3),
    coreItems,
    deadStock,
  };
}

// ---------------------------------------------------------------------------
// Wear tracking
// ---------------------------------------------------------------------------
//
// Everything above answers "what does this person like?". This section answers
// a narrower and much harder question: "what do they actually wear?" — the one
// thing the app could never infer, because a saved outfit is an intention and
// an unopened drawer leaves no trace.
//
// The same rule from the top of this file governs it. Being in no outfit means
// never STYLED, which is not the same fact as never WORN, and the two are kept
// in separate fields all the way to the UI so nothing can quietly promote one
// into the other.

/** An item wear names garments. Only one signal can do that. */
const ITEM_WEAR_TYPES = new Set(["outfit_worn"]);

/**
 * A dated wear only proves the user dressed and logged it that day. A mirror
 * submission qualifies: it is a photo of what is actually on the body. It can
 * never say WHICH garments — perception describes what it sees in the photo and
 * is never matched against the library — so it moves the progress bar and
 * touches no item.
 */
const DATED_WEAR_TYPES = new Set(["outfit_worn", "mirror_submitted"]);

/** How long since a piece was last worn before it is worth a second look. */
export const UNWORN_AFTER_DAYS = 180;

/**
 * How long a never-worn piece must have been in the wardrobe first. This reuses
 * DEAD_STOCK_AFTER_DAYS rather than UNWORN_AFTER_DAYS on purpose: "has it had a
 * fair chance?" is a different question from "how stale is a wear?", and the
 * wardrobe already answered the first one. Holding never-worn pieces to the
 * 180-day bar would also mean a freshly imported wardrobe — which is every
 * wardrobe, for its first six months — could never surface anything at all.
 */
export const UNWORN_OWNERSHIP_FLOOR_DAYS = DEAD_STOCK_AFTER_DAYS;

/**
 * Days of logging before declutter can speak. Not a paywall and not a streak:
 * below this the log is too thin to tell "you never wear it" from "you have not
 * been logging", and guessing between those two is the failure this file exists
 * to prevent.
 */
export const MIN_LOGGED_DAYS_FOR_DECLUTTER = 14;

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** UTC so a test and a user in different zones agree on which day a wear was. */
function calendarDay(at) {
  const time = new Date(at).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function monthLabel(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date();
  const month = MONTHS[date.getUTCMonth()];
  return date.getUTCFullYear() === now.getUTCFullYear() ? month : `${month} ${date.getUTCFullYear()}`;
}

function ageInDays(value, now) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return (now - time) / DAY_MS;
}

/**
 * Per-item wear facts, rolled from the raw log exactly like everything else here.
 *
 * @returns {{byItem: Record<string, {lastWornAt: string|null, wearCount: number, confidence: "worn"|"styled"|"untouched"}>, loggedDays: number}}
 */
export function deriveWearStats(signals = [], { items = [], outfits = [] } = {}) {
  const days = new Set();
  const wearCounts = new Map();
  const lastWorn = new Map();

  // One wear per outfit per day. Identity is the set of garments, not an outfit
  // id, because the log does not carry one — and for this purpose they are the
  // same thing: putting the same combination on twice in a day is one wearing.
  // Deduping here rather than at write time keeps the log raw and append-only,
  // so a double tap costs nothing and this rule can be changed retroactively.
  const seen = new Set();

  for (const signal of signals) {
    if (!signal || !DATED_WEAR_TYPES.has(signal.type)) continue;
    const day = calendarDay(signal.at);
    if (!day) continue;
    days.add(day);

    if (!ITEM_WEAR_TYPES.has(signal.type)) continue;
    const itemIds = (signal.itemIds || []).filter(Boolean);
    if (!itemIds.length) continue;

    const key = `${day}:${[...new Set(itemIds)].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    for (const id of new Set(itemIds)) {
      wearCounts.set(id, (wearCounts.get(id) || 0) + 1);
      const previous = lastWorn.get(id);
      if (!previous || new Date(signal.at) > new Date(previous)) lastWorn.set(id, signal.at);
    }
  }

  const styled = new Set();
  for (const outfit of outfits) for (const id of outfit.itemIds || []) styled.add(id);

  const byItem = {};
  for (const item of items) {
    const wearCount = wearCounts.get(item.id) || 0;
    byItem[item.id] = {
      lastWornAt: lastWorn.get(item.id) || null,
      wearCount,
      confidence: wearCount ? "worn" : styled.has(item.id) ? "styled" : "untouched",
    };
  }

  return { byItem, loggedDays: days.size };
}

/**
 * The declutter view of the wardrobe, in two deliberately separate lists.
 *
 * `candidates` is the answer, and it stays empty until there is enough logging
 * to have earned one. `provisional` is the outfit-membership proxy, available
 * immediately — not because it is good evidence, but because the locked UI shows
 * it greyed out and says in as many words that never styled is not never worn.
 * They never merge: a caller that wants the weak list has to ask for it by name.
 */
export function deriveDeclutter(signals = [], { items = [], outfits = [], now = Date.now() } = {}) {
  const { byItem, loggedDays } = deriveWearStats(signals, { items, outfits });
  const unlocked = loggedDays >= MIN_LOGGED_DAYS_FOR_DECLUTTER;

  const ownedDays = (item) => ageInDays(item.createdAt || item.addedAt, now);

  // Never styled and never worn. Age is shown when known but not required: this
  // list makes no claim that needs it.
  const provisional = items
    .filter((item) => byItem[item.id]?.confidence === "untouched")
    .map((item) => {
      const owned = ownedDays(item);
      const months = owned == null ? null : Math.floor(owned / 30);
      return {
        id: item.id,
        name: item.name,
        confidence: "untouched",
        lastWornAt: null,
        reason: months && months >= 2
          ? `In your wardrobe ${months} months, never styled`
          : "Never styled",
        ownedDays: owned,
      };
    })
    .sort((a, b) => (b.ownedDays ?? -1) - (a.ownedDays ?? -1));

  const candidates = !unlocked ? [] : items
    .map((item) => {
      const stats = byItem[item.id];
      if (!stats) return null;
      const owned = ownedDays(item);

      if (stats.confidence === "worn") {
        const since = ageInDays(stats.lastWornAt, now);
        if (since == null || since < UNWORN_AFTER_DAYS) return null;
        const month = monthLabel(stats.lastWornAt);
        return {
          id: item.id,
          name: item.name,
          confidence: "worn",
          lastWornAt: stats.lastWornAt,
          reason: month ? `Not worn since ${month}` : "Not worn in a long time",
          rank: since,
        };
      }

      // Never worn. Only fair once the piece has had a real chance to be, and
      // only when its age is actually known — the same refusal deadStock makes.
      if (owned == null || owned < UNWORN_OWNERSHIP_FLOOR_DAYS) return null;
      return {
        id: item.id,
        name: item.name,
        confidence: stats.confidence,
        lastWornAt: null,
        reason: stats.confidence === "styled" ? "Styled, but never worn" : "Never worn, never styled",
        rank: owned,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.rank - a.rank);

  return {
    unlocked,
    loggedDays,
    daysNeeded: MIN_LOGGED_DAYS_FOR_DECLUTTER,
    candidates,
    provisional,
  };
}

/**
 * Renders the profile as the prompt block every generative surface reads.
 * Returns "" when there is genuinely nothing learned yet, so a cold-start user
 * gets no section at all rather than a section full of empty claims.
 */
export function describePreferences(profile) {
  if (!profile) return "";
  const lines = [];

  const label = (entries) => entries.map((entry) => entry.name).join(", ");

  if (profile.favouredColors.length) lines.push(`Colors they keep choosing: ${label(profile.favouredColors)}.`);
  if (profile.favouredPairings.length) lines.push(`Combinations they keep choosing: ${label(profile.favouredPairings)}.`);
  if (profile.favouredTags.length) lines.push(`Details that recur in what they pick: ${label(profile.favouredTags)}.`);
  if (profile.favouredParts.length) {
    const parts = profile.favouredParts.map((entry) => GARMENT_PART_MAP[entry.name]?.label || entry.name);
    lines.push(`Garment types they reach for: ${parts.join(", ")}.`);
  }
  if (profile.coreItems.length) {
    lines.push(`Core pieces, worn across several saved outfits: ${profile.coreItems.map((item) => `"${item.name}"`).join(", ")}. Build around these.`);
  }
  if (profile.deadStock.length) {
    lines.push(`Pieces they own but have never put in an outfit: ${profile.deadStock.map((item) => `"${item.name}"`).join(", ")}. Look for a way to make one of these work — this is an opportunity, never a criticism of the piece or of them.`);
  }
  if (profile.rejectedColors.length) lines.push(`Colors present in suggestions they turned down: ${label(profile.rejectedColors)}. Use with care.`);
  if (profile.rejectedPairings.length) lines.push(`Combinations they turned down: ${label(profile.rejectedPairings)}. Avoid repeating these.`);

  if (!lines.length) return "";

  // With no signals yet, everything above came from the wardrobe and its saved
  // outfits — claiming it was "learned from 0 actions" would be a lie about
  // where the profile came from.
  const lead = profile.signalCount
    ? `Learned from ${profile.signalCount} action${profile.signalCount === 1 ? "" : "s"} this user actually took (recent ones count for more):`
    : "Observed from this wardrobe and the outfits already saved in it:";

  return [lead, ...lines.map((line) => `- ${line}`)].join("\n");
}
