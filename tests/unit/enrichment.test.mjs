import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";
globalThis.Zotero = {
  Prefs: { get: () => false },
  CreatorTypes: { getID: () => 1 },
};
globalThis.ztoolkit = { log: () => {} };
const mod = await loadModule("src/modules/enrichment.ts");
test("ambiguous search results do not become automatic metadata", async () => {
  const candidates = [
    {
      title: "Wrong book",
      author: "Other",
      year: "2001",
      result: { publisher: "Wrong" },
    },
  ];
  assert.equal(
    await mod.selectBestCandidate("Actual book", "Smith", 2001, candidates),
    null,
  );
});

test("ambiguous matches can be returned for manual selection", async () => {
  const candidates = [
    {
      title: "Book",
      author: "Smith",
      year: "2001",
      result: { title: "Book", publisher: "Press A" },
    },
    {
      title: "Book",
      author: "Smith",
      year: "2001",
      result: { title: "Book", publisher: "Press B" },
    },
  ];
  const result = await mod.selectBestCandidate(
    "Book",
    "Smith",
    2001,
    candidates,
    { returnAmbiguous: true },
  );
  assert.deepEqual(result.candidates, candidates);
});
test("matching requires exact edition year", async () => {
  const candidates = [
    {
      title: "Actual book",
      author: "Smith",
      year: "1999",
      result: { publisher: "Wrong" },
    },
  ];
  assert.equal(
    await mod.selectBestCandidate("Actual book", "Smith", 2001, candidates),
    null,
  );
});
test("a single exact result can repair a missing author", async () => {
  const result = await mod.selectBestCandidate("Love and Theft", "", 1993, [
    {
      title: "Love and Theft",
      author: "Eric Lott",
      year: "1993",
      result: { publisher: "Oxford University Press" },
    },
  ]);
  assert.equal(result.author, "Eric Lott");
});
test("academic article lookup uses Crossref and returns author and journal fields", async () => {
  const urls = [];
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      return {
        response: {
          message: {
            items: [
              {
                DOI: "10.1234/example",
                URL: "https://doi.org/10.1234/example",
                title: ["A scholarly article"],
                author: [
                  { given: "Ana", family: "Ortiz" },
                  { given: "Luis", family: "Chen" },
                ],
                publisher: "Example Press",
                "container-title": ["Example Journal"],
                volume: "12",
                issue: "3",
                page: "44-59",
                "published-print": { "date-parts": [[2020]] },
              },
            ],
          },
        },
      };
    },
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({ title: "A scholarly article", date: "2020" })[field] || "",
    getCreators: () => [],
  });
  assert.equal(proposal.author, "Ana Ortiz");
  assert.deepEqual(proposal.authors, [
    { given: "Ana", family: "Ortiz" },
    { given: "Luis", family: "Chen" },
  ]);
  assert.equal(proposal.containerTitle, "Example Journal");
  assert.equal(proposal.pages, "44-59");
  assert.match(urls[0], /api\.crossref\.org\/works/);
});

test("DOI article lookup expands shortened Crossref titles", async () => {
  const urls = [];
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      if (url.includes("semanticscholar.org"))
        return {
          response: {
            title:
              "Gimme Gimme This... Gimme Gimme That: Annihilation and Innovation in the Punk Rock Commons",
          },
        };
      return {
        response: {
          message: {
            DOI: "10.1215/01642472-2152855",
            title: ["Gimme Gimme This... Gimme Gimme That"],
            author: [{ given: "José Esteban", family: "Muñoz" }],
            "published-print": { "date-parts": [[2013]] },
          },
        },
      };
    },
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({
        DOI: "10.1215/01642472-2152855",
        title: "Gimme gimme this Gimme gimme that",
      })[field] || "",
    getCreators: () => [],
  });
  assert.match(proposal.title, /Annihilation and Innovation/);
  assert.ok(urls.some((url) => url.includes("semanticscholar.org")));
});

test("DOI article lookup retries Semantic Scholar rate limits", async () => {
  let semanticAttempts = 0;
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      if (url.includes("semanticscholar.org")) {
        semanticAttempts += 1;
        if (semanticAttempts === 1)
          throw new Error("HTTP GET failed with status code 429");
        return {
          response: {
            title:
              "Gimme Gimme This... Gimme Gimme That: Annihilation and Innovation in the Punk Rock Commons",
          },
        };
      }
      return {
        response: {
          message: {
            DOI: "10.1215/01642472-2152855",
            title: ["Gimme Gimme This... Gimme Gimme That"],
            author: [{ given: "José Esteban", family: "Muñoz" }],
            "published-print": { "date-parts": [[2013]] },
          },
        },
      };
    },
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({
        DOI: "10.1215/01642472-2152855",
        title: "Gimme gimme this Gimme gimme that",
      })[field] || "",
    getCreators: () => [],
  });
  assert.equal(semanticAttempts, 2);
  assert.match(proposal.title, /Annihilation and Innovation/);
});

