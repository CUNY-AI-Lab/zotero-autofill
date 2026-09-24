import type {
  APICandidate,
  EnrichmentAuthor,
  EnrichmentResult,
} from "./enrichment";

export interface CreatorChange {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType: string;
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
  creatorsBefore?: CreatorChange[];
  creatorsAfter?: CreatorChange[];
}

function getAuthorTypeID(): number {
  return Number(Zotero.CreatorTypes.getID("author"));
}

function getAuthorValue(item: Zotero.Item): string {
  return item
    .getCreators()
    .filter((creator) => creator.creatorTypeID === getAuthorTypeID())
    .map((creator) =>
      creator.fieldMode === 1
        ? creator.lastName
        : [creator.firstName, creator.lastName].filter(Boolean).join(" "),
    )
    .filter(Boolean)
    .join("; ");
}

function resolveField(item: Zotero.Item, baseField: string): string | null {
  const itemFields = (Zotero as any).ItemFields;
  if (
    !itemFields?.getFieldIDFromTypeAndBase ||
    !itemFields?.getName ||
    !Number.isFinite(Number((item as any).itemTypeID))
  )
    return baseField;
  const fieldID = itemFields.getFieldIDFromTypeAndBase(
    (item as any).itemTypeID,
    baseField,
  );
  if (fieldID === false || fieldID === null || fieldID === undefined)
    return null;
  const field = itemFields.getName(fieldID);
  return typeof field === "string" && field ? field : null;
}

function getCurrentValue(item: Zotero.Item, field: string): string {
  if (field === "author") return getAuthorValue(item);
  const resolved = resolveField(item, field);
  return resolved ? String(item.getField(resolved as any) || "") : "";
}

function parseDisplayAuthor(value: string): CreatorChange {
  const parts = value.trim().split(/\s+/);
  if (parts.length > 1)
    return {
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts.at(-1),
      creatorType: "author",
    };
  return { name: value.trim(), creatorType: "author" };
}

function creatorChange(author: EnrichmentAuthor): CreatorChange {
  if (author.given || author.family)
    return {
      firstName: author.given || "",
      lastName: author.family || "",
      creatorType: "author",
    };
  return parseDisplayAuthor(author.name || "");
}

