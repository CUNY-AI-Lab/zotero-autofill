import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let prefs;
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs[key.split(".").pop()] ?? "",
    set: (key, value) => {
      prefs[key.split(".").pop()] = value;
    },
  },
};
globalThis.ztoolkit = { log() {} };
const keystore = await loadModule("src/utils/keystore.ts");

function reset(initial = {}) {
  prefs = { cailApiKey: "", openrouterApiKey: "", ...initial };
  globalThis.__fakeLogins.length = 0;
}

test("a key saved in the old preference moves into the login store and the pref is cleared", async () => {
  reset({ cailApiKey: "  sk-cail-old  " });
  await keystore.migrateKeysFromPrefs();
  assert.equal(keystore.getApiKey("cailApiKey"), "sk-cail-old");
  assert.equal(prefs.cailApiKey, "");
  const [login] = globalThis.__fakeLogins;
  assert.equal(login.origin, keystore.KEYSTORE_ORIGIN);
  assert.equal(login.realm, keystore.KEYSTORE_REALM);
  assert.equal(login.username, "cailApiKey");
  assert.equal(login.password, "sk-cail-old");
  assert.equal(keystore.getApiKey("cailApiKey"), "sk-cail-old");
  assert.equal(globalThis.__fakeLogins.length, 1);
});

test("keys are stored per provider, replaced on save, and removed when emptied", async () => {
  reset();
  await keystore.setApiKey("cailApiKey", "a");
  await keystore.setApiKey("openrouterApiKey", "b");
  await keystore.setApiKey("cailApiKey", "c");
  assert.equal(keystore.getApiKey("cailApiKey"), "c");
  assert.equal(keystore.getApiKey("openrouterApiKey"), "b");
  assert.equal(globalThis.__fakeLogins.length, 2);
  await keystore.setApiKey("cailApiKey", " ");
  assert.equal(keystore.getApiKey("cailApiKey"), "");
  assert.equal(prefs.cailApiKey, "");
});

test("an unusable login manager fails loudly and never falls back to preferences", async () => {
  reset({ openrouterApiKey: "sk-or-old" });
  const original = globalThis.Services.logins.findLogins;
  globalThis.Services.logins.findLogins = () => {
    throw new Error("NS_ERROR_ABORT: master password cancelled");
  };
  try {
    assert.throws(() => keystore.getApiKey("openrouterApiKey"), {
      name: "KeyStoreError",
      message: keystore.KEYSTORE_UNAVAILABLE_MESSAGE,
    });
    await assert.rejects(keystore.setApiKey("cailApiKey", "x"), {
      name: "KeyStoreError",
    });
    await assert.rejects(keystore.migrateKeysFromPrefs(), {
      name: "KeyStoreError",
    });
    assert.equal(
      prefs.openrouterApiKey,
      "sk-or-old",
      "pref untouched when the store failed",
    );
  } finally {
    globalThis.Services.logins.findLogins = original;
  }
});
