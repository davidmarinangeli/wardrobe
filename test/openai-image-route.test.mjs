import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  describeImageUsage,
  openAIImage,
  openAIImageOptions,
  resolveModeledModel,
  resolveOpenAIImageRoute,
} from "../scripts/import-job-api.mjs";

const inputPng = await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
}).png().toBuffer();

const settingFrom = (values) => (name, fallback = "") => values[name] || fallback;

test("defaults to the Image API route and rejects an unknown one", () => {
  assert.equal(resolveOpenAIImageRoute(settingFrom({})), "images");
  assert.equal(resolveOpenAIImageRoute(settingFrom({ OPENAI_IMAGE_ROUTE: "Responses" })), "responses");
  assert.throws(() => resolveOpenAIImageRoute(settingFrom({ OPENAI_IMAGE_ROUTE: "chat" })), /OPENAI_IMAGE_ROUTE/);
});

test("sends references and tool options to the Responses API route", async (t) => {
  const output = Buffer.from("generated image");
  let request;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({
      output: [{ type: "image_generation_call", result: output.toString("base64") }],
      usage: { input_tokens: 1200, input_tokens_details: { text_tokens: 200, image_tokens: 1000 }, output_tokens: 6600 },
    });
  };

  const setting = settingFrom({ OPENAI_IMAGE_ROUTE: "responses", OPENAI_IMAGE_INPUT_FIDELITY: "high" });
  const result = await openAIImage({
    ...openAIImageOptions(setting),
    key: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2.5-sunburst",
    prompt: "Create a clean garment image.",
    images: [{ data: inputPng }],
    size: "1536x1024",
    quality: "max",
  });

  assert.deepEqual(result, output);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.model, "gpt-6-astra");
  assert.equal(payload.input[0].content[0].type, "input_text");
  assert.equal(payload.input[0].content[1].type, "input_image");
  assert.match(payload.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.deepEqual(payload.tools, [{
    type: "image_generation",
    model: "gpt-image-2.5-sunburst",
    size: "1536x1024",
    quality: "max",
    output_format: "png",
    input_fidelity: "high",
  }]);
});

test("surfaces the model's own words when it answers with text instead of an image", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text: "Which garment should I use?" }] }],
  });

  await assert.rejects(
    openAIImage({
      route: "responses",
      key: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-image-2.5-sunburst",
      prompt: "Create a clean garment image.",
      images: [{ data: inputPng }],
      size: "1024x1024",
    }),
    /Which garment should I use\?/,
  );
});

test("still uses the Image API when the route is left alone", async (t) => {
  const output = Buffer.from("generated image");
  let url;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (target) => {
    url = target;
    return Response.json({ data: [{ b64_json: output.toString("base64") }] });
  };

  const result = await openAIImage({
    ...openAIImageOptions(settingFrom({})),
    key: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2",
    prompt: "Create a clean garment image.",
    images: [{ data: inputPng }],
    size: "1024x1024",
    quality: "high",
  });

  assert.deepEqual(result, output);
  assert.equal(url, "https://api.openai.com/v1/images/edits");
});

test("prices a call from the usage the API reported", () => {
  const usage = { input_tokens_details: { text_tokens: 200, image_tokens: 5800 }, output_tokens: 6600 };
  const summary = describeImageUsage("gpt-image-2.5-sunburst-2026-09-08", usage);
  assert.equal(summary.model, "gpt-image-2.5-sunburst");
  // 200 text @ $5/M + 5800 image @ $8/M + 6600 output @ $30/M
  assert.equal(summary.cost.toFixed(4), "0.2454");
  assert.equal(describeImageUsage("some-other-model", usage).cost, null);
  assert.equal(describeImageUsage("gpt-image-2", undefined), null);
});

// OPENAI_IMAGE_QUALITY is the garment-cutout quality and is commonly set to "high" in .env. It is
// a different key from the tiered modeled-photo qualities and must never bleed into the standard
// tier, which stays at medium so the cheap tier is actually cheap.
test("standard tier stays medium even when OPENAI_IMAGE_QUALITY is high", () => {
  const setting = settingFrom({ OPENAI_IMAGE_MODEL: "gpt-image-2.5-sunburst", OPENAI_IMAGE_QUALITY: "high" });
  assert.equal(resolveModeledModel("openai", "standard", setting).quality, "medium");
  assert.equal(resolveModeledModel("openrouter", "standard", setting).quality, "medium");
});

test("each tier's model and quality can be set independently", () => {
  const setting = settingFrom({
    OPENAI_IMAGE_MODEL: "gpt-image-2",
    OPENAI_MODELED_PREMIUM_MODEL: "gpt-image-2.5-sunburst",
    OPENAI_MODELED_PREMIUM_QUALITY: "max",
  });
  assert.deepEqual(resolveModeledModel("openai", "premium", setting), { model: "gpt-image-2.5-sunburst", quality: "max" });
  assert.deepEqual(resolveModeledModel("openai", "standard", setting), { model: "gpt-image-2", quality: "medium" });
});
