import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { COLOR_NAMES } from "./style-rules.mjs";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const STAGES = new Set(["crop", "garment"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes", "socks"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 25 * 1024 * 1024) {
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

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

function extension(mime = "image/png") {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[mime] || "png";
}

function decodeImage(input) {
  const raw = input.imageDataUrl || input.imageBase64;
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("imageDataUrl or imageBase64 is required"), { status: 400 });
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match?.[1] || input.mimeType || "image/png";
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return { data, mime };
}

export function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    worn: typeof metadata.worn === "boolean" ? metadata.worn : true,
    rotationDegrees: Number.isFinite(Number(metadata.rotationDegrees)) ? Math.max(-180, Math.min(180, Math.round(Number(metadata.rotationDegrees)))) : 0,
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

export async function normalizeImage(bytes) {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

export async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

export function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const selected = candidates.sort((a, b) => {
    const distance = (color) => color.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
    return distance(b) - distance(a);
  })[0];
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export async function detectBorderColor(bytes, bandWidth = 6) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const samples = [];
  const addPixel = (x, y) => {
    const index = ((y * width) + x) * 4;
    samples.push([data[index], data[index + 1], data[index + 2]]);
  };
  for (let x = 0; x < width; x += 1) {
    for (let edge = 0; edge < bandWidth; edge += 1) {
      addPixel(x, edge);
      addPixel(x, height - 1 - edge);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let edge = 0; edge < bandWidth; edge += 1) {
      addPixel(edge, y);
      addPixel(width - 1 - edge, y);
    }
  }
  const median = (channel) => {
    const sorted = samples.map((pixel) => pixel[channel]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return `#${[0, 1, 2].map((channel) => median(channel).toString(16).padStart(2, "0")).join("")}`;
}

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00") {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
}

export const AI_PROVIDERS = new Set(["openai", "gemini", "minimax"]);

export function resolveProvider(setting) {
  const requested = setting("AI_PROVIDER", "openai");
  const provider = AI_PROVIDERS.has(requested) ? requested : "openai";
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : provider === "minimax" ? "MINIMAX_API_KEY" : "OPENAI_API_KEY";
  return { provider, keyName };
}

const AI_MODE_FILE = "ai-mode.json";
const AI_MODES = new Set(["test", "prod"]);

// TEST mode is meant to run on a Gemini API key with no billing account attached, so it can
// only ever touch free-tier endpoints. PROD mode uses the billed key. Defaults to "prod" so
// existing single-key setups keep working until someone opts into TEST from the UI.
export async function readAiMode(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, AI_MODE_FILE), "utf8"));
    return AI_MODES.has(parsed.mode) ? parsed.mode : "prod";
  } catch (error) {
    if (error.code === "ENOENT") return "prod";
    throw error;
  }
}

export async function writeAiMode(dataDir, mode) {
  if (!AI_MODES.has(mode)) throw Object.assign(new Error('mode must be "test" or "prod"'), { status: 400 });
  await atomicJson(path.join(dataDir, AI_MODE_FILE), { mode });
  return mode;
}

// OpenAI and MiniMax have no free tier, so mode only changes which key/model is used for Gemini.
export function resolveApiKey(setting, provider, mode) {
  if (provider === "minimax") return { key: setting("MINIMAX_API_KEY"), keyName: "MINIMAX_API_KEY" };
  if (provider !== "gemini") return { key: setting("OPENAI_API_KEY"), keyName: "OPENAI_API_KEY" };
  if (mode === "test") return { key: setting("GEMINI_API_KEY_TEST"), keyName: "GEMINI_API_KEY_TEST" };
  const legacyKey = setting("GEMINI_API_KEY");
  return setting("GEMINI_API_KEY_PROD")
    ? { key: setting("GEMINI_API_KEY_PROD"), keyName: "GEMINI_API_KEY_PROD" }
    : { key: legacyKey, keyName: "GEMINI_API_KEY" };
}

// gemini-2.5-flash-image is the only image model documented with a free tier; Nano Banana 2 and
// other premium image models require a billed project, so an unbilled TEST key can't run them.
export function isPremiumAllowed(provider, mode) {
  return provider !== "gemini" || mode === "prod";
}

