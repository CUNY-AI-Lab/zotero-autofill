import { undoSelectedEnrichment } from "./modules/enrichmentReview";
import { EnrichmentFactory, isEnrichableItem } from "./modules/enrichment";
import { BibliographyImportFactory } from "./modules/bibliographyImport";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { migrateKeysFromPrefs } from "./utils/keystore";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Move any API key saved in plaintext preferences into the login manager.
  await migrateKeysFromPrefs().catch((error) => ztoolkit.log(error));

  // Register preference pane
  registerPrefs();

  // Register notifier for auto-enrich on import
  registerNotifier();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register right-click context menu
  registerContextMenu();

  // Register Tools menu item
  registerToolsMenu();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterNotifier();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// ==================== Registration Functions ====================

function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

let notifierID: string;

function registerNotifier() {
  const callback = {
    notify: async (
      event: string,
      type: string,
      ids: number[] | string[],
      _extraData: { [key: string]: any },
    ) => {
      if (!addon?.data.alive) {
        unregisterNotifier();
        return;
      }

      // Auto-enrich on item add if enabled
      if (event === "add" && type === "item") {
        const autoEnrich = Zotero.Prefs.get(
          `${addon.data.config.prefsPrefix}.autoEnrichOnImport`,
          true,
        );
        if (autoEnrich) {
          // Delay to let item settle
          await Zotero.Promise.delay(1000);
          if (addon.data.alive)
            await onItemsAdded(ids as number[]).catch((error) =>
              ztoolkit.log(error),
            );
        }
      }
    },
  };

  notifierID = Zotero.Notifier.registerObserver(callback, ["item"]);

  Zotero.Plugins.addObserver({
    shutdown: ({ id }) => {
      if (id === addon.data.config.addonID) {
        unregisterNotifier();
      }
    },
  });
}

function unregisterNotifier() {
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
  }
}

function registerContextMenu() {
  // Right-click menu on items: "Enrich Metadata from Online Sources"
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    label: getString("menu-enrich-metadata"),
    commandListener: () => {
      void EnrichmentFactory.enrichSelectedItems().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        ztoolkit.log(`Metadata enrichment command failed: ${message}`);
        Zotero.alert(
          Zotero.getMainWindow(),
          "CUNY AI Lab Metadata Assistant",
          `Metadata search failed: ${message}`,
        );
      });
    },
    icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

function registerToolsMenu() {
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: "Undo Metadata Changes…",
    commandListener: () => {
      void undoSelectedEnrichment();
    },
  });
  // Tools menu: "Import Bibliography Text..."
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: getString("menu-import-bibliography"),
    commandListener: () => {
      BibliographyImportFactory.openDialog();
    },
    icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

// ==================== Event Handlers ====================

async function onItemsAdded(ids: number[]) {
  const items = await Zotero.Items.getAsync(ids);
  const enrichable = items.filter(
    (item) =>
      item.isRegularItem() &&
      isEnrichableItem(item) &&
      !String(item.getField("extra")).includes(
        "CUNY AI Lab bibliography import",
      ),
  );

  if (enrichable.length === 0) return;

  ztoolkit.log(`Auto-enriching ${enrichable.length} new item(s)...`);

  // Import dynamically to avoid circular dependency
  const { enrichItems } = await import("./modules/enrichment");

  const stats = await enrichItems(enrichable);

  if (stats.found > 0) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: `${stats.found} item(s) have metadata suggestions to review`,
        type: "success",
      })
      .show();
  }
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
