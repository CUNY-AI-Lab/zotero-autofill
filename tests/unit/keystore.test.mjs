import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let prefs;
let now = 1_000_000;
Date.now = () => now;
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs[key.split(".").pop()] ?? "",
    set: (key, value) => {
      prefs[key.split(".").pop()] = value;
    },
  },
};
globalThis.ztoolkit = {
  log() {},
  ProgressWindow: class {
    createLine() {
      notices++;
      return this;
    }
    show() {}
  },
};
let notices = 0;
const keystore = await loadModule("src/utils/keystore.ts");
const modern = globalThis.Services.logins;

function reset(initial = {}) {
  prefs = { cailApiKey: "", openrouterApiKey: "", ...initial };
  globalThis.__fakeLogins.length = 0;
  globalThis.Services.logins = modern;
  keystore.resetKeyStoreState();
  notices = 0;
}

test("a key saved in the old preference moves into the login store and the pref is cleared", async () => {
  reset({ cailApiKey: "  sk-cail-old  " });
  assert.equal(
    keystore.getApiKey("cailApiKey"),
    "sk-cail-old",
    "usable at once",
  );
  await keystore.migrateKeysFromPrefs();
  assert.equal(keystore.getApiKey("cailApiKey"), "sk-cail-old");
  assert.equal(prefs.cailApiKey, "");
  const [login] = globalThis.__fakeLogins;
  assert.equal(login.origin, keystore.KEYSTORE_ORIGIN);
  assert.equal(login.realm, keystore.KEYSTORE_REALM);
  assert.equal(login.username, "cailApiKey");
  assert.equal(login.password, "sk-cail-old");
});

test("stored keys load into the session; save replaces; empty removes", async () => {
  reset();
  await keystore.setApiKey("cailApiKey", "a");
  await keystore.setApiKey("openrouterApiKey", "b");
  assert.deepEqual(await keystore.setApiKey("cailApiKey", "c"), {
    persisted: true,
  });
  assert.equal(globalThis.__fakeLogins.length, 2);
  keystore.resetKeyStoreState();
  assert.equal(keystore.getApiKey("cailApiKey"), "");
  await keystore.migrateKeysFromPrefs();
  assert.equal(keystore.getApiKey("cailApiKey"), "c");
  assert.equal(keystore.getApiKey("openrouterApiKey"), "b");
  await keystore.setApiKey("cailApiKey", " ");
  assert.equal(keystore.getApiKey("cailApiKey"), "");
  assert.equal(globalThis.__fakeLogins.length, 1);
});

test("works on a login manager with only the old synchronous API", async () => {
  reset({ openrouterApiKey: "sk-or-old" });
  globalThis.Services.logins = globalThis.__legacySyncLogins;
  await keystore.migrateKeysFromPrefs();
  assert.equal(prefs.openrouterApiKey, "");
  assert.equal(globalThis.__fakeLogins[0].password, "sk-or-old");
  await keystore.setApiKey("openrouterApiKey", "sk-or-new");
  assert.equal(globalThis.__fakeLogins.length, 1);
  assert.equal(globalThis.__fakeLogins[0].password, "sk-or-new");
  await keystore.setApiKey("openrouterApiKey", "");
  assert.equal(globalThis.__fakeLogins.length, 0);
});

test("prefers the async API when removed sync methods throw (Gecko 153)", async () => {
  reset();
  globalThis.Services.logins = {
    ...modern,
    findLogins() {
      throw new Error("LoginManager.findLogins() was removed.");
    },
  };
  await keystore.setApiKey("cailApiKey", "k");
  keystore.resetKeyStoreState();
  await keystore.migrateKeysFromPrefs();
  assert.equal(keystore.getApiKey("cailApiKey"), "k");
});

test("an unusable store keeps the old pref key usable, never deletes it, and recovers later", async () => {
  reset({ cailApiKey: "sk-cail-old" });
  globalThis.Services.logins = {
    ...modern,
    searchLoginsAsync: async () => {
      throw Object.assign(new Error("master password cancelled"), {
        name: "NS_ERROR_ABORT",
      });
    },
  };
  await keystore.migrateKeysFromPrefs();
  assert.equal(prefs.cailApiKey, "sk-cail-old", "pref untouched");
  assert.equal(keystore.getApiKey("cailApiKey"), "sk-cail-old");
  const problem = keystore.getKeyStoreProblem();
  assert.equal(problem.name, "KeyStoreError");
  assert.deepEqual(problem.cause, {
    name: "NS_ERROR_ABORT",
    message: "master password cancelled",
  });
  assert.equal(notices, 1);
  // Throttled, then retried once the store works.
  globalThis.Services.logins = modern;
  await keystore.migrateKeysFromPrefs();
  assert.equal(prefs.cailApiKey, "sk-cail-old");
  now += 61_000;
  await keystore.migrateKeysFromPrefs();
  assert.equal(prefs.cailApiKey, "");
  assert.equal(globalThis.__fakeLogins[0].password, "sk-cail-old");
  assert.equal(keystore.getKeyStoreProblem(), undefined);
});

