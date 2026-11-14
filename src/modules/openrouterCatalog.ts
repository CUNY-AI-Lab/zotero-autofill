/**
 * Live OpenRouter model list, limited to open-weight families.
 *
 * `GET https://openrouter.ai/api/v1/models` is public (no key). Like the CAIL
 * catalog it is cached in memory and in a preference and refreshed at most
 * once a day; the two built-in DeepSeek models are the offline fallback.
 *
 * A model is offered when it belongs to one of FAMILIES, has a Hugging Face
 * ID (OpenRouter's marker for downloadable weights), accepts
 * `response_format` (the plugin needs JSON replies), takes at least 32k
 * tokens of context, and is not a `:free`/`:nitro`-style variant or a
 * specialist (safety classifier, vision preview, code) model. The newest
 * PER_FAMILY models of each family are kept.
 */

import { getPref, setPref } from "../utils/prefs";
import { testOpenRouterCatalogUrl } from "../utils/testHooks";

export interface OpenRouterModel {
  id: string;
  name: string;
  family: string;
  created: number;
  /** USD per million input tokens, if listed. */
  promptPrice?: number;
}

interface Cache {
  fetchedAt: number;
  models: OpenRouterModel[];
}

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 30000;
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const MIN_CONTEXT = 32000;
/** Specialist variants that are poor at bibliography parsing. */
const SPECIALIST = /guard|vision|-vl\b|\bvl\b|\bexp\b|-exp\b|coder|\bcode\b/i;
export const PER_FAMILY = 3;

/** Open-weight families, in menu order: [label, ID prefix]. */
export const FAMILIES: Array<[string, string]> = [
  ["DeepSeek", "deepseek/"],
  ["Qwen", "qwen/"],
  ["Kimi", "moonshotai/"],
  ["GLM", "z-ai/"],
  ["gpt-oss", "openai/gpt-oss"],
  ["Llama", "meta-llama/"],
  ["Mistral", "mistralai/"],
  ["Gemma", "google/gemma"],
];

/** Offline fallback: the two models the plugin has always offered. */
export const FALLBACK_OPENROUTER_MODELS: OpenRouterModel[] = [
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash — lower cost (Recommended)",
    family: "DeepSeek",
    created: 0,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro — higher quality",
    family: "DeepSeek",
    created: 0,
  },
];

let memory: Cache | undefined;
let lastFailure = 0;
let inflight: Promise<void> | undefined;

function familyOf(id: string): string | undefined {
  return FAMILIES.find(([, prefix]) => id.startsWith(prefix))?.[0];
}

/** Filter OpenRouter's `/models` body down to the menu's models. */
export function parseOpenRouterModels(body: any): OpenRouterModel[] {
  if (!body || !Array.isArray(body.data)) return [];
  const byFamily = new Map<string, OpenRouterModel[]>();
  for (const row of body.data) {
    const id = row?.id;
    if (typeof id !== "string" || !id || id.includes(":")) continue;
    const family = familyOf(id);
    if (!family) continue;
    if (SPECIALIST.test(id) || SPECIALIST.test(String(row.name ?? "")))
      continue;
    if (typeof row.hugging_face_id !== "string" || !row.hugging_face_id)
      continue;
    const params = Array.isArray(row.supported_parameters)
      ? row.supported_parameters
      : [];
    if (!params.includes("response_format")) continue;
    if (
      typeof row.context_length === "number" &&
      row.context_length < MIN_CONTEXT
    )
      continue;
    const outputs = row.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    const price = parseFloat(row.pricing?.prompt);
    const model: OpenRouterModel = {
      id,
      name: typeof row.name === "string" && row.name ? row.name : id,
      family,
      created: typeof row.created === "number" ? row.created : 0,
      promptPrice: Number.isFinite(price) ? price * 1e6 : undefined,
    };
    byFamily.set(family, [...(byFamily.get(family) ?? []), model]);
  }
  return FAMILIES.flatMap(([family]) =>
    (byFamily.get(family) ?? [])
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
      .slice(0, PER_FAMILY),
  );
}

