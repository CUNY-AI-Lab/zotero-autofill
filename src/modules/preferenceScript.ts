import {
  OPEN_WEIGHT_MODELS,
  ensureCatalogAndModel,
  getCatalogModels,
  getConfiguredModel,
  resolveSavedCailModel,
} from "./llmClient";
import { getPref, setPref } from "../utils/prefs";
import {
  KEYSTORE_UNAVAILABLE_MESSAGE,
  getApiKey,
  getKeyStoreProblem,
  migrateKeysFromPrefs,
  setApiKey,
  type KeyName,
} from "../utils/keystore";

const id = (name: string) =>
  `zotero-prefpane-${addon.data.config.addonRef}-${name}`;

const OPEN_WEIGHT_LABELS: Record<string, string> = {
  "deepseek/deepseek-v4.1-flash":
    "DeepSeek V4.1 Flash — lower cost (Recommended)",
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro — higher quality",
};

/**
 * CAIL: the menu is the Gateway catalog (text-generation models, recommended
 * first). OpenRouter: the two built-in DeepSeek models. The selection is
 * written to the `llmModel` preference only when the user changes it.
 */
async function populateModelMenu(window: Window, provider: string) {
  const doc = window.document;
  const menu = doc.getElementById(id("llmmodel")) as any;
  if (!menu?.menupopup) return;
  const item = (value: string, label: string) => {
    const el = (doc as any).createXULElement("menuitem");
    el.setAttribute("value", value);
    el.setAttribute("label", label);
    return el;
  };
  let selected: string;
  if (provider === "openrouter") {
    menu.menupopup.replaceChildren(
      ...OPEN_WEIGHT_MODELS.map((m) => item(m, OPEN_WEIGHT_LABELS[m])),
    );
    selected = getConfiguredModel(undefined, "openrouter");
  } else {
    await ensureCatalogAndModel();
    const models = getCatalogModels();
    menu.menupopup.replaceChildren(
      ...models.map((m) =>
        item(m.id, m.recommended ? `${m.name} (Recommended)` : m.name),
      ),
    );
    selected =
      resolveSavedCailModel(getPref("llmModel") as string) || models[0].id;
  }
  menu.value = selected;
}

/** Key fields read and write the login manager, not preferences. */
async function wireKeyField(doc: Document, field: string, name: KeyName) {
  const input = doc.getElementById(id(field)) as HTMLInputElement | null;
  const status = doc.getElementById("metadata-key-status");
  if (!input) return;
  const show = (message: string) => {
    if (status) status.textContent = message;
  };
  await migrateKeysFromPrefs();
  input.value = getApiKey(name);
  if (getKeyStoreProblem()) show(KEYSTORE_UNAVAILABLE_MESSAGE);
  input.addEventListener("change", () => {
    setApiKey(name, input.value).then((result) =>
      show(result.persisted ? "" : KEYSTORE_UNAVAILABLE_MESSAGE),
    );
  });
}

export async function registerPrefsScripts(_window: Window): Promise<void> {
  const doc = _window.document;
  await wireKeyField(doc, "cail-apikey", "cailApiKey");
  await wireKeyField(doc, "apikey", "openrouterApiKey");
  doc.getElementById("metadata-privacy")?.setAttribute("role", "note");
  const menu = doc.getElementById(id("llmmodel"));
  menu?.addEventListener("command", () => {
    const value = (menu as any).value;
    if (value) setPref("llmModel", value);
  });
  const providerMenu = doc.getElementById(id("provider")) as any;
  providerMenu?.addEventListener(
    "command",
    () => void populateModelMenu(_window, providerMenu.value),
  );
  await populateModelMenu(_window, getPref("aiProvider") as string);
}