test("a key entered while the store is unusable lasts the session and never reaches prefs", async () => {
  reset();
  globalThis.Services.logins = {
    ...modern,
    searchLoginsAsync: async () => {
      throw new Error("no backend");
    },
  };
  const result = await keystore.setApiKey("cailApiKey", "sk-cail-typed");
  assert.equal(result.persisted, false);
  assert.equal(keystore.getApiKey("cailApiKey"), "sk-cail-typed");
  assert.equal(prefs.cailApiKey, "");
  assert.equal(notices, 1);
  await keystore.setApiKey("cailApiKey", "sk-cail-typed-2");
  assert.equal(notices, 1, "notice shown once per session");
  assert.ok(!JSON.stringify(result.error.cause).includes("sk-cail"));
});

test("a login manager that never answers cannot hang callers", async () => {
  reset({ cailApiKey: "sk-cail-old" });
  globalThis.Services.logins = {
    ...modern,
    searchLoginsAsync: () => new Promise(() => {}),
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const done = keystore.migrateKeysFromPrefs();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    mock.timers.tick(keystore.KEYSTORE_TIMEOUT_MS + 1);
    await done;
  } finally {
    mock.timers.reset();
  }
  assert.equal(keystore.getApiKey("cailApiKey"), "sk-cail-old");
  assert.equal(prefs.cailApiKey, "sk-cail-old");
  assert.match(keystore.getKeyStoreProblem().cause.message, /did not respond/);
});

test("after a downgrade, a key typed into the old version replaces the stored one", async () => {
  // 1.1.2 stored key A and cleared the pref; 1.1.1 then saved key B in the
  // pref (the only way the pref can be non-empty again); back on 1.1.2:
  reset();
  await keystore.setApiKey("cailApiKey", "sk-cail-A");
  keystore.resetKeyStoreState();
  prefs.cailApiKey = "sk-cail-B";
  await keystore.migrateKeysFromPrefs();
  assert.equal(keystore.getApiKey("cailApiKey"), "sk-cail-B");
  assert.equal(prefs.cailApiKey, "");
  assert.deepEqual(
    globalThis.__fakeLogins.map((l) => l.password),
    ["sk-cail-B"],
  );
});

test("overlapping saves and migrations run one at a time: no duplicates, last value wins", async () => {
  reset({ cailApiKey: "sk-cail-old" });
  // A slow store that would interleave unserialized calls.
  const slow =
    (fn) =>
    async (...args) => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return fn(...args);
    };
  globalThis.Services.logins = {
    initializationPromise: Promise.resolve(),
    searchLoginsAsync: slow(modern.searchLoginsAsync),
    addLoginAsync: slow(async (login) => {
      if (globalThis.__fakeLogins.some((l) => l.username === login.username))
        throw new Error("This login already exists.");
      return modern.addLoginAsync(login);
    }),
    modifyLoginAsync: slow(modern.modifyLoginAsync),
    removeLoginAsync: slow(modern.removeLoginAsync),
  };
  const results = await Promise.all([
    keystore.migrateKeysFromPrefs(),
    keystore.migrateKeysFromPrefs(),
    keystore.setApiKey("openrouterApiKey", "or-1"),
    keystore.setApiKey("openrouterApiKey", "or-2"),
    keystore.setApiKey("googleBooksApiKey", "g-1"),
  ]);
  assert.equal(keystore.getKeyStoreProblem(), undefined);
  for (const r of results.slice(2)) assert.equal(r.persisted, true);
  const byName = Object.fromEntries(
    globalThis.__fakeLogins.map((l) => [l.username, l.password]),
  );
  assert.deepEqual(byName, {
    cailApiKey: "sk-cail-old",
    openrouterApiKey: "or-2",
    googleBooksApiKey: "g-1",
  });
  assert.equal(globalThis.__fakeLogins.length, 3);
  assert.equal(prefs.cailApiKey, "");
  assert.equal(notices, 0);
});

test("the Google Books key is only ever in the login manager", async () => {
  reset();
  await keystore.setApiKey("googleBooksApiKey", "AIza-dummy");
  assert.equal(keystore.getApiKey("googleBooksApiKey"), "AIza-dummy");
  assert.ok(!JSON.stringify(prefs).includes("AIza"));
  keystore.resetKeyStoreState();
  await keystore.migrateKeysFromPrefs();
  assert.equal(keystore.getApiKey("googleBooksApiKey"), "AIza-dummy");
});
