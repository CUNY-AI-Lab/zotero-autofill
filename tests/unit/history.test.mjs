import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";
globalThis.Zotero = { Prefs: { get: () => false, set: () => {} } };
const review = await loadModule("src/modules/enrichmentReview.ts");
const enrichment = await loadModule("src/modules/enrichment.ts");
const change = (field, before, after) => ({ field, before, after });
const record = (changes, extra = {}) => ({
  version: 1,
  date: "2026-09-07T12:00:00.000Z",
  source: "https://openlibrary.org/books/OL1M.json",
  changes,
  ...extra,
});
const item = (values) => ({ getField: (field) => values[field] || "" });

test("partial undo leaves remaining original changes available", () => {
  const records = [
    {
      id: 1,
      record: record([
        change("publisher", "", "P"),
        change("date", "", "2000"),
      ]),
    },
    { id: 2, record: record([change("publisher", "P", "")], { undoOf: 1 }) },
  ];
  const result = review.pendingUndo(item({ date: "2000" }), records);
  assert.equal(result.undoOf, 1);
  assert.deepEqual(result.changes, [change("date", "2000", "")]);
});

test("invalid history is ignored and edited fields never overwritten", () => {
  const records = [
    {
      id: 1,
      record: record([
        change("publisher", "", "P"),
        change("date", "", "2000"),
      ]),
    },
    { id: 2, record: { date: 42 } },
    { id: 3, record: record([change("bogus", "Original", "Injected")]) },
  ];
  const result = review.pendingUndo(
    item({ publisher: "Human edit", date: "2000", title: "Injected" }),
    records,
  );
  assert.deepEqual(result.changes, [change("date", "2000", "")]);
});

test("fully undone history falls back to older actionable record", () => {
  const records = [
    { id: 1, record: record([change("date", "", "2000")]) },
    {
      id: 2,
      record: record([change("publisher", "", "P")], {
        date: "2026-09-07T13:00:00.000Z",
      }),
    },
    { id: 3, record: record([change("publisher", "P", "")], { undoOf: 2 }) },
  ];
  assert.equal(review.pendingUndo(item({ date: "2000" }), records).undoOf, 1);
});

test("failed history save restores the live item after DB rollback", async () => {
  const values = { publisher: "" };
  const target = {
    ...item(values),
    id: 1,
    libraryID: 1,
    setField: (f, v) => {
      values[f] = v;
    },
    save: async () => {
      throw Error("History failed");
    },
  };
  globalThis.Zotero.DB = { executeTransaction: async (cb) => cb() };
  await assert.rejects(
    review.saveReviewedChanges(
      target,
      [change("publisher", "", "P")],
      "source",
    ),
    /History failed/,
  );
  assert.equal(values.publisher, "");
});

test("review can add a missing author and include it in history", async () => {
  globalThis.Zotero.CreatorTypes = { getID: () => 1 };
  const creators = [];
  const target = {
    ...item({ title: "Love and Theft" }),
    id: 7,
    libraryID: 1,
    getCreators: () => creators,
    setCreator: (index, value) => {
      creators[index] = {
        creatorTypeID: 1,
        fieldMode: value.name ? 1 : 0,
        firstName: value.firstName || "",
        lastName: value.lastName || value.name,
      };
    },
    removeCreator: (index) => creators.splice(index, 1),
    setField: () => {},
    save: async () => {},
  };
  const changes = review.proposedChanges(target, { author: "Eric Lott" });
  assert.deepEqual(changes, [
    {
      field: "author",
      before: "",
      after: "Eric Lott",
      creatorsBefore: [],
      creatorsAfter: [
        { firstName: "Eric", lastName: "Lott", creatorType: "author" },
      ],
    },
  ]);
  globalThis.Zotero.DB = { executeTransaction: async (cb) => cb() };
  globalThis.Zotero.Item = class {
    setNote() {}
    async save() {}
  };
  await review.saveReviewedChanges(target, changes, "Crossref");
  assert.equal(creators[0].firstName, "Eric");
  assert.equal(creators[0].lastName, "Lott");
});

