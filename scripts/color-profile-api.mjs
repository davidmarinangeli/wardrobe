import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  atomicJson,
  loadFaceReference,
  normalizeImage,
  readAiMode,
  resolveApiKey,
  resolveProvider,
} from "./import-job-api.mjs";
import { SEASONS } from "../shared/color-seasons.mjs";
import { prepareSubject, renderDrapedPortrait, DRAPE_SETS } from "./draping-service.mjs";

function sanitizeHex(hex, fallback = "#888888") {
  const match = String(hex || "").match(/#[0-9a-fA-F]{6}\b/i);
  return match ? match[0].toUpperCase() : fallback;
}

function sanitizePalette(rawPalette, fallbackPalette = []) {
  const cleaned = [];
  for (const item of (Array.isArray(rawPalette) ? rawPalette : [])) {
    const match = String(item).match(/#[0-9a-fA-F]{6}\b/i);
    if (match && !cleaned.includes(match[0].toUpperCase())) {
      cleaned.push(match[0].toUpperCase());
    }
  }
  for (const fb of fallbackPalette) {
    if (cleaned.length >= 8) break;
    const upper = fb.toUpperCase();
    if (!cleaned.includes(upper)) cleaned.push(upper);
  }
  return cleaned.slice(0, 8);
}

const COLOR_PROFILE_PROMPT = `You are an expert color analyst and image consultant practicing professional seasonal color analysis (Armocromia / 12-season Munsell method).
Analyze this person's facial features to identify their chromatic harmony based purely on their optical pigmentation:
1. Skin Undertone: Evaluate the temperature of their skin (cool, warm, neutral-cool, neutral-warm). Look at the jawline, neck, and undertones beneath the surface.
2. Depth / Value: Overall lightness or darkness of their natural coloring (light, medium, deep).
3. Contrast / Chroma: The value difference between their eyes, skin, and hair (high, medium, low) and clarity/saturation (bright/clear vs soft/muted).
4. Apparent presentation / gender: "man" or "woman" (used solely to match editorial grooming visual references).
5. Canonical 12-season sub-season (choose exactly one):
   - Winter: "winter-cool", "winter-deep", "winter-bright", "winter-true"
   - Summer: "summer-cool", "summer-light", "summer-soft", "summer-true"
   - Autumn: "autumn-warm", "autumn-deep", "autumn-soft", "autumn-true"
   - Spring: "spring-warm", "spring-light", "spring-bright", "spring-true"
6. Parent Season: "winter", "summer", "autumn", or "spring".
7. Personal Sampled Pigments: Sample the exact RGB hex codes for:
   - Skin: predominant natural skin tone (provide hex and a descriptive name, e.g. "Warm Olive", "Golden Ivory", "Cool Porcelain", "Almond").
   - Eyes: iris color (provide hex and descriptive name, e.g. "Deep Warm Amber", "Icy Slate Blue", "Dark Espresso").
   - Hair: natural hair tone (provide hex and descriptive name, e.g. "Dark Espresso", "Ash Chestnut", "Honey Bronze", "Raven Black").
8. 8-color flattering palette: An array of exactly 8 distinct 6-character hex color codes (e.g. ["#1B3F8B", "#C8102E", ...]) that constitute their most flattering signature harmony.
9. Description: A 1-2 sentence refined editorial summary of why this season flatters their natural contrast and undertones.

NO-JUDGMENT GUARDRAIL:
Do not evaluate or comment on attractiveness, beauty, age, wrinkles, asymmetry, or flaws. Speak strictly in terms of optical color harmony, temperature, saturation, and contrast.`;

const COLOR_PROFILE_SCHEMA = {
  type: "object",
  properties: {
    season: {
      type: "string",
      enum: [
        "winter-cool", "winter-deep", "winter-bright", "winter-true",
        "summer-cool", "summer-light", "summer-soft", "summer-true",
        "autumn-warm", "autumn-deep", "autumn-soft", "autumn-true",
        "spring-warm", "spring-light", "spring-bright", "spring-true",
      ],
    },
    parentSeason: {
      type: "string",
      enum: ["winter", "summer", "autumn", "spring"],
    },
    gender: {
      type: "string",
      enum: ["man", "woman"],
    },
    undertone: {
      type: "string",
      enum: ["cool", "warm", "neutral-cool", "neutral-warm"],
    },
    depth: {
      type: "string",
      enum: ["light", "medium", "deep"],
    },
    contrast: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
    userTones: {
      type: "object",
      properties: {
        skin: {
          type: "object",
          properties: { hex: { type: "string" }, name: { type: "string" } },
          required: ["hex", "name"],
        },
        eyes: {
          type: "object",
          properties: { hex: { type: "string" }, name: { type: "string" } },
          required: ["hex", "name"],
        },
        hair: {
          type: "object",
          properties: { hex: { type: "string" }, name: { type: "string" } },
          required: ["hex", "name"],
        },
      },
      required: ["skin", "eyes", "hair"],
    },
    palette: {
      type: "array",
      items: { type: "string" },
      minItems: 8,
      maxItems: 8,
    },
    description: { type: "string" },
  },
  required: [
    "season",
    "parentSeason",
    "gender",
    "undertone",
    "depth",
    "contrast",
    "userTones",
    "palette",
    "description",
  ],
};

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Expected a JSON request body"), { status: 400 });
  }
}

