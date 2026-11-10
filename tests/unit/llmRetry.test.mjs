import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let provider = "cail";
let script = [];
let calls = [];
globalThis.Zotero = {
  Prefs: {
    get: (key) => {
      if (key.endsWith("ApiKey")) return "k";
      if (key.endsWith("aiProvider")) return provider;
      return "deepseek/deepseek-v4.1-flash";
    },
  },
  HTTP: {
    request: async (_m, _u, options) => {
      if (_m === "GET") return { response: { data: [] } };
      calls.push(options);
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      if (step.ok)
        return {
          response: { choices: [{ message: { content: '{"ok":true}' } }] },
        };
      const headers = step.headers || {};
      const error = new Error(step.message || `Status ${step.status}`);
      if (step.status) {
        error.status = step.status;
        error.xmlhttp = {
          status: step.status,
          response: step.body,
          getResponseHeader: (name) => headers[name.toLowerCase()] ?? null,
        };
      }
      throw error;
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");
let waits = [];
llm.llmRuntime.sleep = async (ms) => {
  waits.push(ms);
};
async function run(p, steps) {
  provider = p;
  script = steps;
  calls = [];
  waits = [];
  return llm.callOpenRouter([{ role: "user", content: "x" }]);
}

test("CAIL 429 with x-should-retry false is attempted once", async () => {
  const r = await run("cail", [
    { status: 429, headers: { "x-should-retry": "false" } },
  ]);
  assert.equal(r.success, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(calls[0].errorDelayMax, 0);
});

test("CAIL 503 with x-should-retry true retries once after Retry-After", async () => {
  const r = await run("cail", [
    { status: 503, headers: { "x-should-retry": "true", "retry-after": "2" } },
    { status: 503, headers: { "x-should-retry": "true", "retry-after": "2" } },
  ]);
  assert.equal(r.success, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
  const ok = await run("cail", [
    { status: 503, headers: { "x-should-retry": "true", "retry-after": "2" } },
    { ok: true },
  ]);
  assert.equal(ok.success, true);
  assert.equal(calls.length, 2);
});

test("CAIL Retry-After is capped and missing header gets a short wait", async () => {
  await run("cail", [
    {
      status: 503,
      headers: { "x-should-retry": "true", "retry-after": "999" },
    },
  ]);
  assert.deepEqual(waits, [30000]);
  await run("cail", [{ status: 503, headers: { "x-should-retry": "true" } }]);
  assert.deepEqual(waits, [1000]);
});

test("CAIL timeouts and quota_exceeded are never retried", async () => {
  await run("cail", [{ message: "Request timed out" }]);
  assert.equal(calls.length, 1);
  await run("cail", [
    {
      status: 429,
      headers: { "x-should-retry": "true" },
      body: { error: { code: "quota_exceeded", message: "Over quota" } },
    },
  ]);
  assert.equal(calls.length, 1);
  await run("cail", [{ status: 500 }]);
  assert.equal(calls.length, 1);
});

test("OpenRouter keeps retrying 429, 5xx and timeouts up to 3 attempts", async () => {
  await run("openrouter", [{ status: 429 }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [2000, 4000]);
  await run("openrouter", [{ status: 503 }, { ok: true }]);
  assert.equal(calls.length, 2);
  await run("openrouter", [{ message: "timeout" }]);
  assert.equal(calls.length, 3);
  await run("openrouter", [{ status: 400 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].errorDelayMax, undefined);
});
