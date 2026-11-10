/**
 * Enrichment module for Zotero Metadata Assistant
 * Searches Open Library, Google Books, and Crossref to fill missing metadata
 * Includes LLM-enhanced features: fuzzy matching fallback and disambiguation
 */

import { getPref } from "../utils/prefs";
import { getApiKey, migrateKeysFromPrefs } from "../utils/keystore";
import { lookupUrl } from "../utils/testHooks";
import { isLLMAvailable, llmCleanupQuery, llmDisambiguate } from "./llmClient";
import { openEnrichmentReview } from "./enrichmentReview";

// ==================== Types ====================

export interface EnrichmentAuthor {
  given?: string;
  family?: string;
  name?: string;
}

export interface EnrichmentResult {
  source?: string;
  title?: string;
  author?: string;
  authors?: EnrichmentAuthor[];
  candidates?: APICandidate[];
  ISBN?: string;
  DOI?: string;
  OCLC?: string;
  LCCN?: string;
  publisher?: string;
  place?: string;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  numPages?: number;
  date?: string;
  tags?: string[];
  abstractNote?: string;
}

/** What one catalog returned; `error` says why it could not be searched. */
export interface SourceSearch {
  candidates: APICandidate[];
  bestResult: EnrichmentResult | null;
  error?: string;
}

export interface APICandidate {
  title?: string;
  author?: string;
  year?: string;
  publisher?: string;
  isbn?: string;
  result: EnrichmentResult;
}

function authorLabel(author: EnrichmentAuthor | undefined): string {
  return (
    [author?.given, author?.family].filter(Boolean).join(" ") ||
    author?.name ||
    ""
  );
}

export interface EnrichmentProposal {
  item: Zotero.Item;
  result: EnrichmentResult;
}

export interface EnrichmentStats {
  found: number;
  notFound: number;
  /** Items whose lookup could not be completed (catalog failures, deadline). */
  failed: number;
  preIsbn: number;
  skipped: number;
  /** Items whose earlier lookup was still running. */
  alreadyRunning: number;
  proposals: EnrichmentProposal[];
  errors: string[];
}

interface EnrichmentOptions {
  openReview?: boolean;
}

const ENRICHABLE_ITEM_TYPES = new Set([
  "book",
  "journalArticle",
  "conferencePaper",
  "thesis",
  "report",
  "preprint",
]);

export function isEnrichableItem(item: Zotero.Item): boolean {
  return ENRICHABLE_ITEM_TYPES.has(item.itemType);
}

// ==================== Helper Functions ====================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replaceable in tests so pacing delays do not take real time. */
export const enrichRuntime = { sleep };

const POLITE_USER_AGENT =
  "Zotero Metadata Assistant/1.0 (https://github.com/CUNY-AI-Lab/zotero-autofill)";

/**
 * GET a catalog URL. Every lookup has a 10 s timeout and no automatic retry:
 * `errorDelayMax: 0` stops Zotero.HTTP's own 5xx backoff (up to an hour in
 * Zotero 7-10) and `noRetryOnThrottle` stops it from sleeping on a 429/503
 * `Retry-After` and trying again, which `errorDelayMax: 0` alone does not.
 */
function lookupRequest(url: string, headers?: Record<string, string>) {
  return Zotero.HTTP.request("GET", lookupUrl(url), {
    ...(headers ? { headers } : {}),
    timeout: 10000,
    errorDelayMax: 0,
    noRetryOnThrottle: true,
    responseType: "json",
  } as any);
}

/** A catalog answered "no such record" (as opposed to failing). */
function isNotFound(error: unknown): boolean {
  const e = error as any;
  return (e?.status ?? e?.xmlhttp?.status) === 404;
}

/** What each catalog did during one lookup. */
export interface SourceReport {
  name: string;
  found: number;
  error?: string;
}

/**
 * A lookup that found nothing while at least one catalog failed: the item is
 * not "not found", it could not be checked.
 */
export class LookupFailedError extends Error {
  sources: SourceReport[];
  constructor(sources: SourceReport[]) {
    super(describeSearchFailures(sources) || "The lookup failed.");
    this.name = "LookupFailedError";
    this.sources = sources;
  }
}

/**
 * Get year from a Zotero item's date field
 */
