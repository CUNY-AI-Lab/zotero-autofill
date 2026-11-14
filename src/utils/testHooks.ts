import { config } from "../../package.json";

/**
 * Integration tests point network calls at a local stub by setting fields on
 * `Zotero[addonInstance].data`. These are read only in builds made by
 * `npm test` (`__env__ === "test"`); in any other build the condition is a
 * constant false, esbuild drops the body, and no preference or UI sets them.
 */
function testData(): Record<string, unknown> | undefined {
  if (__env__ !== "test") return undefined;
  return (Zotero as any)[config.addonInstance]?.data;
}

/** Test-only CAIL base URL, if set. */
export function testCailBaseUrl(): string | undefined {
  if (__env__ !== "test") return undefined;
  const value = testData()?.testBaseUrl;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * OpenRouter model-list URL to request. Test builds never reach the live API:
 * they use `data.testOpenRouterCatalogUrl` when set and otherwise skip the
 * fetch (undefined), leaving the built-in models in place.
 */
export function testOpenRouterCatalogUrl(url: string): string | undefined {
  if (__env__ !== "test") return url;
  const value = testData()?.testOpenRouterCatalogUrl;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Lookup URL to request: unchanged, except in test builds with
 * `data.testLookupBaseUrl` set, where `https://host/path` becomes
 * `<base>/host/path`.
 */
export function lookupUrl(url: string): string {
  if (__env__ !== "test") return url;
  const base = testData()?.testLookupBaseUrl;
  if (typeof base !== "string" || !base) return url;
  return url.replace(/^https:\/\//, `${base}/`);
}
