import { assert } from "chai";
import { config } from "../package.json";
import manifest from "../addon/manifest.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("declares this Zotero version compatible", async function () {
    // The manifest bounds are what Zotero (and update.json, which copies
    // them) use to decide whether the plugin may be installed or updated.
    const { strict_min_version: min, strict_max_version: max } =
      manifest.applications.zotero;
    const version = Services.appinfo.version;
    assert.isAtLeast(
      Services.vc.compare(version, min),
      0,
      `${version} >= ${min}`,
    );
    assert.isAtMost(
      Services.vc.compare(version, max),
      0,
      `${version} <= ${max}`,
    );
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    const addon = await AddonManager.getAddonByID(config.addonID);
    assert.isTrue(addon.isCompatible, `isCompatible on Zotero ${version}`);
    assert.isFalse(addon.appDisabled);
  });
});
