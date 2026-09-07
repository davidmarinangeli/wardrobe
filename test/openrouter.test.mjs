import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  openRouterEdit,
  resolveApiKey,
  resolveOpenAICompatibleBaseUrl,
  resolveProvider,
} from "../scripts/import-job-api.mjs";

const inputPng = await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
}).png().toBuffer();

test("resolves the OpenRouter provider, key, and default base URL", () => {
  const values = { AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-test" };
  const setting = (name, fallback = "") => values[name] || fallback;

  assert.deepEqual(resolveProvider(setting), { provider: "openrouter", keyName: "OPENROUTER_API_KEY" });
  assert.deepEqual(resolveApiKey(setting, "openrouter", "prod"), { key: "sk-or-test", keyName: "OPENROUTER_API_KEY" });
  assert.equal(resolveOpenAICompatibleBaseUrl(setting, "openrouter"), "https://openrouter.ai/api/v1");
});

test("sends reference images to the OpenRouter Image API", async (t) => {
  const output = Buffer.from("generated image");
  let request;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({ data: [{ b64_json: output.toString("base64") }] });
  };

  const result = await openRouterEdit({
    key: "sk-or-test",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-image-2",
    prompt: "Create a clean garment image.",
    images: [{ data: inputPng }],
    size: "1024x1024",
    quality: "high",
  });

  assert.deepEqual(result, output);
  assert.equal(request.url, "https://openrouter.ai/api/v1/images");
  assert.equal(request.options.headers.Authorization, "Bearer sk-or-test");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.model, "openai/gpt-image-2");
  assert.equal(payload.input_references.length, 1);
  assert.equal(payload.input_references[0].type, "image_url");
  assert.match(payload.input_references[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(payload.output_format, "png");
});
