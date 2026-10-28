import { assert } from "chai";
import { getImportDestination } from "../src/modules/bibliographyImport";

describe("bibliography import destination", function () {
  it("follows the main window selection", async function () {
    const pane = Zotero.getActiveZoteroPane()!;
    const tree = pane.collectionsView as any;
    const collection = new Zotero.Collection();
    collection.name = "Import destination";
    await collection.saveTx();
    const other = new Zotero.Collection();
    other.name = "Second destination";
    await other.saveTx();
    await tree.selectCollection(collection.id);
    assert.deepEqual(getImportDestination(pane), {
      libraryID: Zotero.Libraries.userLibraryID,
      collection,
    });
    // Zotero 10's singular selection getters throw once several rows are selected.
    tree.selection.toggleSelect(tree.getRowIndexByID(`C${other.id}`));
    assert.equal(tree.selection.count, 2);
    assert.deepEqual(getImportDestination(pane), {
      libraryID: Zotero.Libraries.userLibraryID,
      collection: undefined,
    });
    await tree.selectLibrary(Zotero.Libraries.userLibraryID);
    assert.deepEqual(getImportDestination(pane), {
      libraryID: Zotero.Libraries.userLibraryID,
      collection: undefined,
    });
  });
});