function getYearFromItem(item: Zotero.Item): number | null {
  const date = item.getField("date") as string;
  if (date) {
    const match = date.match(/(\d{4})/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Get first author's last name from a Zotero item
 */
function getFirstAuthor(item: Zotero.Item): string {
  const creators = item.getCreators();
  if (creators && creators.length > 0) {
    // Find an author - creatorTypeID 1 is typically "author" in Zotero
    // Use getCreatorTypeID to check creator type properly
    const authorTypeID = Zotero.CreatorTypes.getID("author");
    const author = creators.find((c) => c.creatorTypeID === authorTypeID);
    if (author) {
      return author.lastName || "";
    }
    // Fall back to first creator
    return creators[0].lastName || "";
  }
  return "";
}

function addCandidateAuthor(candidate: APICandidate): EnrichmentResult {
  const result = { ...candidate.result };
  if (candidate.author && !result.author) result.author = candidate.author;
  return result;
}

// ==================== API Search Functions ====================

function validISBN(value: string): boolean {
  if (/^97[89]\d{10}$/.test(value))
    return (
      [...value].reduce(
        (sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1),
        0,
      ) %
        10 ===
      0
    );
  if (/^\d{9}[\dX]$/.test(value))
    return (
      [...value].reduce(
        (sum, digit, index) =>
          sum + (digit === "X" ? 10 : Number(digit)) * (10 - index),
        0,
      ) %
        11 ===
      0
    );
  return false;
}

function canonicalISBN(value: string): string {
  const normalized = value.replace(/[-\s]/g, "").toUpperCase();
  if (!validISBN(normalized)) return "";
  if (normalized.length === 13) return normalized;
  const stem = `978${normalized.slice(0, 9)}`;
  const sum = [...stem].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1),
    0,
  );
  return `${stem}${(10 - (sum % 10)) % 10}`;
}

async function resolveOpenLibraryAuthors(
  authors: unknown,
): Promise<EnrichmentAuthor[]> {
  if (!Array.isArray(authors)) return [];
  const directAuthors = authors
    .map((author: any) => author?.name || author?.author?.name)
    .filter(
      (author: unknown): author is string =>
        typeof author === "string" && Boolean(author.trim()),
    )
    .map((name) => ({ name: name.trim() }));
  if (directAuthors.length) return directAuthors;

  const resolved: EnrichmentAuthor[] = [];
  for (const author of authors) {
    const key = String(author?.key || author?.author?.key || "");
    if (!/^\/authors\/OL\d+A$/.test(key)) continue;
    try {
      await enrichRuntime.sleep(
        Math.max(1100, Number(getPref("apiDelayMs")) || 1100),
      );
      const response = await lookupRequest(
        `https://openlibrary.org${key}.json`,
      );
      const name = String((response.response as any)?.name || "").trim();
      if (name) resolved.push({ name });
    } catch (error) {
      ztoolkit.log(`Open Library author fetch error for ${key}: ${error}`);
    }
  }
  return resolved;
}

/**
 * Fetch detailed edition data from Open Library using ISBN
 */
async function fetchOpenLibraryEdition(
  isbn: string,
): Promise<EnrichmentResult | null> {
  const url = `https://openlibrary.org/isbn/${isbn}.json`;

  let response: any;
  try {
    response = await lookupRequest(url);
  } catch (error) {
    ztoolkit.log(`Open Library edition fetch error for ISBN ${isbn}: ${error}`);
    if (isNotFound(error)) return null;
    throw new LookupFailedError([
      { name: "Open Library", found: 0, error: describeSourceFailure(error) },
    ]);
  }
  try {
    const data = response.response as any;
    if (!data || typeof data.title !== "string" || !data.title.trim())
      return null;
    const identifiers = [
      ...(Array.isArray(data.isbn_13) ? data.isbn_13 : []),
      ...(Array.isArray(data.isbn_10) ? data.isbn_10 : []),
    ];
    if (
      identifiers.length &&
      !identifiers.some(
        (value) =>
          typeof value === "string" &&
          canonicalISBN(value) === canonicalISBN(isbn),
      )
    )
      return null;
    const result: EnrichmentResult = {};

    result.title = data.title;
    result.ISBN = isbn;
    result.source = url;
    const authors = await resolveOpenLibraryAuthors(data.authors);
    if (authors.length) {
      result.authors = authors;
      result.author = authorLabel(authors[0]);
    }
    // Publisher
    if (data.publishers && data.publishers.length > 0) {
      result.publisher = data.publishers[0];
    }

    // Place
    if (data.publish_places && data.publish_places.length > 0) {
      result.place = data.publish_places[0];
    }

    // Number of pages
    if (data.number_of_pages) {
      result.numPages = data.number_of_pages;
    }

    // Publication date
    if (data.publish_date) {
      // Extract year from date string like "2020" or "January 2020"
      const yearMatch = data.publish_date.match(/(\d{4})/);
      if (yearMatch) {
        result.date = yearMatch[1];
      }
    }

    // Description/abstract
    if (data.description) {
      const desc =
        typeof data.description === "string"
          ? data.description
          : data.description.value || "";
      if (desc) {
        result.abstractNote =
          desc.length > 500 ? desc.substring(0, 497) + "..." : desc;
      }
    }

    // LCCN
    if (data.lccn && data.lccn.length > 0) {
      result.LCCN = data.lccn[0];
    }

    // OCLC from identifiers
    if (data.oclc_numbers && data.oclc_numbers.length > 0) {
      result.OCLC = data.oclc_numbers[0];
    }

    ztoolkit.log(
      `Open Library edition data for ISBN ${isbn}: publisher=${result.publisher}, place=${result.place}, pages=${result.numPages}`,
    );

    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    ztoolkit.log(`Open Library edition parse error for ISBN ${isbn}: ${error}`);
    return null;
  }
}

/** Short reason a catalog request failed, for the user. Never includes the URL. */
export function describeSourceFailure(error: unknown): string {
  const e = error as any;
  const raw = e?.status ?? e?.xmlhttp?.status;
  const status = typeof raw === "number" && raw > 0 ? raw : undefined;
  const message = String(e?.message ?? error);
  if (
    status === 429 ||
    (status === undefined &&
      /status code 429\b|rate limit|too many requests/i.test(message))
  )
    return "refused the request (rate limit)";
  if (status !== undefined && status >= 500)
    return `had a server error (${status})`;
  if (status !== undefined && status >= 400)
    return `refused the request (HTTP ${status})`;
  if (/timeout|timed out/i.test(message)) return "timed out";
  if (/offline/i.test(message)) return "could not be reached (offline)";
  return "could not be reached";
}

/**
 * Search Open Library for book metadata
 * Returns multiple candidates for LLM disambiguation
 */
export async function searchOpenLibrary(
  title: string,
  author: string,
  year: number | null,
): Promise<SourceSearch> {
  const params = new URLSearchParams();
  params.set("title", title);
  if (author) params.set("author", author);
  if (year) params.set("q", `publish_year:${year}`);
  params.set("limit", "5");
  params.set(
    "fields",
    "key,title,author_name,editions,editions.key,editions.title,editions.isbn,editions.publish_date,editions.publisher,editions.language",
  );

  const url = `https://openlibrary.org/search.json?${params.toString()}`;

  try {
    const response = await lookupRequest(url);

    const data = response.response as any;

    if (data?.numFound > 0 && data.docs && data.docs.length > 0) {
      const candidates: APICandidate[] = [];

      for (const doc of data.docs.slice(0, 5)) {
        // Never combine identifiers or aggregate page counts from different editions.
        for (const edition of doc.editions?.docs || []) {
          const isbn = edition.isbn?.find((value: string) =>
            /^\d{13}$/.test(value),
          );
          const key = edition.key?.replace(/^\/books\//, "");
          if (!key || !/^OL\d+M$/.test(key)) continue;
          const editionURL = `https://openlibrary.org/books/${key}.json`;
          await enrichRuntime.sleep(1100);
          let data: any = {};
          try {
            data = (await lookupRequest(editionURL)).response || {};
          } catch (error) {
            // Keep what the search itself said about this edition.
            ztoolkit.log(`Open Library edition ${key} error: ${error}`);
          }
          const authors = (doc.author_name || []).map((name: string) => ({
            name,
          }));
          const result: EnrichmentResult = {
            title: data.title || edition.title || doc.title,
            author: doc.author_name?.[0],
            authors,
            ISBN: data.isbn_13?.[0] || data.isbn_10?.[0] || isbn,
            publisher: data.publishers?.[0] || edition.publisher?.[0],
            place: data.publish_places?.[0],
            numPages: data.number_of_pages,
            date: (data.publish_date || edition.publish_date?.[0])?.match(
              /\d{4}/,
            )?.[0],
            OCLC: data.oclc_numbers?.[0],
            LCCN: data.lccn?.[0],
            source: editionURL,
          };
          candidates.push({
            title: data.title || edition.title,
            author: doc.author_name?.[0],
            year: result.date,
            publisher: result.publisher,
            isbn: result.ISBN,
            result,
          });
        }
      }

      return {
        candidates,
        bestResult: candidates.length > 0 ? candidates[0].result : null,
      };
    }
  } catch (error) {
    ztoolkit.log(`Open Library search error: ${error}`);
    return {
      candidates: [],
      bestResult: null,
      error: describeSourceFailure(error),
    };
  }

  return { candidates: [], bestResult: null };
}

/**
 * Parse Google Books volumeInfo into EnrichmentResult
 */
function parseGoogleBooksVolume(volumeInfo: any): EnrichmentResult {
  const result: EnrichmentResult = {};

  if (typeof volumeInfo.title === "string" && volumeInfo.title.trim())
    result.title = volumeInfo.title.trim();

  // Get ISBNs from industryIdentifiers
  const identifiers = volumeInfo.industryIdentifiers || [];
  for (const ident of identifiers) {
    if (ident.type === "ISBN_13") {
      result.ISBN = ident.identifier;
      break;
    } else if (ident.type === "ISBN_10" && !result.ISBN) {
      result.ISBN = ident.identifier;
    }
  }

  // Get page count
  if (volumeInfo.pageCount) {
    result.numPages = volumeInfo.pageCount;
  }

  // Get publisher
  if (volumeInfo.publisher) {
    result.publisher = volumeInfo.publisher;
  }

  // Get publication date/year
  if (volumeInfo.publishedDate) {
    const yearMatch = volumeInfo.publishedDate.match(/^(\d{4})/);
    if (yearMatch) {
      result.date = yearMatch[1];
    }
  }

  // Get categories/subjects
  if (volumeInfo.categories && volumeInfo.categories.length > 0) {
    result.tags = volumeInfo.categories.slice(0, 5);
  }

  // Get description/abstract (truncated)
  if (volumeInfo.description) {
    let desc = volumeInfo.description;
    if (desc.length > 500) {
      desc = desc.substring(0, 497) + "...";
    }
    result.abstractNote = desc;
  }

  if (Array.isArray(volumeInfo.authors) && volumeInfo.authors.length) {
    result.authors = volumeInfo.authors.map((name: string) => ({ name }));
    result.author = volumeInfo.authors[0];
  }

  return result;
}

/**
 * Search Google Books for book metadata (fallback)
 * Returns multiple candidates for LLM disambiguation
 */
export async function searchGoogleBooks(
  title: string,
  author: string,
): Promise<SourceSearch> {
  const queryParts: string[] = [];
  if (title) queryParts.push(`intitle:${title}`);
  if (author) queryParts.push(`inauthor:${author}`);

  const query = queryParts.join(" ");
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;
  // The user's own key, if any, goes in a header (never the URL, which
  // Zotero writes to its debug log) and only to googleapis.com.
  const key = getApiKey("googleBooksApiKey");

  try {
    const response = await lookupRequest(
      url,
      key ? { "X-Goog-Api-Key": key } : undefined,
    );

    const data = response.response as any;

    if (data?.totalItems > 0 && data.items && data.items.length > 0) {
      const candidates: APICandidate[] = [];

      for (const item of data.items.slice(0, 5)) {
        const volumeInfo = item.volumeInfo || {};
        const result = parseGoogleBooksVolume(volumeInfo);
        result.source = `https://books.google.com/books?id=${encodeURIComponent(item.id)}`;

        if (Object.keys(result).length > 0) {
          const yearMatch = volumeInfo.publishedDate?.match(/^(\d{4})/);
          candidates.push({
            title: volumeInfo.title,
            author: volumeInfo.authors?.[0],
            year: yearMatch ? yearMatch[1] : undefined,
            publisher: volumeInfo.publisher,
            isbn: result.ISBN,
            result,
          });
        }
      }

      return {
        candidates,
        bestResult: candidates.length > 0 ? candidates[0].result : null,
      };
    }
  } catch (error) {
    ztoolkit.log(`Google Books search error: ${error}`);
    let reason = describeSourceFailure(error);
    if (!key && reason.includes("rate limit"))
      reason = `${reason.slice(0, -1)}; the shared quota is used up, add your own Google Books API key in Settings)`;
    return { candidates: [], bestResult: null, error: reason };
  }

  return { candidates: [], bestResult: null };
}

function crossrefYear(work: any): string | undefined {
  const parts =
    work?.["published-print"]?.["date-parts"]?.[0] ||
    work?.["published-online"]?.["date-parts"]?.[0] ||
    work?.issued?.["date-parts"]?.[0] ||
    work?.created?.["date-parts"]?.[0];
  const year = Array.isArray(parts) ? parts[0] : undefined;
  return Number.isInteger(year) ? String(year) : undefined;
}

function cleanAbstract(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 500 ? `${text.substring(0, 497)}...` : text;
}

const CROSSREF_BOOK_TYPES = [
  "book",
  "monograph",
  "edited-book",
  "reference-book",
];
function isBookWork(work: any): boolean {
  return CROSSREF_BOOK_TYPES.includes(work?.type);
}

function parseCrossrefWork(work: any): EnrichmentResult {
  // Editors are not proposed as authors (the review would add them as such).
  const authors = Array.isArray(work?.author)
    ? work.author
        .map((author: any): EnrichmentAuthor => {
          const parsed: EnrichmentAuthor = {};
          if (typeof author?.given === "string") parsed.given = author.given;
          if (typeof author?.family === "string") parsed.family = author.family;
          if (typeof author?.name === "string") parsed.name = author.name;
          return parsed;
        })
        .filter((author: EnrichmentAuthor) => Boolean(authorLabel(author)))
    : [];
  const doi = typeof work?.DOI === "string" ? work.DOI : undefined;
  const isbns: string[] = Array.isArray(work?.ISBN)
    ? work.ISBN.map((v: unknown) => String(v).replace(/[^0-9Xx]/g, ""))
    : [];
  const isbn = isbns.find((v) => /^\d{13}$/.test(v)) || isbns[0];
  const subtitle = Array.isArray(work?.subtitle) ? work.subtitle[0] : undefined;
  const mainTitle = Array.isArray(work?.title) ? work.title[0] : undefined;
  const result: EnrichmentResult = {
    title:
      isBookWork(work) && mainTitle && subtitle
        ? `${mainTitle}: ${subtitle}`
        : mainTitle,
    ISBN: isbn || undefined,
    place:
      typeof work?.["publisher-location"] === "string"
        ? work["publisher-location"]
        : undefined,
    source:
      typeof work?.URL === "string"
        ? work.URL
        : doi
          ? `https://doi.org/${doi}`
          : undefined,
    author: authorLabel(authors[0]),
    authors,
    DOI: doi,
    publisher: typeof work?.publisher === "string" ? work.publisher : undefined,
    containerTitle: Array.isArray(work?.["container-title"])
      ? work["container-title"][0]
      : undefined,
    volume: typeof work?.volume === "string" ? work.volume : undefined,
    issue: typeof work?.issue === "string" ? work.issue : undefined,
    pages: typeof work?.page === "string" ? work.page : undefined,
    date: crossrefYear(work),
    abstractNote: cleanAbstract(work?.abstract),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as EnrichmentResult;
}

async function fetchCrossrefWork(
  doi: string,
): Promise<EnrichmentResult | null> {
  const normalized = doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "");
  if (!normalized) return null;
  const url = `https://api.crossref.org/works/${encodeURIComponent(normalized)}`;
  let response: any;
  try {
    response = await lookupRequest(url, { "User-Agent": POLITE_USER_AGENT });
  } catch (error) {
    ztoolkit.log(`Crossref DOI lookup error for ${normalized}: ${error}`);
    if (isNotFound(error)) return null;
    throw new LookupFailedError([
      { name: "Crossref", found: 0, error: describeSourceFailure(error) },
    ]);
  }
  try {
    const result = parseCrossrefWork((response.response as any)?.message);
    if (result.DOI && result.title) {
      const expandedTitle = await fetchSemanticScholarTitle(
        result.DOI,
        [result.title, result.author].filter(Boolean).join(" "),
      );
      const crossrefTitle = normalize(result.title);
      const semanticTitle = normalize(expandedTitle || "");
      if (
        expandedTitle &&
        semanticTitle.length > crossrefTitle.length &&
        semanticTitle.includes(crossrefTitle)
      ) {
        result.title = expandedTitle;
      }
    }
    return result.DOI ? result : null;
  } catch (error) {
    ztoolkit.log(`Crossref DOI lookup error for ${normalized}: ${error}`);
    return null;
  }
}

async function fetchSemanticScholarTitle(
  doi: string,
  query = "",
): Promise<string | undefined> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title`;
  for (const delay of [0, 1200]) {
    if (delay) await enrichRuntime.sleep(delay);
    try {
      const response = await lookupRequest(url, {
        "User-Agent": POLITE_USER_AGENT,
      });
      const title = (response.response as any)?.title;
      if (typeof title === "string" && title.trim()) return title.trim();
      return undefined;
    } catch (error) {
      const message = String(error);
      ztoolkit.log(`Semantic Scholar title lookup error: ${message}`);
      if (!/429|too many requests|rate limit/i.test(message) || delay === 1200)
        break;
    }
  }

  if (!query) return undefined;
  const searchURL = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=10&fields=title,externalIds`;
  try {
    const response = await lookupRequest(searchURL, {
      "User-Agent": POLITE_USER_AGENT,
    });
    const normalizedDOI = doi.trim().toLowerCase();
    const match = ((response.response as any)?.data || []).find(
      (paper: any) =>
        typeof paper?.title === "string" &&
        String(paper?.externalIds?.DOI || "")
          .trim()
          .toLowerCase() === normalizedDOI,
    );
    return typeof match?.title === "string" && match.title.trim()
      ? match.title.trim()
      : undefined;
  } catch (error) {
    ztoolkit.log(`Semantic Scholar search title lookup error: ${error}`);
    return undefined;
  }
}

export async function searchCrossref(
  title: string,
  author: string,
  _year: number | null,
  options: { books?: boolean } = {},
): Promise<SourceSearch> {
  const params = new URLSearchParams({
    "query.bibliographic": [title, author].filter(Boolean).join(" "),
    rows: "5",
    select:
      "DOI,URL,title,author,publisher,container-title,volume,issue,page,published-print,published-online,created,abstract" +
      (options.books ? ",subtitle,ISBN,publisher-location,type,issued" : ""),
  });
  if (options.books)
    params.set(
      "filter",
      CROSSREF_BOOK_TYPES.map((type) => `type:${type}`).join(","),
    );
  const url = `https://api.crossref.org/works?${params.toString()}`;
  try {
    const response = await lookupRequest(url, {
      "User-Agent": POLITE_USER_AGENT,
    });
    const items = (response.response as any)?.message?.items;
    const candidates = Array.isArray(items)
      ? items
          .map((work: any) => {
            const result = parseCrossrefWork(work);
            return {
              title: result.title,
              author: result.author,
              year: result.date,
              publisher: result.publisher,
              isbn: result.ISBN,
              result,
            } satisfies APICandidate;
          })
          .filter(
            (candidate: APICandidate) =>
              Boolean(candidate.title) && Boolean(candidate.result.DOI),
          )
      : [];
    return {
      candidates,
      bestResult: candidates.length ? addCandidateAuthor(candidates[0]) : null,
    };
  } catch (error) {
    ztoolkit.log(`Crossref search error: ${error}`);
    return {
      candidates: [],
      bestResult: null,
      error: describeSourceFailure(error),
    };
  }
}

// ==================== Reviewable enrichment ====================

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "Main title: subtitle" split on the first colon. */
function splitTitle(title: string): { main: string; sub: string } {
  const [main, ...rest] = title.split(/\s*:\s+/);
  return { main: normalize(main), sub: normalize(rest.join(" ")) };
}

/**
 * Titles match when identical, or when they differ only by a subtitle that one
 * side lacks (catalogues add subtitles; Zotero records often omit them). Two
 * different subtitles are different books.
 */
export function titlesMatch(a: string, b: string): boolean {
  if (normalize(a) === normalize(b)) return true;
  const x = splitTitle(a);
  const y = splitTitle(b);
  return Boolean(x.main) && x.main === y.main && (!x.sub || !y.sub);
}

/**
 * Surname-based and case-insensitive: "Marazzi" and "Martino Marazzi" both
 * match a catalogue's "MARAZZI" or "Marazzi, Martino".
 */
export function authorMatches(candidateAuthor: string, author: string) {
  const wanted = normalize(author);
  if (!wanted) return true;
  const have = ` ${normalize(candidateAuthor)} `;
  if (have.includes(` ${wanted} `)) return true;
  const surname = wanted.split(" ").pop();
  return Boolean(surname) && have.includes(` ${surname} `);
}

export async function selectBestCandidate(
  title: string,
  author: string,
  year: number | null,
  candidates: APICandidate[],
  options: {
    allowArticleYearMismatch?: boolean;
    returnAmbiguous?: boolean;
  } = {},
): Promise<EnrichmentResult | null> {
  const normalizedTitle = normalize(title);
  const identityMatches = candidates.filter(
    (c) =>
      (titlesMatch(c.title || "", title) ||
        (options.allowArticleYearMismatch &&
          (normalize(c.title || "").includes(normalizedTitle) ||
            normalizedTitle.includes(normalize(c.title || ""))))) &&
      authorMatches(c.author || "", author),
  );
  const suitable = identityMatches.filter(
    (c) => year === null || c.year === String(year),
  );
  // A single candidate with all supplied identifying fields matched is safe
  // to review even when one field is missing from the Zotero item. This lets
  // the review UI repair incomplete records instead of silently dropping them.
  if (suitable.length === 1) return addCandidateAuthor(suitable[0]);
  if (
    options.allowArticleYearMismatch &&
    suitable.length === 0 &&
    identityMatches.length === 1
  )
    return addCandidateAuthor(identityMatches[0]);
  if (options.returnAmbiguous && suitable.length > 1)
    return { candidates: suitable };
  if (!suitable.length || !isLLMAvailable()) {
    if (options.returnAmbiguous && suitable.length > 1)
      return { candidates: suitable };
    if (
      options.returnAmbiguous &&
      options.allowArticleYearMismatch &&
      identityMatches.length > 1
    )
      return { candidates: identityMatches };
    return null;
  }
  const choice = await llmDisambiguate(title, author, year, suitable);
  if (!choice || choice.selectedIndex === null || choice.confidence < 0.9)
    return options.returnAmbiguous ? { candidates: suitable } : null;
  const selected = suitable[choice.selectedIndex];
  return selected ? addCandidateAuthor(selected) : null;
}

/** Normalised main title + first-author surname: the identity of a work. */
function workKey(c: APICandidate): string {
  const surname = normalize(c.author || "")
    .split(" ")
    .filter((part) => part.length > 1 || /\d/.test(part))
    .pop();
  return `${splitTitle(c.title || "").main}|${surname || ""}`;
}

/**
 * Add `incoming` to `merged`, folding duplicates from different catalogs into
 * one record: same ISBN, or (when either side has no ISBN) the same main
 * title, first-author surname and year. Fields missing from the earlier record
 * are filled from the later one; nothing already present is overwritten.
 * Records with different ISBNs, or different or unknown years without an ISBN
 * to tie them, are different editions and stay separate.
 */
export function mergeCandidates(
  merged: APICandidate[],
  incoming: APICandidate[],
): APICandidate[] {
  const out = merged.map((c) => ({ ...c, result: { ...c.result } }));
  for (const c of incoming) {
    const isbn = c.isbn ? canonicalISBN(c.isbn) : "";
    const twin = out.find((m) => {
      const mi = m.isbn ? canonicalISBN(m.isbn) : "";
      if (isbn && mi) return isbn === mi;
      return (
        workKey(m) === workKey(c) &&
        Boolean(m.year) &&
        m.year === c.year &&
        Boolean(splitTitle(c.title || "").main)
      );
    });
    if (!twin) {
      out.push({ ...c, result: { ...c.result } });
      continue;
    }
    const target = twin.result as Record<string, unknown>;
    for (const [key, value] of Object.entries(c.result)) {
      if (key === "candidates" || value === undefined || value === "") continue;
      if (Array.isArray(value) && !value.length) continue;
      const current = target[key];
      if (
        current === undefined ||
        current === "" ||
        (Array.isArray(current) && !current.length)
      )
        target[key] = value;
    }
    twin.isbn ||= c.isbn;
    twin.year ||= c.year;
    twin.publisher ||= c.publisher;
    twin.author ||= c.author;
  }
  return out;
}

/**
 * Open Library's free-text search (`q=`): a last resort when the structured
 * title/author search misses (it tolerates odd catalogue records). Each work
 * contributes its best-matching edition only, so an ISBN, publisher and year
 * always describe the same edition.
 */
export async function searchOpenLibraryGeneral(
  title: string,
  author: string,
): Promise<SourceSearch> {
  const params = new URLSearchParams({
    q: [title, author].filter(Boolean).join(" "),
    limit: "5",
    fields:
      "key,title,author_name,editions,editions.key,editions.title,editions.isbn,editions.publish_date,editions.publisher",
  });
  try {
    const response = await lookupRequest(
      `https://openlibrary.org/search.json?${params.toString()}`,
    );
    const docs = (response.response as any)?.docs;
    const candidates: APICandidate[] = [];
    for (const doc of Array.isArray(docs) ? docs : []) {
      const edition = doc?.editions?.docs?.[0] || {};
      const editionTitle = edition.title || doc?.title;
      if (typeof editionTitle !== "string" || !editionTitle.trim()) continue;
      const isbns: string[] = Array.isArray(edition.isbn) ? edition.isbn : [];
      const isbn =
        isbns.find((v) => /^\d{13}$/.test(v)) ||
        isbns.find((v) => /^\d{9}[\dX]$/.test(v));
      const authors = (Array.isArray(doc.author_name) ? doc.author_name : [])
        .filter((name: unknown) => typeof name === "string" && name.trim())
        .map((name: string) => ({ name }));
      const date = String(edition.publish_date?.[0] ?? "").match(/\d{4}/)?.[0];
      const key = String(edition.key || doc.key || "");
      const result: EnrichmentResult = {
        title: editionTitle,
        author: authors[0]?.name,
        authors,
        ISBN: isbn,
        publisher: edition.publisher?.[0],
        date,
        source: /^\/(books|works)\/OL\d+[MW]$/.test(key)
          ? `https://openlibrary.org${key}`
          : undefined,
      };
      candidates.push({
        title: editionTitle,
        author: result.author,
        year: date,
        publisher: result.publisher,
        isbn,
        result: Object.fromEntries(
          Object.entries(result).filter(([, v]) => v !== undefined),
        ) as EnrichmentResult,
      });
    }
    return { candidates, bestResult: candidates[0]?.result ?? null };
  } catch (error) {
    ztoolkit.log(`Open Library free-text search error: ${error}`);
    return {
      candidates: [],
      bestResult: null,
      error: describeSourceFailure(error),
    };
  }
}

function isIdentityMatch(
  c: APICandidate,
  title: string,
  author: string,
  year: number | null,
): boolean {
  return (
    titlesMatch(c.title || "", title) &&
    authorMatches(c.author || "", author) &&
    (year === null || c.year === String(year))
  );
}

async function runSource(
  name: string,
  search: () => Promise<SourceSearch>,
): Promise<{ report: SourceReport; candidates: APICandidate[] }> {
  let found: SourceSearch;
  try {
    found = await search();
  } catch (error) {
    found = {
      candidates: [],
      bestResult: null,
      error: describeSourceFailure(error),
    };
  }
  return {
    report: { name, found: found.candidates.length, error: found.error },
    candidates: found.candidates,
  };
}

/**
 * Search the book catalogs for an item without an ISBN: Open Library
 * (structured), Crossref (book types only) and Google Books together, then
 * Open Library's free-text search as a last resort if none of them has a
 * title + author (+ year) match. Candidates from all of them are merged and
 * de-duplicated before anything is chosen. One catalog failing never stops
 * the others; each one's outcome is reported.
 */
export async function searchBookSources(
  title: string,
  author: string,
  year: number | null,
): Promise<{ candidates: APICandidate[]; sources: SourceReport[] }> {
  const first = await Promise.all([
    runSource("Open Library", () => searchOpenLibrary(title, author, year)),
    runSource("Crossref", () =>
      searchCrossref(title, author, year, { books: true }),
    ),
    runSource("Google Books", () => searchGoogleBooks(title, author)),
  ]);
  let merged: APICandidate[] = [];
  for (const { candidates } of first)
    merged = mergeCandidates(merged, candidates);
  const sources = first.map(({ report }) => report);
  if (!merged.some((c) => isIdentityMatch(c, title, author, year))) {
    // Open Library again, so keep its pacing.
    await enrichRuntime.sleep(1100);
    const general = await runSource("Open Library", () =>
      searchOpenLibraryGeneral(title, author),
    );
    merged = mergeCandidates(merged, general.candidates);
    sources.push(general.report);
  }
  return { candidates: merged, sources };
}

/**
 * "Crossref had a server error (503); Google Books refused the request (rate
 * limit). Open Library found no match." Null when no catalog failed.
 */
export function describeSearchFailures(sources: SourceReport[]): string | null {
  const failed = new Map<string, string>();
  for (const s of sources)
    if (s.error && !failed.has(s.name)) failed.set(s.name, s.error);
  if (!failed.size) return null;
  const empty = [
    ...new Set(sources.filter((s) => !failed.has(s.name)).map((s) => s.name)),
  ];
  const text = [...failed]
    .map(([name, error]) => `${name} ${error}`)
    .join("; ");
  return empty.length
    ? `${text}. ${empty.join(" and ")} found no match.`
    : `${text}.`;
}

export async function lookupItem(
  item: Zotero.Item,
): Promise<EnrichmentResult | null> {
  if (!isEnrichableItem(item)) return null;
  // Keys (the AI provider's, a Google Books key) come from the login manager.
  await migrateKeysFromPrefs();
  if (item.itemType !== "book") {
    const existingDOI = String(item.getField("DOI") || "").trim();
    if (existingDOI) return fetchCrossrefWork(existingDOI);
    const title = String(item.getField("title") || "");
    if (!title) return null;
    const author = getFirstAuthor(item);
    const year = getYearFromItem(item);
    const crossref = await searchCrossref(title, author, year);
    const reports: SourceReport[] = [
      {
        name: "Crossref",
        found: crossref.candidates.length,
        error: crossref.error,
      },
    ];
    let result = await selectBestCandidate(
      title,
      author,
      year,
      crossref.candidates,
      { allowArticleYearMismatch: true, returnAmbiguous: true },
    );
    if (!result && isLLMAvailable()) {
      const cleaned = await llmCleanupQuery(title, author);
      if (cleaned && (cleaned.title !== title || cleaned.author !== author)) {
        const retry = await searchCrossref(cleaned.title, cleaned.author, year);
        reports.push({
          name: "Crossref",
          found: retry.candidates.length,
          error: retry.error,
        });
        result = await selectBestCandidate(
          cleaned.title,
          cleaned.author,
          year,
          retry.candidates,
          { allowArticleYearMismatch: true, returnAmbiguous: true },
        );
      }
    }
    if (!result && reports.some((r) => r.error))
      throw new LookupFailedError(reports);
    return result;
  }
  const existingISBN = String(item.getField("ISBN") || "").trim();
  if (existingISBN) {
    const isbn = existingISBN
      .split(/[;,\n]/)
      .map((value) => value.replace(/[-\s]/g, "").toUpperCase())
      .find(validISBN);
    // Do not reinterpret a malformed identifier as permission to choose another edition.
    return isbn ? fetchOpenLibraryEdition(isbn) : null;
  }
  const title = String(item.getField("title") || "");
  if (!title) return null;
  const author = getFirstAuthor(item);
  const year = getYearFromItem(item);
  const first = await searchBookSources(title, author, year);
  const reports = [...first.sources];
  let result = await selectBestCandidate(
    title,
    author,
    year,
    first.candidates,
    { returnAmbiguous: true },
  );
  if (result?.candidates?.length) return result;
  if (!result && isLLMAvailable()) {
    const cleaned = await llmCleanupQuery(title, author);
    if (cleaned && (cleaned.title !== title || cleaned.author !== author)) {
      await enrichRuntime.sleep(1100);
      const retry = await searchBookSources(
        cleaned.title,
        cleaned.author,
        year,
      );
      reports.push(...retry.sources);
      result = await selectBestCandidate(
        cleaned.title,
        cleaned.author,
        year,
        retry.candidates,
        { returnAmbiguous: true },
      );
    }
  }
  // A catalog that refused or failed is not the same as "not found".
  if (!result && reports.some((r) => r.error))
    throw new LookupFailedError(reports);
  if (result && year !== null && year < 1970 && getPref("enrichPreIsbn")) {
    // A historical edition must not inherit a later reprint's ISBN.
    delete result.ISBN;
  }
  return result;
}

export async function enrichItem(item: Zotero.Item): Promise<boolean> {
  const result = await lookupItem(item);
  if (!result) return false;
  const { openEnrichmentReview } = await import("./enrichmentReview");
  openEnrichmentReview([{ item, result }]);
  return true;
}

/**
 * No lookup may stay "pending" longer than this. Individual calls have their
 * own timeouts (10 s lookups, 30 s catalog and model calls); this bounds the
 * sum, including anything that has no timeout of its own.
 */
export const LOOKUP_DEADLINE_MS = 3 * 60 * 1000;

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const pending = new Set<number>();
export async function enrichItems(
  items: Zotero.Item[],
  progressCallback?: (current: number, total: number, title: string) => void,
  options: EnrichmentOptions = {},
): Promise<EnrichmentStats> {
  const stats: EnrichmentStats = {
    found: 0,
    notFound: 0,
    preIsbn: 0,
    skipped: 0,
    alreadyRunning: 0,
    failed: 0,
    proposals: [],
    errors: [],
  };
  for (const [index, item] of items.entries()) {
    if (!isEnrichableItem(item)) {
      stats.skipped++;
      continue;
    }
    if (pending.has(item.id)) {
      stats.alreadyRunning++;
      continue;
    }
    pending.add(item.id);
    try {
      progressCallback?.(
        index + 1,
        items.length,
        String(item.getField("title")),
      );
      const result = await withDeadline(
        lookupItem(item),
        LOOKUP_DEADLINE_MS,
        `Lookup timed out after ${Math.round(LOOKUP_DEADLINE_MS / 1000)} s`,
      );
      if (result) {
        stats.proposals.push({ item, result });
        stats.found++;
      } else stats.notFound++;
    } catch (error) {
      stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`${String(item.getField("title"))}: ${message}`);
      ztoolkit.log(`Metadata lookup failed: ${message}`);
    } finally {
      pending.delete(item.id);
    }
    await enrichRuntime.sleep(
      Math.max(1100, Number(getPref("apiDelayMs")) || 1100),
    );
  }
  if (stats.proposals.length && options.openReview !== false) {
    openEnrichmentReview(stats.proposals);
  }
  return stats;
}

