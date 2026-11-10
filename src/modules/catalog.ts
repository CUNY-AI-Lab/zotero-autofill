/**
 * Runtime model catalog for the CAIL Gateway.
 *
 * `GET /v1/catalog` is public (no key). We fetch it with a 30 s timeout, keep it
 * in memory for the session, persist it with a timestamp, and refresh at most
 * once a day. The two built-in DeepSeek models are the offline fallback.
 */

import { getPref, setPref } from "../utils/prefs";
import { getCatalogUrl } from "./provider";

export interface CatalogModel {
  id: string;
  name: string;
  order: number;
  recommended: boolean;
  reasoning: boolean;
}

interface CatalogCache {
  fetchedAt: number;
  models: CatalogModel[];
}

export const CATALOG_TIMEOUT_MS = 30000;
export const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

/** Offline fallback: the two models the plugin has always offered. */
export const FALLBACK_CAIL_MODELS: CatalogModel[] = [
  {
    id: "deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash",
    order: 1,
    recommended: true,
    reasoning: true,
  },
  {
    id: "deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro",
    order: 10,
    recommended: false,
    reasoning: true,
  },
];

let memory: CatalogCache | undefined;
let lastFailure = 0;
let inflight: Promise<void> | undefined;

/** Text-generation rows, recommended first, then by `order`. */
export function parseCatalog(body: any): CatalogModel[] {
  if (!body || !Array.isArray(body.data)) return [];
  const models: CatalogModel[] = [];
  for (const row of body.data) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      !Array.isArray(row.capabilities) ||
      !row.capabilities.includes("text-generation") ||
      (row.status !== undefined && row.status !== "active")
    )
      continue;
    models.push({
      id: row.id,
      name: typeof row.name === "string" && row.name ? row.name : row.id,
      order: typeof row.order === "number" ? row.order : 9999,
      recommended: row.recommended === true,
      reasoning: row.capabilities.includes("reasoning"),
    });
  }
  return models.sort(
    (a, b) =>
      Number(b.recommended) - Number(a.recommended) || a.order - b.order,
  );
}

function readPersisted(): CatalogCache | undefined {
  try {
    const parsed = JSON.parse((getPref("catalogCache") as string) || "");
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

function loaded(): CatalogCache | undefined {
  return (memory ??= readPersisted());
}

/** Synchronous view: session cache, then persisted cache, then the fallback. */
export function getCatalogModels(): CatalogModel[] {
  return loaded()?.models ?? FALLBACK_CAIL_MODELS;
}

/**
 * Models for the settings menu: the Gateway's recommended text models, the
 * two DeepSeek models the plugin has always offered, and the saved model.
 * The full catalog also lists classifiers, tiny LoRA demos and audio models
 * that cannot parse a bibliography, so they are left out unless saved.
 */
export function getMenuModels(saved?: string): CatalogModel[] {
  const builtIn = new Set(FALLBACK_CAIL_MODELS.map((m) => m.id));
  return getCatalogModels().filter(
    (m) => m.recommended || builtIn.has(m.id) || m.id === saved,
  );
}

export function hasLiveCatalog(): boolean {
  return Boolean(loaded());
}

export function isReasoningModel(cailModelId: string): boolean {
  return getCatalogModels().some((m) => m.id === cailModelId && m.reasoning);
}

/** Test hook: forget the session cache. */
export function resetCatalogCache() {
  memory = undefined;
  lastFailure = 0;
  inflight = undefined;
}

async function fetchCatalog(): Promise<void> {
  const response = await Zotero.HTTP.request("GET", getCatalogUrl(), {
    timeout: CATALOG_TIMEOUT_MS,
    responseType: "json",
    errorDelayMax: 0,
    noRetryOnThrottle: true,
    headers: { Accept: "application/json" },
  } as any);
  const models = parseCatalog(response.response);
  if (!models.length) throw new Error("Catalog contained no text models");
  memory = { fetchedAt: Date.now(), models };
  setPref("catalogCache", JSON.stringify(memory));
}

/**
 * Refresh when the cache is missing or older than a day. Never throws: on
 * failure the previous cache (or the fallback) stays in effect.
 */
export function refreshCatalog(force = false): Promise<void> {
  const cache = loaded();
  if (
    !force &&
    cache &&
    Date.now() - cache.fetchedAt < CATALOG_REFRESH_MS &&
    cache.fetchedAt <= Date.now()
  )
    return Promise.resolve();
  if (!force && Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS)
    return Promise.resolve();
  inflight ??= fetchCatalog()
    .catch((error) => {
      lastFailure = Date.now();
      ztoolkit.log(`Model catalog refresh failed: ${error}`);
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
