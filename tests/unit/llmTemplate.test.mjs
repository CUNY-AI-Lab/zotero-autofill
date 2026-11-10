import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let lastBody;
globalThis.Zotero = {
  Prefs: { get: (key) => (key.endsWith("ApiKey") ? "k" : "cail") },
  HTTP: {
    request: async (_m, _u, options) => {
      lastBody = JSON.parse(options.body);
      return {
        response: {
          choices: [{ message: { content: '{"title":"t","author":"a"}' } }],
        },
      };
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");

test("template values are inserted verbatim in a single pass", async () => {
  const title = "A $& B $' C $` D $$ E {author}";
  await llm.llmCleanupQuery(title, "Real Author");
  const prompt = lastBody.messages[1].content;
  assert.ok(prompt.includes(`Title: "${title}"`));
  assert.ok(prompt.includes('Author: "Real Author"'));

  await llm.llmDisambiguate(title, "{year}", null, [{ title: "x" }]);
  const second = lastBody.messages[1].content;
  assert.ok(second.includes(`- Title: ${title}`));
  assert.ok(second.includes("- Author: {year}"));
  assert.ok(second.includes("- Year: unknown"));
});
