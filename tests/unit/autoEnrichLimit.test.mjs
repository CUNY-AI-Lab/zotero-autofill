import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let prefs = {};
globalThis.Zotero = {
  Prefs: { get: (key) => prefs[key.split(".").pop()] },
};
const limit = await loadModule("src/modules/autoEnrichLimit.ts");

test("default cap is 20 items per hour and the hidden pref overrides it", () => {
  prefs = {};
  assert.equal(limit.getAutoEnrichCap(), 20);
  prefs = { autoEnrichMaxPerHour: 5 };
  assert.equal(limit.getAutoEnrichCap(), 5);
  prefs = { autoEnrichMaxPerHour: "junk" };
  assert.equal(limit.getAutoEnrichCap(), 20);
  prefs = { autoEnrichMaxPerHour: -1 };
  assert.equal(limit.getAutoEnrichCap(), 20);
});

test("items beyond the cap are refused with a single notice per cap hit", () => {
  let t = 0;
  const limiter = limit.createAutoEnrichLimiter(
    () => 20,
    () => t,
  );
  assert.deepEqual(limiter.take(15), { allowed: 15, notify: false, cap: 20 });
  assert.deepEqual(limiter.take(10), { allowed: 5, notify: true, cap: 20 });
  assert.deepEqual(limiter.take(3), { allowed: 0, notify: false, cap: 20 });
  t += 59 * 60 * 1000;
  assert.equal(limiter.take(1).allowed, 0);
  t += 2 * 60 * 1000;
  assert.deepEqual(limiter.take(20), { allowed: 20, notify: false, cap: 20 });
  assert.deepEqual(limiter.take(1), { allowed: 0, notify: true, cap: 20 });
});

test("a cap of zero disables automatic lookups", () => {
  const limiter = limit.createAutoEnrichLimiter(() => 0);
  assert.equal(limiter.take(1).allowed, 0);
});

test("sync-delivered adds are recognised from notifier extraData", () => {
  assert.equal(limit.isSyncedAdd([1, 2], { skipAutoSync: true }), true);
  assert.equal(
    limit.isSyncedAdd([1, 2], {
      1: { skipRenameFile: true },
      2: { skipRenameFile: true },
    }),
    true,
  );
  assert.equal(
    limit.isSyncedAdd([1, 2], { 1: { skipRenameFile: true } }),
    false,
  );
  assert.equal(limit.isSyncedAdd([1], { 1: { skipSelect: true } }), false);
  assert.equal(limit.isSyncedAdd([1], undefined), false);
});
