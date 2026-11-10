/**
 * API keys live in the Firefox login manager (Services.logins), not in
 * plaintext preferences.
 *
 * Gecko changed this API across the Zotero versions we support (115 to 153):
 * the synchronous findLogins/addLogin/modifyLogin/removeLogin were removed in
 * stages, so every call goes through feature detection that prefers the async
 * method and falls back to the sync one.
 *
 * Reads are served from an in-memory cache filled by `migrateKeysFromPrefs()`
 * (run at startup and before AI calls) so the rest of the plugin stays sync.
 *
 * Failure policy when the login manager is unusable (locked, cancelled master
 * password, missing backend): keys the user enters are kept in memory for the
 * session only and are never written to preferences; a key saved by an earlier
 * version in a plaintext preference is left in place, stays usable, and is
 * migrated once the store works. A user's key is never deleted before it is
 * safely stored.
 */

import { getPref, setPref } from "./prefs";

function log(message: string) {
  if (typeof ztoolkit !== "undefined") ztoolkit.log(message);
}

export type KeyName = "cailApiKey" | "openrouterApiKey";
const KEY_NAMES: KeyName[] = ["cailApiKey", "openrouterApiKey"];

export const KEYSTORE_ORIGIN = "chrome://zotero-metadata-assistant";
export const KEYSTORE_REALM = "Zotero Metadata Assistant API key";

export const KEYSTORE_UNAVAILABLE_MESSAGE =
  "Zotero's saved-password store (Firefox login manager) is unavailable, so API keys cannot be saved securely. " +
  "Keys you enter now are kept for this session only and are not written to preferences. " +
  "If you use a master password, unlock it and restart Zotero.";

/** Name and message of the underlying error. Never contains key material. */
export function sanitizeCause(error: unknown): {
  name: string;
  message: string;
} {
  const e = error as { name?: unknown; message?: unknown } | undefined;
  return {
    name: String(e?.name ?? typeof error).slice(0, 80),
    message: String(e?.message ?? error).slice(0, 200),
  };
}

export class KeyStoreError extends Error {
  declare cause: { name: string; message: string };
  constructor(cause: unknown) {
    super(KEYSTORE_UNAVAILABLE_MESSAGE);
    this.name = "KeyStoreError";
    this.cause = sanitizeCause(cause);
  }
}

const cache = new Map<KeyName, string>();
let loaded = false;
let lastAttempt = 0;
let problem: KeyStoreError | undefined;
let noticeShown = false;
const RETRY_AFTER_MS = 60 * 1000;
/** A hung login manager (e.g. an unanswered master-password prompt) must not hang callers. */
export const KEYSTORE_TIMEOUT_MS = 20 * 1000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Login manager did not respond")),
        KEYSTORE_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Reason the store could not be used, if the last attempt failed. */
export function getKeyStoreProblem(): KeyStoreError | undefined {
  return problem;
}

/** Show the unavailable-store message once per session, without blocking. */
function noticeOnce() {
  if (noticeShown) return;
  noticeShown = true;
  try {
    new ztoolkit.ProgressWindow("Metadata Assistant")
      .createLine({ text: KEYSTORE_UNAVAILABLE_MESSAGE, type: "default" })
      .show();
  } catch (error) {
    log(`Key store notice failed: ${error}`);
  }
}

/** Test hook: forget session state. */
export function resetKeyStoreState() {
  cache.clear();
  loaded = false;
  lastAttempt = 0;
  problem = undefined;
  noticeShown = false;
}

// ---- login manager access (feature-detected) ----

function manager(): any {
  const m = (globalThis as any).Services?.logins;
  if (!m) throw new Error("Services.logins is unavailable");
  return m;
}

async function ready(m: any) {
  if (m.initializationPromise) await m.initializationPromise;
}

async function findAll(m: any): Promise<any[]> {
  const found =
    typeof m.searchLoginsAsync === "function"
      ? await m.searchLoginsAsync({
          origin: KEYSTORE_ORIGIN,
          httpRealm: KEYSTORE_REALM,
        })
      : m.findLogins(KEYSTORE_ORIGIN, null, KEYSTORE_REALM);
  return Array.from(found as ArrayLike<any>);
}

