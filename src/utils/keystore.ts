/**
 * API keys live in the Firefox login manager (Services.logins), not in
 * plaintext preferences. Keys saved by earlier versions in the old
 * preferences are moved into the store (see migrateKeysFromPrefs) and the preference is
 * cleared. If the store cannot be used (for example a locked or cancelled
 * master password) we throw rather than falling back to preferences.
 */

import { getPref, setPref } from "./prefs";

function log(message: string) {
  if (typeof ztoolkit !== "undefined") ztoolkit.log(message);
}

export type KeyName = "cailApiKey" | "openrouterApiKey";

export const KEYSTORE_ORIGIN = "chrome://zotero-metadata-assistant";
export const KEYSTORE_REALM = "Zotero Metadata Assistant API key";

export const KEYSTORE_UNAVAILABLE_MESSAGE =
  "Could not use the saved-password store (Firefox login manager) for the API key. " +
  "Unlock it (master password) and try again. The key was not read from or saved to preferences.";

export class KeyStoreError extends Error {
  constructor(cause?: unknown) {
    super(KEYSTORE_UNAVAILABLE_MESSAGE, cause ? { cause } : undefined);
    this.name = "KeyStoreError";
    if (cause) log(`Key store error: ${cause}`);
  }
}

function logins(): any {
  const manager = (globalThis as any).Services?.logins;
  if (!manager) throw new KeyStoreError("Services.logins is unavailable");
  return manager;
}

function find(name: KeyName): any {
  return logins()
    .findLogins(KEYSTORE_ORIGIN, null, KEYSTORE_REALM)
    .find((login: any) => login.username === name);
}

async function writeLogin(name: KeyName, value: string) {
  const existing = find(name);
  if (!value) {
    if (existing) logins().removeLogin(existing);
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
  if (existing) logins().modifyLogin(existing, login);
  // Zotero 10 (Firefox 140) only has the async add.
  else await logins().addLoginAsync(login);
}

/** The key is safe in the store by now; a failure to clear the old pref is only logged. */
function clearLegacyPref(name: KeyName) {
  try {
    setPref(name, "");
  } catch (error) {
    log(`Could not clear the old ${name} preference: ${error}`);
  }
}

const asKeyStoreError = (error: unknown) =>
  error instanceof KeyStoreError ? error : new KeyStoreError(error);

/**
 * Move keys saved by earlier versions in plaintext preferences into the login
 * store and clear the preferences. Run at startup and before each AI call.
 */
export async function migrateKeysFromPrefs(): Promise<void> {
  for (const name of ["cailApiKey", "openrouterApiKey"] as const) {
    const legacy = (getPref(name) as string | undefined)?.trim();
    if (!legacy) continue;
    try {
      if (!find(name)) await writeLogin(name, legacy);
    } catch (error) {
      throw asKeyStoreError(error);
    }
    clearLegacyPref(name);
  }
}

/** True while an old plaintext key still waits to be moved into the store. */
export function hasLegacyKeyPref(name: KeyName): boolean {
  return Boolean((getPref(name) as string | undefined)?.trim());
}

export function getApiKey(name: KeyName): string {
  try {
    return (find(name)?.password as string | undefined)?.trim() ?? "";
  } catch (error) {
    throw asKeyStoreError(error);
  }
}

export async function setApiKey(name: KeyName, value: string): Promise<void> {
  try {
    await writeLogin(name, value.trim());
  } catch (error) {
    throw asKeyStoreError(error);
  }
  clearLegacyPref(name);
}
