import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// API keys live in the login manager; give unit tests an in-memory one.
const fakeLogins = [];
globalThis.__fakeLogins = fakeLogins;
const replace = (old, login) =>
  fakeLogins.splice(fakeLogins.indexOf(old), 1, login);
const remove = (login) => fakeLogins.splice(fakeLogins.indexOf(login), 1);
// Modern Gecko: async only. keystore.test.mjs also exercises the old sync-only API.
globalThis.Services ??= {
  logins: {
    initializationPromise: Promise.resolve(),
    searchLoginsAsync: async () => [...fakeLogins],
    addLoginAsync: async (login) => {
      fakeLogins.push(login);
    },
    modifyLoginAsync: async (old, login) => replace(old, login),
    removeLoginAsync: async (login) => remove(login),
  },
};
globalThis.__legacySyncLogins = {
  findLogins: () => [...fakeLogins],
  addLogin: (login) => fakeLogins.push(login),
  modifyLogin: replace,
  removeLogin: remove,
};
globalThis.Ci ??= { nsILoginInfo: {} };
globalThis.Components ??= {
  Constructor: () =>
    class {
      constructor(origin, form, realm, username, password) {
        Object.assign(this, { origin, form, realm, username, password });
      }
    },
};
export async function loadModule(entry) {
  const dir = await mkdtemp(join(tmpdir(), "metadata-tests-"));
  const outfile = join(dir, "module.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    define: { __env__: '"production"' },
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}
