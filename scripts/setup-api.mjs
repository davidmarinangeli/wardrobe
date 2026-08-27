import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AI_PROVIDERS } from "./import-job-api.mjs";

const WRITABLE_KEYS = new Set(["AI_PROVIDER", "OPENAI_API_KEY", "GEMINI_API_KEY_TEST", "GEMINI_API_KEY_PROD", "MINIMAX_API_KEY"]);
const ENV_LINE = /^([A-Z0-9_]+)=/;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 15 * 1024 * 1024) {
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

async function readTextFile(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Rewrites matching KEY=... lines in place (preserving every other line, including comments)
// and appends any keys that weren't already present, so a hand-edited .env keeps its shape.
export function upsertEnvValues(content, values) {
  const lines = (content ?? "").split("\n");
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = line.match(ENV_LINE);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${values[match[1]]}`;
    }
    return line;
  });
  const additions = Object.entries(values).filter(([key]) => !seen.has(key));
  if (additions.length) {
    if (updated.length && updated[updated.length - 1].trim() !== "") updated.push("");
    for (const [key, value] of additions) updated.push(`${key}=${value}`);
  }
  while (updated.length > 1 && updated[updated.length - 1] === "" && updated[updated.length - 2] === "") updated.pop();
  return `${updated.join("\n").replace(/\n+$/, "")}\n`;
}

export function wardrobeSetupApi(options = {}) {
  let root;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;

  async function saveEnvValues(values) {
    const envPath = path.join(root, ".env");
    const examplePath = path.join(root, ".env.example");
    const existing = (await readTextFile(envPath)) ?? (await readTextFile(examplePath)) ?? "";
    await writeFile(envPath, upsertEnvValues(existing, values));
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/setup/")) return next();
    try {
      if (url.pathname === "/api/setup/config" && req.method === "POST") {
        const input = await body(req);
        const values = {};
        if (typeof input.provider === "string" && AI_PROVIDERS.has(input.provider)) values.AI_PROVIDER = input.provider;
        if (input.values && typeof input.values === "object" && !Array.isArray(input.values)) {
          for (const [key, rawValue] of Object.entries(input.values)) {
            if (!WRITABLE_KEYS.has(key) || typeof rawValue !== "string") continue;
            const trimmed = rawValue.trim();
            if (!trimmed) continue;
            if (/[\r\n]/.test(trimmed)) throw Object.assign(new Error(`${key} cannot contain line breaks`), { status: 400 });
            values[key] = trimmed;
          }
        }
        if (!Object.keys(values).length) throw Object.assign(new Error("Nothing to save"), { status: 400 });
        await saveEnvValues(values);
        // Vite watches .env files itself and restarts the dev server (and the browser's HMR
        // client reloads the page) as soon as this write lands — no explicit restart needed here.
        return json(res, 200, { saved: true, restarting: true });
      }
      if (url.pathname === "/api/setup/reference" && req.method === "POST") {
        const input = await body(req);
        const kind = input.kind === "face" ? "face" : "full";
        const raw = input.imageDataUrl;
        const match = typeof raw === "string" ? raw.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/is) : null;
        if (!match) throw Object.assign(new Error("A PNG or JPG image is required"), { status: 400 });
        const bytes = Buffer.from(match[1], "base64");
        if (!bytes.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
        const normalized = await sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
        const settingKey = kind === "face" ? "WARDROBE_FACE_REFERENCE" : "WARDROBE_MODEL_REFERENCE";
        const fallback = kind === "face" ? "data/model-reference-face.png" : "data/model-reference.png";
        const targetPath = path.resolve(root, setting(settingKey, fallback));
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, normalized);
        return json(res, 200, { saved: true, kind });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-setup-api",
    apply: "serve",
    configResolved(config) { root = config.root; },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