async function geminiAnalyzeColorProfile({ key, model, image, mime = "image/png" }) {
  const parts = [
    { text: COLOR_PROFILE_PROMPT },
    { inlineData: { mimeType: mime, data: image.toString("base64") } },
  ];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: COLOR_PROFILE_SCHEMA,
        },
      }),
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error?.message || `Gemini color analysis failed (${response.status})`);
  }
  const outputText = result.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part.text === "string"
  )?.text;
  if (!outputText) throw new Error("Gemini color analysis returned no structured result");
  return JSON.parse(outputText);
}

async function openAIAnalyzeColorProfile({ key, baseUrl, model, image, mime = "image/png" }) {
  const content = [
    { type: "input_text", text: COLOR_PROFILE_PROMPT },
    { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
  ];
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "color_profile",
          strict: true,
          schema: COLOR_PROFILE_SCHEMA,
        },
      },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error?.message || `OpenAI color analysis failed (${response.status})`);
  }
  const outputText =
    result.output_text ||
    result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI color analysis returned no structured result");
  return JSON.parse(outputText);
}

const DRAPE_ANALYSIS_PROMPT = `You are a certified seasonal colour analyst running a digital draping test.

Each image shows the same person on the same neutral grey ground, under a different solid gabardine drape. The only variable between images is the fabric colour, so every difference you describe must be attributable to that colour.

Judge, in this order:
1. Skin clarity — under which drape does the complexion read even and luminous, and under which does it turn sallow, grey, ashen, or ruddy?
2. Shadow — which drape lightens the shadows under the eyes and around the mouth, and which one deepens them?
3. Definition — which drape lets the eyes and hair come forward, and which one overpowers them so the fabric is the loudest thing in frame?

Then name the winner. Write for the person being analysed: plain, concrete, second person, no jargon they would have to look up. Two or three sentences.

GUARDRAIL: Do not comment on attractiveness, age, weight, or facial features. Speak only about optical colour harmony, undertone, and skin luminosity.`;

const DRAPE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      description: "The id of the winning candidate, copied exactly from the candidate list given in the prompt.",
    },
    parentSeason: {
      type: "string",
      enum: ["winter", "summer", "autumn", "spring"],
    },
    undertone: {
      type: "string",
      enum: ["warm", "cool"],
    },
    depth: {
      type: "string",
      enum: ["deep", "medium", "light"],
    },
    contrast: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
    confidence: {
      type: "string",
      enum: ["high", "medium"],
    },
    title: {
      type: "string",
      description: "Short verdict headline naming the winner, e.g. 'Deep Autumn wins'. English.",
    },
    explanation: {
      type: "string",
      description: "2-3 plain-English sentences, addressed to the person, on what the winning drape does for their skin that the other does not.",
    },
    candidateNotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          drapeId: { type: "string" },
          drapeName: { type: "string" },
          reaction: { type: "string", description: "One plain-English sentence on how this drape read on the skin." },
        },
        required: ["drapeId", "reaction"],
      },
    },
  },
  required: [
    "verdict",
    "parentSeason",
    "undertone",
    "depth",
    "contrast",
    "confidence",
    "title",
    "explanation",
    "candidateNotes",
  ],
};