function creatorDisplay(change: CreatorChange): string {
  if (change.name) return change.name;
  return [change.firstName, change.lastName].filter(Boolean).join(" ");
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function creatorChangesForItem(item: Zotero.Item): CreatorChange[] {
  return item
    .getCreators()
    .filter((creator) => creator.creatorTypeID === getAuthorTypeID())
    .map((creator) =>
      creator.fieldMode === 1
        ? { name: creator.lastName, creatorType: "author" }
        : {
            firstName: creator.firstName || "",
            lastName: creator.lastName || "",
            creatorType: "author",
          },
    );
}

function isExpandedValue(current: string, proposed: string): boolean {
  const normalizedCurrent = normalizeForMatch(current);
  const normalizedProposed = normalizeForMatch(proposed);
  return Boolean(
    normalizedCurrent &&
    normalizedProposed &&
    normalizedCurrent !== normalizedProposed &&
    normalizedProposed.includes(normalizedCurrent),
  );
}

function applyAuthorValue(
  item: Zotero.Item,
  value: string,
  creatorsAfter?: CreatorChange[],
): void {
  const creators = item.getCreators();
  const authorIndexes = creators
    .map((creator, index) =>
      creator.creatorTypeID === getAuthorTypeID() ? index : -1,
    )
    .filter((index) => index >= 0)
    .reverse();
  for (const index of authorIndexes) item.removeCreator(index);
  if (!value) {
    return;
  }
  const authors = creatorsAfter?.length
    ? creatorsAfter
    : [parseDisplayAuthor(value)];
  for (const author of authors)
    item.setCreator(item.getCreators().length, {
      ...author,
      creatorType: "author",
    });
}

function applyChange(item: Zotero.Item, change: FieldChange): void {
  if (change.field === "author")
    applyAuthorValue(item, change.after, change.creatorsAfter);
  else {
    const field = resolveField(item, change.field);
    if (!field)
      throw new Error(`The ${change.field} field is not valid for this item.`);
    item.setField(field as any, change.after);
  }
}

const marker = "CUNY-METADATA-HISTORY:";
const HISTORY_PREF = "extensions.zotero.metadata-assistant.privateHistory";

interface StoredHistory {
  nextId: number;
  items: Record<string, Array<{ id: number; record: HistoryRecord }>>;
}

function historyItemKey(item: Zotero.Item): string {
  return `${item.libraryID}:${item.id}`;
}

function readPrivateHistory(): StoredHistory {
  const raw = Zotero.Prefs.get(HISTORY_PREF, true);
  if (typeof raw !== "string" || !raw)
    return { nextId: 1_000_000_000_000, items: {} };
  try {
    const parsed = JSON.parse(raw) as StoredHistory;
    if (
      parsed &&
      Number.isSafeInteger(parsed.nextId) &&
      parsed.nextId > 0 &&
      parsed.items &&
      typeof parsed.items === "object"
    )
      return parsed;
  } catch {
    /* Ignore malformed plugin state. */
  }
  return { nextId: 1_000_000_000_000, items: {} };
}

function writePrivateHistory(store: StoredHistory): void {
  Zotero.Prefs.set(HISTORY_PREF, JSON.stringify(store), true);
}

function privateHistoryForItem(
  item: Zotero.Item,
): Array<{ id: number; record: HistoryRecord }> {
  return readPrivateHistory().items[historyItemKey(item)] || [];
}

function appendPrivateHistory(
  item: Zotero.Item,
  record: HistoryRecord,
): number {
  const store = readPrivateHistory();
  const id = store.nextId++;
  const key = historyItemKey(item);
  const records = store.items[key] || [];
  records.push({ id, record });
  store.items[key] = records.slice(-100);
  writePrivateHistory(store);
  return id;
}
export function proposedChanges(
  item: Zotero.Item,
  result: EnrichmentResult,
): FieldChange[] {
  const values: Record<string, string | number | undefined> = {
    title: result.title,
    DOI: result.DOI,
    ISBN: result.ISBN,
    publicationTitle: result.containerTitle,
    publisher: result.publisher,
    place: result.place,
    volume: result.volume,
    issue: result.issue,
    pages: result.pages,
    numPages: result.numPages,
    date: result.date,
    abstractNote: result.abstractNote,
  };
  const changes: FieldChange[] = [];
  const currentAuthor = getAuthorValue(item);
  if (
    result.author &&
    (!currentAuthor || isExpandedValue(currentAuthor, result.author))
  ) {
    const creatorsAfter = result.authors?.length
      ? result.authors.map(creatorChange)
      : [parseDisplayAuthor(result.author)];
    const authorAfter = creatorsAfter
      .map(creatorDisplay)
      .filter(Boolean)
      .join("; ");
    changes.push({
      field: "author",
      before: currentAuthor,
      after: authorAfter || result.author,
      creatorsBefore: creatorChangesForItem(item),
      creatorsAfter,
    });
  }
  for (const [field, value] of Object.entries(values)) {
    if (!resolveField(item, field)) continue;
    const before = getCurrentValue(item, field);
    if (
      value &&
      (!before || (field === "title" && before.trim() !== String(value).trim()))
    )
      changes.push({ field, before, after: String(value) });
  }
  const extra = String(item.getField("extra") || "");
  const identifiers = [
    result.OCLC && !/^OCLC:/im.test(extra) ? `OCLC: ${result.OCLC}` : "",
    result.LCCN && !/^LCCN:/im.test(extra) ? `LCCN: ${result.LCCN}` : "",
  ].filter(Boolean);
  if (identifiers.length)
    changes.push({
      field: "extra",
      before: extra,
      after: [extra, ...identifiers].filter(Boolean).join("\n"),
    });
  return changes;
}

export async function saveReviewedChanges(
  item: Zotero.Item,
  changes: FieldChange[],
  source: string,
  undoOf?: number,
): Promise<void> {
  if (!changes.length) return;
  if (
    !isHistoryRecord({
      version: 1,
      date: new Date().toISOString(),
      source,
      changes,
      undoOf,
    })
  )
    throw new Error("Invalid metadata change record");
  for (const change of changes) {
    if (getCurrentValue(item, change.field) !== change.before)
      throw new Error(
        `The ${change.field} field changed since review. Reopen review to protect your edits.`,
      );
  }
  const applied: FieldChange[] = [];
  const record: HistoryRecord = {
    version: 1,
    date: new Date().toISOString(),
    source,
    changes,
    undoOf,
  };
  try {
    await Zotero.DB.executeTransaction(async () => {
      for (const change of changes) {
        if (getCurrentValue(item, change.field) !== change.before)
          throw new Error(`The ${change.field} field changed since review.`);
      }
      for (const change of changes) {
        applyChange(item, change);
        applied.push(change);
      }
      await item.save();
    });
    appendPrivateHistory(item, record);
  } catch (error) {
    // The DB transaction rolls back persisted data; also restore the cached object.
    for (const change of applied) {
      if (getCurrentValue(item, change.field) === change.after)
        applyChange(item, { ...change, after: change.before });
    }
    throw error;
  }
}

interface ReviewRow {
  item: Zotero.Item;
  changes: FieldChange[];
  source: string;
  undoOf?: number;
  candidates?: APICandidate[];
}
function openReview(rows: ReviewRow[], title: string): void {
  const args = {
    onLoad(win: Window) {
      const doc = win.document;
      doc.title = title;
      const container = doc.getElementById("review-rows")!;
      const status = doc.getElementById("review-status")!;
      const create = (tag: string, text?: string) => {
        const el = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          tag,
        ) as HTMLElement;
        if (text) el.textContent = text;
        return el;
      };
      for (const row of rows) {
        const section = create("fieldset");
        section.append(create("legend", String(row.item.getField("title"))));
        const sourceContainer = create("div");
        section.append(sourceContainer);
        let inputs: HTMLInputElement[] = [];
        const changesContainer = create("div");
        section.append(changesContainer);
        const candidatePicker = row.candidates?.length
          ? (create("select") as HTMLSelectElement)
          : null;
        if (candidatePicker) {
          const label = create(
            "label",
            "Multiple matches found — choose one: ",
          );
          for (const [index, candidate] of row.candidates!.entries()) {
            const option = create("option") as HTMLOptionElement;
            const result = candidate.result;
            option.value = String(index);
            option.textContent = [
              candidate.title || result.title,
              candidate.author || result.author,
              candidate.year,
            ]
              .filter(Boolean)
              .join(" — ");
            candidatePicker.append(option);
          }
          label.append(candidatePicker);
          section.insertBefore(label, sourceContainer);
        }
        const button = create(
          "button",
          row.undoOf ? "Undo selected changes" : "Save selected changes",
        ) as HTMLButtonElement;

        const render = (candidate?: APICandidate) => {
          if (candidate) {
            row.changes = proposedChanges(row.item, candidate.result);
            row.source = candidate.result.source || "Unknown source";
          }
          while (sourceContainer.firstChild)
            sourceContainer.removeChild(sourceContainer.firstChild);
          if (/^https:\/\//.test(row.source)) {
            const link = create(
              "a",
              "View metadata source",
            ) as HTMLAnchorElement;
            link.href = row.source;
            link.addEventListener("click", (e) => {
              e.preventDefault();
              Zotero.launchURL(row.source);
            });
            sourceContainer.append(link);
          }
          while (changesContainer.firstChild)
            changesContainer.removeChild(changesContainer.firstChild);
          inputs = [];
          for (const change of row.changes) {
            const label = create("label");
            label.style.display = "block";
            const input = create("input") as HTMLInputElement;
            input.type = "checkbox";
            input.checked = true;
            label.append(
              input,
              doc.createTextNode(
                ` ${change.field}: ${change.before || "(empty)"} → ${change.after || "(empty)"}`,
              ),
            );
            changesContainer.append(label);
            inputs.push(input);
          }
          button.disabled = !inputs.length;
        };
        candidatePicker?.addEventListener("change", () => {
          const candidate = row.candidates?.[Number(candidatePicker.value)];
          if (candidate) render(candidate);
        });
        render(row.candidates?.[0]);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const changes = row.changes.filter((_, i) => inputs[i].checked);
            if (!changes.length) {
              status.textContent = "Select at least one field to save.";
              button.disabled = false;
              return;
            }
            await saveReviewedChanges(
              row.item,
              changes,
              row.source,
              row.undoOf,
            );
            inputs.forEach((i) => (i.disabled = true));
            button.textContent = changes.length ? "Saved" : "Nothing selected";
            status.textContent =
              "Changes saved. Undo history is stored privately.";
          } catch (error) {
            status.textContent = String(error);
            button.disabled = false;
          }
        });
        section.append(button);
        container.append(section);
      }
      if (!rows.length)
        status.textContent =
          "No changes available. Existing metadata is preserved.";
    },
  };
  const reviewWindow = Zotero.getMainWindow().openDialog(
    `chrome://${addon.data.config.addonRef}/content/enrichmentReview.xhtml`,
    "",
    "chrome,dialog,centerscreen,resizable",
    args,
  );
  reviewWindow?.focus();
}

