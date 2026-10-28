import type { Plugin } from "esbuild";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

// The toolkit registers deprecated zotero://plugin and zotero://ztoolkit-debug
// handlers, which let a link install add-ons or run code. The plugin uses
// neither, so the build ships inert stand-ins instead.
const withoutToolkitBridges: Plugin = {
  name: "without-toolkit-bridges",
  setup(build) {
    build.onResolve(
      { filter: /\/utils\/(debug|plugin)Bridge\.js$/ },
      ({ path, importer }) =>
        importer.includes("zotero-plugin-toolkit")
          ? { path, namespace: "toolkit-bridge" }
          : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "toolkit-bridge" }, ({ path }) => ({
      contents: `export class ${path.includes("debug") ? "DebugBridge" : "PluginBridge"} { static setModule() {} }`,
      loader: "js",
    }));
  },
};

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        plugins: [withoutToolkitBridges],
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
