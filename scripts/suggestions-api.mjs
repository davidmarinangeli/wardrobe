import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson, readAiMode, resolveApiKey, resolveProvider } from "./import-job-api.mjs";
import { PART_TO_REGION, classifyColor, describeColorHarmonyRules, evaluateColorHarmony } from "./style-rules.mjs";
import { NO_JUDGMENT_PROMPT } from "../shared/prompt-guardrails.mjs";
import { describePreferences } from "./preferences.mjs";
import { loadDerivedPreferences } from "./preferences-api.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, no API key)
// ---------------------------------------------------------------------------

const WMO_CONDITIONS = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "heavy showers",
  85: "light snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm",
};

async function fetchWeather(lat = 45.46, lon = 9.19) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,uv_index",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "1",
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) return null;
  const data = await response.json();
  const current = data.current || {};
  const daily = data.daily || {};
  return {
    temperature: current.temperature_2m ?? null,
    apparentTemp: current.apparent_temperature ?? null,
    conditions: WMO_CONDITIONS[current.weather_code] || "unknown",
    windSpeed: current.wind_speed_10m ?? null,
    uvIndex: current.uv_index ?? null,
    precipitationProb: daily.precipitation_probability_max?.[0] ?? null,
    tempRange: {
      min: daily.temperature_2m_min?.[0] ?? null,
      max: daily.temperature_2m_max?.[0] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-filter wardrobe items by weather + occasion
// ---------------------------------------------------------------------------

const HOT_EXCLUDE_TAGS = new Set(["wool", "fleece", "down", "puffer", "heavy", "thermal", "flannel", "cashmere", "sherpa", "corduroy"]);
const COLD_EXCLUDE_TAGS = new Set(["linen", "sleeveless", "tank", "mesh", "sheer"]);
const COLD_EXCLUDE_SHORTS = true;
const FORMAL_EXCLUDE_TAGS = new Set(["gym", "athletic", "sport", "sweatpants", "jogger", "running", "track"]);
const SPORT_PREFER_TAGS = new Set(["athletic", "sport", "gym", "running", "track", "jogger", "performance"]);

function preFilterWardrobe(items, weather, occasion) {
  let filtered = [...items];

  // Weather filtering
  if (weather) {
    const temp = weather.apparentTemp ?? weather.temperature;
    if (temp !== null) {
      if (temp > 25) {
        // Hot: remove heavy items
        filtered = filtered.filter((item) => {
          if (item.part === "wholebody_up") {
            const hasLightTag = item.tags?.some((t) => ["linen", "light", "rain", "windbreaker", "thin"].includes(t));
            return hasLightTag;
          }
          return !item.tags?.some((t) => HOT_EXCLUDE_TAGS.has(t));
        });
      }
      if (temp < 10) {
        // Cold: remove summer-only items
        filtered = filtered.filter((item) => {
          if (COLD_EXCLUDE_SHORTS && item.part === "lowerbody" && item.tags?.some((t) => t === "shorts" || t === "short")) return false;
          return !item.tags?.some((t) => COLD_EXCLUDE_TAGS.has(t));
        });
      }
    }
  }

  // Occasion filtering
  if (occasion === "work" || occasion === "date" || occasion === "event") {
    filtered = filtered.filter((item) => !item.tags?.some((t) => FORMAL_EXCLUDE_TAGS.has(t)));
  }
  if (occasion === "sport") {
    // For sport: prefer athletic items but don't exclude everything else
    const athletic = filtered.filter((item) => item.tags?.some((t) => SPORT_PREFER_TAGS.has(t)));
    const rest = filtered.filter((item) => !item.tags?.some((t) => SPORT_PREFER_TAGS.has(t)));
    // Ensure we have items from each category
    const athleticParts = new Set(athletic.map((item) => item.part));
    const needed = rest.filter((item) => !athleticParts.has(item.part));
    filtered = [...athletic, ...needed];
  }

  // Cap at 45 items if still too many: ensure category diversity
  if (filtered.length > 45) {
    const byPart = {};
    for (const item of filtered) (byPart[item.part] ||= []).push(item);
    const result = [];
    const perCategory = Math.max(3, Math.floor(45 / Object.keys(byPart).length));
    for (const [, partItems] of Object.entries(byPart)) {
      result.push(...partItems.slice(0, perCategory));
    }
    // Fill remaining slots
    const inResult = new Set(result.map((item) => item.id));
    for (const item of filtered) {
      if (result.length >= 45) break;
      if (!inResult.has(item.id)) result.push(item);
    }
    filtered = result;
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Style DNA from inspo board
// ---------------------------------------------------------------------------

function inspoHash(pins) {
  const hash = createHash("md5");
  for (const pin of pins) hash.update(`${pin.id}:${pin.category || ""}:${pin.name || ""}`);
  return hash.digest("hex");
}

async function computeStyleDNA(inspoFile, styleDnaFile, setting, mode) {
  let pins;
  try { pins = JSON.parse(await readFile(inspoFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }

  const classified = pins.filter((pin) => pin.category && pin.name);
  if (classified.length < 3) return null;

  const hash = inspoHash(classified);

  // Check cache
  try {
    const cached = JSON.parse(await readFile(styleDnaFile, "utf8"));
    if (cached.hash === hash && cached.styleDna) return cached.styleDna;
  } catch { /* no cache or invalid, recompute */ }

  // Build summary for Gemini
  const pinSummaries = classified.map((pin) => {
    const parts = [pin.name];
    if (pin.category) parts.push(`[${pin.category}]`);
    if (pin.colors?.length) parts.push(`colors: ${pin.colors.join(", ")}`);
    if (pin.notes) parts.push(`notes: "${pin.notes}"`);
    return parts.join(" — ");
  }).join("\n");

  const { key } = resolveApiKey(setting, "gemini", mode);
  if (!key) return null;

  const model = setting("GEMINI_SUGGESTIONS_MODEL", "gemini-3.6-flash");

  const prompt = `You are a fashion analyst. Based on these inspiration references saved by a user, describe their personal style in 2-3 sentences. Identify their style archetype (minimalist, streetwear, classic, Scandinavian, preppy, old money, etc.), recurring patterns (color preferences, silhouette preferences, textures they gravitate toward), and anything they consistently avoid if detectable. Be specific and direct. No filler.

${NO_JUDGMENT_PROMPT}
- Describe the aesthetic they are drawn to. Do not rate it, date it, or place it on a timeline.

Inspiration pins:
${pinSummaries}`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300 },
    }),
  });
  if (!response.ok) return null;
  const result = await response.json().catch(() => ({}));
  const text = result.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;
  if (!text) return null;

  // Cache
  try { await writeFile(styleDnaFile, JSON.stringify({ hash, styleDna: text.trim() })); }
  catch { /* non-critical */ }

  return text.trim();
}

// ---------------------------------------------------------------------------
// Gemini suggestion call
// ---------------------------------------------------------------------------

const SUGGESTION_SCHEMA = {
  type: "object",
  properties: {
    outfits: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short descriptive name for the outfit" },
          itemIds: { type: "array", items: { type: "string" }, maxItems: 6, description: "IDs of wardrobe items in this outfit" },
          reasoning: {
            type: "object",
            properties: {
              style: { type: "string", description: "Why this outfit works stylistically" },
              color: { type: "string", description: "Color harmony explanation" },
              weather: { type: "string", description: "Weather appropriateness" },
              occasion: { type: "string", description: "Occasion suitability" },
            },
            required: ["style", "color", "weather", "occasion"],
          },
        },
        required: ["name", "itemIds", "reasoning"],
      },
    },
  },
  required: ["outfits"],
};

