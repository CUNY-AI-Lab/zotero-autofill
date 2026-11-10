// Default preferences for Zotero Metadata Assistant
pref("extensions.zotero.metadata-assistant.openrouterApiKey", "");
pref("extensions.zotero.metadata-assistant.cailApiKey", "");
pref("extensions.zotero.metadata-assistant.aiProvider", "cail");
pref("extensions.zotero.metadata-assistant.autoEnrichOnImport", false);
pref(
  "extensions.zotero.metadata-assistant.llmModel",
  "deepseek/deepseek-v4.1-flash",
);
pref("extensions.zotero.metadata-assistant.enrichPreIsbn", true);
pref("extensions.zotero.metadata-assistant.apiDelayMs", 1100);
// Hidden: cached CAIL model catalog (JSON with fetch timestamp)
pref("extensions.zotero.metadata-assistant.catalogCache", "");
