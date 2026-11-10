import { getPref } from "../utils/prefs";
import { getApiKey } from "../utils/keystore";
import { testCailBaseUrl } from "../utils/testHooks";

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

/** The CAIL base URL can be pointed at a local stub in test builds only (see testHooks.ts). */
function getBaseUrl(config: ProviderConfig): string {
  return (config.id === "cail" && testCailBaseUrl()) || config.baseUrl;
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
