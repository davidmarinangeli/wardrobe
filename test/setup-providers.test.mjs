import assert from "node:assert/strict";
import test from "node:test";
import { configuredProviders } from "../scripts/setup-api.mjs";
import { isSameOriginRequest } from "../scripts/import-job-api.mjs";

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

// The setup endpoints rewrite .env and the reference photo, so a page on
// another site must not be able to POST to them through the user's browser.
test("only a request from a page on this same server counts as same-origin", () => {
  const request = (headers) => ({ headers });
  assert.equal(isSameOriginRequest(request({ origin: "http://localhost:5173", host: "localhost:5173" })), true);
  assert.equal(isSameOriginRequest(request({ origin: "http://terminal.local:5173", host: "terminal.local:5173" })), true);
  assert.equal(isSameOriginRequest(request({ origin: "https://evil.example", host: "localhost:5173" })), false);
  assert.equal(isSameOriginRequest(request({ origin: "http://localhost:4173", host: "localhost:5173" })), false, "another local port is another origin");
  assert.equal(isSameOriginRequest(request({ host: "localhost:5173" })), false, "a request without Origin is refused");
  assert.equal(isSameOriginRequest(request({ origin: "null", host: "localhost:5173" })), false);
});
