import { assert } from "chai";
import { config } from "../package.json";
import { clearPref, getPref, setPref } from "../src/utils/prefs";
import { KEYSTORE_ORIGIN, KEYSTORE_REALM } from "../src/utils/keystore";
import catalog from "../tests/fixtures/cail-catalog-response.json";

// Opens Zotero's real Settings window on the plugin's pane, so the pane's own
// script (preferenceScript.ts, via the onload hook in preferences.xhtml) runs
// exactly as it does for a user.
const instance = () => (Zotero as any)[config.addonInstance];
const api = () => instance().api;
const root = () =>
  `http://127.0.0.1:${Services.env.get("METADATA_ASSISTANT_STUB_PORT")}`;
const el = (win: Window, name: string) =>
  win.document.getElementById(
    `zotero-prefpane-${config.addonRef}-${name}`,
  ) as any;

async function storedKey(name: string): Promise<string | undefined> {
  const logins: any = Services.logins;
  const all: any[] = Array.from(
    typeof logins.searchLoginsAsync === "function"
      ? await logins.searchLoginsAsync({
          origin: KEYSTORE_ORIGIN,
          httpRealm: KEYSTORE_REALM,
        })
      : logins.findLogins(KEYSTORE_ORIGIN, null, KEYSTORE_REALM),
  );
  return all.find((l) => l.username === name)?.password;
}

async function until<T>(read: () => Promise<T> | T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!value && Date.now() < end) {
    await Zotero.Promise.delay(50);
    value = await read();
  }
  return value;
}

async function openPane(): Promise<Window> {
  const existing = Services.wm.getMostRecentWindow("zotero:pref");
  const preExisting = Boolean(existing);
  if (existing) await closed(existing);
  instance().data.prefsPaneReady = undefined;
  const pane = (Zotero as any).PreferencePanes.pluginPanes.find(
    (p: any) => p.pluginID === config.addonID,
  );
  const win = (Zotero as any).Utilities.Internal.openPreferences(pane.id);
  assert.isTrue(
    await until(() => instance().data.prefsPaneReady !== undefined, 20000),
    "the pane's onload hook ran",
  );
  await instance().data.prefsPaneReady;
  return win;
}

async function closed(win: Window) {
  if (win.closed) return;
  const gone = new Promise((resolve) =>
    win.addEventListener("unload", resolve, { once: true }),
  );
  win.close();
  await gone;
}

describe("settings pane in real Zotero", function () {
  this.timeout(60000);
  let win: Window | undefined;

  before(async function () {
    instance().data.testBaseUrl = `${root()}/v1`;
    await Zotero.HTTP.request("POST", `${root()}/__control`, {
      body: JSON.stringify({ responses: [], catalog }),
      headers: { "Content-Type": "application/json" },
    });
    setPref("aiProvider", "cail");
    setPref("llmModel", "deepseek/deepseek-v4.1-flash");
    setPref("catalogCache", "");
    setPref("openrouterCatalogCache", "");
    api().resetCatalogCache();
    await api().setApiKey("cailApiKey", "sk-cail-pane-dummy");
    await api().setApiKey("openrouterApiKey", "");
    await api().setApiKey("googleBooksApiKey", "");
  });

  afterEach(async function () {
    if (win) await closed(win);
    win = undefined;
  });

  after(async function () {
    delete instance().data.testBaseUrl;
    for (const name of ["cailApiKey", "openrouterApiKey", "googleBooksApiKey"])
      await api().setApiKey(name, "");
    for (const pref of [
      "aiProvider",
      "llmModel",
      "catalogCache",
      "openrouterCatalogCache",
      "customBaseUrl",
      "customModel",
    ])
      clearPref(pref);
  });

  it("shows the stored key and saves typed keys to the login manager, not preferences", async function () {
    win = await openPane();
    assert.equal(el(win, "cail-apikey").value, "sk-cail-pane-dummy");
    assert.equal(el(win, "apikey").value, "");
    const input = el(win, "apikey");
    input.focus();
    input.value = "sk-or-pane-dummy";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(
      await until(() => storedKey("openrouterApiKey")),
      "sk-or-pane-dummy",
    );
    assert.equal(api().getApiKey("openrouterApiKey"), "sk-or-pane-dummy");
    assert.equal(getPref("openrouterApiKey"), "");
    assert.notInclude(
      String(Zotero.Prefs.get(`${config.prefsPrefix}.cailApiKey`, true)),
      "sk-",
    );
  });

  it("keeps a key typed just before the window is closed", async function () {
    win = await openPane();
    const input = el(win, "googlebooks-apikey");
    assert.ok(input, "Google Books key field exists");
    input.value = "AIza-pane-dummy";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    await closed(win); // before the save delay or a change event
    win = undefined;
    // Saved by the unload flush, well before the typing debounce would fire.
    assert.equal(
      await until(() => storedKey("googleBooksApiKey"), 250),
      "AIza-pane-dummy",
    );
  });

  it("builds the model menu from the Gateway catalog and saves a choice", async function () {
    win = await openPane();
    const menu = el(win, "llmmodel");
    const values = () =>
      Array.from(menu.menupopup.children as ArrayLike<any>).map((m) =>
        m.getAttribute("value"),
      );
    // Recommended text models plus the built-in DeepSeek pair, in catalog
    // order; image models and unrecommended extras are left out.
    assert.deepEqual(values(), [
      "deepseek-v4.1-flash-1017",
      "glm-5.3",
      "gpt-oss-120b",
      "deepseek-v4-pro-0813",
    ]);
    assert.equal(menu.value, "deepseek-v4.1-flash-1017");
    menu.value = "glm-5.3";
    menu.dispatchEvent(new win.Event("command", { bubbles: true }));
    assert.equal(getPref("llmModel"), "glm-5.3");
  });

  it("switches the menu to the OpenRouter models when the provider changes", async function () {
    win = await openPane();
    const provider = el(win, "provider");
    provider.value = "openrouter";
    provider.dispatchEvent(new win.Event("command", { bubbles: true }));
    const menu = el(win, "llmmodel");
    const values = Array.from(menu.menupopup.children as ArrayLike<any>).map(
      (m) => m.getAttribute("value"),
    );
    assert.deepEqual(values, [
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-pro",
    ]);
    assert.equal(menu.value, "deepseek/deepseek-v4.1-flash");
    setPref("aiProvider", "cail");
  });

  it("shows the custom endpoint fields and flags a remote http URL", async function () {
    win = await openPane();
    const doc = win.document;
    const section = doc.getElementById("metadata-custom-endpoint") as any;
    const modelRow = doc.getElementById("metadata-model-row") as any;
    assert.isTrue(section.hidden);
    const provider = el(win, "provider");
    provider.value = "custom";
    provider.dispatchEvent(new win.Event("command", { bubbles: true }));
    assert.isFalse(section.hidden);
    assert.isTrue(modelRow.hidden);
    const base = el(win, "custom-baseurl");
    base.value = "http://api.example.com/v1";
    base.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.match(
      doc.getElementById("metadata-custom-status")!.textContent!,
      /https/,
    );
    provider.value = "cail";
    provider.dispatchEvent(new win.Event("command", { bubbles: true }));
    assert.isTrue(section.hidden);
    assert.isFalse(modelRow.hidden);
    setPref("aiProvider", "cail");
  });
});