/** What to tell the user when a manual lookup produced nothing to review. */
export function noSuggestionMessage(stats: EnrichmentStats): string {
  const failed = stats.failed ?? 0;
  if (stats.alreadyRunning && !stats.notFound && !stats.skipped && !failed)
    return stats.alreadyRunning === 1
      ? "A lookup for this item is already running."
      : `Lookups for these ${stats.alreadyRunning} items are already running.`;
  const others: string[] = [];
  if (stats.notFound) others.push(`${stats.notFound} unresolved`);
  if (stats.skipped) others.push(`${stats.skipped} not eligible`);
  if (stats.alreadyRunning)
    others.push(`${stats.alreadyRunning} already running`);
  if (failed) {
    const first = stats.errors[0] ?? "";
    const head =
      failed === 1
        ? `The lookup could not be completed. ${first}`
        : `${failed} lookups could not be completed. First: ${first}`;
    return others.length ? `${head} (Also: ${others.join("; ")}.)` : head;
  }
  return `No matching metadata found (${others.join("; ") || "0 unresolved"}).`;
}

export class EnrichmentFactory {
  static async enrichSelectedItems(): Promise<void> {
    const items = Zotero.getActiveZoteroPane()?.getSelectedItems() ?? [];
    if (!items.length) {
      Zotero.alert(
        Zotero.getMainWindow(),
        "CUNY AI Lab Metadata Assistant",
        "Select at least one book or scholarly article first.",
      );
      return;
    }
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: "Looking up metadata…", progress: 0 })
      .show(-1); // stay open until the lookup finishes (default auto-closes after 5 s)
    let popupClosed = false;
    try {
      const stats = await enrichItems(
        items,
        (current, total, title) =>
          popup.changeLine({
            text: `Looking up ${current}/${total}: ${title}`,
            progress: Math.round(((current - 1) / total) * 100),
          }),
        { openReview: false },
      );
      if (stats.proposals.length) {
        popup.close();
        popupClosed = true;
        await enrichRuntime.sleep(0);
        openEnrichmentReview(stats.proposals);
      } else {
        const message = noSuggestionMessage(stats);
        popup.changeLine({
          text: message,
          progress: 100,
        });
        Zotero.alert(
          Zotero.getMainWindow(),
          "CUNY AI Lab Metadata Assistant",
          message,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ztoolkit.log(`Metadata review failed: ${message}`);
      Zotero.alert(
        Zotero.getMainWindow(),
        "CUNY AI Lab Metadata Assistant",
        `Metadata review failed: ${message}`,
      );
      if (popupClosed) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: `Metadata review failed: ${message}` })
          .show();
      } else {
        popup.changeLine({
          text: `Metadata review failed: ${message}`,
          progress: 100,
        });
      }
    } finally {
      if (!popupClosed) popup.startCloseTimer(5000);
    }
  }
}
