import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let requests;
let hang;
globalThis.Zotero = {
  Prefs: { get: () => "" },
  CreatorTypes: { getID: () => 1 },
  HTTP: {
    request: (method, url, options) => {
      requests.push({ url, options });
      if (hang) return new Promise(() => {});
      return Promise.resolve({ response: { docs: [], items: [] } });
    },
  },
};
globalThis.ztoolkit = { log() {} };
const mod = await loadModule("src/modules/enrichment.ts");
mod.enrichRuntime.sleep = async () => {};

let nextId = 1;
const book = () => ({
  id: nextId++,
  itemType: "book",
  getField: (f) => ({ title: "Through the Periscope", ISBN: "" })[f] ?? "",
  getCreators: () => [{ creatorTypeID: 1, lastName: "Marazzi" }],
});

// Let queued promise callbacks run between timer ticks.
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function advance(ms, step = 1000) {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    await settle();
  }
}

test("every lookup request disables Zotero's own 5xx and Retry-After retries", async () => {
  requests = [];
  hang = false;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const run = mod.enrichItems([book()]);
    await settle();
    await advance(5000);
    await run;
  } finally {
    mock.timers.reset();
  }
  assert.ok(requests.length > 0);
  for (const r of requests) {
    assert.equal(r.options.errorDelayMax, 0, r.url);
    assert.equal(r.options.noRetryOnThrottle, true, r.url);
    assert.ok(r.options.timeout <= 10000);
  }
});

test("a lookup that never answers is abandoned at its deadline and frees the item", async () => {
  requests = [];
  hang = true;
  const item = book();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const run = mod.enrichItems([item]);
    await settle();
    // Not done before the deadline...
    await advance(mod.LOOKUP_DEADLINE_MS - 5000, 5000);
    let done = false;
    run.then(() => (done = true));
    await settle();
    assert.equal(done, false);
    // ...and not stuck after it.
    await advance(10000, 1000);
    const stats = await run;
    assert.equal(stats.failed, 1, "a timeout is a failure, not a miss");
    assert.equal(stats.notFound, 0);
    assert.match(stats.errors[0], /Lookup timed out/);
  } finally {
    mock.timers.reset();
  }
  // The item is no longer pending: a new lookup actually runs.
  hang = false;
  requests = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rerun = mod.enrichItems([item]);
    await settle();
    await advance(5000);
    const stats = await rerun;
    assert.equal(stats.alreadyRunning, 0);
    assert.ok(requests.length > 0);
  } finally {
    mock.timers.reset();
  }
});

test("a second request for an item still being looked up is reported as already running, not skipped", async () => {
  requests = [];
  hang = true;
  const item = book();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const first = mod.enrichItems([item]);
    await settle();
    const second = await mod.enrichItems([item]);
    assert.equal(second.alreadyRunning, 1);
    assert.equal(second.skipped, 0);
    assert.equal(
      mod.noSuggestionMessage(second),
      "A lookup for this item is already running.",
    );
    await advance(mod.LOOKUP_DEADLINE_MS + 5000, 5000);
    await first;
  } finally {
    mock.timers.reset();
  }
});

test("no-suggestion messages tell unresolved, ineligible and running items apart", () => {
  const base = {
    found: 0,
    notFound: 0,
    preIsbn: 0,
    skipped: 0,
    alreadyRunning: 0,
  };
  assert.equal(
    mod.noSuggestionMessage({ ...base, notFound: 1 }),
    "No matching metadata found (1 unresolved).",
  );
  assert.equal(
    mod.noSuggestionMessage({
      ...base,
      notFound: 2,
      skipped: 1,
      alreadyRunning: 1,
    }),
    "No matching metadata found (2 unresolved; 1 not eligible; 1 already running).",
  );
  assert.equal(
    mod.noSuggestionMessage({ ...base, alreadyRunning: 3 }),
    "Lookups for these 3 items are already running.",
  );
});

test("the progress popup stays open and shows progress while a lookup runs", async () => {
  const shown = [];
  const lines = [];
  let closed = 0;
  globalThis.ztoolkit = {
    log() {},
    ProgressWindow: class {
      createLine(line) {
        lines.push(line.text);
        return this;
      }
      show(closeTime) {
        shown.push(closeTime);
        return this;
      }
      changeLine(line) {
        lines.push(line.text);
        return this;
      }
      startCloseTimer() {
        closed++;
        return this;
      }
      close() {
        closed++;
        return this;
      }
    },
  };
  globalThis.addon = { data: { config: { addonName: "Test" } } };
  globalThis.Zotero.getActiveZoteroPane = () => ({
    getSelectedItems: () => [book()],
  });
  globalThis.Zotero.getMainWindow = () => ({});
  globalThis.Zotero.alert = () => {};
  requests = [];
  hang = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const run = mod.EnrichmentFactory.enrichSelectedItems();
    await settle();
    assert.deepEqual(shown, [-1], "show(-1): no automatic close timer");
    assert.equal(closed, 0);
    assert.ok(
      lines.some((l) => /Looking up 1\/1: Through the Periscope/.test(l)),
    );
    await advance(mod.LOOKUP_DEADLINE_MS + 5000, 5000);
    await run;
  } finally {
    mock.timers.reset();
  }
  assert.ok(lines.some((l) => /Lookup timed out/.test(l)));
});