test("base field mapping protects existing conference metadata", () => {
  globalThis.Zotero.ItemFields = {
    getFieldIDFromTypeAndBase: (itemTypeID, baseField) =>
      itemTypeID === 99 && baseField === "publicationTitle"
        ? "proceedingsTitle"
        : baseField,
    getName: (fieldID) => fieldID,
  };
  const values = { proceedingsTitle: "Existing Proceedings" };
  const target = {
    itemType: "conferencePaper",
    itemTypeID: 99,
    ...item(values),
    getCreators: () => [],
  };

  assert.deepEqual(
    review.proposedChanges(target, { containerTitle: "Replacement Title" }),
    [],
  );
});

test("review keeps structured coauthors in the proposed creator list", () => {
  const target = {
    ...item({ title: "A scholarly article" }),
    getCreators: () => [],
  };
  const changes = review.proposedChanges(target, {
    author: "Ana Ortiz",
    authors: [
      { given: "Ana", family: "Ortiz" },
      { given: "Luis", family: "Chen" },
    ],
  });
  assert.equal(changes[0].after, "Ana Ortiz; Luis Chen");
  assert.deepEqual(changes[0].creatorsAfter, [
    { firstName: "Ana", lastName: "Ortiz", creatorType: "author" },
    { firstName: "Luis", lastName: "Chen", creatorType: "author" },
  ]);
});

test("review proposes fuller titles and author names", () => {
  globalThis.Zotero.CreatorTypes = { getID: () => 1 };
  const target = {
    ...item({ title: "Gimme gimme this Gimme gimme that" }),
    getCreators: () => [{ creatorTypeID: 1, fieldMode: 1, lastName: "Munoz" }],
  };
  const changes = review.proposedChanges(target, {
    title:
      "Gimme Gimme This... Gimme Gimme That: Annihilation and Innovation in the Punk Rock Commons",
    author: "José Esteban Muñoz",
    authors: [{ given: "José Esteban", family: "Muñoz" }],
  });
  assert.deepEqual(changes, [
    {
      field: "author",
      before: "Munoz",
      after: "José Esteban Muñoz",
      creatorsBefore: [{ name: "Munoz", creatorType: "author" }],
      creatorsAfter: [
        {
          firstName: "José Esteban",
          lastName: "Muñoz",
          creatorType: "author",
        },
      ],
    },
    {
      field: "title",
      before: "Gimme gimme this Gimme gimme that",
      after:
        "Gimme Gimme This... Gimme Gimme That: Annihilation and Innovation in the Punk Rock Commons",
    },
  ]);
});

test("review keeps a title proposal when only punctuation and casing differ", () => {
  const target = {
    ...item({ title: "Gimme gimme this Gimme gimme that" }),
    getCreators: () => [],
  };
  assert.deepEqual(
    review.proposedChanges(target, {
      title: "“Gimme Gimme This... Gimme Gimme That”",
    }),
    [
      {
        field: "title",
        before: "Gimme gimme this Gimme gimme that",
        after: "“Gimme Gimme This... Gimme Gimme That”",
      },
    ],
  );
});

test("title changes pass history validation and save", async () => {
  const values = { title: "Short title" };
  const target = {
    ...item(values),
    id: 8,
    libraryID: 1,
    setField: (field, value) => {
      values[field] = value;
    },
    save: async () => {},
  };
  globalThis.Zotero.DB = { executeTransaction: async (cb) => cb() };
  await review.saveReviewedChanges(
    target,
    [{ field: "title", before: "Short title", after: "Full title" }],
    "Crossref",
  );
  assert.equal(values.title, "Full title");
});

test("review records the catalog and Open Library ID alongside real changes", () => {
  const target = {
    ...item({ title: "Matilda", extra: "OCLC: 1" }),
    getCreators: () => [],
  };
  const changes = review.proposedChanges(target, {
    publisher: "Puffin",
    openLibraryID: "OL7353617M",
    libraryCatalog: "Open Library",
  });
  assert.deepEqual(changes, [
    { field: "publisher", before: "", after: "Puffin" },
    { field: "libraryCatalog", before: "", after: "Open Library" },
    {
      field: "extra",
      before: "OCLC: 1",
      after: "OCLC: 1\nOpen Library ID: OL7353617M",
    },
  ]);
  // Both can be undone.
  const undo = review.pendingUndo(
    item({
      title: "Matilda",
      publisher: "Puffin",
      libraryCatalog: "Open Library",
      extra: "OCLC: 1\nOpen Library ID: OL7353617M",
    }),
    [{ id: 1, record: record(changes) }],
  );
  assert.deepEqual(
    undo.changes.map((c) => c.field),
    ["publisher", "libraryCatalog", "extra"],
  );
});

