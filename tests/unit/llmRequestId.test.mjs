/* global AbortController */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let provider = "cail";
let sent = [];
globalThis.Zotero = {
  Prefs: {
    get: (key) =>
      key.endsWith("ApiKey")
        ? "k"
        : key.endsWith("aiProvider")
          ? provider
          : "deepseek/deepseek-v4.1-flash",
  },
  HTTP: {
    request: async (_m, _u, options) => {
      sent.push(options);
      return {
        response: { choices: [{ message: { content: '{"ok":true}' } }] },
      };
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("CAIL sends a fresh lowercase UUIDv4 request ID per call", async () => {
  provider = "cail";
  sent = [];
  await llm.callOpenRouter([]);
  await llm.callOpenRouter([]);
  const ids = sent.map((o) => o.headers["x-cail-request-id"]);
  assert.match(ids[0], UUID);
  assert.match(ids[1], UUID);
  assert.notEqual(ids[0], ids[1]);
});

test("OpenRouter does not send the request ID header", async () => {
  provider = "openrouter";
  sent = [];
  await llm.callOpenRouter([]);
  assert.equal(
    Object.keys(sent[0].headers).some((h) => /cail/i.test(h)),
    false,
  );
});

test("an aborted signal stops before sending and cancels an in-flight request", async () => {
  provider = "cail";
  sent = [];
  const done = new AbortController();
  done.abort();
  const r = await llm.callOpenRouter([], { signal: done.signal });
  assert.equal(r.success, false);
  assert.equal(sent.length, 0);

  const live = new AbortController();
  let cancelled = false;
  const original = globalThis.Zotero.HTTP.request;
  globalThis.Zotero.HTTP.request = (_m, _u, options) =>
    new Promise((_resolve, reject) => {
      options.cancellerReceiver(() => {
        cancelled = true;
        reject(new Error("aborted"));
      });
    });
  const pending = llm.callOpenRouter([], { signal: live.signal });
  live.abort();
  const res = await pending;
  globalThis.Zotero.HTTP.request = original;
  assert.equal(cancelled, true);
  assert.equal(res.error, "Cancelled");
});
