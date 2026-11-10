import { getPref } from "../utils/prefs";
import { getApiKey } from "../utils/keystore";
import { config as pluginConfig } from "../../package.json";

export type LLMProvider = "openrouter" | "cail";

export interface ProviderConfig {
  id: LLMProvider;
  label: string;
  baseUrl: string;
  keyPreference: "openrouterApiKey" | "cailApiKey";
  keyHelpUrl: string;
}

const PROVIDERS: Record<LLMProvider, ProviderConfig> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPreference: "openrouterApiKey",
    keyHelpUrl: "https://openrouter.ai/settings/keys",
  },
  cail: {
    id: "cail",
    label: "CUNY AI Lab Gateway",
    baseUrl: "https://tools.ailab.gc.cuny.edu/v1",
    keyPreference: "cailApiKey",
    keyHelpUrl: "https://ailab.gc.cuny.edu/docs/api-keys/",
  },
};

export function getConfiguredProvider(requested?: string): LLMProvider {
  const configured = requested || (getPref("aiProvider") as string);
  return configured === "cail" ? "cail" : "openrouter";
}

export function getProviderConfig(requested?: string): ProviderConfig {
  return PROVIDERS[getConfiguredProvider(requested)];
}

export function getProviderKey(requested?: string): string {
  const config = getProviderConfig(requested);
  return getApiKey(config.keyPreference);
}

/**
 * Integration tests point the CAIL provider at a local stub through
 * `Zotero[addonInstance].data.testBaseUrl`. It is honored only in builds made
 * by `npm test` (`__env__ === "test"`), and no preference or UI can set it.
 */
function getBaseUrl(config: ProviderConfig): string {
  if (config.id === "cail" && __env__ === "test") {
    const instance = (Zotero as any)[pluginConfig.addonInstance];
    if (instance?.data?.testBaseUrl) return instance.data.testBaseUrl;
  }
  return config.baseUrl;
}

export function getChatCompletionsUrl(requested?: string): string {
  return `${getBaseUrl(getProviderConfig(requested))}/chat/completions`;
}

export function getCatalogUrl(): string {
  return `${getBaseUrl(PROVIDERS.cail)}/catalog`;
}

export function getMissingProviderKeyMessage(requested?: string): string {
  const config = getProviderConfig(requested);
  return `${config.label} API key is missing. Add a key in Zotero Settings → Metadata Assistant: ${config.keyHelpUrl}`;
}
