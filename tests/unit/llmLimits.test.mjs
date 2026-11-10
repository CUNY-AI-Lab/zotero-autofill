import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadModule } from "./helpers.mjs";

const fixture = JSON.parse(
  await readFile("tests/fixtures/cail-catalog-response.json", "utf8"),
);
let prefs;
let posts;
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs[key.split(".").pop()] ?? "",
    set: (key, value) => {
      prefs[key.split(".").pop()] = value;
    },
  },
  HTTP: {
    request: async (method, _url, options) => {
      if (method === "GET") return { response: fixture };
      posts.push(JSON.parse(options.body));
      const content =
        posts.at(-1).messages[0].role === "system" &&
        /bibliography parser/.test(posts.at(-1).messages[0].content)
          ? JSON.stringify({ items: [] })
          : '{"title":"t","author":"a","selectedIndex":null,"confidence":0}';
      return { response: { choices: [{ message: { content } }] } };
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");
llm.llmRuntime.sleep = async () => {};

function setup(provider, model) {
  prefs = {
    aiProvider: provider,
    cailApiKey: "k",
    openrouterApiKey: "k",
    llmModel: model,
  };
  posts = [];
  llm.resetCatalogCache();
}

test("short calls send max_tokens 4000 (reasoning models get the higher floor)", async () => {
  assert.equal(llm.MAX_TOKENS_SHORT, 4000);
  setup("cail", "qwen3-vl-235b-a22b-instruct");
  await llm.llmCleanupQuery("T", "A");
  await llm.llmDisambiguate("T", "A", null, [{ title: "x" }]);
  assert.deepEqual(
    posts.map((p) => p.max_tokens),
    [4000, 4000],
  );
  setup("cail", "gpt-oss-120b");
  await llm.llmCleanupQuery("T", "A");
  assert.equal(posts[0].max_tokens, llm.MAX_TOKENS_REASONING_MIN);
  setup("openrouter", "deepseek/deepseek-v4.1-flash");
  await llm.llmCleanupQuery("T", "A");
  assert.equal(posts[0].max_tokens, 4000);
});

test("bibliography batches send max_tokens 16000", async () => {
  assert.equal(llm.MAX_TOKENS_PARSE, 16000);
  for (const [provider, model] of [
    ["cail", "gpt-oss-120b"],
    ["openrouter", "deepseek/deepseek-v4-pro"],
  ]) {
    setup(provider, model);
    await llm.parseBibliographyWithLLM(["one"]);
    assert.equal(posts[0].max_tokens, 16000);
  }
});

test("CAIL parses 10 entries per request, OpenRouter 25", async () => {
  const entries = Array.from({ length: 25 }, (_, i) => `entry ${i}`);
  setup("cail", "gpt-oss-120b");
  await llm.parseBibliographyWithLLM(entries);
  assert.equal(posts.length, 3);
  // Callers asking for more than the provider cap are capped.
  setup("cail", "gpt-oss-120b");
  await llm.parseBibliographyWithLLM(entries, 25);
  assert.equal(posts.length, 3);
  setup("openrouter", "deepseek/deepseek-v4.1-flash");
  await llm.parseBibliographyWithLLM(entries);
  assert.equal(posts.length, 1);
});