export async function checkSetup(root, setting, mode = "prod") {
  const { provider } = resolveProvider(setting);
  const { key, keyName } = resolveApiKey(setting, provider, mode);
  const hasApiKey = Boolean(key && key.trim());
  const hasTestKey = provider === "gemini" ? Boolean(setting("GEMINI_API_KEY_TEST").trim()) : null;
  const hasProdKey = provider === "gemini" ? Boolean((setting("GEMINI_API_KEY_PROD") || setting("GEMINI_API_KEY")).trim()) : null;
  const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
  const referencePath = path.resolve(root, referenceSetting);
  let hasModelReference = false;
  try {
    hasModelReference = (await stat(referencePath)).isFile();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const faceReferenceSetting = setting("WARDROBE_FACE_REFERENCE", "data/model-reference-face.png");
  let hasFaceReference = false;
  try {
    hasFaceReference = (await stat(path.resolve(root, faceReferenceSetting))).isFile();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ready: hasApiKey && hasModelReference, hasApiKey, hasModelReference, modelReference: referenceSetting, hasFaceReference, faceReference: faceReferenceSetting, provider, keyName, mode, hasTestKey, hasProdKey };
}

// Optional close-up face/headshot reference. The full-body model-reference photo alone usually
// leaves the face as a tiny fraction of the frame, which is often the real bottleneck for
// consistent identity across generations — this gives the model far more facial detail to anchor
// to. Silently absent when the file doesn't exist; callers fall back to the full-body photo alone.
export async function loadFaceReference(root, setting) {
  const facePath = path.resolve(root, setting("WARDROBE_FACE_REFERENCE", "data/model-reference-face.png"));
  try {
    return { data: await readFile(facePath), mime: "image/png", name: "model-face.png" };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const IDENTITY_PROFILE_PROMPT = "Describe this person's visible physical identity in 2-4 factual, neutral sentences, to be used as a text-based redundancy alongside their photo when an AI image generator depicts them: apparent build/body type, apparent height impression, visible skin tone, hair color/length/style, face shape, apparent ethnicity, and any distinguishing features. Do not describe clothing, mood, or attractiveness — be direct and descriptive, not flattering.";

async function geminiDescribeIdentity({ key, model, images }) {
  const parts = [
    { text: IDENTITY_PROFILE_PROMPT },
    ...images.map((image) => ({ inlineData: { mimeType: "image/png", data: image.toString("base64") } })),
  ];
  const schema = { type: "object", properties: { profile: { type: "string" } }, required: ["profile"] };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini identity analysis failed (${response.status})`);
  const outputText = result.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!outputText) throw new Error("Gemini identity analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (typeof parsed.profile !== "string") throw new Error("Gemini identity analysis returned an invalid result");
  return parsed.profile;
}

async function openAIDescribeIdentity({ key, baseUrl, model, images }) {
  const content = [
    { type: "input_text", text: IDENTITY_PROFILE_PROMPT },
    ...images.map((image) => ({ type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}` })),
  ];
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "identity_profile", strict: true, schema: { type: "object", additionalProperties: false, properties: { profile: { type: "string" } }, required: ["profile"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI identity analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI identity analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (typeof parsed.profile !== "string") throw new Error("OpenAI identity analysis returned an invalid result");
  return parsed.profile;
}

// One-time, cached text description of the reference photos' visible identity (build, skin tone,
// hair, ethnicity, etc.), reused as a redundant text signal alongside the images themselves in
// buildModeledPrompt — a small face crop can be misread by the image model, but a text anchor
// survives even when that happens. Re-derived only when the reference photos change (same
// hash-then-cache pattern as suggestions-api.mjs's computeStyleDNA).
export async function computeIdentityProfile({ root, dataDir, setting, provider, mode }) {
  const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
  let modelData;
  try { modelData = await readFile(modelPath); }
  catch { return null; }
  const face = await loadFaceReference(root, setting);
  const hash = createHash("md5").update(modelData);
  if (face) hash.update(face.data);
  const digest = hash.digest("hex");
  const cacheFile = path.join(dataDir, "identity-profile.json");
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    if (cached.hash === digest && typeof cached.profile === "string") return cached.profile;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Vision analysis has no MiniMax path, so fall back to OpenAI the same way outfit style
  // analysis does (outfits-api.mjs) — a MiniMax setup can still get an identity profile.
  const identityProvider = provider === "gemini" ? "gemini" : "openai";
  const identityKey = identityProvider === "gemini" ? resolveApiKey(setting, "gemini", mode).key : setting("OPENAI_API_KEY");
  if (!identityKey) return null;
  const images = face ? [modelData, face.data] : [modelData];
  let profile;
  try {
    profile = identityProvider === "gemini"
      ? await geminiDescribeIdentity({ key: identityKey, model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"), images })
      : await openAIDescribeIdentity({ key: identityKey, baseUrl: setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), images });
  } catch (error) {
    console.warn(`Identity profile generation failed (${error.message})`);
    return null;
  }
  await atomicJson(cacheFile, { hash: digest, profile });
  return profile;
}

// "standard" = Gemini 2.5 Flash Image / OpenAI medium quality (cheap). "premium" = Nano Banana 2 (gemini-3.1-flash-image) / OpenAI high quality.
// MiniMax has no documented quality tiers, so both fall back to the same model unless a premium override is set.
export function resolveModeledModel(provider, tier, setting) {
  const premium = tier === "premium";
  if (provider === "gemini") {
    return {
      model: premium
        ? setting("GEMINI_MODELED_PREMIUM_MODEL", "gemini-3.1-flash-image")
        : setting("GEMINI_MODELED_MODEL", setting("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")),
      imageSize: setting("GEMINI_IMAGE_SIZE", "1K"),
    };
  }
  if (provider === "minimax") {
    return {
      model: premium
        ? setting("MINIMAX_MODELED_PREMIUM_MODEL", setting("MINIMAX_MODELED_MODEL", setting("MINIMAX_IMAGE_MODEL", "image-01")))
        : setting("MINIMAX_MODELED_MODEL", setting("MINIMAX_IMAGE_MODEL", "image-01")),
    };
  }
  return {
    model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
    quality: premium ? "high" : "medium",
  };
}

function describeGarment(meta = {}) {
  const label = meta?.name ? meta.name : "garment";
  const details = Array.isArray(meta?.tags) && meta.tags.length ? ` (${meta.tags.join(", ")})` : "";
  return `${label}${details}`;
}

// A flat-lay/product photo's sleeve foreshortens unpredictably, so the model needs an explicit
// anatomical anchor or it drifts toward a longer sleeve than the garment actually has — "oversized"
// especially gets misread as "longer sleeve" when it should only mean extra width/drop. Only fires
// for garments that read as short-sleeve from their own name/tags, so it never fights a genuine
// 3/4- or long-sleeve piece.
function isLikelyShortSleeve(meta = {}) {
  const text = `${meta?.name || ""} ${(Array.isArray(meta?.tags) ? meta.tags : []).join(" ")}`.toLowerCase();
  if (/3\s*\/\s*4|three.?quarter|long.?sleeve|elbow.?sleeve/.test(text)) return false;
  return /\bt-?shirt\b|\btee\b|\bpolo\b|\btank\b|\bshort.?sleeve\b/.test(text);
}

// Adding socks to an outfit alongside full-length trousers made the model invent a cuffed/rolled
// hem so the socks would show, which isn't the fit the trousers actually have. Socks should only
// become visible at the ankle when the bottoms are themselves cropped/ankle-length or are shorts —
// otherwise the trousers keep their natural full length and the socks stay hidden beneath the hem.
export function isLikelySocks(meta = {}) {
  if (meta?.part === "socks") return true;
  const text = `${meta?.name || ""} ${(Array.isArray(meta?.tags) ? meta.tags : []).join(" ")}`.toLowerCase();
  return /\bsocks?\b/.test(text);
}

export function isLikelyBottom(meta = {}) {
  if (meta?.part === "lowerbody") return true;
  const text = `${meta?.name || ""} ${(Array.isArray(meta?.tags) ? meta.tags : []).join(" ")}`.toLowerCase();
  return /\btrousers?\b|\bpants?\b|\bjeans?\b|\bchinos?\b|\bslacks?\b|\bleggings?\b|\bskirt\b/.test(text);
}

export function isLikelyCroppedOrShortBottom(meta = {}) {
  const text = `${meta?.name || ""} ${(Array.isArray(meta?.tags) ? meta.tags : []).join(" ")}`.toLowerCase();
  return /\bankle\b|\bcropped\b|\bcapri\b|\bbermuda\b|\bculottes?\b|\bshorts?\b|3\s*\/\s*4|three.?quarter/.test(text);
}

// garments: array of { name, tags } metadata, one per garment image, in the same order those
// images are attached — used to name every reference image explicitly (per Google's own Nano
// Banana prompting guidance: assign each input image a role rather than a bare "Image N") and to
// carry fit/length words (e.g. "cropped", "ankle-length", "oversized") from the item's own tags
// into the prompt, since the model otherwise has nothing but a loose "preserve fit" to go on.
export function buildModeledPrompt(garments = [{}], { hasFaceReference = false } = {}) {
  const list = garments.length ? garments : [{}];
  const multi = list.length > 1;
  let nextImage = 2;

  const imageRoles = ["Image 1 is the exact person who must appear in the output — use it as the ground truth for their identity, body proportions, and pose."];
  if (hasFaceReference) {
    imageRoles.push(`Image ${nextImage} is a close-up reference of that same person's face — the primary, overriding source for their exact facial identity: face shape, eyes, nose, mouth, skin tone, ethnicity, hairline, and any distinguishing features like facial hair, moles, or freckles. Do not idealize, beautify, lighten, or otherwise alter it.`);
    nextImage += 1;
  }
  const garmentStart = nextImage;
  list.forEach((meta, index) => {
    imageRoles.push(`Image ${garmentStart + index} is the exact ${describeGarment(meta)} to depict — reproduce it pixel-faithful to this photo.`);
  });
  const garmentEnd = garmentStart + list.length - 1;
  const garmentImagesPhrase = multi ? `Images ${garmentStart} through ${garmentEnd}` : `Image ${garmentStart}`;
  const wearingPhrase = multi
    ? `all ${list.length} garments from ${garmentImagesPhrase}, worn together as one complete outfit`
    : `the garment from ${garmentImagesPhrase}`;

  const shortSleeveNote = list.some(isLikelyShortSleeve)
    ? " A short-sleeve t-shirt, tee, or polo — even an oversized one — ends above the elbow, never at or past it; oversized fit reads as extra width and drop through the body, not a longer sleeve reaching further down the arm."
    : "";
  const bottomItem = list.find((meta) => isLikelyBottom(meta) && !isLikelySocks(meta));
  const sockNote = list.some(isLikelySocks) && bottomItem && !isLikelyCroppedOrShortBottom(bottomItem)
    ? " Do not cuff, roll up, or shorten the trousers to expose the socks — the trousers keep their natural full length reaching down to the shoe, with the socks staying hidden beneath the hem; only let socks show at the ankle if the bottoms are themselves cropped, ankle-length, or shorts."
    : "";
  const relationship = `Composite these into one photorealistic scene: the person from Image 1 (identity anchored by Image ${hasFaceReference ? 2 : 1}) wearing ${wearingPhrase}, reproduced pixel-faithful to ${garmentImagesPhrase} — same hem length, same sleeve or pant length, same looseness or tightness, same silhouette, judged against realistic human anatomy rather than an idealized average.${shortSleeveNote}${sockNote} If a garment is cropped, oversized, ankle-length, or any other specific cut in its reference photo, it must remain exactly that cut in the output. When genuinely uncertain about a length, render the shorter, tighter reading rather than a longer, looser one. Never lengthen, shorten, tighten, loosen, or otherwise "correct" a garment's proportions toward a more generic fit.`;

  const supportingClothes = multi
    ? "use understated neutral supporting clothes only for any part of the body the selected pieces don't already cover"
    : "use understated neutral supporting clothes";
  const scenario = `Create a professional horizontal 3:2 editorial fashion photograph. Preserve the person's recognizable identity, face, hair, age, ethnicity, skin tone, and body proportions exactly — this must read as the same individual, not a reinterpretation. Preserve every garment's color, material, construction, graphic, logo, and distinctive detail exactly as photographed. Keep ${multi ? "every featured piece" : "the complete featured item"} clearly visible and unobstructed, ${supportingClothes}, realistic anatomy, natural light, authentic fabric drape, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.`;

  return `Reference images:\n${imageRoles.join("\n")}\n\nRelationship instruction:\n${relationship}\n\nNew scenario:\n${scenario}`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

export async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

export async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

let backgroundRemovalPipelinePromise = null;
function loadBackgroundRemovalPipeline() {
  if (!backgroundRemovalPipelinePromise) {
    backgroundRemovalPipelinePromise = import("@huggingface/transformers")
      .then(({ pipeline }) => pipeline("background-removal", "onnx-community/BiRefNet-ONNX", { dtype: "fp16" }));
  }
  return backgroundRemovalPipelinePromise;
}

// Segments the garment out of an arbitrary background (a patterned floor, a table, a rug — not
// just a plain studio backdrop) using a real ML segmentation model instead of a color threshold.
// Only the alpha channel is touched, so source colors and texture never drift. Needs its model
// (~490MB) cached on first use. Returns the keyed image at its original size/orientation — not
// yet rotated or framed.
export async function removeBackgroundML(bytes) {
  const segmenter = await loadBackgroundRemovalPipeline();
  const result = await segmenter(new Blob([bytes]));
  return result.toSharp().png().toBuffer();
}

// Same contract as removeBackgroundML (keyed, not yet rotated or framed) but via a plain color
// threshold — used only as a fallback when the ML model can't be loaded.
export async function removeStudioBackground(bytes, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 40;
  const backgroundHex = options.backgroundColor || await detectBorderColor(bytes);
  const target = [1, 3, 5].map((offset) => Number.parseInt(backgroundHex.slice(offset, offset + 2), 16));
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else if (distance < tolerance + feather) {
      data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
    }
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

// removeBackgroundML leaves the original background RGB in place under alpha=0 (only the alpha
// channel is touched). That's invisible as-is, but rotate()/resize() interpolate neighboring
// pixels, so those "invisible" background colors bleed into the resampled edges as a faint ghost
// of the original background. Zeroing RGB wherever alpha is negligible removes that leaked color
// before any resampling happens.
async function zeroTransparentRgb(bytes, alphaThreshold = 8) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] <= alphaThreshold) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
    }
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

// For an already-unworn product photo (flat lay, ghost mannequin, hanging), the source pixels
// are already the correct color — regenerating the garment through the AI edit model only
// introduces color/texture drift. Try the ML segmentation model first since it handles any
// background; fall back to a plain-color-key heuristic if that model can't be loaded (e.g. no
// network for its one-time download). A flat lay is rarely photographed perfectly upright, so
// rotationDegrees (from vision analysis) straightens it before framing — the generative path
// doesn't need this since it always redraws the garment upright regardless of input orientation.
export async function removeUnwornGarmentBackground(bytes, options = {}) {
  let keyed;
  try {
    keyed = await removeBackgroundML(bytes);
  } catch (error) {
    console.warn(`ML background removal failed (${error.message}); falling back to color-based cleanup.`);
    keyed = await removeStudioBackground(bytes, options);
  }
  keyed = await zeroTransparentRgb(keyed);
  const rotation = Math.round(Number(options.rotationDegrees)) || 0;
  const rotated = rotation
    ? await sharp(keyed).rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
    : keyed;
  // A real segmentation mask can leave scattered low-confidence noise far from the garment (e.g.
  // a patterned floor's grid lines); a much higher trim threshold than the default keeps the crop
  // tight around the actual garment instead of being thrown off by a handful of stray pixels.
  return frameTransparentGarment(rotated, 1024, 0.88, 128);
}

export async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88, trimThreshold = 8) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= trimThreshold) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes, key) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

