import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { getApiKey, setApiKey } from "./utils/keystore";
import { enrichItems, noSuggestionMessage } from "./modules/enrichment";
import {
  callOpenRouter,
  ensureCatalogAndModel,
  parseBibliographyWithLLM,
  resetCatalogCache,
} from "./modules/llmClient";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production" | "test";
    initialized?: boolean;
    /** Test-only overrides, read only in test builds; see utils/testHooks.ts. */
    testBaseUrl?: string;
    testLookupBaseUrl?: string;
    /** Settles when the settings pane last opened has finished wiring. */
    prefsPaneReady?: Promise<void>;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    // Test builds expose the LLM client so integration tests drive the real bundle.
    this.api =
      __env__ === "test"
        ? {
            callOpenRouter,
            ensureCatalogAndModel,
            parseBibliographyWithLLM,
            resetCatalogCache,
            setApiKey,
            getApiKey,
            enrichItems,
            noSuggestionMessage,
          }
        : {};
  }
}

export default Addon;
