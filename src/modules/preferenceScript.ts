import {
  DEFAULT_LLM_MODEL,
  OPEN_WEIGHT_MODELS,
  ensureCatalogAndModel,
  getConfiguredModel,
  getMenuModels,
  resolveSavedCailModel,
} from "./llmClient";
import { getPref, setPref } from "../utils/prefs";
import { listCustomModels, parseCustomBaseUrl } from "./provider";
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

/** Key fields, in pane order: element id suffix and login-manager name. */
const KEY_FIELDS: Array<[string, KeyName]> = [
  ["cail-apikey", "cailApiKey"],
  ["apikey", "openrouterApiKey"],
  ["custom-apikey", "customApiKey"],
  ["googlebooks-apikey", "googleBooksApiKey"],
];

/** How long typing must pause before a key is written to the login manager. */
export const KEY_SAVE_DELAY_MS = 400;

/**
 * Fill the model menu. CAIL: recommended Gateway models (plus the built-in
 * DeepSeek models and the saved one), shown at once from the cached catalog
 * and refreshed from the Gateway in the background. OpenRouter: the two
 * built-in DeepSeek models. The selection is written to `llmModel` only when
 * the user picks one.
 */
let menuGeneration = 0;
function fillModelMenu(doc: Document, provider: string) {
  const menu = doc.getElementById(id("llmmodel")) as any;
  if (!menu?.menupopup) return;
  const item = (value: string, label: string) => {
    const el = (doc as any).createXULElement("menuitem");
    el.setAttribute("value", value);
    el.setAttribute("label", label);
    return el;
  };
  if (provider === "openrouter") {
    menu.menupopup.replaceChildren(
      ...OPEN_WEIGHT_MODELS.map((m) => item(m, OPEN_WEIGHT_LABELS[m])),
    );
    menu.value = getConfiguredModel(undefined, "openrouter");
    return;
  }
  const saved = getPref("llmModel") as string;
  const selected = resolveSavedCailModel(saved);
  const models = getMenuModels(selected);
  menu.menupopup.replaceChildren(...models.map((m) => item(m.id, m.name)));
  menu.value =
    selected || resolveSavedCailModel(DEFAULT_LLM_MODEL) || models[0]?.id || "";
}

/** Show the custom endpoint fields, or the built-in model menu. */
function showProviderFields(doc: Document, provider: string) {
  const custom = provider === "custom";
  const toggle = (elementId: string, hidden: boolean) => {
    const el = doc.getElementById(elementId) as any;
    if (el) el.hidden = hidden;
  };
  toggle("metadata-custom-endpoint", !custom);
  toggle("metadata-model-row", custom);
}

/** Explain an unusable base URL as soon as it is typed. */
function showBaseUrlProblem(doc: Document) {
  const input = doc.getElementById(id("custom-baseurl")) as
    HTMLInputElement | undefined;
  const status = doc.getElementById("metadata-custom-status");
  if (!input || !status) return;
  status.textContent = input.value.trim()
    ? (parseCustomBaseUrl(input.value).error ?? "")
    : "";
}

/**
 * "Load models from endpoint": read the endpoint's model list into a menu;
 * picking one fills the model ID field, which stays editable.
 */
function wireCustomModels(doc: Document) {
  const button = doc.getElementById(id("custom-load-models")) as any;
  const menu = doc.getElementById(id("custom-models")) as any;
  const modelInput = doc.getElementById(id("custom-model")) as
    HTMLInputElement | undefined;
  const baseInput = doc.getElementById(id("custom-baseurl")) as
    HTMLInputElement | undefined;
  const status = doc.getElementById("metadata-custom-status");
  const show = (message: string) => {
    if (status) status.textContent = message;
  };
  baseInput?.addEventListener("input", () => showBaseUrlProblem(doc));
  menu?.addEventListener("command", () => {
    const value = menu.value as string;
    if (!value || !modelInput) return;
    modelInput.value = value;
    setPref("customModel", value);
  });
  button?.addEventListener("command", async () => {
    // The base URL field saves on change; make sure the typed value is used.
    if (baseInput) setPref("customBaseUrl", baseInput.value.trim());
    button.disabled = true;
    show("Loading models…");
    try {
      const { models, error } = await listCustomModels();
      if (!models) {
        show(error ?? "Could not load models.");
        return;
      }
      const items = models.map((m) => {
        const el = (doc as any).createXULElement("menuitem");
        el.setAttribute("value", m);
        el.setAttribute("label", m);
        return el;
      });
      menu.menupopup.replaceChildren(...items);
      menu.hidden = false;
      const current = modelInput?.value.trim() ?? "";
      if (current && models.includes(current)) menu.value = current;
      else menu.selectedIndex = -1;
      show(
        `${models.length} model${models.length === 1 ? "" : "s"} found. Pick one, or type an ID above.`,
      );
    } finally {
      button.disabled = false;
    }
  });
}

async function populateModelMenu(doc: Document, provider: string) {
  const generation = ++menuGeneration;
  showProviderFields(doc, provider);
  if (provider === "custom") return;
  fillModelMenu(doc, provider);
  if (provider === "openrouter") return;
  await ensureCatalogAndModel();
  // A later provider switch owns the menu now.
  if (generation === menuGeneration) fillModelMenu(doc, provider);
}

/**
 * Key fields read and write the login manager, not preferences. Listeners are
 * attached at once; the stored key is filled in by the returned `load` once
 * the store has answered, unless the user has already started typing.
 */
function wireKeyField(
  win: Window,
  field: string,
  name: KeyName,
  show: (message: string) => void,
): { load: () => void } {
  const input = win.document.getElementById(id(field)) as
    HTMLInputElement | undefined;
  if (!input) return { load: () => undefined };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();
  let savedValue = "";
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const value = input.value.trim();
    if (value === savedValue) return saving;
    savedValue = value;
    saving = setApiKey(name, value).then((result) =>
      show(result.persisted ? "" : KEYSTORE_UNAVAILABLE_MESSAGE),
    );
    return saving;
  };
  // Like Zotero's own preference binding: save while typing (debounced), on
  // change, and when the window closes before the field loses focus.
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, KEY_SAVE_DELAY_MS);
  });
  input.addEventListener("change", () => void save());
  win.addEventListener("unload", () => void save());
  return {
    load: () => {
      if (input.value || timer) return;
      input.value = getApiKey(name);
      savedValue = input.value.trim();
    },
  };
}

export async function registerPrefsScripts(_window: Window): Promise<void> {
  const doc = _window.document;
  const status = doc.getElementById("metadata-key-status");
  const show = (message: string) => {
    if (status) status.textContent = message;
  };
  doc.getElementById("metadata-privacy")?.setAttribute("role", "note");

  const menu = doc.getElementById(id("llmmodel"));
  menu?.addEventListener("command", () => {
    const value = (menu as any).value;
    if (value) setPref("llmModel", value);
  });
  const providerMenu = doc.getElementById(id("provider")) as any;
  providerMenu?.addEventListener(
    "command",
    () => void populateModelMenu(doc, providerMenu.value),
  );
  wireCustomModels(doc);
  showBaseUrlProblem(doc);
  const models = populateModelMenu(doc, getPref("aiProvider") as string);

  // Keys come from the login manager, which may be slow (or prompt for a
  // primary password); neither the menu nor typing waits for it.
  const fields = KEY_FIELDS.map(([field, name]) =>
    wireKeyField(_window, field, name, show),
  );
  await migrateKeysFromPrefs();
  for (const f of fields) f.load();
  if (getKeyStoreProblem()) show(KEYSTORE_UNAVAILABLE_MESSAGE);
  await models;
}
