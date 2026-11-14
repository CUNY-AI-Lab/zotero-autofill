import { getPref } from "../utils/prefs";
import { getApiKey, migrateKeysFromPrefs } from "../utils/keystore";
import { testCailBaseUrl } from "../utils/testHooks";

export type LLMProvider = "openrouter" | "cail" | "custom";

export interface ProviderConfig {
  id: LLMProvider;
  label: string;
  baseUrl: string;
  keyPreference: "openrouterApiKey" | "cailApiKey" | "customApiKey";
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
  custom: {
    id: "custom",
    label: "Custom endpoint",
    // Read from the customBaseUrl preference; see getCustomEndpoint().
    baseUrl: "",
    keyPreference: "customApiKey",
    keyHelpUrl: "",
  },
};

export function getConfiguredProvider(requested?: string): LLMProvider {
  const configured = requested || (getPref("aiProvider") as string);
  if (configured === "cail" || configured === "custom") return configured;
  return "openrouter";
}

export function getProviderConfig(requested?: string): ProviderConfig {
  return PROVIDERS[getConfiguredProvider(requested)];
}

export function getProviderKey(requested?: string): string {
  const config = getProviderConfig(requested);
  return getApiKey(config.keyPreference);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalize and check a custom OpenAI-compatible base URL. Accepts the base
 * (`https://api.openai.com/v1`) or a pasted full `/chat/completions` URL.
 * Plain http is allowed only for servers on this computer (Ollama, LM Studio),
 * so a key is never sent unencrypted over the network.
 */
export function parseCustomBaseUrl(raw: string): {
  baseUrl?: string;
  error?: string;
} {
  const trimmed = (raw || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");
  if (!trimmed) return { error: "Enter the endpoint's base URL." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      error: `"${trimmed}" is not a valid URL. Example: https://api.openai.com/v1`,
    };
  }
  if (url.username || url.password)
    return {
      error:
        "Put the API key in the key field, not in the URL, so it is stored securely.",
    };
  if (url.search || url.hash)
    return { error: "The base URL must not contain ? or # parts." };
  if (url.protocol === "https:") return { baseUrl: trimmed };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    return { baseUrl: trimmed };
  if (url.protocol === "http:")
    return {
      error:
        "Use https:// for remote endpoints. Plain http:// is allowed only for localhost.",
    };
  return { error: "The base URL must start with https://." };
}

export function getCustomModel(): string {
  return ((getPref("customModel") as string) || "").trim();
}

/** The custom endpoint's base URL and model, or why it cannot be used yet. */
export function getCustomEndpoint(): {
  baseUrl?: string;
  model: string;
  error?: string;
} {
  const { baseUrl, error } = parseCustomBaseUrl(
    getPref("customBaseUrl") as string,
  );
  const model = getCustomModel();
  if (error) return { model, error };
  if (!model)
    return {
      baseUrl,
      model,
      error: "Enter the model ID the endpoint expects.",
    };
  return { baseUrl, model };
}

/**
 * Whether AI requests can be sent. Hosted providers need a key; a custom
 * endpoint needs a valid base URL and model, and its key is optional because
 * local servers usually need none.
 */
export function isProviderReady(requested?: string): boolean {
  const provider = getConfiguredProvider(requested);
  if (provider === "custom") return !getCustomEndpoint().error;
  return getProviderKey(provider).length > 0;
}

/** The CAIL base URL can be pointed at a local stub in test builds only (see testHooks.ts). */
function getBaseUrl(config: ProviderConfig): string {
  if (config.id === "custom") return getCustomEndpoint().baseUrl ?? "";
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
  if (config.id === "custom") {
    const { error } = getCustomEndpoint();
    return `The custom AI endpoint is not set up. ${error ?? ""} Check it in Zotero Settings → Metadata Assistant.`
      .replace(/\s+/g, " ")
      .trim();
  }
  return `${config.label} API key is missing. Add a key in Zotero Settings → Metadata Assistant: ${config.keyHelpUrl}`;
}

/** Model IDs that are clearly not chat models (embeddings, speech, images). */
const NON_CHAT_MODEL =
  /embed|whisper|tts|dall-e|moderation|transcribe|realtime|image|audio|rerank/i;

/**
 * Model IDs from the custom endpoint's OpenAI-style `GET /models` list,
 * sorted and without obvious non-chat models. Not every server offers this
 * list; the model ID field can always be typed instead.
 */
export async function listCustomModels(): Promise<{
  models?: string[];
  error?: string;
}> {
  const { baseUrl, error } = parseCustomBaseUrl(
    getPref("customBaseUrl") as string,
  );
  if (!baseUrl) return { error };
  await migrateKeysFromPrefs();
  const apiKey = getProviderKey("custom");
  try {
    const response = await Zotero.HTTP.request("GET", `${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      responseType: "json",
      timeout: 15000,
      errorDelayMax: 0,
      noRetryOnThrottle: true,
    } as any);
    const body = response.response as any;
    const list: any[] = Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : [];
    const ids = list
      .map((m) => (typeof m === "string" ? m : (m?.id ?? m?.name)))
      .filter((id): id is string => typeof id === "string" && !!id.trim())
      .map((id) => id.trim())
      .filter((id) => !NON_CHAT_MODEL.test(id));
    const models = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    if (!models.length)
      return {
        error:
          "The endpoint returned no chat models. Type the model ID instead.",
      };
    return { models };
  } catch (e: any) {
    const status = e?.status ?? e?.xmlhttp?.status;
    if (status === 401 || status === 403)
      return { error: "The endpoint rejected the API key." };
    if (status === 404)
      return {
        error:
          "This endpoint does not list its models. Type the model ID instead.",
      };
    return {
      error: `Could not load models${status ? ` (HTTP ${status})` : ""}. Type the model ID instead.`,
    };
  }
}
