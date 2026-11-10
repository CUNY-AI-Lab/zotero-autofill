/**
 * Guards for "look up metadata for new items automatically": a rolling cap on
 * how many items are auto-enriched per hour (each can trigger model calls), and
 * a test for items that arrive by sync rather than from the user.
 */

import { getPref } from "../utils/prefs";

export const AUTO_ENRICH_WINDOW_MS = 60 * 60 * 1000;
export const AUTO_ENRICH_DEFAULT_MAX = 20;

export function getAutoEnrichCap(): number {
  const cap = Number(getPref("autoEnrichMaxPerHour"));
  return Number.isInteger(cap) && cap >= 0 ? cap : AUTO_ENRICH_DEFAULT_MAX;
}

/**
 * Zotero sync saves items through a notifier queue created with
 * `skipAutoSync: true` (the same flag Zotero's own sync listener checks), and
 * each synced item carries `skipRenameFile`. Both mean "downloaded, not added
 * by the user".
 */
export function isSyncedAdd(
  ids: Array<number | string>,
  extraData: { [key: string]: any } | undefined,
): boolean {
  if (extraData?.skipAutoSync) return true;
  return (
    ids.length > 0 &&
    ids.every((id) => extraData?.[id]?.skipRenameFile === true)
  );
}

export function createAutoEnrichLimiter(
  getCap: () => number = getAutoEnrichCap,
  now: () => number = () => Date.now(),
) {
  let stamps: number[] = [];
  let noticeShown = false;
  return {
    /**
     * Ask to enrich `count` items. Returns how many may proceed and whether the
     * caller should show the (once per cap hit) notice.
     */
    take(count: number): { allowed: number; notify: boolean; cap: number } {
      const cap = getCap();
      const t = now();
      stamps = stamps.filter((s) => t - s < AUTO_ENRICH_WINDOW_MS);
      const room = Math.max(0, cap - stamps.length);
      const allowed = Math.min(count, room);
      for (let i = 0; i < allowed; i++) stamps.push(t);
      const capped = allowed < count;
      const notify = capped && !noticeShown;
      noticeShown = capped;
      return { allowed, notify, cap };
    },
  };
}
