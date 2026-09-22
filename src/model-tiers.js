// What the quality tiers resolve to depends on AI_PROVIDER, so the copy has to
// follow it — the quality menu reads as a promise about what you're paying for.
// Prices are per modeled photo at 1536x1024 and approximate: OpenAI publishes
// token rates but no per-image token counts, so the server logs the measured
// cost of each call ([image] lines) and that is the number to trust.
const MODEL_TIERS_BY_PROVIDER = {
  gemini: [
    { id: "standard", label: "Standard", model: "Gemini 2.5 Flash", note: "fast", price: "Free" },
    { id: "premium", label: "Premium", model: "Nano Banana 2", note: "sharper detail", price: "~$0.07" },
  ],
  openai: [
    { id: "standard", label: "Standard", model: "gpt-image medium", note: "fast", price: "~$0.11" },
    { id: "premium", label: "Premium", model: "gpt-image high", note: "sharper detail", price: "~$0.26" },
  ],
  openrouter: [
    { id: "standard", label: "Standard", model: "gpt-image medium", note: "fast", price: "~$0.11" },
    { id: "premium", label: "Premium", model: "gpt-image high", note: "sharper detail", price: "~$0.26" },
    { id: "openrouter", label: "OpenRouter", model: "meta-muse", note: "best quality for cost", price: "$0.01" },
  ],
  minimax: [
    { id: "standard", label: "Standard", model: "MiniMax image-01", note: "fast", price: null },
    { id: "premium", label: "Premium", model: "MiniMax image-01", note: "sharper detail", price: null },
  ],
};

// An unknown or not-yet-loaded provider gets the tier names with no model or
// price attached, which is better than naming the wrong model.
const MODEL_TIERS_FALLBACK = [
  { id: "standard", label: "Standard", model: null, note: "Faster, cheaper", price: null },
  { id: "premium", label: "Premium", model: null, note: "Sharper detail", price: null },
];

export function modelTiers(provider) {
  return MODEL_TIERS_BY_PROVIDER[provider] || MODEL_TIERS_FALLBACK;
}
