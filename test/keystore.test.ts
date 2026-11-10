import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";
import {
  KEYSTORE_ORIGIN,
  KEYSTORE_REALM,
  getApiKey,
  migrateKeysFromPrefs,
  resetKeyStoreState,
  setApiKey,
} from "../src/utils/keystore";

// Same lookup the plugin uses, spelled out so the test doesn't share its bugs.
const stored = async (): Promise<any[]> => {
  const logins: any = Services.logins;
  return Array.from(
    typeof logins.searchLoginsAsync === "function"
      ? await logins.searchLoginsAsync({
          origin: KEYSTORE_ORIGIN,
          httpRealm: KEYSTORE_REALM,
        })
      : logins.findLogins(KEYSTORE_ORIGIN, null, KEYSTORE_REALM),
  );
};

describe("API key storage in the Firefox login manager", function () {
  afterEach(async function () {
    await setApiKey("cailApiKey", "");
    await setApiKey("openrouterApiKey", "");
    setPref("cailApiKey", "");
  });

  it("migrates a key from the old plaintext preference and clears it", async function () {
    setPref("cailApiKey", "sk-cail-dummy-migration-key");
    await migrateKeysFromPrefs();
    assert.equal(getApiKey("cailApiKey"), "sk-cail-dummy-migration-key");
    assert.equal(getPref("cailApiKey"), "", "preference was cleared");
    const logins = await stored();
    assert.lengthOf(logins, 1);
    assert.equal(logins[0].username, "cailApiKey");
    assert.equal(logins[0].password, "sk-cail-dummy-migration-key");
    assert.equal(logins[0].origin, KEYSTORE_ORIGIN);
  });

  it("saves, replaces and removes keys without touching preferences", async function () {
    await setApiKey("openrouterApiKey", "dummy-1");
    await setApiKey("openrouterApiKey", "dummy-2");
    assert.equal(getApiKey("openrouterApiKey"), "dummy-2");
    assert.lengthOf(await stored(), 1);
    assert.equal(getPref("openrouterApiKey"), "");
    await setApiKey("openrouterApiKey", "");
    assert.equal(getApiKey("openrouterApiKey"), "");
    assert.lengthOf(await stored(), 0);
  });
});
