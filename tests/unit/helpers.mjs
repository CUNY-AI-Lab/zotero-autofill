import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// API keys live in the login manager; give unit tests an in-memory one.
const fakeLogins = [];
globalThis.__fakeLogins = fakeLogins;
globalThis.Services ??= {
  logins: {
    findLogins: () => [...fakeLogins],
    addLoginAsync: async (login) => {
      fakeLogins.push(login);
    },
    modifyLogin: (old, login) =>
      fakeLogins.splice(fakeLogins.indexOf(old), 1, login),
    removeLogin: (login) => fakeLogins.splice(fakeLogins.indexOf(login), 1),
  },
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
