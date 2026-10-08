import {
  geminiEdit, isPremiumAllowed, miniMaxEdit, openAIImage, openAIImageOptions, openRouterEdit,
  readAiMode, resolveApiKey, resolveModeledModel, resolveOpenAICompatibleBaseUrl, resolveProvider,
} from "./import-job-api.mjs";

/** Reuse the app's image provider and TEST/PROD credentials, without a model photo. */
export async function cheatSheetImageSettings(setting, dataDir, requestedTier = "standard") {
  const { provider } = resolveProvider(setting);
  const mode = await readAiMode(dataDir);
  const { key, keyName } = resolveApiKey(setting, provider, mode);
  if (!key) throw Object.assign(new Error(`${keyName} is not configured for ${mode.toUpperCase()} mode. Add it in Settings.`), { status: 400 });
  const tier = requestedTier === "openrouter" && provider === "openrouter"
    ? "openrouter" : requestedTier === "premium" ? "premium" : "standard";
  if (tier === "premium" && !isPremiumAllowed(provider, mode)) {
    throw Object.assign(new Error("Premium quality needs PROD mode — the free TEST key has no billing enabled for Nano Banana 2. Switch to PROD to generate this."), { status: 400 });
  }
  return { provider, key, setting, tier, ...resolveModeledModel(provider, tier, setting) };
}

export async function generateCheatSheetImage({ data, prompt, width, height, settings }) {
  const { provider, key, setting, model, quality, imageSize } = settings;
  const images = [{ data, mime: "image/png", name: "cheat-sheet.png" }];
  // Providers have fixed output sizes. Ask for the closest orientation and
  // preserve the returned canvas; thumbnail fitting is handled separately.
  const size = width === height ? "1024x1024" : width > height ? "1536x1024" : "1024x1536";
  if (provider === "gemini") {
    return geminiEdit({ key, model, imageSize, images, prompt, size });
  }
  if (provider === "minimax") {
    const seed = setting("MINIMAX_IMAGE_SEED").trim();
    return miniMaxEdit({
      key, baseUrl: setting("MINIMAX_API_BASE_URL", "https://api.minimax.io/v1").replace(/\/$/, ""),
      model, images, prompt, size,
      responseFormat: setting("MINIMAX_IMAGE_RESPONSE_FORMAT", "base64"),
      promptOptimizer: setting("MINIMAX_PROMPT_OPTIMIZER") === "true",
      seed: /^-?\d+$/.test(seed) ? Number(seed) : undefined,
    });
  }
  const request = {
    key, baseUrl: resolveOpenAICompatibleBaseUrl(setting, provider), images, prompt, size,
    model, quality,
  };
  return provider === "openrouter" ? openRouterEdit(request) : openAIImage({ ...openAIImageOptions(setting), ...request });
}
