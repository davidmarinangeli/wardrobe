import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { cheatSheetImageSettings, generateCheatSheetImage } from "../scripts/cheat-sheet-beautify.mjs";
import { buildCheatSheetBeautifyPrompt, DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT } from "../shared/cheat-sheet-prompt.mjs";

test("beautification includes title and description and permits title styling while preserving clothes", () => {
  const prompt = buildCheatSheetBeautifyPrompt({ title: "Autunno in montagna", description: "Trekking nelle Dolomiti", width: 2400, height: 4800 });
  assert.ok(prompt.includes(DEFAULT_CHEAT_SHEET_BEAUTIFY_PROMPT));
  assert.match(prompt, /Autunno in montagna/);
  assert.match(prompt, /Trekking nelle Dolomiti/);
  assert.match(prompt, /2400 × 4800/);
  assert.match(prompt, /redesign the title's typography/);
  assert.match(prompt, /garment colors, shapes and details must remain faithful and readable/);
  const customized = buildCheatSheetBeautifyPrompt({ title: "Estate", prompt: "Use watercolor scenery and leave a generous white border", width: 2400, height: 3000 });
  assert.match(customized, /^Use watercolor scenery/);
  assert.match(customized, /Preserve every garment, all garment details, and the existing group arrangement/);
  assert.match(customized, /exact wording: "Estate"/);
  assert.match(customized, /mandatory even when the custom art direction above requests a border or blank space/);
  assert.match(customized, /no white borders, blank margins, frames, letterboxing or padding/);
});

test("AI finish uses the shared quality tiers and only the sheet reference", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-sheet-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await sharp({ create: { width: 12, height: 18, channels: 3, background: "#aaa" } }).png().toBuffer();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ data: [{ b64_json: data.toString("base64") }] }) };
  });
  const values = {
    AI_PROVIDER: "openai", OPENAI_API_KEY: "fixture-key",
    OPENAI_IMAGE_MODEL: "fixture-image-model", OPENAI_IMAGE_QUALITY: "high",
    OPENAI_MODELED_MODEL: "fixture-standard-model", OPENAI_MODELED_QUALITY: "medium",
    OPENAI_MODELED_PREMIUM_MODEL: "fixture-premium-model", OPENAI_MODELED_PREMIUM_QUALITY: "high",
  };
  const setting = (name, fallback = "") => values[name] || fallback;
  const settings = await cheatSheetImageSettings(setting, root);
  assert.equal(settings.tier, "standard");
  const output = await generateCheatSheetImage({ data, prompt: "Style the title", width: 2400, height: 6000, settings });
  assert.deepEqual(output, data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  const form = calls[0].init.body;
  assert.equal(form.get("model"), "fixture-standard-model");
  assert.equal(form.get("quality"), "medium");
  assert.equal(form.get("size"), "1024x1536");
  assert.equal(form.getAll("image[]").length, 1);
  assert.equal(form.get("prompt"), "Style the title");
  await generateCheatSheetImage({ data, prompt: "Premium finish", width: 2400, height: 2400, settings: await cheatSheetImageSettings(setting, root, "premium") });
  assert.equal(calls[1].init.body.get("model"), "fixture-premium-model");
  assert.equal(calls[1].init.body.get("quality"), "high");
  assert.equal(calls[1].init.body.get("size"), "1024x1024");
  values.AI_PROVIDER = "openrouter";
  values.OPENROUTER_API_KEY = "fixture-router-key";
  values.OPENROUTER_IMAGE_MODEL = "fixture/router-model";
  for (const [tier, model, quality] of [
    ["standard", "openai/gpt-image-2", "medium"],
    ["premium", "openai/gpt-image-2", "high"],
    ["openrouter", "fixture/router-model", "high"],
  ]) {
    const settings = await cheatSheetImageSettings(setting, root, tier);
    assert.equal(settings.tier, tier);
    await generateCheatSheetImage({ data, prompt: "Autumn finish", width: 2400, height: 3000, settings });
    const call = calls.at(-1);
    assert.equal(call.url, "https://openrouter.ai/api/v1/images");
    const body = JSON.parse(call.init.body);
    assert.equal(body.model, model);
    assert.equal(body.quality, quality);
    assert.equal(body.input_references.length, 1);
  }
});

test("Gemini AI finish respects TEST credentials and needs no personal model reference", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-sheet-test-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "ai-mode.json"), JSON.stringify({ mode: "test" }));
  const data = await sharp({ create: { width: 12, height: 18, channels: 3, background: "#aaa" } }).png().toBuffer();
  let call;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    call = { url, init };
    return { ok: true, json: async () => ({ output_image: { data: data.toString("base64") } }) };
  });
  const values = { AI_PROVIDER: "gemini", GEMINI_API_KEY_TEST: "fixture-test-key", GEMINI_API_KEY_PROD: "fixture-prod-key", GEMINI_IMAGE_MODEL: "fixture-gemini-model" };
  const setting = (name, fallback = "") => values[name] || fallback;
  const settings = await cheatSheetImageSettings(setting, root);
  await generateCheatSheetImage({ data, prompt: "A trekking theme", width: 2400, height: 3000, settings });
  assert.equal(call.init.headers["x-goog-api-key"], "fixture-test-key");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "fixture-gemini-model");
  assert.equal(body.input.filter((entry) => entry.type === "image").length, 1);
  assert.equal(body.input.find((entry) => entry.type === "text").text, "A trekking theme");
  await assert.rejects(cheatSheetImageSettings(setting, root, "premium"), { status: 400, message: /Premium quality needs PROD mode/ });
  await writeFile(path.join(root, "ai-mode.json"), JSON.stringify({ mode: "prod" }));
  await generateCheatSheetImage({ data, prompt: "Premium trekking theme", width: 2400, height: 3000, settings: await cheatSheetImageSettings(setting, root, "premium") });
  assert.equal(call.init.headers["x-goog-api-key"], "fixture-prod-key");
  assert.equal(JSON.parse(call.init.body).model, "gemini-3.1-flash-image");
  await writeFile(path.join(root, "ai-mode.json"), JSON.stringify({ mode: "test" }));
  delete values.GEMINI_API_KEY_TEST;
  await assert.rejects(cheatSheetImageSettings(setting, root), /GEMINI_API_KEY_TEST is not configured/);
});