export async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

export async function openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality || "high");
  form.set("output_format", "png");
  if (background) form.set("background", background);
  for (const [index, image] of images.entries()) {
    const normalized = await normalizeImage(image.data);
    form.append("image[]", new Blob([normalized], { type: "image/png" }), image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`);
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

function geminiImageFormat(size) {
  const [width, height] = size.split("x").map(Number);
  const divisor = (a, b) => (b ? divisor(b, a % b) : a) || 1;
  const factor = divisor(width, height);
  return { aspect_ratio: `${width / factor}:${height / factor}` };
}

export async function geminiEdit({ key, model, prompt, images, size, imageSize }) {
  const input = [];
  for (const image of images) {
    const normalized = await normalizeImage(image.data);
    input.push({ type: "image", mime_type: "image/png", data: normalized.toString("base64") });
  }
  input.push({ type: "text", text: prompt });
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input,
      response_format: { type: "image", mime_type: "image/jpeg", image_size: imageSize, ...geminiImageFormat(size) },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini image request failed (${response.status})`);
  const encoded = result.output_image?.data
    || result.steps?.flatMap((step) => step.content || step.summary || []).find((block) => block.type === "image")?.data;
  if (!encoded) throw new Error("Gemini response did not contain image data");
  return Buffer.from(encoded, "base64");
}