export function openEnrichmentReview(
  proposals: Array<{ item: Zotero.Item; result: EnrichmentResult }>,
): void {
  openReview(
    proposals.map(({ item, result }) => ({
      item,
      changes: proposedChanges(item, result),
      source: result.source || "Unknown source",
      candidates: result.candidates?.length ? result.candidates : undefined,
    })),
    "Review metadata — CUNY AI Lab",
  );
}

interface HistoryRecord {
  version: number;
  date: string;
  source: string;
  changes: FieldChange[];
  undoOf?: number;
}
const historyFields = new Set([
  "title",
  "DOI",
  "ISBN",
  "author",
  "publicationTitle",
  "publisher",
  "place",
  "volume",
  "issue",
  "pages",
  "numPages",
  "date",
  "abstractNote",
  "extra",
]);
function isCreatorChanges(value: unknown): value is CreatorChange[] {
  return (
    Array.isArray(value) &&
    value.every(
      (creator) =>
        creator &&
        typeof creator === "object" &&
        typeof (creator as CreatorChange).creatorType === "string" &&
        (["firstName", "lastName", "name"] as const).every(
          (field) =>
            (creator as any)[field] === undefined ||
            typeof (creator as any)[field] === "string",
        ),
    )
  );
}
function isHistoryRecord(value: any): value is HistoryRecord {
  return (
    !!value &&
    value.version === 1 &&
    typeof value.date === "string" &&
    Number.isFinite(Date.parse(value.date)) &&
    typeof value.source === "string" &&
    Array.isArray(value.changes) &&
    value.changes.length > 0 &&
    value.changes.every(
      (change: any) =>
        change &&
        historyFields.has(change.field) &&
        typeof change.before === "string" &&
        typeof change.after === "string" &&
        (change.creatorsBefore === undefined ||
          isCreatorChanges(change.creatorsBefore)) &&
        (change.creatorsAfter === undefined ||
          isCreatorChanges(change.creatorsAfter)),
    ) &&
    new Set(value.changes.map((change: FieldChange) => change.field)).size ===
      value.changes.length &&
    (value.undoOf === undefined ||
      (Number.isInteger(value.undoOf) && value.undoOf > 0))
  );
}