async function generateSuggestions({ filteredItems, weather, occasion, colorProfile, styleDna, preferences, existingOutfits, setting, mode }) {
  const { key, keyName } = resolveApiKey(setting, "gemini", mode);
  if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);

  const model = setting("GEMINI_SUGGESTIONS_MODEL", "gemini-3.6-flash");

  // Build wardrobe text — colors are classified through the same shared vocabulary
  // Mirror uses, so navy/brown/etc. are correctly labeled neutral instead of being
  // described as raw hue degrees that miss real style convention.
  const wardrobeText = filteredItems.map((item) => {
    const primary = classifyColor(item.color);
    const secondary = item.secondaryColor ? classifyColor(item.secondaryColor) : null;
    const describe = (info) => info.neutral ? `${info.name}, neutral` : `${info.name}, hue:${info.hue}°`;
    const secondaryText = secondary ? ` secondary:${item.secondaryColor}(${describe(secondary)})` : "";
    return `- id:"${item.id}" name:"${item.name}" part:${item.part} color:${item.color}(${describe(primary)})${secondaryText} tags:[${(item.tags || []).join(", ")}]`;
  }).join("\n");

  // Build existing outfits text (to avoid duplicates)
  const existingText = existingOutfits.length
    ? existingOutfits.map((o) => `  ${o.name}: [${o.itemIds.join(", ")}]`).join("\n")
    : "None yet.";

  // Weather text
  const weatherText = weather
    ? `Temperature: ${weather.temperature}°C (feels like ${weather.apparentTemp}°C). Conditions: ${weather.conditions}. Wind: ${weather.windSpeed} km/h. UV: ${weather.uvIndex}. Precipitation chance: ${weather.precipitationProb}%. Day range: ${weather.tempRange.min}°C to ${weather.tempRange.max}°C.`
    : "Weather data unavailable. Suggest seasonally neutral outfits.";

  // Color profile text
  const colorText = colorProfile
    ? `Season: ${colorProfile.season}. Palette: ${(colorProfile.palette || []).join(", ")}. Prefer items whose colors work with this seasonal palette.`
    : "No color profile set. Use general color harmony principles.";

  // Style DNA text
  const styleText = styleDna || "No style profile available. Use balanced, versatile suggestions.";

  // Behaviour-derived taste profile. Omitted entirely when nothing has been
  // learned yet, so a cold-start user gets no section rather than an empty one.
  const preferencesText = describePreferences(preferences);
  const preferencesBlock = preferencesText ? `\nWHAT THIS USER KEEPS CHOOSING:\n${preferencesText}\n` : "";

  const prompt = `You are a personal fashion stylist. Suggest 3 to 5 outfit combinations from the user's wardrobe for today.

${NO_JUDGMENT_PROMPT}

WEATHER TODAY:
${weatherText}

OCCASION: ${occasion}

COLOR PROFILE:
${colorText}

STYLE PROFILE:
${styleText}
${preferencesBlock}
EXISTING OUTFITS (don't duplicate these):
${existingText}

AVAILABLE WARDROBE ITEMS:
${wardrobeText}

Rules:
- Each outfit MUST include at least 1 top (upperbody) and 1 bottom (lowerbody). This is mandatory.
- Optionally add a jacket (wholebody_up), shoes, socks, or 1 accessory (accessories_up).
- Maximum 6 pieces per outfit.
- Only use item IDs from the list above. Do not invent IDs.
- Don't repeat an outfit that already exists.
- ${describeColorHarmonyRules()}
- If a color profile is set, prefer items that work with that seasonal palette.
- If a style profile is set, match its aesthetic sensibility.
- If a "what this user keeps choosing" section is present, weight it above generic styling convention — it is evidence from their own actions. Combinations they turned down must not reappear.
- Weather must be appropriate: no heavy layers in heat, proper coverage in cold.
- Each outfit needs a short name (2-4 words) and a "reasoning" object with style, color, weather, and occasion explanations. Keep each explanation to 1-2 sentences.
- Reasoning explains why these pieces work together. It never comments on how current the wardrobe is, and never suggests buying or replacing anything.`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: SUGGESTION_SCHEMA,
        temperature: 0.9,
      },
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini suggestions failed (${response.status})`);
  const outputText = result.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;
  if (!outputText) throw new Error("Gemini returned no suggestion result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.outfits)) throw new Error("Gemini returned invalid suggestions format");

  // Validate that all itemIds reference real items
  const validIds = new Set(filteredItems.map((item) => item.id));
  for (const outfit of parsed.outfits) {
    outfit.itemIds = outfit.itemIds.filter((id) => validIds.has(id));
  }
  // Remove outfits with no valid items
  parsed.outfits = parsed.outfits.filter((outfit) => outfit.itemIds.length >= 2);

  // Defense in depth: even with the harmony rules stated in the prompt, re-check
  // each proposed outfit against the same deterministic engine Mirror uses, and
  // drop any that still violate a grounded rule rather than surface a bad call.
  const itemById = new Map(filteredItems.map((item) => [item.id, item]));
  parsed.outfits = parsed.outfits.filter((outfit) => {
    const garments = outfit.itemIds
      .map((id) => itemById.get(id))
      .filter(Boolean)
      .map((item) => ({ region: PART_TO_REGION[item.part] || item.part, color: classifyColor(item.color).name }));
    return !evaluateColorHarmony(garments).issue;
  });

  return parsed.outfits;
}

// ---------------------------------------------------------------------------
// Vite plugin
// ---------------------------------------------------------------------------

export function suggestionsApi(options = {}) {
  let root;
  let dataDir;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/suggestions")) return next();

    try {
      if (url.pathname === "/api/suggestions/generate" && req.method === "POST") {
        const input = await body(req);
        const occasion = ["casual", "work", "date", "sport", "event"].includes(input.occasion)
          ? input.occasion : "casual";

        const { provider } = resolveProvider(setting);
        if (provider !== "gemini") {
          return json(res, 400, { error: "Outfit suggestions require Gemini. Set AI_PROVIDER=gemini in .env." });
        }

        const mode = await readAiMode(dataDir);
        const { key, keyName } = resolveApiKey(setting, "gemini", mode);
        if (!key) return json(res, 503, { error: `${keyName} is not configured for ${mode.toUpperCase()} mode.` });

        // Load wardrobe
        const libraryFile = path.join(dataDir, "library.json");
        let items;
        try { items = JSON.parse(await readFile(libraryFile, "utf8")); }
        catch (error) { if (error.code === "ENOENT") items = []; else throw error; }

        if (items.length < 5) {
          return json(res, 400, { error: "Add at least 5 wardrobe items before generating suggestions." });
        }

        // Fetch weather (non-blocking failure)
        const lat = typeof input.lat === "number" ? input.lat : undefined;
        const lon = typeof input.lon === "number" ? input.lon : undefined;
        let weather = null;
        try { weather = await fetchWeather(lat, lon); }
        catch { /* weather is optional */ }

        // Pre-filter
        const filteredItems = preFilterWardrobe(items, weather, occasion);

        // Style DNA
        const inspoFile = path.join(dataDir, "inspo.json");
        const styleDnaFile = path.join(dataDir, "style-dna.json");
        let styleDna = null;
        try { styleDna = await computeStyleDNA(inspoFile, styleDnaFile, setting, mode); }
        catch { /* style DNA is optional */ }

        // Color profile (passed from frontend)
        const colorProfile = input.colorProfile || null;

        // Existing outfits
        const outfitsFile = path.join(dataDir, "outfits.json");
        let existingOutfits = [];
        try { existingOutfits = JSON.parse(await readFile(outfitsFile, "utf8")); }
        catch { /* no outfits yet */ }

        // Behaviour-derived taste profile (never throws; degrades to null)
        const preferences = await loadDerivedPreferences(dataDir);

        // Generate
        const suggestions = await generateSuggestions({
          filteredItems,
          weather,
          occasion,
          colorProfile,
          styleDna,
          preferences,
          existingOutfits,
          setting,
          mode,
        });

        return json(res, 200, {
          suggestions,
          weather,
          styleDna: styleDna ? true : false,
          personalized: Boolean(preferences?.signalCount),
        });
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-suggestions-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