test("DOI article lookup uses exact-DOI Semantic Scholar search fallback", async () => {
  let directAttempts = 0;
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      if (url.includes("api.crossref.org"))
        return {
          response: {
            message: {
              DOI: "10.1215/01642472-2152855",
              title: ["Gimme Gimme This... Gimme Gimme That"],
              author: [{ given: "José Esteban", family: "Muñoz" }],
            },
          },
        };
      if (
        url.includes("semanticscholar.org") &&
        !url.includes("/paper/search")
      ) {
        directAttempts += 1;
        throw new Error("HTTP GET failed with status code 429");
      }
      assert.match(url, /paper\/search/);
      return {
        response: {
          data: [
            {
              title:
                "“Gimme Gimme This... Gimme Gimme That” Annihilation and Innovation in the Punk Rock Commons",
              externalIds: { DOI: "10.1215/01642472-2152855" },
            },
            {
              title: "Wrong article",
              externalIds: { DOI: "10.1215/01642472-3607564" },
            },
          ],
        },
      };
    },
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({
        DOI: "10.1215/01642472-2152855",
        title: "Gimme gimme this Gimme gimme that",
      })[field] || "",
    getCreators: () => [],
  });
  assert.equal(directAttempts, 2);
  assert.match(proposal.title, /Annihilation and Innovation/);
});

test("academic article matching tolerates Crossref online and print year differences", async () => {
  globalThis.Zotero.HTTP = {
    request: async () => ({
      response: {
        message: {
          items: [
            {
              DOI: "10.1234/online-first",
              URL: "https://doi.org/10.1234/online-first",
              title: ["A scholarly article"],
              author: [{ given: "Ana", family: "Ortiz" }],
              "published-online": { "date-parts": [[2021]] },
            },
          ],
        },
      },
    }),
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({ title: "A scholarly article", date: "2020" })[field] || "",
    getCreators: () => [{ creatorTypeID: 1, lastName: "Ortiz", fieldMode: 0 }],
  });
  assert.equal(proposal.DOI, "10.1234/online-first");
});

test("academic article matching handles abbreviated titles and unaccented author names", async () => {
  globalThis.Zotero.HTTP = {
    request: async () => ({
      response: {
        message: {
          items: [
            {
              DOI: "10.1215/01642472-2152855",
              title: [
                "Gimme Gimme This... Gimme Gimme That: Annihilation and Innovation in the Punk Rock Commons",
              ],
              author: [{ given: "José Esteban", family: "Muñoz" }],
              "published-print": { "date-parts": [[2013]] },
            },
          ],
        },
      },
    }),
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({
        title: "Gimme gimme this Gimme gimme that",
        date: "2013",
      })[field] || "",
    getCreators: () => [{ creatorTypeID: 1, lastName: "Munoz", fieldMode: 1 }],
  });
  assert.equal(proposal.DOI, "10.1215/01642472-2152855");
});
test("existing ISBN anchors lookup without title search", async () => {
  const urls = [];
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      return {
        response: {
          isbn_13: ["9780140328721"],
          publishers: ["Puffin"],
          publish_date: "1988",
          title: "Matilda",
        },
      };
    },
  };
  const item = {
    itemType: "book",
    getField: (f) =>
      ({ ISBN: "9780140328721", title: "Matilda", date: "1988" })[f] || "",
    getCreators: () => [],
  };
  const proposal = await mod.lookupItem(item);
  assert.equal(proposal.publisher, "Puffin");
  assert.equal(urls.length, 1);
  assert.match(urls[0], /isbn\/9780140328721/);
});

test("ISBN lookup resolves an Open Library author reference", async () => {
  const urls = [];
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      if (url.includes("/authors/")) return { response: { name: "Eric Lott" } };
      return {
        response: {
          isbn_10: ["0195078322"],
          title: "Love and theft",
          authors: [{ key: "/authors/OL2630029A" }],
        },
      };
    },
  };
  const proposal = await mod.lookupItem({
    itemType: "book",
    getField: (field) =>
      ({ ISBN: "0-19-507832-2", title: "Love and Theft", date: "1993" })[
        field
      ] || "",
    getCreators: () => [],
  });

  assert.equal(proposal.author, "Eric Lott");
  assert.deepEqual(proposal.authors, [{ name: "Eric Lott" }]);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /openlibrary\.org\/authors\/OL2630029A\.json$/);
});

