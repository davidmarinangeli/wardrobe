import { readFile } from "node:fs/promises";
import path from "node:path";
import { geminiPerceiveOutfit, normalizeImage, openAIPerceiveOutfit, readAiMode, resolveApiKey, resolveOpenAICompatibleBaseUrl, resolveProvider } from "./import-job-api.mjs";
import { buildMirrorCritique } from "./style-rules.mjs";
import { geminiJudgeOutfit, openAIJudgeOutfit } from "./mirror-judge.mjs";
import { recordSignal } from "./preferences-api.mjs";

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

function decodeImage(input) {
  const raw = input.imageDataUrl;
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("imageDataUrl is required"), { status: 400 });
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match?.[1] || "image/png";
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return { data, mime };
}

export function mirrorApi(options = {}) {
  let root;
  let dataDir;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = (provider) => resolveOpenAICompatibleBaseUrl(setting, provider);

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/mirror")) return next();

    try {
      if (url.pathname === "/api/mirror/critique" && req.method === "POST") {
        const input = await body(req);
        const { data, mime } = decodeImage(input);
        const normalized = await normalizeImage(data);

        const { provider } = resolveProvider(setting);
        const mode = await readAiMode(dataDir);
        // MiniMax has no vision path, so only it falls back to OpenAI.
        const critiqueProvider = provider === "gemini" || provider === "openrouter" ? provider : "openai";
        const { key, keyName } = resolveApiKey(setting, critiqueProvider, mode);
        if (!key) return json(res, 503, { error: `${keyName} is not configured for ${mode.toUpperCase()} mode.` });

        const libraryFile = path.join(dataDir, "library.json");
        let items;
        try { items = JSON.parse(await readFile(libraryFile, "utf8")); }
        catch (error) { if (error.code === "ENOENT") items = []; else throw error; }

        // Two passes, deliberately split. The first only observes; the second only
        // decides which of a fixed catalogue of observations applies, citing the
        // garments it is relying on. Neither can invent a fact the other did not
        // report, and neither picks the remedy — style-rules.mjs re-derives the
        // evidence, drops any finding that does not hold, and works out the fix
        // from the wardrobe itself. One free-form call doing all three at once is
        // what used to produce critiques that contradicted their own swaps.
        const perception = critiqueProvider === "gemini"
          ? await geminiPerceiveOutfit({ key, model: setting("GEMINI_VISION_MODEL", "gemini-3.6-flash"), image: normalized, mime: "image/png" })
          : await openAIPerceiveOutfit({
            key,
            baseUrl: apiBaseUrl(critiqueProvider),
            model: critiqueProvider === "openrouter" ? setting("OPENROUTER_VISION_MODEL", "openai/gpt-5.4-mini") : setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
            image: normalized,
            mime: "image/png",
          });

        // A judge that fails is not a critique that fails: an empty judgment
        // yields an honest, positive read of the outfit rather than an error
        // page, and every finding it would have made was optional anyway.
        let judgment = { findings: [], works: [] };
        try {
          judgment = critiqueProvider === "gemini"
            ? await geminiJudgeOutfit({ key, model: setting("GEMINI_JUDGE_MODEL", setting("GEMINI_SUGGESTIONS_MODEL", "gemini-3.6-flash")), perception })
            : await openAIJudgeOutfit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_JUDGE_MODEL", "gpt-5.4-mini"), perception });
        } catch (judgeError) {
          console.warn("[mirror] judgment step failed, falling back to observation only:", judgeError.message);
        }

        const critique = buildMirrorCritique(perception, judgment, items);

        // Ground truth of what is actually being worn, not just planned.
        await recordSignal(dataDir, { type: "mirror_submitted" });

        return json(res, 200, { critique });
      }

      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || 500;
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message });
    }
  }

  return {
    name: "wardrobe-mirror-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
