import { assert } from "chai";
import { config } from "../package.json";
import { clearPref, setPref } from "../src/utils/prefs";
// Real responses recorded for the item that failed in 1.1.1.
import olStructured from "../tests/fixtures/openlibrary-periscope-structured.json";
import crossref from "../tests/fixtures/crossref-periscope.json";
import google429 from "../tests/fixtures/googlebooks-429.json";
import olGeneral from "../tests/fixtures/openlibrary-periscope-general.json";

// Drives the plugin's own bundle (Zotero[instance].api, test builds only)
// with Zotero.HTTP.request against test/support/stubServer.ts.
const instance = () => (Zotero as any)[config.addonInstance];
const api = () => instance().api;
const root = () =>
  `http://127.0.0.1:${Services.env.get("METADATA_ASSISTANT_STUB_PORT")}`;

type Route = [string, { status: number; headers?: object; body?: unknown }];
async function script(lookup: Route[], responses: object[] = []) {
  await Zotero.HTTP.request("POST", `${root()}/__control`, {
    body: JSON.stringify({ responses, lookup }),
    headers: { "Content-Type": "application/json" },
  });
}
async function lookupLog(): Promise<Array<{ url: string; headers: any }>> {
  const res = await Zotero.HTTP.request("GET", `${root()}/__lookuplog`, {
    responseType: "json",
  });
  return res.response;
}

const OL_STRUCTURED = "openlibrary.org/search.json?title=";
const OL_GENERAL = "openlibrary.org/search.json?q=";
const CROSSREF = "api.crossref.org/works?";
const GOOGLE = "www.googleapis.com/books/v1/volumes?";
const recorded: Route[] = [
  [OL_STRUCTURED, { status: 200, body: olStructured }],
  [CROSSREF, { status: 200, body: crossref }],
  [GOOGLE, { status: 429, body: google429 }],
  [OL_GENERAL, { status: 200, body: olGeneral }],
];

describe("book lookup in real Zotero", function () {
  this.timeout(60000);
  let item: Zotero.Item;

  before(async function () {
    setPref("autoEnrichOnImport", false);
    instance().data.testLookupBaseUrl = `${root()}/lookup`;
    item = new Zotero.Item("book");
    item.setField("title", "Through the Periscope");
    item.setCreators([
      { firstName: "", lastName: "Marazzi", creatorType: "author" },
    ]);
    await item.saveTx();
  });

  after(async function () {
    delete instance().data.testLookupBaseUrl;
    clearPref("autoEnrichOnImport");
    await item?.eraseTx();
  });

  it("Through the Periscope / Marazzi: Google 429 and an Open Library miss still give a Crossref proposal", async function () {
    await script(recorded);
    const stats = await api().enrichItems([item], undefined, {
      openReview: false,
    });
    assert.equal(stats.found, 1, JSON.stringify(stats.errors));
    const { result } = stats.proposals[0];
    assert.equal(
      result.title,
      "Through the Periscope: Changing Culture, Italian America",
    );
    assert.equal(result.ISBN, "9781438488622");
    assert.equal(result.date, "2022");
    assert.ok(result.publisher);
    const hosts = (await lookupLog()).map((r) => r.url.split("?")[0]);
    assert.includeMembers(hosts, [
      "openlibrary.org/search.json",
      "api.crossref.org/works",
      "www.googleapis.com/books/v1/volumes",
    ]);
  });

  it("a 429 or 503 with Retry-After is not retried behind the plugin's back", async function () {
    // Zotero 7-10 sleep on Retry-After and resend even with errorDelayMax: 0.
    await script([
      [OL_STRUCTURED, { status: 503, headers: { "Retry-After": "2" } }],
      [CROSSREF, { status: 503, headers: { "Retry-After": "2" } }],
      [GOOGLE, { status: 429, headers: { "Retry-After": "2" } }],
      [OL_GENERAL, { status: 503, headers: { "Retry-After": "2" } }],
    ]);
    const started = Date.now();
    const stats = await api().enrichItems([item], undefined, {
      openReview: false,
    });
    const log = await lookupLog();
    assert.equal(stats.failed, 1);
    assert.lengthOf(log, 4, log.map((r) => r.url).join("\n"));
    assert.isBelow(Date.now() - started, 1900 + 2200);
    const message = api().noSuggestionMessage(stats);
    assert.include(message, "could not be completed");
    assert.include(message, "Open Library had a server error (503)");
    assert.include(message, "Crossref had a server error (503)");
    assert.include(message, "Google Books refused the request (rate limit");
    assert.notInclude(message, "No matching metadata found");
  });

  it("sends a saved Google Books key as a header to Google only", async function () {
    await api().setApiKey("googleBooksApiKey", "AIza-integration-dummy");
    try {
      await script(
        recorded
          .filter(([p]) => p !== GOOGLE)
          .concat([[GOOGLE, { status: 200, body: { totalItems: 0 } }]]),
      );
      await api().enrichItems([item], undefined, { openReview: false });
      for (const r of await lookupLog()) {
        assert.notInclude(r.url, "AIza");
        if (r.url.startsWith("www.googleapis.com"))
          assert.equal(r.headers["x-goog-api-key"], "AIza-integration-dummy");
        else assert.isUndefined(r.headers["x-goog-api-key"], r.url);
      }
    } finally {
      await api().setApiKey("googleBooksApiKey", "");
    }
  });
});