/** Call the async variant when it exists, else the sync one. */
async function call(m: any, base: string, ...args: any[]) {
  const fn =
    typeof m[`${base}Async`] === "function" ? m[`${base}Async`] : m[base];
  return fn.apply(m, args);
}

async function readFromStore(name: KeyName): Promise<string> {
  const m = manager();
  await ready(m);
  const login = (await findAll(m)).find((l) => l.username === name);
  return (login?.password as string | undefined)?.trim() ?? "";
}

async function writeToStore(name: KeyName, value: string) {
  const m = manager();
  await ready(m);
  const existing = (await findAll(m)).find((l) => l.username === name);
  if (!value) {
    if (existing) await call(m, "removeLogin", existing);
    return;
  }
  const LoginInfo = (globalThis as any).Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    (globalThis as any).Ci.nsILoginInfo,
    "init",
  );
  const login = new LoginInfo(
    KEYSTORE_ORIGIN,
    null,
    KEYSTORE_REALM,
    name,
    value,
    "",
    "",
  );
  if (existing) await call(m, "modifyLogin", existing, login);
  else await call(m, "addLogin", login);
}

function legacyPref(name: KeyName): string {
  return ((getPref(name) as string | undefined) ?? "").trim();
}

function clearLegacyPref(name: KeyName) {
  try {
    setPref(name, "");
  } catch (error) {
    log(`Could not clear the old ${name} preference: ${error}`);
  }
}

/**
 * Load keys from the login manager into the session cache and move any key
 * still sitting in the old plaintext preferences into the store. Never
 * throws. If the store fails the problem is recorded (see getKeyStoreProblem),
 * shown once, and retried at most once a minute; old preference keys stay put.
 */
export async function migrateKeysFromPrefs(): Promise<void> {
  const pending = KEY_NAMES.some((name) => legacyPref(name));
  if (loaded && !pending) return;
  if (!loaded && Date.now() - lastAttempt < RETRY_AFTER_MS && problem) return;
  lastAttempt = Date.now();
  try {
    for (const name of KEY_NAMES) {
      const stored = await withTimeout(readFromStore(name));
      const legacy = legacyPref(name);
      if (stored) {
        // Don't clobber a key the user just typed this session.
        if (!cache.has(name)) cache.set(name, stored);
        if (legacy) clearLegacyPref(name);
      } else if (legacy) {
        await withTimeout(writeToStore(name, legacy));
        if (!cache.has(name)) cache.set(name, legacy);
        clearLegacyPref(name);
      }
    }
    loaded = true;
    problem = undefined;
  } catch (error) {
    problem = new KeyStoreError(error);
    log(
      `Key store unavailable: ${problem.cause.name}: ${problem.cause.message}`,
    );
    noticeOnce();
  }
}

/**
 * The key in use right now: this session's cache, else the store's value,
 * else a not-yet-migrated plaintext preference. Synchronous.
 */
export function getApiKey(name: KeyName): string {
  return cache.get(name) ?? legacyPref(name);
}

/**
 * Save a key. It is cached for the session first, so it works even if the
 * store fails; `persisted` says whether the login manager has it.
 */
export async function setApiKey(
  name: KeyName,
  value: string,
): Promise<{ persisted: boolean; error?: KeyStoreError }> {
  const trimmed = value.trim();
  if (trimmed) cache.set(name, trimmed);
  else cache.delete(name);
  try {
    await withTimeout(writeToStore(name, trimmed));
    clearLegacyPref(name);
    problem = undefined;
    return { persisted: true };
  } catch (error) {
    problem = new KeyStoreError(error);
    log(
      `Key store unavailable: ${problem.cause.name}: ${problem.cause.message}`,
    );
    noticeOnce();
    // An empty value must also stop an unmigrated old key from being used.
    if (!trimmed) cache.set(name, "");
    return { persisted: false, error: problem };
  }
}
