// Default preferences for Zotero Metadata Assistant
pref("extensions.zotero.metadata-assistant.openrouterApiKey", "");
pref("extensions.zotero.metadata-assistant.cailApiKey", "");
pref("extensions.zotero.metadata-assistant.aiProvider", "cail");
// Custom OpenAI-compatible endpoint (its API key lives in the login manager)
pref("extensions.zotero.metadata-assistant.customBaseUrl", "");
pref("extensions.zotero.metadata-assistant.customModel", "");
pref("extensions.zotero.metadata-assistant.autoEnrichOnImport", false);
pref(
  "extensions.zotero.metadata-assistant.llmModel",
  "deepseek/deepseek-v4.1-flash",
);
pref("extensions.zotero.metadata-assistant.enrichPreIsbn", true);
pref("extensions.zotero.metadata-assistant.apiDelayMs", 1100);
// Hidden: cached CAIL model catalog (JSON with fetch timestamp)
pref("extensions.zotero.metadata-assistant.catalogCache", "");
// Hidden: cap on items auto-enriched per hour
pref("extensions.zotero.metadata-assistant.autoEnrichMaxPerHour", 20);
