import { assert } from "chai";
import { config } from "../package.json";
import { setPref, clearPref } from "../src/utils/prefs";

// Drives the plugin's own bundle (Zotero[instance].api, exposed in test builds
// only) against test/support/stubServer.ts, so Zotero.HTTP.request behaves as
// it does in production.
const instance = () => (Zotero as any)[config.addonInstance];
const api = () => instance().api;
const root = () =>
  `http://127.0.0.1:${Services.env.get("METADATA_ASSISTANT_STUB_PORT")}`;

async function script(responses: object[], catalog?: object) {
  await Zotero.HTTP.request("POST", `${root()}/__control`, {
    body: JSON.stringify({ responses, catalog }),
    headers: { "Content-Type": "application/json" },
  });
}
async function stubLog(): Promise<any[]> {
  const res = await Zotero.HTTP.request("GET", `${root()}/__log`, {
    responseType: "json",
  });
  return res.response;
}
const ok = {
  status: 200,
  body: { choices: [{ message: { content: '{"ok":true}' } }] },
};
const msgs = [{ role: "user", content: "hi" }];

describe("CAIL Gateway client in real Zotero", function () {
  this.timeout(30000);

  before(async function () {
    instance().data.testBaseUrl = `${root()}/v1`;
    setPref("aiProvider", "cail");
    await api().setApiKey("cailApiKey", "sk-cail-integration-test");
  });

  after(async function () {
    delete instance().data.testBaseUrl;
    clearPref("aiProvider");
    await api().setApiKey("cailApiKey", "");
  });

  it("makes exactly one request for a 503 without x-should-retry", async function () {
    await script([{ status: 503, body: { error: { message: "down" } } }]);
    const result = await api().callOpenRouter(msgs);
    assert.isFalse(result.success);
    assert.lengthOf(await stubLog(), 1);
  });

  it("makes exactly one request for a 503 with x-should-retry: false", async function () {
    await script([
      { status: 503, headers: { "x-should-retry": "false" }, body: {} },
    ]);
    await api().callOpenRouter(msgs);
    assert.lengthOf(await stubLog(), 1);
  });

  it("makes exactly one request for a 429 or 503 with Retry-After but no x-should-retry", async function () {
    // Zotero 7-10's own HTTP layer would sleep Retry-After and resend
    // (unbounded) unless the request opts out with noRetryOnThrottle.
    for (const status of [429, 503]) {
      await script([
        {
          status,
          headers: { "Retry-After": "1" },
          body: { error: { code: "quota_exceeded", message: "Over quota" } },
        },
        ok,
      ]);
      const result = await api().callOpenRouter(msgs);
      assert.isFalse(result.success, String(status));
      assert.lengthOf(await stubLog(), 1, String(status));
    }
  });

  it("retries once, after Retry-After, when x-should-retry is true", async function () {
    await script([
      {
        status: 503,
        headers: { "x-should-retry": "true", "Retry-After": "1" },
        body: {},
      },
      ok,
    ]);
    const started = Date.now();
    const result = await api().callOpenRouter(msgs);
    assert.isTrue(result.success);
    assert.lengthOf(await stubLog(), 2);
    assert.isAtLeast(Date.now() - started, 900);
  });

  it("surfaces the Gateway error body and request ID on a 404", async function () {
    await script([
      {
        status: 404,
        body: {
          error: {
            code: "model_not_found",
            message: "The model does not exist",
            param: "model",
          },
        },
      },
    ]);
    const result = await api().callOpenRouter(msgs);
    assert.isFalse(result.success);
    const [seen] = await stubLog();
    assert.equal(
      result.error,
      `The model does not exist (code: model_not_found, request ID: ${seen.headers["x-cail-request-id"]})`,
    );
  });

  it("sends a lowercase UUIDv4 x-cail-request-id", async function () {
    await script([ok]);
    await api().callOpenRouter(msgs);
    const [seen] = await stubLog();
    assert.match(
      seen.headers["x-cail-request-id"],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("closes the connection when aborted and sends no further batch", async function () {
    await script([{ ...ok, delayMs: 8000 }, ok]);
    const controller = new AbortController();
    const entries = Array.from({ length: 25 }, (_, i) => `citation ${i}`);
    const pending = api().parseBibliographyWithLLM(
      entries,
      10,
      undefined,
      controller.signal,
    );
    for (let i = 0; i < 50 && !(await stubLog()).length; i++)
      await Zotero.Promise.delay(100);
    assert.lengthOf(await stubLog(), 1);
    controller.abort();
    await pending;
    await Zotero.Promise.delay(1500);
    const log = await stubLog();
    assert.lengthOf(log, 1, "no further batch was requested");
    assert.isTrue(log[0].closedEarly, "stub saw the connection close");
  });

  it("fetches the real catalog over HTTP and migrates a removed model", async function () {
    await script([], {
      object: "list",
      data: [
        {
          id: "deepseek-v4.1-flash-1017",
          name: "DeepSeek V4.1 Flash",
          order: 1,
          recommended: true,
          status: "active",
          capabilities: ["text-generation", "reasoning"],
        },
        {
          id: "glm-5.3",
          name: "GLM 5.3",
          order: 2,
          status: "active",
          capabilities: ["text-generation"],
        },
      ],
    });
    setPref("catalogCache", "");
    api().resetCatalogCache();
    setPref("llmModel", "retired-model");
    await api().ensureCatalogAndModel();
    assert.equal(
      Zotero.Prefs.get(`${config.prefsPrefix}.llmModel`, true),
      "deepseek-v4.1-flash-1017",
    );
    const cache = JSON.parse(
      Zotero.Prefs.get(`${config.prefsPrefix}.catalogCache`, true) as string,
    );
    assert.deepEqual(
      cache.models.map((m: { id: string }) => m.id),
      ["deepseek-v4.1-flash-1017", "glm-5.3"],
    );
    clearPref("catalogCache");
    clearPref("llmModel");
  });
});