/** Undo only un-reverted fields whose current value still matches the saved change. */
export function pendingUndo(
  item: Zotero.Item,
  history: Array<{ id: number; record: unknown }>,
): ReviewRow | null {
  const records = history.filter(
    (entry): entry is { id: number; record: HistoryRecord } =>
      Number.isInteger(entry.id) &&
      entry.id > 0 &&
      isHistoryRecord(entry.record),
  );
  const originals = records
    .filter((entry) => entry.record.undoOf === undefined)
    .sort(
      (a, b) =>
        Date.parse(b.record.date) - Date.parse(a.record.date) || b.id - a.id,
    );
  for (const original of originals) {
    const reversed = records
      .filter((entry) => entry.record.undoOf === original.id)
      .flatMap((entry) => entry.record.changes);
    const changes = original.record.changes
      .filter(
        (change) =>
          !reversed.some(
            (reverse) =>
              reverse.field === change.field &&
              reverse.before === change.after &&
              reverse.after === change.before,
          ) && getCurrentValue(item, change.field) === change.after,
      )
      .map((change) => {
        const reversed: FieldChange = {
          field: change.field,
          before: change.after,
          after: change.before,
        };
        if (change.creatorsAfter !== undefined)
          reversed.creatorsBefore = change.creatorsAfter;
        if (change.creatorsBefore !== undefined)
          reversed.creatorsAfter = change.creatorsBefore;
        return reversed;
      });
    if (changes.length)
      return {
        item,
        changes,
        source: original.record.source,
        undoOf: original.id,
      };
  }
  return null;
}

export async function undoSelectedEnrichment(): Promise<void> {
  const rows: ReviewRow[] = [];
  for (const item of Zotero.getActiveZoteroPane()?.getSelectedItems() ?? []) {
    if (!item.isRegularItem()) continue;
    const records: Array<{ id: number; record: unknown }> = [
      ...privateHistoryForItem(item),
    ];
    const notes = await Zotero.Items.getAsync(item.getNotes());
    for (const note of notes) {
      const encoded = note
        .getNote()
        .match(/CUNY-METADATA-HISTORY:([^<\s]+)/)?.[1];
      if (!encoded) continue;
      try {
        records.push({
          id: note.id,
          record: JSON.parse(decodeURIComponent(encoded)),
        });
      } catch {
        /* Ignore unrelated or edited notes. */
      }
    }
    const row = pendingUndo(item, records);
    if (row) rows.push(row);
  }
  openReview(rows, "Undo metadata changes — CUNY AI Lab");
}
