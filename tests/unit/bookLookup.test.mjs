import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadModule } from "./helpers.mjs";

// Real responses recorded 2026-11-10 for the item that failed in 1.1.1:
// title "Through the Periscope", first author Marazzi, no date, no ISBN.
// The URLs are the ones the plugin requests.
const read = async (name) =>
  JSON.parse(await readFile(`tests/fixtures/${name}`, "utf8"));
const recorded = {
  // search.json?title=Through the Periscope&author=Marazzi -> numFound 0
  olStructured: await read("openlibrary-periscope-structured.json"),
  // works?query.bibliographic=...&filter=type:book,type:monograph,...
  crossref: await read("crossref-periscope.json"),
  // volumes?q=intitle:... inauthor:... (keyless) -> HTTP 429
  google429: await read("googlebooks-429.json"),
  // search.json?q=Through the Periscope Marazzi -> garbled records only
  olGeneral: await read("openlibrary-periscope-general.json"),
};

/** Shaped like Zotero.HTTP.UnexpectedStatusException / TimeoutException. */
const httpError = (status, url, body) =>
  Object.assign(
    new Error(`HTTP GET ${url} failed with status code ${status}`),
    { status, xmlhttp: { status, response: body } },
  );
const timeout = () => new Error("Request timed out after 10000 ms");

let behavior;
let requests;
const kindOf = (url) =>
  url.includes("api.crossref.org")
    ? "crossref"
    : url.includes("googleapis.com")
      ? "google"
      : url.includes("/isbn/")
        ? "olIsbn"
        : url.includes("search.json?q=")
          ? "olGeneral"
          : "olStructured";
globalThis.Zotero = {
  Prefs: { get: () => "" },
  CreatorTypes: { getID: () => 1 },
  HTTP: {
    request: async (_method, url, options) => {
      requests.push({ url, options, kind: kindOf(url) });
      let reply = behavior[kindOf(url)];
      if (typeof reply === "function") reply = reply(url);
      if (reply instanceof Error) throw reply;
      return { response: reply };
    },
  },
};
globalThis.ztoolkit = { log() {} };
const mod = await loadModule("tests/unit/entries/enrichmentWithKeys.mjs");
mod.enrichRuntime.sleep = async () => {};

const periscope = (overrides = {}) => ({
  id: 1,
  itemType: "book",
  getField: (f) =>
    ({ title: "Through the Periscope", ISBN: "", date: "", ...overrides })[f] ??
    "",
  getCreators: () => [{ creatorTypeID: 1, lastName: "Marazzi" }],
});

function recordedBehavior(overrides = {}) {
  requests = [];
  behavior = {
    olStructured: recorded.olStructured,
    crossref: recorded.crossref,
    google: (url) => httpError(429, url, recorded.google429),
    olGeneral: recorded.olGeneral,
    ...overrides,
  };
}
const asked = (kind) => requests.filter((r) => r.kind === kind).length;

test("Through the Periscope / Marazzi (recorded responses) yields a proposal with publisher, 2022 and ISBN", async () => {
  recordedBehavior();
  const result = await mod.lookupItem(periscope());
  assert.ok(result, "a proposal, not 'No matching metadata found'");
  assert.ok(!result.candidates, "one merged record, not a list of choices");
  assert.equal(
    result.title,
    "Through the Periscope: Changing Culture, Italian America",
  );
  assert.match(result.publisher, /SUNY Press|State University of New York/);
  assert.equal(result.date, "2022");
  assert.equal(result.ISBN, "9781438488622");
  assert.match(result.author, /Marazzi/i);
});

