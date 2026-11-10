import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadModule } from "./helpers.mjs";

let response;
let selectedModel = "deepseek/deepseek-v4.1-flash";
let selectedProvider = "cail";
let openrouterKey = "";
let cailKey = "cail-test-key";
let lastRequest;
globalThis.Zotero = {
  Prefs: {
    get: (key) => {
      if (key.endsWith(".openrouterApiKey")) return openrouterKey;
      if (key.endsWith(".cailApiKey")) return cailKey;
      if (key.endsWith(".aiProvider")) return selectedProvider;
      return selectedModel;
    },
  },
  HTTP: {
    request: async (...args) => {
      if (args[0] === "GET") return { response: { data: [] } };
      lastRequest = args;
      return {
        response: {
          choices: [{ message: { content: JSON.stringify(response) } }],
        },
      };
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");

test("an API key makes AI available without a separate enable preference", () => {
  assert.equal(llm.isLLMAvailable(), true);
});

test("CUNY requests use the gateway endpoint and app header", async () => {
  response = { selectedIndex: null, confidence: 0 };
  await llm.callOpenRouter([{ role: "user", content: "test" }]);
  assert.equal(
    lastRequest[1],
    "https://tools.ailab.gc.cuny.edu/v1/chat/completions",
  );
  assert.equal(
    lastRequest[2].headers["X-CAIL-App"],
    "zotero-metadata-assistant",
  );
});

test("missing CUNY key returns an actionable error", async () => {
  globalThis.__fakeLogins.length = 0;
  llm.resetKeyStoreState();
  cailKey = "";
  const result = await llm.callOpenRouter([]);
  assert.equal(result.success, false);
  assert.match(result.error, /CUNY AI Lab Gateway API key is missing/);
  cailKey = "cail-test-key";
});

test("model IDs follow the selected provider for both models and saved ID formats", async () => {
  response = { ok: true };
  try {
    for (const provider of ["cail", "openrouter"]) {
      selectedProvider = provider;
      openrouterKey = "test-key";
      const cailIds = {
        "deepseek-v4.1-flash": "deepseek-v4.1-flash-1017",
        "deepseek-v4-pro": "deepseek-v4-pro-0813",
      };
      for (const slug of ["deepseek-v4.1-flash", "deepseek-v4-pro"]) {
        // Menu value, and the unprefixed legacy value that getConfiguredModel coerces.
        for (const saved of [`deepseek/${slug}`, slug]) {
          selectedModel = saved;
          await llm.callOpenRouter([]);
          assert.equal(
            JSON.parse(lastRequest[2].body).model,
            provider === "cail" ? cailIds[slug] : `deepseek/${slug}`,
          );
        }
      }
    }
    selectedModel = "deepseek/deepseek-v4-flash";
    assert.equal(llm.getConfiguredModel(), "deepseek/deepseek-v4.1-flash");
  } finally {
    selectedProvider = "cail";
    selectedModel = "deepseek/deepseek-v4.1-flash";
    openrouterKey = "";
  }
});

test("every CAIL model ID the plugin can send is in the checked-in catalog fixture", async () => {
  const catalog = JSON.parse(
    await readFile("tests/fixtures/cail-catalog-ids.json", "utf8"),
  );
  const sendable = Object.values(llm.PROVIDER_MODEL_IDS).map((ids) => ids.cail);
  assert.deepEqual(sendable.sort(), [
    "deepseek-v4-pro-0813",
    "deepseek-v4.1-flash-1017",
  ]);
  for (const id of sendable) assert.ok(catalog.includes(id), `${id} missing`);
  for (const model of llm.OPEN_WEIGHT_MODELS)
    assert.ok(catalog.includes(llm.getProviderModelId(model, "cail")));
});

test("a legacy proprietary preference falls back to the open-weight default", () => {
  selectedModel = "openai/gpt-4o-mini";
  assert.equal(llm.getConfiguredModel(), "deepseek/deepseek-v4.1-flash");
  selectedModel = "deepseek/deepseek-v4.1-flash";
});

test("an unusable key store does not block a key from the old preference, and says why when no key exists", async () => {
  const original = globalThis.Services.logins.searchLoginsAsync;
  globalThis.Services.logins.searchLoginsAsync = async () => {
    throw new Error("locked");
  };
  llm.resetKeyStoreState();
  try {
    response = { ok: true };
    const worked = await llm.callOpenRouter([]);
    assert.equal(worked.success, true, "pref key stays usable");
    globalThis.__fakeLogins.length = 0;
    llm.resetKeyStoreState();
    cailKey = "";
    const result = await llm.callOpenRouter([]);
    assert.equal(result.success, false);
    assert.match(result.error, /API key is missing/);
    assert.match(result.error, /saved-password store/);
  } finally {
    cailKey = "cail-test-key";
    globalThis.Services.logins.searchLoginsAsync = original;
    llm.resetKeyStoreState();
  }
});

test("disambiguation rejects invalid indexes and confidence without selecting first", async () => {
  const candidates = [{ title: "A" }, { title: "B" }];
  for (const invalid of [
    { selectedIndex: "0", confidence: 0.9 },
    { selectedIndex: 3, confidence: 0.9 },
    { selectedIndex: 0 },
    { selectedIndex: 0, confidence: 2 },
  ]) {
    response = invalid;
    assert.equal(await llm.llmDisambiguate("A", "B", null, candidates), null);
  }
  response = { selectedIndex: null, confidence: 0 };
  assert.deepEqual(await llm.llmDisambiguate("A", "B", null, candidates), {
    selectedIndex: null,
    confidence: 0,
    reasoning: undefined,
  });
});

test("single candidate still needs assessment", async () => {
  response = { selectedIndex: null, confidence: 0 };
  assert.equal(
    (await llm.llmDisambiguate("A", "B", null, [{ title: "C" }])).selectedIndex,
    null,
  );
});

test("query cleanup rejects malformed types", async () => {
  response = { title: { text: "Book" }, author: "Name" };
  assert.equal(await llm.llmCleanupQuery("Book", "Name"), null);
});

test("bibliography maps reordered output and identifies omitted and duplicate entries", async () => {
  response = {
    items: [
      {
        sourceIndex: 2,
        type: "book",
        title: "三",
        author: [{ literal: "CUNY AI Lab" }],
      },
      { sourceIndex: 0, type: "book", title: "One" },
    ],
  };
  let result = await llm.parseBibliographyWithLLM(["one", "two", "three"]);
  assert.equal(result.entries[0].item.title, "One");
  assert.equal(result.entries[2].item.author[0].literal, "CUNY AI Lab");
  assert.equal(result.entries[2].item.sourceIndex, undefined);
  assert.deepEqual(result.failed, ["two"]);
  assert.match(result.entries[1].error, /omitted/);
  response = {
    items: [
      { sourceIndex: 0, type: "book", title: "A" },
      { sourceIndex: 0, type: "book", title: "B" },
    ],
  };
  result = await llm.parseBibliographyWithLLM(["one"]);
  assert.match(result.entries[0].error, /Duplicate/);
  assert.equal(result.items.length, 0);
});

test("bibliography rejects malformed CSL and untraceable responses", async () => {
  for (const items of [
    [{ type: "book", title: "A" }],
    [{ sourceIndex: 9, type: "book", title: "A" }],
    [{ sourceIndex: 0, type: "book", title: "A", author: "Name" }],
    [
      {
        sourceIndex: 0,
        type: "book",
        title: "A",
        issued: { "date-parts": [[2000, 13]] },
      },
    ],
  ]) {
    response = { items };
    const result = await llm.parseBibliographyWithLLM(["citation"]);
    assert.equal(result.items.length, 0);
    assert.equal(result.entries[0].original, "citation");
    assert.ok(result.entries[0].error);
  }
});
