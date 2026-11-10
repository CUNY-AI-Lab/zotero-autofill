import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

globalThis.Zotero = {
  Prefs: { get: (key) => (key.endsWith("ApiKey") ? "k" : "cail") },
  HTTP: {
    request: async () => ({
      response: {
        choices: [
          { finish_reason: "length", message: { content: '{"items": [' } },
        ],
      },
    }),
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");

test("a truncated response gets its own error, not 'Invalid AI response'", async () => {
  const result = await llm.parseBibliographyWithLLM(["one"]);
  assert.match(result.entries[0].error, /cut off; try importing fewer/);
  assert.doesNotMatch(result.entries[0].error, /Invalid AI response/);
  assert.equal(result.items.length, 0);
});
