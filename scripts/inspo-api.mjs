import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { atomicJson } from "./import-job-api.mjs";
import { detectAndCreateWishlistItems, wishlistPaths } from "./wishlist-api.mjs";

const INSPO_ASSET_ROOT = "/api/inspo/assets";
const VALID_PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes", "socks", "full_look"]);

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 50 * 1024 * 1024) {
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

function decodeBase64Image(raw) {
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const data = Buffer.from(match ? match[2] : raw, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return data;
}

async function fetchUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw Object.assign(new Error(`Invalid URL: ${url}`), { status: 400 }); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("Only http and https URLs are supported"), { status: 400 });
  }
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; Wardrobe/1.0)" } });
  if (!response.ok) throw new Error(`Could not fetch image: HTTP ${response.status} from ${url}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`URL did not return an image (got ${contentType}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function savePinImage(assetDir, id, bytes) {
  const filename = `${id}.jpg`;
  const resized = await sharp(bytes)
    .rotate()
    .resize(1200, 1600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  await writeFile(path.join(assetDir, filename), resized);
  return `${INSPO_ASSET_ROOT}/${filename}`;
}

function newPin(id, imageUrl, sourceUrl = null) {
  const now = new Date().toISOString();
  return {
    id,
    sourceUrl,
    image: imageUrl,
    category: null,
    name: "",
    notes: "",
    colors: [],
    detectStatus: null,
    detectError: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function inspoApi(options = {}) {
  let root;
  let dataDir;
  let inspoFile;
  let inspoAssetDir;
  const detecting = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;

  async function loadPins() {
    try { return JSON.parse(await readFile(inspoFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function detectPinItems(id) {
    if (detecting.has(id)) return detecting.get(id);
    const task = (async () => {
      try {
        const pins = await loadPins();
        const pin = pins.find((p) => p.id === id);
        if (!pin) throw new Error("Pin not found");

        const filename = path.basename(pin.image);
        const imageBytes = await readFile(path.join(inspoAssetDir, filename));
        const { wishlistFile, wishlistAssetDir } = wishlistPaths(root, setting);
        const { created, aggregate } = await detectAndCreateWishlistItems({
          imageBytes, sourcePinId: pin.id, sourceUrl: pin.sourceUrl, setting, dataDir, wishlistFile, wishlistAssetDir,
        });

        const fresh = await loadPins();
        await atomicJson(inspoFile, fresh.map((p) => p.id === id
          ? {
            ...p,
            category: aggregate?.category ?? p.category,
            name: aggregate?.name || p.name,
            colors: aggregate?.colors?.length ? aggregate.colors : p.colors,
            detectStatus: null,
            detectError: created.length ? null : "No distinct wearable items were detected in this photo.",
            updatedAt: new Date().toISOString(),
          }
          : p));
      } catch (error) {
        const fresh = await loadPins();
        await atomicJson(inspoFile, fresh.map((p) => p.id === id
          ? { ...p, detectStatus: "error", detectError: error.message, updatedAt: new Date().toISOString() }
          : p));
      }
    })().finally(() => detecting.delete(id));
    detecting.set(id, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/inspo")) return next();

    try {
      // GET /api/inspo
      if (url.pathname === "/api/inspo" && req.method === "GET") {
        return json(res, 200, await loadPins());
      }

      // POST /api/inspo — batch create
      if (url.pathname === "/api/inspo" && req.method === "POST") {
        const input = await body(req);
        const entries = Array.isArray(input.entries) ? input.entries : [input];
        if (!entries.length) throw Object.assign(new Error("No entries provided"), { status: 400 });
        if (entries.length > 30) throw Object.assign(new Error("Maximum 30 entries per batch"), { status: 400 });

        const created = [];
        const errors = [];

        for (const entry of entries) {
          const id = `inspo-${randomUUID()}`;
          try {
            let bytes;
            let sourceUrl = null;

            if (entry.url) {
              sourceUrl = entry.url;
              bytes = await fetchUrl(entry.url);
            } else if (entry.imageDataUrl || entry.imageBase64) {
              const raw = entry.imageDataUrl || entry.imageBase64;
              bytes = decodeBase64Image(raw);
            } else {
              errors.push({ input: entry, error: "Each entry needs a url or imageDataUrl" });
              continue;
            }

            const imageUrl = await savePinImage(inspoAssetDir, id, bytes);
            const pin = newPin(id, imageUrl, sourceUrl);
            const pins = await loadPins();
            await atomicJson(inspoFile, [...pins, pin]);
            created.push(pin);
          } catch (entryError) {
            errors.push({ input: entry, error: entryError.message });
          }
        }

        return json(res, created.length ? 201 : 400, { created, errors });
      }

      // POST /api/inspo/:id/detect
      const detectMatch = url.pathname.match(/^\/api\/inspo\/(inspo-[a-f0-9-]{36})\/detect$/i);
      if (detectMatch && req.method === "POST") {
        const id = detectMatch[1];
        const pins = await loadPins();
        const pin = pins.find((p) => p.id === id);
        if (!pin) return json(res, 404, { error: "Pin not found" });
        if (pin.detectStatus === "processing") return json(res, 200, pin);

        const updated = { ...pin, detectStatus: "processing", detectError: null, updatedAt: new Date().toISOString() };
        await atomicJson(inspoFile, pins.map((p) => p.id === id ? updated : p));
        void detectPinItems(id);
        return json(res, 202, updated);
      }

      // PATCH /api/inspo/:id
      const itemMatch = url.pathname.match(/^\/api\/inspo\/(inspo-[a-f0-9-]{36})$/i);
      if (itemMatch && (req.method === "PATCH" || req.method === "PUT")) {
        const id = itemMatch[1];
        const pins = await loadPins();
        const pin = pins.find((p) => p.id === id);
        if (!pin) return json(res, 404, { error: "Pin not found" });
        const input = await body(req);
        const updated = {
          ...pin,
          name: typeof input.name === "string" ? input.name.trim().slice(0, 200) : pin.name,
          notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : pin.notes,
          category: typeof input.category === "string" && VALID_PARTS.has(input.category) ? input.category : pin.category,
          updatedAt: new Date().toISOString(),
        };
        await atomicJson(inspoFile, pins.map((p) => p.id === id ? updated : p));
        return json(res, 200, updated);
      }

      // DELETE /api/inspo/:id
      if (itemMatch && req.method === "DELETE") {
        const id = itemMatch[1];
        const pins = await loadPins();
        const pin = pins.find((p) => p.id === id);
        if (!pin) return json(res, 404, { error: "Pin not found" });
        const remaining = pins.filter((p) => p.id !== id);
        await atomicJson(inspoFile, remaining);
        if (pin.image) {
          const filename = path.basename(pin.image);
          await rm(path.join(inspoAssetDir, filename), { force: true });
        }
        return json(res, 200, { deleted: true, id });
      }

      // GET /api/inspo/assets/:file
      const assetMatch = url.pathname.match(/^\/api\/inspo\/assets\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(inspoAssetDir, path.basename(assetMatch[1]));
        const ext = path.extname(file).toLowerCase();
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-inspo-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      inspoFile = path.join(dataDir, "inspo.json");
      inspoAssetDir = path.join(dataDir, "inspo-assets");
      await mkdir(dataDir, { recursive: true });
      await mkdir(inspoAssetDir, { recursive: true });
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