test("Google Books 429 and an Open Library miss do not stop Crossref; every source is asked once", async () => {
  recordedBehavior();
  const result = await mod.lookupItem(periscope());
  assert.equal(result.ISBN, "9781438488622");
  assert.equal(asked("olStructured"), 1);
  assert.equal(asked("crossref"), 1);
  assert.equal(asked("google"), 1);
  // A match was found, so the free-text last resort was not needed.
  assert.equal(asked("olGeneral"), 0);
  const crossref = requests.find((r) => r.kind === "crossref");
  assert.match(
    crossref.url,
    /filter=type%3Abook%2Ctype%3Amonograph%2Ctype%3Aedited-book%2Ctype%3Areference-book/,
  );
  assert.match(crossref.options.headers["User-Agent"], /mailto|https:\/\//);
});

test("the same lookup driven through enrichItems produces one proposal", async () => {
  recordedBehavior();
  const stats = await mod.enrichItems([periscope()], undefined, {
    openReview: false,
  });
  assert.equal(stats.found, 1);
  assert.equal(stats.failed, 0);
  assert.equal(stats.proposals[0].result.ISBN, "9781438488622");
});

test("the Open Library free-text search is the last resort, and its garbled records are not accepted", async () => {
  recordedBehavior({ crossref: { status: "ok", message: { items: [] } } });
  await assert.rejects(mod.lookupItem(periscope()), (error) => {
    assert.equal(error.name, "LookupFailedError");
    assert.match(
      error.message,
      /^Google Books refused the request \(rate limit/,
    );
    assert.match(error.message, /Open Library and Crossref found no match\.$/);
    return true;
  });
  assert.equal(asked("olGeneral"), 1);
});

test("a free-text hit is used when it matches", async () => {
  recordedBehavior({
    crossref: { status: "ok", message: { items: [] } },
    olGeneral: {
      docs: [
        {
          key: "/works/OL1W",
          title: "Through the Periscope",
          author_name: ["MARAZZI"],
          editions: {
            docs: [
              {
                key: "/books/OL2M",
                title: "Through the Periscope",
                publisher: ["State University of New York Press"],
                publish_date: ["2022"],
                isbn: ["1438488602", "9781438488608"],
              },
            ],
          },
        },
      ],
    },
  });
  const result = await mod.lookupItem(periscope());
  assert.equal(result.ISBN, "9781438488608");
  assert.equal(result.publisher, "State University of New York Press");
  assert.equal(result.date, "2022");
});

test("two editions that both match are offered as choices, not guessed", async () => {
  recordedBehavior({
    google: {
      totalItems: 1,
      items: [
        {
          id: "g1",
          volumeInfo: {
            title: "Through the Periscope",
            authors: ["Martino Marazzi"],
            publisher: "SUNY Press",
            publishedDate: "2022-07-01",
            industryIdentifiers: [
              { type: "ISBN_13", identifier: "9781438488608" },
            ],
          },
        },
      ],
    },
  });
  const result = await mod.lookupItem(periscope());
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((c) => c.isbn).sort(), [
    "9781438488608",
    "9781438488622",
  ]);
});

test("when every source fails, the message names each failure and nothing is called 'not found'", async () => {
  recordedBehavior({
    olStructured: (url) => httpError(503, url),
    crossref: () => timeout(),
    olGeneral: (url) => httpError(502, url),
  });
  await assert.rejects(mod.lookupItem(periscope()), {
    name: "LookupFailedError",
    message:
      "Open Library had a server error (503); Crossref timed out; Google Books refused the request (rate limit; the shared quota is used up, add your own Google Books API key in Settings).",
  });
  recordedBehavior({
    olStructured: (url) => httpError(503, url),
    crossref: () => timeout(),
    olGeneral: (url) => httpError(502, url),
  });
  const stats = await mod.enrichItems([periscope()], undefined, {
    openReview: false,
  });
  assert.equal(stats.failed, 1);
  assert.equal(stats.notFound, 0);
  const message = mod.noSuggestionMessage(stats);
  assert.match(
    message,
    /^The lookup could not be completed\. Through the Periscope: /,
  );
  assert.doesNotMatch(message, /No matching metadata found/);
});

test("a genuine miss with no failing source is still 'not found'", async () => {
  recordedBehavior({
    crossref: { status: "ok", message: { items: [] } },
    google: { totalItems: 0 },
    olGeneral: { docs: [] },
  });
  assert.equal(await mod.lookupItem(periscope()), null);
  const stats = await mod.enrichItems([periscope()], undefined, {
    openReview: false,
  });
  assert.equal(
    mod.noSuggestionMessage(stats),
    "No matching metadata found (1 unresolved).",
  );
});

test("an item with an ISBN resolves that edition only", async () => {
  recordedBehavior({
    olIsbn: { title: "Through the Periscope", isbn_13: ["9781438488622"] },
  });
  const result = await mod.lookupItem(periscope({ ISBN: "9781438488622" }));
  assert.equal(result.ISBN, "9781438488622");
  assert.deepEqual(
    requests.map((r) => r.kind),
    ["olIsbn"],
  );
});

test("an ISBN lookup that fails in transport is reported, a 404 is a miss", async () => {
  recordedBehavior({ olIsbn: (url) => httpError(503, url) });
  await assert.rejects(mod.lookupItem(periscope({ ISBN: "9781438488622" })), {
    message: "Open Library had a server error (503).",
  });
  recordedBehavior({ olIsbn: (url) => httpError(404, url) });
  assert.equal(
    await mod.lookupItem(periscope({ ISBN: "9781438488622" })),
    null,
  );
});

test("a 503 whose URL happens to contain 429 is a server error, not a rate limit", () => {
  const url = "https://openlibrary.org/isbn/9781429000000.json";
  assert.equal(
    mod.describeSourceFailure(httpError(503, url)),
    "had a server error (503)",
  );
  assert.equal(
    mod.describeSourceFailure(httpError(0, url)),
    "could not be reached",
  );
});

test("a Google Books key goes in a header to googleapis.com only, never in a URL", async () => {
  await mod.setApiKey("googleBooksApiKey", "AIza-dummy-test-key");
  try {
    recordedBehavior({
      google: { totalItems: 0 },
      crossref: { status: "ok", message: { items: [] } },
      olGeneral: { docs: [] },
    });
    await mod.lookupItem(periscope());
    const google = requests.find((r) => r.kind === "google");
    assert.equal(
      google.options.headers["X-Goog-Api-Key"],
      "AIza-dummy-test-key",
    );
    for (const r of requests) {
      assert.ok(!r.url.includes("AIza-dummy"), r.url);
      if (r.kind !== "google")
        assert.ok(
          !JSON.stringify(r.options.headers ?? {}).includes("AIza-dummy"),
          r.url,
        );
    }
    // With a key, a 429 is not blamed on the shared quota.
    recordedBehavior({
      google: (url) => httpError(429, url),
      crossref: { status: "ok", message: { items: [] } },
      olGeneral: { docs: [] },
    });
    await assert.rejects(mod.lookupItem(periscope()), {
      message:
        "Google Books refused the request (rate limit). Open Library and Crossref found no match.",
    });
  } finally {
    await mod.setApiKey("googleBooksApiKey", "");
  }
});

test("every catalog request identifies the plugin in its User-Agent", async () => {
  // Both searches, plus an ISBN lookup whose author is only a key.
  recordedBehavior({ crossref: { status: "ok", message: { items: [] } } });
  await mod.lookupItem(periscope()).catch(() => {});
  const searchRequests = requests;
  recordedBehavior({
    olIsbn: {
      title: "Through the Periscope",
      isbn_13: ["9781438488622"],
      authors: [{ key: "/authors/OL1A" }],
    },
    olStructured: { name: "Teresa Fiore" },
  });
  await mod.lookupItem(periscope({ ISBN: "9781438488622" }));
  const all = [...searchRequests, ...requests];
  const ol = all.filter((r) => r.url.startsWith("https://openlibrary.org/"));
  assert.ok(ol.some((r) => r.url.includes("search.json?title=")));
  assert.ok(ol.some((r) => r.url.includes("search.json?q=")));
  assert.ok(ol.some((r) => r.url.includes("/isbn/")));
  assert.ok(ol.some((r) => r.url.includes("/authors/OL1A.json")));
  assert.ok(all.some((r) => r.kind === "google"));
  assert.ok(all.some((r) => r.kind === "crossref"));
  for (const r of all)
    assert.match(
      r.options.headers?.["User-Agent"] ?? "",
      /^Zotero Metadata Assistant\/.* \(https:\/\/github\.com\/CUNY-AI-Lab\/zotero-autofill\)$/,
      r.url,
    );
});

test("titles tolerate a subtitle on one side only", () => {
  const full = "Through the Periscope: Changing Culture, Italian America";
  assert.ok(mod.titlesMatch("Through the Periscope", full));
  assert.ok(mod.titlesMatch(full, "Through the Periscope"));
  assert.ok(mod.titlesMatch("through the periscope", "THROUGH THE PERISCOPE"));
  assert.ok(
    !mod.titlesMatch("Through the Periscope: A", "Through the Periscope: B"),
  );
  assert.ok(!mod.titlesMatch("Through the Periscopes", full));
  assert.ok(!mod.titlesMatch("Through the Periscohb", "Through the Periscope"));
});

test("author matching is surname-based and case-insensitive", () => {
  assert.ok(mod.authorMatches("MARAZZI", "Marazzi"));
  assert.ok(mod.authorMatches("Martino Marazzi", "Marazzi"));
  assert.ok(mod.authorMatches("MARAZZI", "Martino Marazzi"));
  assert.ok(mod.authorMatches("Marazzi, Martino", "Marazzi"));
  assert.ok(mod.authorMatches("anyone", ""));
  assert.ok(!mod.authorMatches("Smith", "Marazzi"));
  assert.ok(!mod.authorMatches("Marazzini", "Marazzi"));
});

test("merging folds the same book from different catalogs and keeps editions apart", () => {
  const crossref = {
    title: "Through the Periscope: Changing Culture",
    author: "Martino Marazzi",
    year: "2022",
    isbn: "9781438488622",
    publisher: "SUNY Press",
    result: { ISBN: "9781438488622", publisher: "SUNY Press", DOI: "10.1/x" },
  };
  const sameIsbn = {
    title: "Through the Periscope",
    author: "MARAZZI",
    isbn: "1438488629", // ISBN-10 of the same edition
    result: { ISBN: "1438488629", numPages: 300, publisher: "Other" },
  };
  const noIsbnSameYear = {
    title: "Through the Periscope",
    author: "Marazzi",
    year: "2022",
    result: { place: "Albany" },
  };
  const noIsbnNoYear = {
    title: "Through the Periscope",
    author: "Marazzi",
    result: { place: "Elsewhere" },
  };
  const otherEdition = {
    title: "Through the Periscope",
    author: "Marazzi",
    isbn: "9781438488608",
    result: { ISBN: "9781438488608" },
  };
  const merged = mod.mergeCandidates(
    [crossref],
    [sameIsbn, noIsbnSameYear, noIsbnNoYear, otherEdition],
  );
  assert.equal(merged.length, 3);
  assert.equal(merged[0].result.publisher, "SUNY Press", "first value kept");
  assert.equal(merged[0].result.numPages, 300, "missing value filled");
  assert.equal(merged[0].result.place, "Albany");
  assert.equal(merged[0].result.DOI, "10.1/x");
  assert.equal(merged[1].result.place, "Elsewhere", "unknown year kept apart");
  assert.equal(merged[2].isbn, "9781438488608", "different ISBN kept apart");
});