function miniMaxDimensions(size) {
  const match = /^(\d+)x(\d+)$/.exec(typeof size === "string" ? size.trim() : "");
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const supported = (value) => Number.isInteger(value) && value >= 512 && value <= 2048 && value % 8 === 0;
  return supported(width) && supported(height) ? { width, height } : null;
}

export async function miniMaxEdit({ key, baseUrl, model, prompt, images, size, aspectRatio, responseFormat, promptOptimizer, seed }) {
  const subjectReference = [];
  for (const image of images) {
    const normalized = await normalizeImage(image.data);
    subjectReference.push({ type: "character", image_file: `data:image/png;base64,${normalized.toString("base64")}` });
  }
  const format = responseFormat === "url" ? "url" : "base64";
  const payload = { model, prompt: prompt.slice(0, 1500), response_format: format, n: 1 };
  if (subjectReference.length) payload.subject_reference = subjectReference;
  if (aspectRatio) {
    payload.aspect_ratio = aspectRatio;
  } else {
    const dimensions = miniMaxDimensions(size);
    if (dimensions) { payload.width = dimensions.width; payload.height = dimensions.height; }
  }
  if (promptOptimizer) payload.prompt_optimizer = true;
  if (Number.isInteger(seed)) payload.seed = seed;
  const response = await fetch(`${baseUrl}/image_generation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.base_resp?.status_msg || `MiniMax image request failed (${response.status})`);
  const statusCode = result.base_resp?.status_code;
  if (typeof statusCode === "number" && statusCode !== 0) {
    throw new Error(result.base_resp?.status_msg || `MiniMax image request failed (status ${statusCode})`);
  }
  const image = result.data?.image_urls?.[0];
  if (typeof image === "string" && image) {
    if (format === "base64") {
      const comma = image.indexOf(",");
      const encoded = image.startsWith("data:") && comma !== -1 ? image.slice(comma + 1) : image;
      return Buffer.from(encoded, "base64");
    }
    const download = await fetch(image);
    if (!download.ok) throw new Error(`MiniMax image download failed (${download.status})`);
    return Buffer.from(await download.arrayBuffer());
  }
  throw new Error("MiniMax response did not contain image data");
}

export async function geminiAnalyze({ key, model, image, mime }) {
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes", "socks"] },
            color: { type: "string", description: "6-digit hex color, such as #d8d0c2" },
            secondaryColor: { type: "string", description: "optional distinct 6-digit hex color" },
            tags: { type: "array", items: { type: "string" }, maxItems: 4 },
            worn: { type: "boolean", description: "true if a person is currently wearing this item in the photo; false if it's an unworn product shot (flat lay, ghost mannequin, hanging, or floating on a plain backdrop)" },
            rotationDegrees: { type: "integer", description: "clockwise rotation in degrees, -180 to 180, needed to make the item appear upright as it's normally worn or displayed (collar/waistband at top); 0 if it already appears upright" },
            boundingBox: {
              type: "object",
              properties: {
                x: { type: "integer" },
                y: { type: "integer" },
                width: { type: "integer" },
                height: { type: "integer" },
              },
              required: ["x", "y", "width", "height"],
            },
          },
          required: ["name", "part", "color", "tags", "worn", "rotationDegrees", "boundingBox"],
        },
      },
    },
    required: ["items"],
  };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes, socks. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags. Also set worn to true if a person is actually wearing the item in this photo, or false if it's an unworn product shot such as a flat lay, ghost mannequin, hanging, or floating on a plain backdrop with no person. And set rotationDegrees to the clockwise degrees (-180 to 180) needed to make the item appear upright — 0 if it's already upright, non-zero if the photo shows it tilted, sideways, or upside-down." },
        { inlineData: { mimeType: mime, data: image.toString("base64") } },
      ] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini analysis failed (${response.status})`);
  const outputText = result.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!outputText) throw new Error("Gemini analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("Gemini analysis returned an invalid clothing list");
  return parsed.items;
}

