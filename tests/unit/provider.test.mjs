import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let prefs = {
  aiProvider: "cail",
  openrouterApiKey: "",
  cailApiKey: "",
};
globalThis.Zotero = {
  Prefs: { get: (key) => prefs[key.split(".").pop()] },
};
const provider = await loadModule("src/modules/provider.ts");

test("CUNY provider uses the canonical OpenAI-compatible gateway", () => {
  const config = provider.getProviderConfig("cail");
  assert.equal(config.baseUrl, "https://tools.ailab.gc.cuny.edu/v1");
  assert.equal(config.keyPreference, "cailApiKey");
  assert.equal(config.keyHelpUrl, "https://ailab.gc.cuny.edu/docs/api-keys/");
});

test("provider URLs append one chat completions path", () => {
  assert.equal(
    provider.getChatCompletionsUrl("cail"),
    "https://tools.ailab.gc.cuny.edu/v1/chat/completions",
  );
  assert.equal(
    provider.getChatCompletionsUrl("openrouter"),
    "https://openrouter.ai/api/v1/chat/completions",
  );
});

test("missing selected provider key gives an actionable message", () => {
  assert.equal(provider.getProviderKey("cail"), "");
  assert.match(
    provider.getMissingProviderKeyMessage("cail"),
    /CUNY AI Lab Gateway/,
  );
  assert.match(provider.getMissingProviderKeyMessage("cail"), /add.*key/i);
  assert.match(
    provider.getMissingProviderKeyMessage("cail"),
    /ailab\.gc\.cuny\.edu/,
  );
  prefs.cailApiKey = "cail-test-key";
  assert.equal(provider.getProviderKey("cail"), "cail-test-key");
});

test("unknown provider safely uses OpenRouter", () => {
  assert.equal(provider.getConfiguredProvider("unknown"), "openrouter");
});
