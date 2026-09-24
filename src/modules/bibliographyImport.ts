/** Reviewed, destination-aware bibliography imports for the CUNY AI Lab. */
import { isLLMAvailable, parseBibliographyWithLLM } from "./llmClient";
import { getMissingProviderKeyMessage } from "./provider";
import { enrichItems } from "./enrichment";
import {
  CSLItem,
  duplicateKeys,
  escapeHTML,
  reviewWarnings,
  splitEntries,
  validateEditedItem,
} from "./bibliographyValidation";

interface ReviewEntry {
  original: string;
  item?: CSLItem;
  error?: string;
  model?: string;
  savedID?: number;
  selected: boolean;
}

const types: Record<string, string> = {
  book: "book",
  chapter: "bookSection",
  "article-journal": "journalArticle",
  "article-magazine": "magazineArticle",
  "article-newspaper": "newspaperArticle",
  thesis: "thesis",
  report: "report",
  manuscript: "manuscript",
  pamphlet: "document",
  webpage: "webpage",
  paper: "conferencePaper",
  "paper-conference": "conferencePaper",
  document: "document",
};

export function cslToZoteroItem(csl: CSLItem, libraryID: number): Zotero.Item {
  const itemType = types[csl.type || ""] || "document";
  const item = new Zotero.Item(itemType as "book");
  item.libraryID = libraryID;
  const unmapped: string[] = [];
  const set = (field: string, value: unknown) => {
    if (value === undefined || value === "") return;
    if (
      Zotero.ItemFields.isValidForType(
        Zotero.ItemFields.getID(field),
        item.itemTypeID,
      )
    ) {
      item.setField(field, String(value));
    } else unmapped.push(`${field}: ${String(value)}`);
  };
  set("title", csl.title);
  for (const [role, names] of [
    ["author", csl.author],
    ["editor", csl.editor],
  ] as const) {
    for (const name of names || []) {
      item.setCreator(item.getCreators().length, {
        firstName: name.literal ? "" : name.given || "",
        lastName: name.literal || name.family || "",
        fieldMode: name.literal ? 1 : 0,
        creatorType: role,
      });
    }
  }
  set(
    "date",
    csl.issued?.["date-parts"]?.[0]
      ?.map((part, index) =>
        index ? String(part).padStart(2, "0") : String(part),
      )
      .join("-"),
  );
  const containerField =
    itemType === "bookSection"
      ? "bookTitle"
      : itemType === "conferencePaper"
        ? "proceedingsTitle"
        : "publicationTitle";
  for (const [source, target] of Object.entries({
    publisher: "publisher",
    "publisher-place": "place",
    "container-title": containerField,
    volume: "volume",
    issue: "issue",
    page: "pages",
    ISBN: "ISBN",
    DOI: "DOI",
    URL: "url",
    abstract: "abstractNote",
    language: "language",
  }))
    set(target, csl[source]);
  item.setField(
    "extra",
    ["CUNY AI Lab bibliography import", csl.note, ...unmapped]
      .filter(Boolean)
      .join("\n"),
  );
  return item;
}

function itemKeys(item: Zotero.Item): string[] {
  const creators = item.getCreators();
  return duplicateKeys({
    title: String(item.getField("title") || ""),
    DOI: item.getField("DOI"),
    ISBN: item.getField("ISBN"),
    author: creators
      .filter(
        (creator) =>
          creator.creatorTypeID === Zotero.CreatorTypes.getID("author"),
      )
      .map((creator) => ({ family: creator.lastName })),
    editor: creators
      .filter(
        (creator) =>
          creator.creatorTypeID === Zotero.CreatorTypes.getID("editor"),
      )
      .map((creator) => ({ family: creator.lastName })),
    issued: {
      "date-parts": [
        [Number(String(item.getField("date")).match(/\b\d{4}\b/)?.[0])],
      ],
    },
  });
}

