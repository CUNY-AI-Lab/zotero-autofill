import { assert } from "chai";
import { isSyncedAdd } from "../src/modules/autoEnrichLimit";

// What Zotero's notifier really hands an observer for sync-saved items.
describe("sync detection in the real notifier", function () {
  async function observe(queueOptions: object, extraData: object) {
    let received: { ids: any[]; extraData: any } | undefined;
    const id = Zotero.Notifier.registerObserver(
      {
        notify(_event: string, _type: string, ids: any[], data: any) {
          received = { ids, extraData: data };
        },
      },
      ["item"],
      "metadata-assistant-test",
    );
    try {
      const queue = new Zotero.Notifier.Queue(queueOptions);
      Zotero.Notifier.queue("add", "item", [987654], extraData, queue);
      await Zotero.Notifier.commit(queue);
      await Zotero.Promise.delay(50);
    } finally {
      Zotero.Notifier.unregisterObserver(id);
    }
    return received!;
  }

  it("flags items delivered through a skipAutoSync queue (as Sync does)", async function () {
    const { ids, extraData } = await observe(
      { skipAutoSync: true },
      { 987654: { skipRenameFile: true } },
    );
    assert.isTrue(isSyncedAdd(ids, extraData));
  });

  it("does not flag an ordinary user-added item", async function () {
    const { ids, extraData } = await observe({}, {});
    assert.isFalse(isSyncedAdd(ids, extraData));
  });
});
