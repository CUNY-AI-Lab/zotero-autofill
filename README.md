# Zotero Metadata Assistant

**A CUNY AI Lab tool** for reviewing book and academic article metadata and turning bibliography text into Zotero items.

The assistant proposes catalogue metadata for your review. Optional AI helps parse citations and assess possible matches. You remain responsible for checking the cited edition and the resulting record.

## Install

Download an `.xpi` from [Releases](https://github.com/CUNY-AI-Lab/zotero-autofill/releases). In Zotero, open **Tools → Plugins** (or **Add-ons**), select the gear menu, then **Install Add-on From File**. Select the XPI and restart if prompted.

This development version targets Zotero 7 through Zotero 10.0.x, and the manifest declares `strict_max_version: 10.0.*`. Zotero 10 lets you select several collections at once: bibliography import saves into a collection only when exactly one is selected, and otherwise into the selected library's root. Changes in this checkout are not published releases.

## Review book metadata

1. Select books or academic articles and right-click **Enrich Metadata from Online Sources**.
2. Wait for the metadata review window. An existing ISBN anchors lookup; otherwise the assistant checks title, author, and edition year. Uncertain results remain unresolved.
3. Open the source link and check that it describes your edition. Select the missing fields you want and click **Save selected changes**.
4. A child note records the source, time, and before/after values. Use **Tools → Undo Metadata Changes…** to review an undo. Undo preserves fields you have subsequently edited.

Existing populated fields are preserved. OCLC and LCCN are stored as labelled identifiers in Extra; LCCN is not a shelf call number. Work-level aggregate page counts and unrelated reprint ISBNs are not applied. Automatic lookup, if enabled in settings, opens suggestions for review; it does not save them automatically.

## Import a bibliography

1. In **Settings → Metadata Assistant**, choose **CUNY AI Lab Gateway** or **OpenRouter**, enter that provider’s key, and choose a DeepSeek model.
2. Select the destination library and collection in Zotero, then open **Tools → Import Bibliography Text…**.
3. Paste entries separated by a blank line. Wrapped lines within a paragraph stay together.
4. Click **Parse with AI**. Compare every parsed record to its original text; edit fields and deselect records you do not want. Missing and invalid responses are reported per entry.
5. Check the destination, then import. Duplicate candidates are reported for review. Saved rows retain their status, so retrying a partial failure does not import those rows again.

Original text and model provenance accompany imported items. Optional enrichment opens a separate review of catalogue suggestions.

### Humanities walkthrough

Try these public-domain works, one paragraph per entry:

> Du Bois, W. E. B. The Souls of Black Folk. Chicago: A. C. McClurg & Co., 1903.
>
> Martí, José. Versos sencillos. Nueva York: Louis Weiss y Cía., 1891.
>
> Woolf, Virginia. A Room of One’s Own. London: Hogarth Press, 1929.

Check accents and author names, publisher and place, and the specific publication year. A modern reprint is a different edition; do not accept its ISBN or pagination for the original. For incomplete citations, leave unknown information blank and consult your source. Corporate authors and multilingual text should be reviewed with the same care.

The dialogs use labelled native inputs and buttons. Navigate with Tab, use Space to select checkboxes, and inspect the status messages. Screen-reader and high-contrast behavior are part of the manual release checklist.

## Data and costs

- **Catalogue lookup:** sends book queries (title, author, year) or ISBN to Open Library and Google Books. Scholarly articles use [Crossref](https://www.crossref.org/), including DOI lookup when a DOI is already present. Source links identify returned records.
- **AI:** when a provider key is configured, sends pasted bibliography text, query text, or candidate metadata through the selected provider to DeepSeek V4. Without a key, catalogue lookup still works but bibliography parsing shows an add-a-key error.
- **Provider access:** CUNY users can create a personal key through [CUNY Model Access](https://ailab.gc.cuny.edu/docs/api-keys/). The gateway uses `https://tools.ailab.gc.cuny.edu/v1` and its CUNY quota. OpenRouter uses your OpenRouter account and credits.
- **Billing:** OpenRouter charges your account; CUNY Gateway requests use the CUNY allocation and quota. Check the selected provider before large imports.
- **Storage:** the API key is stored in local Zotero preferences. Original bibliography text and change-history notes become part of your Zotero library and follow its sync/sharing settings.
- **Provider policies:** retention and processing depend on OpenRouter and the selected provider. The plugin does not promise institutional approval, confidential processing, or zero retention.

Remove the selected provider’s key to stop AI requests and continue using catalogue lookup. Review text before sending it to an external service.

### Open-weight model policy

The model menu is limited to DeepSeek’s downloadable-weight models:

CAIL Gateway requests use prefix-free IDs (`deepseek-v4.1-flash` and `deepseek-v4-pro`); OpenRouter requests retain the `deepseek/` prefix. Saved V4 Flash selections resolve to V4.1 Flash.

- **DeepSeek V4.1 Flash** (`deepseek/deepseek-v4.1-flash`) is the lower-cost default.
- **DeepSeek V4 Pro** (`deepseek/deepseek-v4-pro`) is the higher-quality alternative.

The IDs and OpenRouter availability were checked on September 7, 2026. Both support the JSON responses required by the plugin. OpenRouter prices and availability can change, so check its model page before a large import. Any older saved model preference automatically falls back to DeepSeek V4.1 Flash.

## Development and verification

```bash
npm ci
npm run test:unit
npm run lint:check
npm run build
npm test
```

The build produces `.scaffold/build/zotero-metadata-assistant.xpi`. Unit tests run without Zotero or network credentials. `npm test` is the scaffold's Zotero integration test and needs a configured Zotero executable/profile; see `.env.example`. Use a disposable test profile for UI testing, not your research library.

For hot reload, configure `.env` and run `npm start`. Keep the extension ID `zotero-metadata-assistant@smorello.org` stable for upgrades.

Before a release, test installation, settings persistence, catalogue lookup without a provider key, uncertain matches, bibliography parsing, duplicate handling, partial-failure retry, selected group library/collection, source notes, undo after manual edits, keyboard navigation, and plugin shutdown in the supported Zotero versions. Test with fixture credentials and a disposable library. Do not publish a release on unit-test results alone.

## Maintenance and support

A CUNY AI Lab project, developed by Stefano Morello. Report reproducible problems through [GitHub Issues](https://github.com/CUNY-AI-Lab/zotero-autofill/issues), including plugin/Zotero versions and an anonymized example. Do not post API keys or private bibliography text. Release artifacts and version history are maintained through [GitHub Releases](https://github.com/CUNY-AI-Lab/zotero-autofill/releases).

Built with [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template). Licensed GPL-3.0-or-later. Catalogue data comes from [Open Library](https://openlibrary.org/) and [Google Books](https://books.google.com/); model access uses the selected [CUNY AI Lab Gateway](https://github.com/CUNY-AI-Lab/cail-gateway) or [OpenRouter](https://openrouter.ai/).