test("review proposes nothing when only the catalog and ID would change", () => {
  const target = {
    ...item({ title: "Matilda", publisher: "Puffin" }),
    getCreators: () => [],
  };
  assert.deepEqual(
    review.proposedChanges(target, {
      publisher: "Puffin",
      openLibraryID: "OL7353617M",
      libraryCatalog: "Open Library",
    }),
    [],
  );
});

test("review keeps an existing Library Catalog and Open Library ID", () => {
  const target = {
    ...item({
      title: "Matilda",
      libraryCatalog: "Library of Congress",
      extra: "Open Library ID: OL1M",
    }),
    getCreators: () => [],
  };
  assert.deepEqual(
    review.proposedChanges(target, {
      publisher: "Puffin",
      openLibraryID: "OL7353617M",
      libraryCatalog: "Open Library",
    }),
    [{ field: "publisher", before: "", after: "Puffin" }],
  );
});

test("multi-author history can be undone after saving", () => {
  globalThis.Zotero.CreatorTypes = { getID: () => 1 };
  const target = {
    ...item({ title: "A scholarly article" }),
    getCreators: () => [],
  };
  const changes = review.proposedChanges(target, {
    author: "Ana Ortiz",
    authors: [
      { given: "Ana", family: "Ortiz" },
      { given: "Luis", family: "Chen" },
    ],
  });
  assert.equal(changes[0].after, "Ana Ortiz; Luis Chen");
  target.getCreators = () => [
    { creatorTypeID: 1, fieldMode: 0, firstName: "Ana", lastName: "Ortiz" },
    { creatorTypeID: 1, fieldMode: 0, firstName: "Luis", lastName: "Chen" },
  ];
  const result = review.pendingUndo(target, [
    { id: 10, record: record(changes) },
  ]);
  assert.deepEqual(result.changes, [
    {
      field: "author",
      before: "Ana Ortiz; Luis Chen",
      after: "",
      creatorsBefore: changes[0].creatorsAfter,
      creatorsAfter: [],
    },
  ]);
});

test("author surname substrings do not establish deterministic matches", async () => {
  const candidates = [
    {
      title: "Book",
      author: "John Smithson",
      year: "2000",
      result: { publisher: "Wrong" },
    },
  ];
  assert.equal(
    await enrichment.selectBestCandidate("Book", "Smith", 2000, candidates),
    null,
  );
});

test("invalid existing ISBN cannot silently switch to title matching", async () => {
  let calls = 0;
  globalThis.Zotero.HTTP = {
    request: async () => {
      calls++;
      return { response: {} };
    },
  };
  const target = {
    itemType: "book",
    ...item({ ISBN: "9781234567890", title: "Book" }),
    getCreators: () => [],
  };
  assert.equal(await enrichment.lookupItem(target), null);
  assert.equal(calls, 0);
});

test("conflict discovered inside transaction preserves concurrent edits", async () => {
  const values = { publisher: "" };
  const target = {
    ...item(values),
    id: 1,
    libraryID: 1,
    setField: (f, v) => {
      values[f] = v;
    },
    save: async () => {},
  };
  globalThis.Zotero.DB = {
    executeTransaction: async (cb) => {
      values.publisher = "P";
      return cb();
    },
  };
  await assert.rejects(
    review.saveReviewedChanges(
      target,
      [change("publisher", "", "P")],
      "source",
    ),
    /changed since review/,
  );
  assert.equal(values.publisher, "P");
});

test("ISBN-10 resolves to equivalent ISBN-13 edition", async () => {
  globalThis.ztoolkit = { log() {} };
  globalThis.Zotero.HTTP = {
    request: async () => ({
      response: {
        title: "Matilda",
        isbn_13: ["9780140328721"],
        publishers: ["Puffin"],
      },
    }),
  };
  const target = { itemType: "book", ...item({ ISBN: "0140328726" }) };
  assert.equal((await enrichment.lookupItem(target)).publisher, "Puffin");
});
