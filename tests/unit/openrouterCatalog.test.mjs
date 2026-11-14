import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

const prefs = {
  aiProvider: "openrouter",
  llmModel: "deepseek/deepseek-v4.1-flash",
  openrouterApiKey: "or-key",
  openrouterCatalogCache: "",
};
let calls = [];
let modelsBody;
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs[key.split(".").pop()],
    set: (key, value) => {
      prefs[key.split(".").pop()] = value;
    },
  },
  HTTP: {
    request: async (method, url, options) => {
      calls.push({ method, url, options });
      if (method === "GET") return { response: modelsBody };
      return {
        response: { choices: [{ message: { content: '{"ok":true}' } }] },
      };
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");
const catalog = await loadModule("src/modules/openrouterCatalog.ts");

const row = (id, created, extra = {}) => ({
  id,
  name: id,
  created,
  hugging_face_id: `org/${id}`,
  context_length: 128000,
  supported_parameters: ["response_format", "temperature"],
  architecture: { output_modalities: ["text"] },
  pricing: { prompt: "0.0000003" },
  ...extra,
});

const BODY = {
  data: [
    row("deepseek/deepseek-v4-pro", 40),
    row("deepseek/deepseek-v4.1-flash", 50),
    row("deepseek/deepseek-v3.2", 30),
    row("deepseek/deepseek-r1", 10),
    row("deepseek/deepseek-v4.1-flash:free", 60),
    row("qwen/qwen3-max", 70, { hugging_face_id: "" }), // closed weights
    row("qwen/qwen3.5-235b", 65),
    row("mistralai/tiny", 20, { context_length: 8000 }),
    row("z-ai/glm-5.3", 55, { supported_parameters: ["temperature"] }),
    row("anthropic/claude-opus", 99), // not an allowed family
    row("deepseek/deepseek-v4-vision-exp", 90), // specialist
    row("openai/gpt-oss-safeguard-20b", 95), // specialist
    row("openai/gpt-oss-120b", 45, { pricing: { prompt: "0" } }),
  ],
};

test("only newest open-weight JSON-capable models of allowed families are kept", () => {
  const ids = catalog.parseOpenRouterModels(BODY).map((m) => m.id);
  assert.deepEqual(ids, [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v3.2",
    "qwen/qwen3.5-235b",
    "openai/gpt-oss-120b",
  ]);
});

test("labels carry the input price", () => {
  const [first] = catalog.parseOpenRouterModels(BODY);
  assert.equal(
    catalog.openRouterLabel(first),
    "deepseek/deepseek-v4.1-flash · $0.30/M in",
  );
  const free = catalog
    .parseOpenRouterModels(BODY)
    .find((m) => m.id === "openai/gpt-oss-120b");
  assert.match(catalog.openRouterLabel(free), /free$/);
});

test("a listed model is sent to OpenRouter as is; an unlisted one falls back", async () => {
  modelsBody = BODY;
  llm.resetOpenRouterCatalog();
  prefs.llmModel = "qwen/qwen3.5-235b";
  calls = [];
  await llm.callOpenRouter([]);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  const post = calls.find((c) => c.method === "POST");
  assert.equal(JSON.parse(post.options.body).model, "qwen/qwen3.5-235b");
  assert.ok(JSON.parse(prefs.openrouterCatalogCache).models.length);

  prefs.llmModel = "anthropic/claude-opus";
  calls = [];
  await llm.callOpenRouter([]);
  const second = calls.find((c) => c.method === "POST");
  assert.equal(
    JSON.parse(second.options.body).model,
    "deepseek/deepseek-v4.1-flash",
  );
  // Cached for a day: no second list fetch.
  assert.equal(calls.filter((c) => c.method === "GET").length, 0);
});

test("built-in DeepSeek models missing from the list join the DeepSeek group", async () => {
  prefs.openrouterCatalogCache = JSON.stringify({
    fetchedAt: Date.now(),
    models: catalog
      .parseOpenRouterModels(BODY)
      .filter((m) => m.id !== "deepseek/deepseek-v4-pro"),
  });
  catalog.resetOpenRouterCatalog();
  const ids = catalog.getOpenRouterMenuModels().map((m) => m.id);
  assert.deepEqual(ids.slice(0, 3), [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v3.2",
    "deepseek/deepseek-v4-pro",
  ]);
});

test("a failed list fetch leaves the built-in DeepSeek models", async () => {
  prefs.openrouterCatalogCache = "";
  catalog.resetOpenRouterCatalog();
  modelsBody = { data: [] };
  await catalog.refreshOpenRouterCatalog();
  assert.deepEqual(
    catalog.getOpenRouterMenuModels().map((m) => m.id),
    ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"],
  );
});