/** An ISBN lookup for Matilda; `work` answers the work request. */
async function isbnLookupWithWork(edition, work) {
  const urls = [];
  const sleep = mod.enrichRuntime.sleep;
  mod.enrichRuntime.sleep = async () => {};
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      if (url.includes("/works/")) {
        if (work instanceof Error) throw work;
        return { response: work };
      }
      return {
        response: {
          isbn_13: ["9780140328721"],
          title: "Matilda",
          works: [{ key: "/works/OL45804W" }],
          ...edition,
        },
      };
    },
  };
  const proposal = await mod
    .lookupItem({
      itemType: "book",
      getField: (f) =>
        ({ ISBN: "9780140328721", title: "Matilda", date: "1988" })[f] || "",
      getCreators: () => [],
    })
    .finally(() => {
      mod.enrichRuntime.sleep = sleep;
    });
  return { proposal, urls };
}

test("ISBN lookup takes the description from the work when the edition has none", async () => {
  const { proposal, urls } = await isbnLookupWithWork(
    {},
    {
      description: {
        type: "/type/text",
        value: "  Matilda is a little girl who is far too good to be true.  ",
      },
    },
  );
  assert.equal(
    proposal.abstractNote,
    "Matilda is a little girl who is far too good to be true.",
  );
  assert.equal(urls.length, 2);
  assert.match(urls[1], /openlibrary\.org\/works\/OL45804W\.json$/);

  const long = await isbnLookupWithWork({}, { description: "x".repeat(600) });
  assert.equal(long.proposal.abstractNote.length, 500);
  assert.ok(long.proposal.abstractNote.endsWith("..."));
});

test("ISBN lookup keeps the edition's own description and does not fetch the work", async () => {
  const { proposal, urls } = await isbnLookupWithWork(
    { description: "The edition's blurb." },
    { description: "The work's description." },
  );
  assert.equal(proposal.abstractNote, "The edition's blurb.");
  assert.equal(urls.length, 1);
});

test("ISBN lookup still succeeds without an abstract when the work has none or fails", async () => {
  for (const work of [
    {},
    { description: "   " },
    Object.assign(new Error("HTTP 503"), { status: 503 }),
  ]) {
    const { proposal, urls } = await isbnLookupWithWork(
      { publishers: ["Puffin"] },
      work,
    );
    assert.equal(proposal.publisher, "Puffin");
    assert.equal(proposal.abstractNote, undefined);
    assert.equal(urls.length, 2);
  }
});

test("ISBN lookup does not request a work with a malformed key", async () => {
  const { proposal, urls } = await isbnLookupWithWork(
    { works: [{ key: "/works/../admin" }] },
    { description: "should not be fetched" },
  );
  assert.equal(proposal.abstractNote, undefined);
  assert.equal(urls.length, 1);
});

test("manual enrichment closes progress before opening and focusing review", async () => {
  const events = [];
  globalThis.addon = {
    data: {
      config: {
        addonName: "Zotero Metadata Assistant",
        addonRef: "zotero-metadata-assistant",
      },
    },
  };
  globalThis.Zotero.Prefs.get = () => false;
  globalThis.Zotero.HTTP = {
    request: async () => ({
      response: {
        isbn_13: ["9780140328721"],
        publishers: ["Puffin"],
        publish_date: "1988",
        title: "Matilda",
      },
    }),
  };
  globalThis.Zotero.getActiveZoteroPane = () => ({
    getSelectedItems: () => [
      {
        id: 42,
        itemType: "book",
        getField: (field) =>
          ({ ISBN: "9780140328721", title: "Matilda", date: "1988" })[field] ||
          "",
        getCreators: () => [],
      },
    ],
  });
  globalThis.Zotero.getMainWindow = () => ({
    openDialog: () => {
      events.push("dialog:open");
      return { focus: () => events.push("dialog:focus") };
    },
  });
  globalThis.ztoolkit.ProgressWindow = class {
    createLine() {
      return this;
    }
    show() {
      events.push("popup:show");
      return this;
    }
    changeLine() {
      return this;
    }
    startCloseTimer() {
      events.push("popup:timer");
      return this;
    }
    close() {
      events.push("popup:close");
      return this;
    }
  };

  await mod.EnrichmentFactory.enrichSelectedItems();

  assert.deepEqual(events, [
    "popup:show",
    "popup:close",
    "dialog:open",
    "dialog:focus",
  ]);
});
