import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadModule } from "./helpers.mjs";

const fixture = JSON.parse(
  await readFile("tests/fixtures/cail-catalog-response.json", "utf8"),
);
let prefs;
let catalogResponse;
let catalogFails;
let calls;
let notices;
let now = 1_000_000;
Date.now = () => now;
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs[key.split(".").pop()] ?? "",
    set: (key, value) => {
      prefs[key.split(".").pop()] = value;
    },
  },
  HTTP: {
    request: async (method, url, options) => {
      calls.push({ method, url, options });
      if (method === "GET") {
        if (catalogFails) throw new Error("offline");
        return { response: catalogResponse };
      }
      return {
        response: { choices: [{ message: { content: '{"ok":true}' } }] },
      };
    },
  },
};
globalThis.ztoolkit = {
  log() {},
  ProgressWindow: class {
    createLine(line) {
      notices.push(line.text);
      return this;
    }
    show() {}
  },
};
const llm = await loadModule("src/modules/llmClient.ts");
const catalog = llm;

function reset(saved = "deepseek/deepseek-v4.1-flash") {
  prefs = {
    cailApiKey: "k",
    aiProvider: "cail",
    llmModel: saved,
    catalogCache: "",
  };
  catalogResponse = fixture;
  catalogFails = false;
  calls = [];
  notices = [];
  catalog.resetCatalogCache();
}
const chat = () => calls.filter((c) => c.method === "POST");
const sentModel = () => JSON.parse(chat().at(-1).options.body).model;

test("catalog rows keep text-generation only, recommended first, then by order", () => {
  const rows = catalog.parseCatalog({
    data: [
      ...fixture.data,
      { id: "retired", capabilities: ["text-generation"], status: "retired" },
      { id: "no-caps" },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    [
      "deepseek-v4.1-flash-1017",
      "glm-5.3",
      "gpt-oss-120b",
      "deepseek-v4-pro-0813",
      "glm-4.7",
      "qwen3-vl-235b-a22b-instruct",
    ],
  );
  assert.equal(rows[0].recommended, true);
  assert.equal(rows[0].reasoning, true);
  assert.equal(rows.find((r) => r.id.startsWith("qwen3-vl")).reasoning, false);
});

test("the catalog is fetched without credentials, cached, and persisted with a timestamp", async () => {
  reset();
  await llm.callOpenRouter([]);
  await llm.callOpenRouter([]);
  const gets = calls.filter((c) => c.method === "GET");
  assert.equal(gets.length, 1);
  assert.equal(gets[0].url, "https://tools.ailab.gc.cuny.edu/v1/catalog");
  assert.equal(gets[0].options.timeout, 30000);
  assert.equal(gets[0].options.headers.Authorization, undefined);
  const saved = JSON.parse(prefs.catalogCache);
  assert.equal(saved.fetchedAt, now);
  assert.equal(saved.models[0].id, "deepseek-v4.1-flash-1017");
});

test("a persisted catalog is reused within a day and refreshed after it", async () => {
  reset();
  await llm.callOpenRouter([]);
  catalog.resetCatalogCache();
  calls = [];
  now += 23 * 3600 * 1000;
  await llm.callOpenRouter([]);
  assert.equal(calls.filter((c) => c.method === "GET").length, 0);
  catalog.resetCatalogCache();
  now += 2 * 3600 * 1000;
  await llm.callOpenRouter([]);
  assert.equal(calls.filter((c) => c.method === "GET").length, 1);
});

test("catalog IDs are sent as-is and legacy values still resolve", async () => {
  reset("glm-5.3");
  await llm.callOpenRouter([]);
  assert.equal(sentModel(), "glm-5.3");
  for (const [saved, id] of [
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro-0813"],
    ["deepseek-v4-pro", "deepseek-v4-pro-0813"],
    ["deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash-1017"],
  ]) {
    reset(saved);
    await llm.callOpenRouter([]);
    assert.equal(sentModel(), id);
    assert.equal(prefs.llmModel, saved, "legacy value is not rewritten");
    assert.deepEqual(notices, []);
  }
});

test("a saved model that left the catalog migrates to the default with one notice", async () => {
  reset("retired-model-x");
  await llm.callOpenRouter([]);
  assert.equal(prefs.llmModel, "deepseek-v4.1-flash-1017");
  assert.equal(sentModel(), "deepseek-v4.1-flash-1017");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /retired-model-x.*no longer offered/);
  await llm.callOpenRouter([]);
  assert.equal(notices.length, 1);
});

test("when the catalog cannot be fetched the built-in models still work and nothing migrates", async () => {
  reset("glm-5.3");
  catalogFails = true;
  await llm.callOpenRouter([]);
  assert.equal(prefs.llmModel, "glm-5.3");
  assert.deepEqual(
    catalog.getCatalogModels().map((m) => m.id),
    ["deepseek-v4.1-flash-1017", "deepseek-v4-pro-0813"],
  );
  assert.equal(sentModel(), "deepseek-v4.1-flash-1017");
  // A failed fetch is not retried on every call.
  await llm.callOpenRouter([]);
  assert.equal(calls.filter((c) => c.method === "GET").length, 1);
});

test("OpenRouter never fetches the CAIL catalog", async () => {
  reset();
  prefs.aiProvider = "openrouter";
  prefs.openrouterApiKey = "k";
  await llm.callOpenRouter([]);
  assert.equal(calls.filter((c) => c.method === "GET").length, 0);
  assert.equal(sentModel(), "deepseek/deepseek-v4.1-flash");
});