function readPersisted(): Cache | undefined {
  try {
    const parsed = JSON.parse(
      (getPref("openrouterCatalogCache") as string) || "",
    );
    if (
      typeof parsed?.fetchedAt === "number" &&
      Array.isArray(parsed.models) &&
      parsed.models.length
    )
      return parsed;
  } catch {
    // no cache yet
  }
  return undefined;
}

function loaded(): Cache | undefined {
  return (memory ??= readPersisted());
}

/** Synchronous view: session cache, then persisted cache, then the fallback. */
export function getOpenRouterModels(): OpenRouterModel[] {
  return loaded()?.models ?? FALLBACK_OPENROUTER_MODELS;
}

/** Whether an ID can be sent to OpenRouter: listed now, or built in. */
export function isOfferedOpenRouterModel(id: string): boolean {
  return (
    getOpenRouterModels().some((m) => m.id === id) ||
    FALLBACK_OPENROUTER_MODELS.some((m) => m.id === id)
  );
}

/** Menu label: name and input price, e.g. "DeepSeek V4 Pro · $0.40/M in". */
export function openRouterLabel(model: OpenRouterModel): string {
  if (model.promptPrice === undefined) return model.name;
  const price =
    model.promptPrice === 0
      ? "free"
      : `$${model.promptPrice < 1 ? model.promptPrice.toFixed(2) : model.promptPrice.toFixed(1)}/M in`;
  return `${model.name} · ${price}`;
}

/**
 * Menu models: the live list, plus the built-in DeepSeek pair (placed after
 * the other DeepSeek models) and the saved model when the list lacks them.
 */
export function getOpenRouterMenuModels(saved?: string): OpenRouterModel[] {
  const models = [...getOpenRouterModels()];
  for (const fallback of FALLBACK_OPENROUTER_MODELS) {
    if (models.some((m) => m.id === fallback.id)) continue;
    const lastOfFamily = models.findLastIndex(
      (m) => m.family === fallback.family,
    );
    models.splice(lastOfFamily + 1, 0, fallback);
  }
  if (saved && !models.some((m) => m.id === saved)) {
    const family = familyOf(saved);
    if (family) models.push({ id: saved, name: saved, family, created: 0 });
  }
  return models;
}

/** Test hook: forget the session cache. */
export function resetOpenRouterCatalog() {
  memory = undefined;
  lastFailure = 0;
  inflight = undefined;
}

async function fetchModels(url: string): Promise<void> {
  const response = await Zotero.HTTP.request("GET", url, {
    timeout: TIMEOUT_MS,
    responseType: "json",
    errorDelayMax: 0,
    noRetryOnThrottle: true,
    headers: { Accept: "application/json" },
  } as any);
  const models = parseOpenRouterModels(response.response);
  if (!models.length) throw new Error("OpenRouter listed no usable models");
  memory = { fetchedAt: Date.now(), models };
  setPref("openrouterCatalogCache", JSON.stringify(memory));
}

/**
 * Refresh when the cache is missing or older than a day. Never throws: on
 * failure the previous cache (or the fallback) stays in effect.
 */
export function refreshOpenRouterCatalog(force = false): Promise<void> {
  const url = testOpenRouterCatalogUrl(OPENROUTER_MODELS_URL);
  if (!url) return Promise.resolve();
  const cache = loaded();
  if (
    !force &&
    cache &&
    Date.now() - cache.fetchedAt < REFRESH_MS &&
    cache.fetchedAt <= Date.now()
  )
    return Promise.resolve();
  if (!force && Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS)
    return Promise.resolve();
  inflight ??= fetchModels(url)
    .catch((error) => {
      lastFailure = Date.now();
      ztoolkit.log(`OpenRouter model list refresh failed: ${error}`);
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
