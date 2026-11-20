import { assert } from "chai";
import { config } from "../package.json";
import { clearPref, setPref } from "../src/utils/prefs";

// The right-click entry must be offered on every item type the plugin
// enriches (issue #35: reported missing on preprints).
describe("item context menu", function () {
  this.timeout(60000);
  const label = "Enrich Metadata from Online Sources";
  const created: Zotero.Item[] = [];

  before(function () {
    setPref("autoEnrichOnImport", false);
  });

  after(async function () {
    clearPref("autoEnrichOnImport");
    for (const item of created) await item.eraseTx();
  });

  for (const type of [
    "book",
    "journalArticle",
    "conferencePaper",
    "thesis",
    "report",
    "preprint",
  ]) {
    it(`offers Enrich Metadata on a ${type}`, async function () {
      const item = new Zotero.Item(type as "book");
      item.setField("title", `Menu test ${type}`);
      await item.saveTx();
      created.push(item);

      const win = Zotero.getMainWindow();
      await win.ZoteroPane.selectItem(item.id);
      await win.ZoteroPane.buildItemContextMenu();
      const menu = win.document.getElementById("zotero-itemmenu")!;
      const entries = Array.from(menu.children).filter(
        (el) => el.getAttribute("label") === label,
      );
      assert.lengthOf(entries, 1, `one entry on a ${type}`);
      assert.notEqual(entries[0].getAttribute("hidden"), "true");
    });
  }

  // Each main window carries its own entries: closing one window must not
  // strip the menus from another, and loading a window twice must not
  // duplicate them.
  describe("menus across main windows", function () {
    this.timeout(60000);
    const enrichLabel = "Enrich Metadata from Online Sources";
    const toolsLabel = /Import Bibliography|Undo Metadata/;
    const hooks = () => (Zotero as any)[config.addonInstance].hooks;

    function count(
      win: Window,
      popupId: string,
      match: (l: string) => boolean,
    ) {
      const popup = win.document.getElementById(popupId);
      if (!popup) return 0;
      return Array.from(popup.children).filter((el) =>
        match(el.getAttribute("label") ?? ""),
      ).length;
    }
    const itemEntries = (win: Window) =>
      count(win, "zotero-itemmenu", (l) => l === enrichLabel);
    const toolsEntries = (win: Window) =>
      count(win, "menu_ToolsPopup", (l) => toolsLabel.test(l));

    async function waitFor(check: () => boolean, what: string) {
      const deadline = Date.now() + 20000;
      while (!check()) {
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting: ${what}`);
        await Zotero.Promise.delay(50);
      }
    }

    function assertEntries(
      win: Window,
      items: number,
      tools: number,
      which: string,
    ) {
      assert.equal(itemEntries(win), items, `item-menu entries in ${which}`);
      assert.equal(toolsEntries(win), tools, `Tools entries in ${which}`);
    }

    it("keeps each window's entries when another window unloads", async function () {
      const first = Zotero.getMainWindow();
      const before = new Set(Zotero.getMainWindows());
      assertEntries(first, 1, 2, "the first window before opening another");

      let second: _ZoteroTypes.MainWindow | undefined;
      try {
        Zotero.openMainWindow();
        await waitFor(() => {
          second = Zotero.getMainWindows().find((w) => !before.has(w));
          return !!second && second.document.readyState === "complete";
        }, "a second main window to load");
        await waitFor(
          () => itemEntries(second!) >= 1 && toolsEntries(second!) >= 2,
          "the plugin's entries in the second window",
        );
        assertEntries(first, 1, 2, "the first window");
        assertEntries(second!, 1, 2, "the second window");

        await hooks().onMainWindowUnload(first);
        assertEntries(
          second!,
          1,
          2,
          "the second window after the first unloads",
        );
        assertEntries(first, 0, 0, "the unloaded first window");

        await hooks().onMainWindowLoad(first);
        await hooks().onMainWindowLoad(first);
        assertEntries(first, 1, 2, "the first window after loading twice");
        assertEntries(
          second!,
          1,
          2,
          "the second window after the first reloads",
        );
      } finally {
        if (second && !second.closed) {
          const closing = second;
          closing.close();
          await waitFor(
            () => !Zotero.getMainWindows().includes(closing),
            "the second window to close",
          );
        }
      }
      assertEntries(first, 1, 2, "the first window after the second closes");
    });
  });
});
