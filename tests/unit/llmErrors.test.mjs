import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let step;
globalThis.Zotero = {
  Prefs: {
    get: (key) =>
      key.endsWith("ApiKey")
        ? "k"
        : key.endsWith("aiProvider")
          ? "cail"
          : "deepseek/deepseek-v4.1-flash",
  },
  HTTP: {
    request: async (method) => {
      if (method === "GET") return { response: { data: [] } };
      const error = new Error("Unexpected status code 4xx");
      error.status = step.status;
      error.xmlhttp = {
        status: step.status,
        get response() {
          if (step.throwOnResponse) throw new Error("InvalidStateError");
          return step.response;
        },
        responseText: step.responseText,
        getResponseHeader: (name) =>
          name.toLowerCase() === "x-cail-request-id" ? "req-123" : null,
      };
      throw error;
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");
const call = async (s) => {
  step = s;
  return llm.callOpenRouter([{ role: "user", content: "x" }]);
};

test("model_not_found (404) shows the Gateway message, code and request ID", async () => {
  const r = await call({
    status: 404,
    response: {
      error: {
        code: "model_not_found",
        message: "The model 'x' does not exist",
        param: "model",
      },
    },
  });
  assert.equal(
    r.error,
    "The model 'x' does not exist (code: model_not_found, request ID: req-123)",
  );
});

test("quota_exceeded string body is parsed from responseText", async () => {
  const r = await call({
    status: 429,
    throwOnResponse: true,
    responseText: JSON.stringify({
      error: { code: "quota_exceeded", message: "Monthly quota used up" },
    }),
  });
  assert.match(r.error, /Monthly quota used up/);
  assert.match(r.error, /quota_exceeded/);
  assert.match(r.error, /req-123/);
});

test("401 with a JSON string response is parsed", async () => {
  const r = await call({
    status: 401,
    response: JSON.stringify({
      error: { code: "invalid_api_key", message: "Bad key" },
    }),
  });
  assert.match(r.error, /Bad key \(code: invalid_api_key/);
});

test("non-JSON bodies fall back to a fixed sentence and never leak the body", async () => {
  const html = "<html>secret-body-text</html>";
  for (const [status, pattern] of [
    [401, /rejected the API key/],
    [404, /could not find the requested model/],
    [429, /rate limiting/],
    [400, /rejected the request/],
    [502, /server error/],
  ]) {
    const r = await call({ status, response: html, responseText: html });
    assert.match(r.error, pattern);
    assert.match(r.error, /req-123/);
    assert.doesNotMatch(r.error, /secret-body-text/);
  }
});
