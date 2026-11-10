import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