export function openImportDialog(): void {
  if (!isLLMAvailable()) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getMissingProviderKeyMessage(),
        type: "fail",
      })
      .show();
    return;
  }
  const pane = Zotero.getActiveZoteroPane();
  if (!pane) return;
  const libraryID =
    pane.getSelectedLibraryID() || Zotero.Libraries.userLibraryID;
  const collection = pane.getSelectedCollection();
  const collectionID =
    collection?.libraryID === libraryID ? collection.id : undefined;
  const library = Zotero.Libraries.get(libraryID);
  if (!library) return;
  // Each window owns its state; destination is captured and cannot drift while reviewing.
  let win: Window;
  let entries: ReviewEntry[] = [];
  let busy = false;
  let closed = false;
  const doc = () => win.document;
  const status = (message: string) => {
    if (!closed) doc().getElementById("results-text")!.textContent = message;
  };
  const setBusy = (value: boolean) => {
    busy = value;
    if (closed) return;
    (
      doc().getElementById("bibliography-input") as HTMLTextAreaElement
    ).disabled = value;
    for (const id of ["parse-button", "import-button"]) {
      const button = doc().getElementById(id)!;
      if (
        value ||
        (id === "import-button" &&
          !entries.some(
            (entry) => !entry.savedID && entry.selected && entry.item,
          ))
      )
        button.setAttribute("disabled", "true");
      else button.removeAttribute("disabled");
    }
    doc()
      .querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >("#review-items input, #review-items textarea, #review-items select")
      .forEach(
        (
          element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        ) => {
          element.disabled =
            value ||
            element.closest("fieldset")?.hasAttribute("data-saved") === true;
        },
      );
  };
  const html = <K extends keyof HTMLElementTagNameMap>(tag: K) =>
    doc().createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElementTagNameMap[K];
  const render = () => {
    if (closed) return;
    const container = doc().getElementById("review-items")!;
    container.replaceChildren();
    entries.forEach((entry, index) => {
      const box = html("fieldset");
      box.style.cssText = "margin:12px 0;padding:12px;border:1px solid #888;";
      if (entry.savedID) box.setAttribute("data-saved", "true");
      const legend = html("legend");
      legend.textContent = `Entry ${index + 1}${entry.savedID ? " — imported" : ""}`;
      box.append(legend);
      const original = html("p");
      original.textContent = `Original: ${entry.original}`;
      original.style.whiteSpace = "pre-wrap";
      box.append(original);
      const selectedLabel = html("label");
      const selected = html("input");
      selected.type = "checkbox";
      selected.checked = entry.selected && !entry.savedID;
      selected.disabled = Boolean(entry.savedID);
      selected.addEventListener("change", () => {
        entry.selected = selected.checked;
        setBusy(false);
      });
      selectedLabel.append(
        selected,
        doc().createTextNode(" Import this entry"),
      );
      box.append(selectedLabel);
      const warnings = html("p");
      warnings.setAttribute("role", "status");
      box.append(warnings);
      const refreshWarnings = () => {
        warnings.textContent =
          entry.error ||
          (entry.item
            ? reviewWarnings(entry.item).join(" ")
            : "Could not parse. Add metadata below to recover this entry.");
      };
      const inputField = (
        label: string,
        value: string,
        update: (value: string) => void,
        multiline = false,
      ) => {
        const wrapper = html("label");
        wrapper.style.cssText = "display:block;margin-top:8px;";
        wrapper.textContent = label;
        const input = multiline ? html("textarea") : html("input");
        input.value = value;
        input.style.cssText = "display:block;width:100%;box-sizing:border-box;";
        if (multiline) (input as HTMLTextAreaElement).rows = 3;
        input.addEventListener("input", () => {
          update(input.value);
          entry.error = undefined;
          refreshWarnings();
        });
        wrapper.append(input);
        box.append(wrapper);
      };
      entry.item ||= { type: "document", title: "" };
      inputField("Title (required)", entry.item.title || "", (value) => {
        entry.item!.title = value;
      });
      inputField(
        "Authors (one per line: Family, Given; organization names without a comma)",
        (entry.item.author || [])
          .map(
            (name) =>
              name.literal ||
              [name.family, name.given].filter(Boolean).join(", "),
          )
          .join("\n"),
        (value) => {
          entry.item!.author = value
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
              const comma = line.indexOf(",");
              return comma < 0
                ? { literal: line.trim() }
                : {
                    family: line.slice(0, comma).trim(),
                    given: line.slice(comma + 1).trim(),
                  };
            });
        },
        true,
      );
      inputField(
        "Publication date (YYYY or YYYY-MM-DD)",
        entry.item.issued?.["date-parts"]?.[0]?.join("-") || "",
        (value) => {
          if (value.trim())
            entry.item!.issued = {
              "date-parts": [value.split("-").map(Number)],
            };
          else delete entry.item!.issued;
        },
      );
      const typeLabel = html("label");
      typeLabel.textContent = "Item type";
      typeLabel.style.display = "block";
      const typeSelect = html("select");
      for (const type of Object.keys(types)) {
        const option = html("option");
        option.value = type;
        option.textContent = type;
        typeSelect.append(option);
      }
      typeSelect.value = types[String(entry.item.type)]
        ? String(entry.item.type)
        : "document";
      entry.item.type = typeSelect.value;
      typeSelect.addEventListener("change", () => {
        entry.item!.type = typeSelect.value;
      });
      typeLabel.append(typeSelect);
      box.append(typeLabel);
      for (const [key, label] of Object.entries({
        publisher: "Publisher",
        "publisher-place": "Publication place",
        "container-title": "Journal or book title",
        ISBN: "ISBN",
        DOI: "DOI",
        URL: "URL",
        volume: "Volume",
        issue: "Issue",
        page: "Pages",
        language: "Language",
        abstract: "Abstract",
        note: "Notes",
      }))
        inputField(label, String(entry.item[key] || ""), (value) => {
          entry.item![key] = value;
        });
      inputField(
        "Editors (one per line: Family, Given; organization names without a comma)",
        (entry.item.editor || [])
          .map(
            (name) =>
              name.literal ||
              [name.family, name.given].filter(Boolean).join(", "),
          )
          .join("\n"),
        (value) => {
          entry.item!.editor = value
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
              const comma = line.indexOf(",");
              return comma < 0
                ? { literal: line.trim() }
                : {
                    family: line.slice(0, comma).trim(),
                    given: line.slice(comma + 1).trim(),
                  };
            });
        },
        true,
      );
      refreshWarnings();
      container.append(box);
    });
    setBusy(busy);
  };
  const args = {
    onLoad: (window: Window) => {
      win = window;
      (win as Window & { dialogArgs?: typeof args }).dialogArgs = args;
      doc().getElementById("destination")!.textContent =
        `Destination: ${library.name}${collectionID ? ` / ${collection!.name}` : " (library root)"}. To change destination, close this dialog and select another library or collection.`;
      const input = doc().getElementById(
        "bibliography-input",
      ) as HTMLTextAreaElement;
      input.addEventListener("input", () => {
        doc().getElementById("entry-count")!.textContent =
          `${splitEntries(input.value).length} entries detected. Blank lines separate multiline citations; otherwise each line is an entry.`;
      });
      win.addEventListener("unload", () => {
        closed = true;
      });
      if (!library.editable)
        status(
          "This library is read-only. Select an editable library before importing.",
        );
    },
    onParse: async () => {
      if (busy || closed) return;
      const originals = splitEntries(
        (doc().getElementById("bibliography-input") as HTMLTextAreaElement)
          .value,
      );
      if (!originals.length) {
        status("Enter at least one citation.");
        return;
      }
      if (entries.some((entry) => entry.savedID)) {
        status(
          "Some entries have already been imported. Open a new import dialog for another bibliography.",
        );
        return;
      }
      setBusy(true);
      try {
        const result = await parseBibliographyWithLLM(
          originals,
          25,
          (current, total) => status(`Parsing ${current}/${total} entries…`),
        );
        if (closed) return;
        entries = result.entries.map((entry) => ({
          ...entry,
          selected: Boolean(entry.item),
        }));
        render();
        status(
          `Review all ${entries.length} entries against the originals. ${result.failed.length} need correction. Only selected entries will be imported.`,
        );
      } catch (error) {
        status(
          `Parsing failed: ${String(error)}. Your previous review remains available.`,
        );
      } finally {
        setBusy(false);
      }
    },
    onImport: async () => {
      if (busy || closed || !entries.length) return;
      const targetLibrary = Zotero.Libraries.get(libraryID);
      if (!targetLibrary || !targetLibrary.editable) {
        status("The destination library is read-only.");
        return;
      }
      setBusy(true);
      const created: Zotero.Item[] = [];
      let skipped = 0;
      try {
        const existing = await Zotero.Items.getAll(libraryID, true, false);
        const keys = new Set(
          existing.filter((item) => item.isRegularItem()).flatMap(itemKeys),
        );
        for (const entry of entries) {
          if (closed) break;
          if (!entry.selected || entry.savedID) continue;
          try {
            const csl = validateEditedItem(entry.item);
            const candidateKeys = duplicateKeys(csl);
            if (candidateKeys.some((key) => keys.has(key))) {
              entry.error =
                "Possible duplicate in this library or batch; not imported. Check your library before retrying.";
              entry.selected = false;
              skipped++;
              continue;
            }
            const item = cslToZoteroItem(csl, libraryID);
            if (collectionID) item.addToCollection(collectionID);
            await Zotero.DB.executeTransaction(async () => {
              await item.save();
              const note = new Zotero.Item("note");
              note.libraryID = libraryID;
              note.parentID = item.id;
              note.setNote(
                `<h2>CUNY AI Lab bibliography import</h2><p>AI output reviewed and imported by the user. Model: ${escapeHTML(entry.model || "unknown")}. Imported: ${new Date().toISOString()}.</p><h3>Original citation</h3><pre>${escapeHTML(entry.original)}</pre><h3>Reviewed metadata (CSL-JSON)</h3><pre>${escapeHTML(JSON.stringify(csl, null, 2))}</pre>`,
              );
              await note.save();
            });
            entry.savedID = item.id;
            entry.selected = false;
            entry.error = undefined;
            candidateKeys.forEach((key) => keys.add(key));
            created.push(item);
          } catch (error) {
            entry.error = `Not imported: ${String(error)}. Correct this entry and retry.`;
          }
        }
        render();
        status(
          `Imported ${created.length} items this time; ${entries.filter((entry) => entry.savedID).length} total. ${skipped} possible duplicates skipped. Failed entries remain available for correction; saved entries cannot be imported again.`,
        );
        if (
          !closed &&
          (doc().getElementById("auto-enrich") as HTMLInputElement).checked &&
          created.length
        )
          await enrichItems(created);
      } catch (error) {
        status(
          `Import failed: ${String(error)}. Previously saved entries remain marked as imported.`,
        );
      } finally {
        setBusy(false);
      }
    },
  };
  Zotero.getMainWindow().openDialog(
    `chrome://${addon.data.config.addonRef}/content/importDialog.xhtml`,
    "",
    "chrome,dialog,centerscreen,resizable",
    args,
  );
}

export class BibliographyImportFactory {
  static openDialog(): void {
    openImportDialog();
  }
}