export async function openAIAnalyze({ key, baseUrl, model, image, mime }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes, socks. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags. Also set worn to true if a person is actually wearing the item in this photo, or false if it's an unworn product shot such as a flat lay, ghost mannequin, hanging, or floating on a plain backdrop with no person. And set rotationDegrees to the clockwise degrees (-180 to 180) needed to make the item appear upright — 0 if it's already upright, non-zero if the photo shows it tilted, sideways, or upside-down." },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes", "socks"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, worn: { type: "boolean" }, rotationDegrees: { type: "integer", minimum: -180, maximum: 180 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "worn", "rotationDegrees", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI analysis returned an invalid clothing list");
  return parsed.items;
}

const OUTFIT_STYLE_PROMPT = "Write a short one-sentence editorial description of this outfit as it would appear in a fashion lookbook caption, plus 2-4 concise lowercase style tags (such as minimal, street, business casual, evening). Base it only on what's visible in the photo.";

export async function geminiAnalyzeOutfitStyle({ key, model, image, mime }) {
  const schema = { type: "object", properties: { description: { type: "string" }, tags: { type: "array", items: { type: "string" }, maxItems: 4 } }, required: ["description", "tags"] };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: OUTFIT_STYLE_PROMPT },
        { inlineData: { mimeType: mime, data: image.toString("base64") } },
      ] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini analysis failed (${response.status})`);
  const outputText = result.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!outputText) throw new Error("Gemini analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (typeof parsed.description !== "string" || !Array.isArray(parsed.tags)) throw new Error("Gemini analysis returned an invalid outfit style result");
  return { description: parsed.description, tags: parsed.tags.filter((tag) => typeof tag === "string").slice(0, 4) };
}

export async function openAIAnalyzeOutfitStyle({ key, baseUrl, model, image, mime }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: OUTFIT_STYLE_PROMPT },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "outfit_style", strict: true, schema: { type: "object", additionalProperties: false, properties: { description: { type: "string" }, tags: { type: "array", items: { type: "string" }, maxItems: 4 } }, required: ["description", "tags"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (typeof parsed.description !== "string" || !Array.isArray(parsed.tags)) throw new Error("OpenAI analysis returned an invalid outfit style result");
  return { description: parsed.description, tags: parsed.tags.filter((tag) => typeof tag === "string").slice(0, 4) };
}

const MIRROR_REGIONS = ["upperbody", "lowerbody", "outerwear", "footwear", "accessory"];
const MIRROR_VOLUMES = ["fitted", "regular", "relaxed", "oversized"];
const MIRROR_HEM_SEVERITIES = ["slight", "moderate", "severe"];

// Perception-only prompt: the vision model reports what it sees (garment, color,
// silhouette, hem behavior) and nothing else. All judgment — what's actually a
// problem, what single fix addresses it — happens afterward in the deterministic
// style-rules engine, so the critique can never contradict itself the way a single
// free-form "describe and judge in one shot" call could.
function buildMirrorPerceptionPrompt() {
  return `You are looking at a photo of a person wearing an outfit. Identify each distinct visible garment and describe ONLY what you observe — do not judge, critique, rate, or suggest anything.

