import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

const prefs = {
  aiProvider: "custom",
  customBaseUrl: "https://api.example.com/v1/",
  customModel: "example-chat-1",
  llmModel: "deepseek/deepseek-v4.1-flash",
  cailApiKey: "",
  openrouterApiKey: "",
};
let requests = [];
/** Each POST takes the next handler; a handler returns a response or throws. */
let handlers = [];
let modelsResponse;
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs[key.split(".").pop()],
    set: (key, value) => {
      prefs[key.split(".").pop()] = value;
    },
  },
  HTTP: {
    request: async (method, url, options) => {
      requests.push({ method, url, options });
      if (method === "GET") {
        if (modelsResponse instanceof Error) throw modelsResponse;
        return { response: modelsResponse };
      }
      const handler = handlers.shift();
      return handler(JSON.parse(options.body));
    },
  },
};
globalThis.ztoolkit = { log() {} };

const llm = await loadModule("src/modules/llmClient.ts");
const provider = await loadModule("src/modules/provider.ts");

const ok = (content) => () => ({
  response: { choices: [{ message: { content } }] },
});
const badRequest = (body) => () => {
  const error = new Error("HTTP 400");
  error.status = 400;
  error.xmlhttp = {
    status: 400,
    response: body,
    getResponseHeader: () => null,
  };
  throw error;
};

function reset() {
  requests = [];
  handlers = [];
  globalThis.__fakeLogins.length = 0;
  llm.resetKeyStoreState();
}

test("base URLs are normalized and remote http is refused", () => {
  const parse = provider.parseCustomBaseUrl;
  assert.equal(
    parse(" https://api.openai.com/v1/ ").baseUrl,
    "https://api.openai.com/v1",
  );
  assert.equal(
    parse("https://api.openai.com/v1/chat/completions").baseUrl,
    "https://api.openai.com/v1",
  );
  assert.equal(
    parse("http://localhost:11434/v1").baseUrl,
    "http://localhost:11434/v1",
  );
  assert.equal(
    parse("http://127.0.0.1:1234/v1").baseUrl,
    "http://127.0.0.1:1234/v1",
  );
  assert.match(parse("http://api.example.com/v1").error, /https/);
  assert.match(parse("https://user:secret@example.com/v1").error, /key field/);
  assert.match(parse("not a url").error, /not a valid URL/);
  assert.match(parse("").error, /base URL/);
  assert.match(parse("ftp://example.com").error, /https/);
});

test("a custom endpoint gets the configured URL, model and key", async () => {
  reset();
  globalThis.__fakeLogins.push({
    username: "customApiKey",
    password: "custom-key",
  });
  handlers.push(ok('{"ok":true}'));
  const result = await llm.callOpenRouter([{ role: "user", content: "hi" }]);
  assert.equal(result.success, true);
  const [request] = requests.filter((r) => r.method === "POST");
  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer custom-key");
  assert.equal(request.options.headers["X-CAIL-App"], undefined);
  assert.equal(JSON.parse(request.options.body).model, "example-chat-1");
  assert.equal(llm.getConfiguredModel(), "example-chat-1");
});

test("a local endpoint works without a key and sends no Authorization", async () => {
  reset();
  prefs.customBaseUrl = "http://localhost:11434/v1";
  handlers.push(ok('{"ok":true}'));
  assert.equal(llm.isLLMAvailable(), true);
  const result = await llm.callOpenRouter([]);
  assert.equal(result.success, true);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  prefs.customBaseUrl = "https://api.example.com/v1/";
});

test("a custom endpoint without a model is not available and says why", async () => {
  reset();
  prefs.customModel = "  ";
  assert.equal(llm.isLLMAvailable(), false);
  const result = await llm.callOpenRouter([]);
  assert.equal(result.success, false);
  assert.match(result.error, /custom AI endpoint is not set up/);
  assert.match(result.error, /model ID/);
  assert.equal(requests.length, 0);
  prefs.customModel = "example-chat-1";
});

test("rejected optional parameters are renamed or dropped and retried", async () => {
  reset();
  handlers.push(
    badRequest({
      error: {
        message:
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      },
    }),
    badRequest({
      error: {
        message:
          "Unsupported value: 'temperature' does not support 0 with this model.",
      },
    }),
    badRequest({
      error: "'response_format.type' must be 'json_schema' or 'text'",
    }),
    ok('{"ok":true}'),
  );
  const result = await llm.callOpenRouter([], { maxRetries: 1 });
  assert.equal(result.success, true);
  const last = JSON.parse(requests.at(-1).options.body);
  assert.equal(last.max_tokens, undefined);
  assert.equal(last.max_completion_tokens, llm.MAX_TOKENS_SHORT);
  assert.equal(last.temperature, undefined);
  assert.equal(last.response_format, undefined);
  assert.equal(requests.length, 4);
});

test("an unrelated 400 is reported, not retried", async () => {
  reset();
  handlers.push(badRequest({ error: { message: "Model not found" } }));
  const result = await llm.callOpenRouter([]);
  assert.equal(result.success, false);
  assert.match(result.error, /Model not found/);
  assert.equal(requests.length, 1);
});

test("model output wrapped in a Markdown fence still parses", () => {
  assert.deepEqual(llm.parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(llm.parseModelJson('Here you go: {"a":2} Done.'), {
    a: 2,
  });
  assert.throws(() => llm.parseModelJson("no json here"));
});

test("the model list is read from GET /models without non-chat models", async () => {
  reset();
  globalThis.__fakeLogins.push({
    username: "customApiKey",
    password: "custom-key",
  });
  modelsResponse = {
    data: [
      { id: "zeta-chat" },
      { id: "text-embedding-3-small" },
      { id: "alpha-chat" },
      { id: "whisper-1" },
      { id: "alpha-chat" },
    ],
  };
  const { models } = await provider.listCustomModels();
  assert.deepEqual(models, ["alpha-chat", "zeta-chat"]);
  assert.equal(requests[0].url, "https://api.example.com/v1/models");
  assert.equal(requests[0].options.headers.Authorization, "Bearer custom-key");
});

test("a server without a model list gets a type-it-instead message", async () => {
  reset();
  const error = new Error("HTTP 404");
  error.status = 404;
  modelsResponse = error;
  const { models, error: message } = await provider.listCustomModels();
  assert.equal(models, undefined);
  assert.match(message, /Type the model ID/);
});
