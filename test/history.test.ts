import { assert } from "chai";
import {
  privateHistoryForItem,
  proposedChanges,
  saveReviewedChanges,
} from "../src/modules/enrichmentReview";

describe("reviewed metadata in Zotero", function () {
  it("saves fields and provenance atomically and protects later edits", async function () {
    const item = new Zotero.Item("book");
    item.setField("title", "Metadata Assistant integration fixture");
    await item.saveTx();
    try {
      const changes = proposedChanges(item, {
        publisher: "Fixture Press",
        LCCN: "123456",
        source: "https://openlibrary.org/books/OL1M.json",
      });
      await saveReviewedChanges(
        item,
        changes,
        "https://openlibrary.org/books/OL1M.json",
      );
      assert.equal(item.getField("publisher"), "Fixture Press");
      assert.include(String(item.getField("extra")), "LCCN: 123456");
      assert.isFalse(Boolean(item.getField("callNumber")));
      assert.lengthOf(item.getNotes(), 0);
      const history = privateHistoryForItem(item);
      assert.lengthOf(history, 1);
      assert.equal(
        history[0].record.source,
        "https://openlibrary.org/books/OL1M.json",
      );
      item.setField("publisher", "User correction");
      await item.saveTx();
      let rejected = false;
      try {
        await saveReviewedChanges(
          item,
          [{ field: "publisher", before: "Fixture Press", after: "" }],
          "https://openlibrary.org/books/OL1M.json",
        );
      } catch {
        rejected = true;
      }
      assert.isTrue(rejected);
      assert.equal(item.getField("publisher"), "User correction");
    } finally {
      await item.eraseTx();
    }
  });
});