For each visible garment, report:
- region: one of "upperbody", "lowerbody", "outerwear", "footwear", "accessory" (use "outerwear" for a jacket/overshirt worn open over another top, "accessory" for belts/bags/hats/scarves/jewelry)
- description: a short 2-4 word description, e.g. "open-collar shirt" or "wide-leg cargo pants"
- color: the closest match from this exact list: ${COLOR_NAMES.join(", ")}
- volume: how the piece sits on the body — one of "fitted", "regular", "relaxed", "oversized"
- hemNotes: for lowerbody garments ONLY, a short factual note if the hem visibly pools, stacks, or bunches at the shoe (e.g. "pools over the shoe"); otherwise null
- hemSeverity: only when hemNotes is set — one of "slight" (a light break/rest on the shoe, barely bunching), "moderate" (visibly bunches but doesn't obstruct the shoe), "severe" (heavy bunching, fabric mostly covers the shoe or drags); otherwise null. Judge this purely on how much fabric is stacked, not on whether the trouser is a wide-leg or relaxed cut — a wide-leg trouser can have a slight, normal amount of break just like a slim one.

List every clearly visible garment. Do not invent garments you can't see, and do not add commentary.`;
}

const MIRROR_PERCEPTION_SCHEMA_GEMINI = {
  type: "object",
  properties: {
    garments: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          region: { type: "string", enum: MIRROR_REGIONS },
          description: { type: "string" },
          color: { type: "string", enum: COLOR_NAMES },
          volume: { type: "string", enum: MIRROR_VOLUMES },
          hemNotes: { type: "string", nullable: true },
          hemSeverity: { type: "string", enum: MIRROR_HEM_SEVERITIES, nullable: true },
        },
        required: ["region", "description", "color", "volume", "hemNotes", "hemSeverity"],
      },
    },
  },
  required: ["garments"],
};