async function geminiAnalyzeDrapes({ key, model, candidates }) {
  const parts = [{ text: DRAPE_ANALYSIS_PROMPT }];
  for (const candidate of candidates) {
    parts.push({ text: `Drape candidate: ${candidate.name} (ID: ${candidate.id}, Type: ${candidate.type})` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: candidate.buffer.toString("base64") } });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: DRAPE_ANALYSIS_SCHEMA,
        },
      }),
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error?.message || `Gemini drape analysis failed (${response.status})`);
  }
  const outputText = result.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part.text === "string"
  )?.text;
  if (!outputText) throw new Error("Gemini drape analysis returned no structured result");
  return JSON.parse(outputText);
}

async function openAIAnalyzeDrapes({ key, baseUrl, model, candidates }) {
  const content = [{ type: "input_text", text: DRAPE_ANALYSIS_PROMPT }];
  for (const candidate of candidates) {
    content.push({ type: "input_text", text: `Drape candidate: ${candidate.name} (ID: ${candidate.id}, Type: ${candidate.type})` });
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${candidate.buffer.toString("base64")}`,
    });
  }

  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "drape_analysis",
          strict: true,
          schema: DRAPE_ANALYSIS_SCHEMA,
        },
      },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error?.message || `OpenAI drape analysis failed (${response.status})`);
  }
  const outputText =
    result.output_text ||
    result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI drape analysis returned no structured result");
  return JSON.parse(outputText);
}

export function colorProfileApi(options = {}) {
  let root;
  let dataDir;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  async function getReferenceImage() {
    const face = await loadFaceReference(root, setting);
    if (face?.data) return { data: face.data, mime: face.mime || "image/png", isFaceCrop: true };

    const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
    try {
      const data = await readFile(modelPath);
      return { data, mime: "image/png", isFaceCrop: false };
    } catch {
      return null;
    }
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/color-profile")) return next();

    try {
      const cacheFile = path.join(dataDir, "color-profile.json");

      if (url.pathname === "/api/color-profile/status" && req.method === "GET") {
        const ref = await getReferenceImage();
        let cached = null;
        try {
          cached = JSON.parse(await readFile(cacheFile, "utf8"));
        } catch {}

        // Only flag a real ambiguity. A neutral undertone means the warm/cool
        // split — the question every other reading hangs off — is still open;
        // a sister-season assignment means the family is settled but the
        // boundary inside it isn't. Anything else gets no banner.
        const undertone = (cached?.undertone || "").toLowerCase();
        const SISTER_PAIRS = {
          sisterDeep: ["autumn-deep", "winter-cool"],
          sisterSoft: ["summer-soft", "autumn-soft"],
        };

        let openQuestion = null;
        if (cached?.season && undertone.includes("neutral")) {
          openQuestion = {
            setId: "temperature",
            reason: "Your undertone read as neutral, so warm against cool is still an open question.",
          };
        } else if (cached?.season) {
          const pair = Object.entries(SISTER_PAIRS).find(([, ids]) => ids.includes(cached.season));
          if (pair) {
            openQuestion = {
              setId: pair[0],
              reason: "This season sits right against its neighbour. A drape test separates them.",
            };
          }
        }

        return json(res, 200, {
          hasReference: !!ref,
          isFaceCrop: ref?.isFaceCrop ?? false,
          hasProfile: !!cached?.season,
          profile: cached,
          openQuestion,
        });
      }

      // The browser recolours the drape itself, so this only has to hand over
      // the portrait and where its neck is. One image, cached on disk.
      if (url.pathname === "/api/color-profile/drapes" && req.method === "GET") {
        const publicDrapesDir = path.resolve(root, "public/drapes");
        const subject = await prepareSubject(root, publicDrapesDir);
        return json(res, 200, { subject, sets: DRAPE_SETS });
      }

      if (url.pathname === "/api/color-profile/drapes/analyze" && req.method === "POST") {
        const reqBody = await body(req);
        const setId = reqBody.setId || "sisterDeep";
        const targetSet = DRAPE_SETS[setId] || DRAPE_SETS.sisterDeep;
        const fabricIndex = Number.isInteger(reqBody.fabricIndex) ? reqBody.fabricIndex : 0;
        const publicDrapesDir = path.resolve(root, "public/drapes");

        // Rasterise only the fabrics actually on screen — the same ones the
        // user is looking at, so the verdict answers the question they asked.
        const candidates = [];
        for (const candidate of targetSet.candidates) {
          const color = candidate.fabrics[fabricIndex] || candidate.fabrics[0];
          candidates.push({
            id: candidate.id,
            name: candidate.name,
            type: candidate.type,
            buffer: await renderDrapedPortrait(root, publicDrapesDir, color),
          });
        }

        if (!candidates.length) {
          return json(res, 400, { error: "No drapes to compare." });
        }

        const { provider } = resolveProvider(setting);
        const mode = await readAiMode(dataDir);
        const activeProvider = provider === "gemini" ? "gemini" : "openai";
        const { key } = resolveApiKey(setting, activeProvider, mode);

        if (!key) {
          return json(res, 503, {
            error: "No AI key configured, so the second opinion isn't available. Your own pick still applies.",
          });
        }

        const analyzed = activeProvider === "gemini"
          ? await geminiAnalyzeDrapes({
              key,
              model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"),
              candidates,
            })
          : await openAIAnalyzeDrapes({
              key,
              baseUrl: apiBaseUrl(),
              model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
              candidates,
            });

        // Map the model's answer back onto a real season id, so applying it
        // can't write a test-only id like "warm" into the profile.
        const winner = targetSet.candidates.find((c) => c.id === analyzed.verdict);
        return json(res, 200, {
          ...analyzed,
          setId,
          winnerId: winner?.id || analyzed.verdict,
          seasonId: winner?.seasonId || null,
          narrowsTo: winner?.narrowsTo || null,
        });
      }

      if (url.pathname === "/api/color-profile/analyze" && (req.method === "GET" || req.method === "POST")) {
        const ref = await getReferenceImage();
        if (!ref) {
          return json(res, 400, {
            error: "No reference photo found on disk. Upload a photo in Settings or use the quiz fallback.",
          });
        }

        const hash = createHash("md5").update(ref.data).digest("hex");
        const force = url.searchParams.get("force") === "true";

        if (!force) {
          try {
            const cached = JSON.parse(await readFile(cacheFile, "utf8"));
            if (cached?.hash === hash && cached?.season) {
              return json(res, 200, { profile: cached, cached: true });
            }
          } catch {}
        }

        const { provider } = resolveProvider(setting);
        const mode = await readAiMode(dataDir);
        const activeProvider = provider === "gemini" ? "gemini" : "openai";
        const { key, keyName } = resolveApiKey(setting, activeProvider, mode);
        if (!key) {
          return json(res, 503, { error: `${keyName} is not configured for ${mode.toUpperCase()} mode.` });
        }

        const normalized = await normalizeImage(ref.data);

        const analyzed = activeProvider === "gemini"
          ? await geminiAnalyzeColorProfile({
              key,
              model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"),
              image: normalized,
              mime: "image/png",
            })
          : await openAIAnalyzeColorProfile({
              key,
              baseUrl: apiBaseUrl(),
              model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
              image: normalized,
              mime: "image/png",
            });

        const cleanSeason = analyzed.season || analyzed.parentSeason || "winter-cool";
        const seasonDef = SEASONS[cleanSeason] || SEASONS["winter-cool"];
        const cleanPalette = sanitizePalette(analyzed.palette, seasonDef.palette);

        const profile = {
          hash,
          analyzedAt: new Date().toISOString(),
          provider: activeProvider,
          ...analyzed,
          season: seasonDef.id,
          parentSeason: seasonDef.parentSeason,
          gender: analyzed.gender === "man" ? "man" : "woman",
          palette: cleanPalette,
          userTones: {
            skin: {
              hex: sanitizeHex(analyzed.userTones?.skin?.hex, "#D8AB95"),
              name: analyzed.userTones?.skin?.name || "Natural Skin",
            },
            eyes: {
              hex: sanitizeHex(analyzed.userTones?.eyes?.hex, "#503020"),
              name: analyzed.userTones?.eyes?.name || "Natural Eye",
            },
            hair: {
              hex: sanitizeHex(analyzed.userTones?.hair?.hex, "#281D18"),
              name: analyzed.userTones?.hair?.name || "Natural Hair",
            },
          },
        };

        await atomicJson(cacheFile, profile);
        return json(res, 200, { profile, cached: false });
      }

      if (url.pathname === "/api/color-profile/save" && req.method === "POST") {
        const input = await body(req);
        let existing = {};
        try {
          existing = JSON.parse(await readFile(cacheFile, "utf8"));
        } catch {}

        const updated = {
          ...existing,
          ...input,
          updatedAt: new Date().toISOString(),
        };

        await atomicJson(cacheFile, updated);
        return json(res, 200, { saved: true, profile: updated });
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || 500;
      return json(res, statusCode, { error: error.message || "Internal server error" });
    }
  }

  return {
    name: "wardrobe-color-profile-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
