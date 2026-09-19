import assert from "node:assert/strict";
import test from "node:test";
import { configuredProviders } from "../scripts/setup-api.mjs";

const settingsFrom = (values) => (name, fallback = "") => values[name] ?? fallback;

test("each provider reports whether its key is saved, and nothing more", () => {
  const configured = configuredProviders(settingsFrom({ OPENAI_API_KEY: "sk-secret", OPENROUTER_API_KEY: "" }));
  assert.deepEqual(configured, { openai: true, openrouter: false, gemini: false, minimax: false });
  assert.ok(!JSON.stringify(configured).includes("sk-secret"), "the key itself never comes back");
});

test("a blank or whitespace key does not count as saved", () => {
  assert.equal(configuredProviders(settingsFrom({ MINIMAX_API_KEY: "   " })).minimax, false);
});

// The Settings TEST/PROD switch picks between Gemini's keys after the fact, so
// either one is enough to make Gemini something you can switch to.
test("Gemini counts as ready with either its test or its prod key", () => {
  assert.equal(configuredProviders(settingsFrom({ GEMINI_API_KEY_TEST: "AIza-test" })).gemini, true);
  assert.equal(configuredProviders(settingsFrom({ GEMINI_API_KEY_PROD: "AIza-prod" })).gemini, true);
  assert.equal(configuredProviders(settingsFrom({ GEMINI_API_KEY: "AIza-legacy" })).gemini, true, "the legacy name still counts as prod");
  assert.equal(configuredProviders(settingsFrom({})).gemini, false);
});