export async function geminiPerceiveOutfit({ key, model, image, mime }) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: buildMirrorPerceptionPrompt() },
        { inlineData: { mimeType: mime, data: image.toString("base64") } },
      ] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: MIRROR_PERCEPTION_SCHEMA_GEMINI },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Gemini perception failed (${response.status})`);
  const outputText = result.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!outputText) throw new Error("Gemini perception returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.garments)) throw new Error("Gemini perception returned an invalid result");
  return parsed.garments;
}

export async function openAIPerceiveOutfit({ key, baseUrl, model, image, mime }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: buildMirrorPerceptionPrompt() },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "mirror_perception", strict: true, schema: {
        type: "object", additionalProperties: false,
        properties: {
          garments: {
            type: "array", maxItems: 8,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                region: { type: "string", enum: MIRROR_REGIONS },
                description: { type: "string" },
                color: { type: "string", enum: COLOR_NAMES },
                volume: { type: "string", enum: MIRROR_VOLUMES },
                hemNotes: { type: ["string", "null"] },
                hemSeverity: { type: ["string", "null"], enum: [...MIRROR_HEM_SEVERITIES, null] },
              },
              required: ["region", "description", "color", "volume", "hemNotes", "hemSeverity"],
            },
          },
        },
        required: ["garments"],
      } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI perception failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI perception returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.garments)) throw new Error("OpenAI perception returned an invalid result");
  return parsed.garments;
}

export function wardrobeImportApi(options = {}) {
  let root;
  let dataDir;
  let jobsDir;
  let importedFile;
  let libraryAssetDir;
  const running = new Map();
  const runningModeled = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const miniMaxBaseUrl = () => setting("MINIMAX_API_BASE_URL", "https://api.minimax.io/v1").replace(/\/$/, "");
  const activeProvider = () => resolveProvider(setting).provider;
  const currentMode = () => readAiMode(dataDir);

  async function setupStatus() {
    return checkSetup(root, setting, await currentMode());
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(jobsDir, id, "job.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
  }

  async function loadImported() {
    try { return JSON.parse(await readFile(importedFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function persistImported(job) {
    const id = `import-${job.id}`;
    await mkdir(libraryAssetDir, { recursive: true });
    const garmentName = `${id}-garment.png`;
    const garmentSource = job.stages.garment.assetUrl
      ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
      : `garment-${job.stages.garment.attempts}.png`;
    await copyFile(path.join(jobsDir, job.id, garmentSource), path.join(libraryAssetDir, garmentName));
    const metadata = job.metadata || {};
    const records = await loadImported();
    const existing = records.find((record) => record.id === id);
    const record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: existing?.modeledImage || null,
      modeledStatus: existing?.modeledStatus || null,
      modeledError: existing?.modeledError || null,
      modeledTier: existing?.modeledTier || null,
      importJobId: job.id,
    };
    const next = [...records.filter((item) => item.id !== id), record];
    await atomicJson(importedFile, next);
    return record;
  }

  async function generateModeledForItem(id, { tier, prompt }) {
    if (runningModeled.has(id)) return runningModeled.get(id);
    const task = (async () => {
      try {
        const provider = activeProvider();
        const mode = await currentMode();
        const { key, keyName } = resolveApiKey(setting, provider, mode);
        if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
        if (tier === "premium" && !isPremiumAllowed(provider, mode)) {
          throw new Error("Premium quality needs PROD mode — the free TEST key has no billing enabled for Nano Banana 2. Switch to PROD to generate this.");
        }
        const garment = { data: await readFile(path.join(libraryAssetDir, `${id}-garment.png`)), mime: "image/png", name: "garment.png" };
        const itemRecord = (await loadImported()).find((record) => record.id === id);
        const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
        let modelData;
        try {
          modelData = await readFile(modelPath);
        } catch (error) {
          if (error.code === "ENOENT") throw new Error(`Model reference not found at ${modelPath}. Set WARDROBE_MODEL_REFERENCE or add data/model-reference.png.`);
          throw error;
        }
        const model = { data: modelData, mime: "image/png", name: "model.png" };
        const face = await loadFaceReference(root, setting);
        const referenceImages = face ? [model, face] : [model];
        // Tried dropping the face closeup on standard tier on the theory that two "person" images
        // were competing — tested against the same outfit and it was still an unreliable draw either
        // way, so the face closeup isn't the cause. Reverted; keeping this for reference in case it's
        // worth revisiting once standard tier itself changes.
        // const useFaceReference = tier === "premium" && Boolean(face);
        // const referenceImages = useFaceReference ? [model, face] : [model];
        const basePrompt = options.modeledPrompt || buildModeledPrompt([{ name: itemRecord?.name, tags: itemRecord?.tags }], { hasFaceReference: Boolean(face) });
        const identityProfile = await computeIdentityProfile({ root, dataDir, setting, provider, mode });
        const withIdentity = identityProfile ? `${basePrompt}\nAdditional identity notes for consistency: ${identityProfile}` : basePrompt;
        const modeledPrompt = prompt ? `${withIdentity}\nUser regeneration direction: ${prompt}` : withIdentity;
        const resolved = resolveModeledModel(provider, tier, setting);
        let bytes;
        if (provider === "gemini") {
          bytes = await geminiEdit({ key, model: resolved.model, imageSize: resolved.imageSize, size: "1536x1024", images: [...referenceImages, garment], prompt: modeledPrompt });
        } else if (provider === "minimax") {
          const seedValue = setting("MINIMAX_IMAGE_SEED").trim();
          bytes = await miniMaxEdit({
            key, baseUrl: miniMaxBaseUrl(), model: resolved.model, prompt: modeledPrompt, images: [...referenceImages, garment], size: "1536x1024",
            aspectRatio: setting("MINIMAX_IMAGE_ASPECT_RATIO"),
            responseFormat: setting("MINIMAX_IMAGE_RESPONSE_FORMAT", "base64"),
            promptOptimizer: setting("MINIMAX_PROMPT_OPTIMIZER") === "true",
            seed: /^-?\d+$/.test(seedValue) ? Number(seedValue) : undefined,
          });
        } else {
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: resolved.model, quality: resolved.quality, size: "1536x1024", images: [...referenceImages, garment], prompt: modeledPrompt });
        }
        const modeledName = `${id}-modeled.png`;
        await writeFile(path.join(libraryAssetDir, modeledName), bytes);
        const records = await loadImported();
        await atomicJson(importedFile, records.map((record) => record.id === id
          ? { ...record, modeledImage: `${LIBRARY_ASSET_ROOT}/${modeledName}`, modeledStatus: null, modeledError: null, modeledTier: tier }
          : record));
      } catch (error) {
        const records = await loadImported();
        await atomicJson(importedFile, records.map((record) => record.id === id
          ? { ...record, modeledStatus: "error", modeledError: error.message }
          : record));
      }
    })().finally(() => runningModeled.delete(id));
    runningModeled.set(id, task);
    return task;
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id);
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const dir = path.join(jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        const sourceFile = current.internal.cropFile ? current.internal.cropFile : current.internal.originalFile;
        const original = { data: await readFile(path.join(dir, sourceFile)), mime: "image/png", name: sourceFile };

        // An unworn product photo's pixels are already correct — key out its real backdrop
        // directly instead of asking the AI edit model to repaint the garment. A manual
        // regenerate-with-direction always goes through the AI model since the user is
        // explicitly asking for a repaint.
        let bytes;
        if (current.metadata.worn === false && !current.stages.garment.prompt) {
          bytes = await removeUnwornGarmentBackground(original.data, { rotationDegrees: current.metadata.rotationDegrees });
        } else {
          const provider = activeProvider();
          const mode = await currentMode();
          const { key, keyName } = resolveApiKey(setting, provider, mode);
          if (!key) throw new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode`);
          const requestedChromaKey = chooseChromaKey(current.metadata.color);
          const basePrompt = options.garmentPrompt || buildGarmentPrompt(current.metadata, requestedChromaKey);
          const garmentPrompt = current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt;
          let rawBytes;
          if (provider === "gemini") {
            rawBytes = await geminiEdit({ key, model: setting("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image"), imageSize: setting("GEMINI_IMAGE_SIZE", "1K"), size: "1024x1024", images: [original], prompt: garmentPrompt });
          } else if (provider === "minimax") {
            const seedValue = setting("MINIMAX_IMAGE_SEED").trim();
            rawBytes = await miniMaxEdit({
              key, baseUrl: miniMaxBaseUrl(), model: setting("MINIMAX_GARMENT_MODEL", setting("MINIMAX_IMAGE_MODEL", "image-01")), prompt: garmentPrompt, images: [original], size: "1024x1024",
              aspectRatio: setting("MINIMAX_IMAGE_ASPECT_RATIO"),
              responseFormat: setting("MINIMAX_IMAGE_RESPONSE_FORMAT", "base64"),
              promptOptimizer: setting("MINIMAX_PROMPT_OPTIMIZER") === "true",
              seed: /^-?\d+$/.test(seedValue) ? Number(seedValue) : undefined,
            });
          } else {
            rawBytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1024x1024", images: [original], prompt: garmentPrompt });
          }
          // Gemini and MiniMax don't reliably render the exact requested chroma color, so detect whatever solid backdrop they actually used instead of trusting the request.
          chromaKeyUsed = provider === "openai" ? requestedChromaKey : await detectBorderColor(rawBytes);
          const rawName = `${stageName}-${stage.attempts}-source.png`;
          await writeFile(path.join(dir, rawName), rawBytes);
          failedAssetUrl = `${ASSET_ROOT}/${current.id}/${rawName}`;
          bytes = await removeChromaBackground(rawBytes, chromaKeyUsed);
        }
        await writeFile(output, bytes);
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${path.basename(output)}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/")) return next();
    try {
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        return json(res, 200, await loadImported());
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        return json(res, 200, await setupStatus());
      }
      if (url.pathname === "/api/import/mode" && req.method === "GET") {
        return json(res, 200, { mode: await currentMode() });
      }
      if (url.pathname === "/api/import/mode" && req.method === "POST") {
        const input = await body(req);
        const mode = await writeAiMode(dataDir, input.mode);
        return json(res, 200, { mode });
      }
      const wardrobeDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
      if (wardrobeDeleteMatch && req.method === "DELETE") {
        const id = wardrobeDeleteMatch[1];
        const records = await loadImported();
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Imported wardrobe item not found" });
        await atomicJson(importedFile, next);
        await Promise.all([
          rm(path.join(libraryAssetDir, `${id}-garment.png`), { force: true }),
          rm(path.join(libraryAssetDir, `${id}-modeled.png`), { force: true }),
        ]);
        return json(res, 200, { deleted: true, id });
      }
      const modeledMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/modeled$/i);
      if (modeledMatch && req.method === "POST") {
        const id = modeledMatch[1];
        const records = await loadImported();
        const record = records.find((item) => item.id === id);
        if (!record) return json(res, 404, { error: "Imported wardrobe item not found" });
        const setup = await setupStatus();
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && `${setup.keyName} in .env for ${setup.mode.toUpperCase()} mode`,
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const tier = input.tier === "premium" ? "premium" : "standard";
        if (tier === "premium" && !isPremiumAllowed(setup.provider, setup.mode)) {
          return json(res, 400, { error: "Premium quality needs PROD mode — the free TEST key has no billing enabled for Nano Banana 2. Switch to PROD to generate this." });
        }
        const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) : "";
        const updated = { ...record, modeledStatus: "processing", modeledError: null, modeledTier: tier };
        await atomicJson(importedFile, records.map((item) => item.id === id ? updated : item));
        void generateModeledForItem(id, { tier, prompt });
        return json(res, 202, updated);
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const file = path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(jobsDir, assetMatch[1], path.basename(assetMatch[2]));
        await stat(file);
        res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }
      if (url.pathname === API_ROOT && req.method === "POST") {
        const setup = await setupStatus();
        const provider = activeProvider();
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && `${setup.keyName} in .env for ${setup.mode.toUpperCase()} mode`,
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const image = decodeImage(input);
        const normalizedImage = await normalizeImage(image.data);
        const { key } = resolveApiKey(setting, provider, setup.mode);
        const detected = (provider === "gemini"
          ? await geminiAnalyze({ key, model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"), image: normalizedImage, mime: "image/png" })
          : await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: normalizedImage, mime: "image/png" })
        ).map(normalizeMetadata);
        const jobs = [];
        for (const metadata of detected) {
          const id = randomUUID();
          const dir = path.join(jobsDir, id); await mkdir(dir, { recursive: true });
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await writeFile(path.join(dir, originalFile), normalizedImage);
          await writeFile(path.join(dir, cropFile), croppedImage);
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          const job = { id, status: "active", metadata, stages: { crop: cropStage, garment: stageState() }, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job); jobs.push(publicJob(job));
        }
        return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
      }
      if (url.pathname === API_ROOT && req.method === "GET") {
        const ids = await readdir(jobsDir).catch(() => []);
        const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
        const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected");
        await Promise.all(hiddenJobs.map((job) => rm(path.join(jobsDir, job.id), { recursive: true, force: true })));
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(res, 200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") return json(res, 200, publicJob(job));
      if (!action && req.method === "DELETE") {
        await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await body(req);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }); await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && req.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await body(req);
        const tolerance = cleanupTolerance(input.tolerance);
        const sourceName = path.basename(new URL(stage.failedAssetUrl, "http://localhost").pathname);
        const source = await readFile(path.join(jobsDir, job.id, sourceName));
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
        stage.chromaKey = key;
        stage.cleanupTolerance = cleaned.tolerance;
        stage.cleanupDiagnostics = cleaned.verification;
        stage.cleanupPreviewUrl = previewUrl;
        stage.updatedAt = new Date().toISOString();
        if (cleanupAction[1] === "cleanup-accept") {
          stage.status = "review";
          stage.decision = null;
          stage.error = null;
          stage.assetUrl = previewUrl;
        }
        await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment)\/(approve|reject|regenerate)$/);
      if (stageMatch && req.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await body(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          void generate(job, stageName);
          return json(res, 202, publicJob(job));
        }
        if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        if (stageName === "garment" && decision === "approve") job.status = "complete";
        await saveJob(job);
        if (decision === "approve" && stageName === "garment") {
          try {
            await persistImported(job);
          } catch (error) {
            job.stages[stageName].status = previousStatus;
            job.stages[stageName].decision = previousDecision;
            job.status = previousJobStatus;
            await saveJob(job);
            throw error;
          }
        }
        if (decision === "reject") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        if (startGarment) void generate(job, "garment");
        const response = publicJob(job);
        if (job.status === "complete") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, response);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message, ...(process.env.NODE_ENV === "development" && statusCode === 500 ? { detail: error.message } : {}) });
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      jobsDir = path.join(dataDir, "jobs");
      importedFile = path.join(dataDir, "library.json");
      libraryAssetDir = path.join(dataDir, "imported");
      await mkdir(jobsDir, { recursive: true });
      await mkdir(libraryAssetDir, { recursive: true });
      const ids = await readdir(jobsDir).catch(() => []);
      for (const id of ids) {
        const job = await loadJob(id);
        if (!job) continue;
        if (job.status === "complete") {
          try {
            await persistImported(job);
            await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          } catch (error) {
            job.status = "active";
            job.stages.garment.status = "review";
            job.stages.garment.decision = null;
            job.stages.garment.error = null;
            await saveJob(job);
          }
          continue;
        }
        if (job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected") {
          await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          continue;
        }
        if (job.stages.crop && job.stages.crop.status !== "approved") continue;
        if (["processing", "queued"].includes(job.stages.garment.status)) {
          job.stages.garment.status = "pending";
          await saveJob(job);
          void generate(job, "garment");
        }
      }
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
