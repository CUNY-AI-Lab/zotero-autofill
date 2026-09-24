/**
 * Enrichment module for Zotero Metadata Assistant
 * Searches Open Library, Google Books, and Crossref to fill missing metadata
 * Includes LLM-enhanced features: fuzzy matching fallback and disambiguation
 */

import { getPref } from "../utils/prefs";
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
  preIsbn: number;
  skipped: number;
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
      await sleep(Math.max(1100, Number(getPref("apiDelayMs")) || 1100));
      const response = await Zotero.HTTP.request(
        "GET",
        `https://openlibrary.org${key}.json`,
        { timeout: 10000, responseType: "json" },
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

  try {
    const response = await Zotero.HTTP.request("GET", url, {
      timeout: 10000,
      responseType: "json",
    });

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
    ztoolkit.log(`Open Library edition fetch error for ISBN ${isbn}: ${error}`);
    return null;
  }
}

/**
 * Search Open Library for book metadata
 * Returns multiple candidates for LLM disambiguation
 */
export async function searchOpenLibrary(
  title: string,
  author: string,
  year: number | null,
): Promise<{
  candidates: APICandidate[];
  bestResult: EnrichmentResult | null;
}> {
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
    const response = await Zotero.HTTP.request("GET", url, {
      timeout: 10000,
      responseType: "json",
    });

    const data = response.response as any;

    if (data.numFound > 0 && data.docs && data.docs.length > 0) {
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
          await sleep(1100);
          const detail = await Zotero.HTTP.request("GET", editionURL, {
            timeout: 10000,
            responseType: "json",
          });
          const data = detail.response as any;
          const authors = (doc.author_name || []).map((name: string) => ({
            name,
          }));
          const result: EnrichmentResult = {
            title: data.title || edition.title || doc.title,
            author: doc.author_name?.[0],
            authors,
            ISBN: data.isbn_13?.[0] || data.isbn_10?.[0] || isbn,
            publisher: data.publishers?.[0],
            place: data.publish_places?.[0],
            numPages: data.number_of_pages,
            date: data.publish_date?.match(/\d{4}/)?.[0],
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
): Promise<{
  candidates: APICandidate[];
  bestResult: EnrichmentResult | null;
}> {
  const queryParts: string[] = [];
  if (title) queryParts.push(`intitle:${title}`);
  if (author) queryParts.push(`inauthor:${author}`);

  const query = queryParts.join(" ");
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;

  try {
    const response = await Zotero.HTTP.request("GET", url, {
      timeout: 10000,
      responseType: "json",
    });

    const data = response.response as any;

    if (data.totalItems > 0 && data.items && data.items.length > 0) {
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

function parseCrossrefWork(work: any): EnrichmentResult {
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
  const result: EnrichmentResult = {
    title: Array.isArray(work?.title) ? work.title[0] : undefined,
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
  try {
    const response = await Zotero.HTTP.request("GET", url, {
      headers: {
        "User-Agent":
          "Zotero Metadata Assistant/1.0 (https://github.com/CUNY-AI-Lab/zotero-autofill)",
      },
      timeout: 10000,
      responseType: "json",
    });
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
    if (delay) await sleep(delay);
    try {
      const response = await Zotero.HTTP.request("GET", url, {
        headers: {
          "User-Agent":
            "Zotero Metadata Assistant/1.0 (https://github.com/CUNY-AI-Lab/zotero-autofill)",
        },
        timeout: 10000,
        responseType: "json",
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
    const response = await Zotero.HTTP.request("GET", searchURL, {
      headers: {
        "User-Agent":
          "Zotero Metadata Assistant/1.0 (https://github.com/CUNY-AI-Lab/zotero-autofill)",
      },
      timeout: 10000,
      responseType: "json",
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
  year: number | null,
): Promise<{
  candidates: APICandidate[];
  bestResult: EnrichmentResult | null;
}> {
  const params = new URLSearchParams({
    "query.bibliographic": [title, author].filter(Boolean).join(" "),
    rows: "5",
    select:
      "DOI,URL,title,author,publisher,container-title,volume,issue,page,published-print,published-online,created,abstract",
  });
  const url = `https://api.crossref.org/works?${params.toString()}`;
  try {
    const response = await Zotero.HTTP.request("GET", url, {
      headers: {
        "User-Agent":
          "Zotero Metadata Assistant/1.0 (https://github.com/CUNY-AI-Lab/zotero-autofill)",
      },
      timeout: 10000,
      responseType: "json",
    });
    const items = (response.response as any)?.message?.items;
    const candidates = Array.isArray(items)
      ? items
          .map((work: any) => {
            const result = parseCrossrefWork(work);
            return {
              title: Array.isArray(work?.title) ? work.title[0] : undefined,
              author: result.author,
              year: result.date,
              publisher: result.publisher,
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
    return { candidates: [], bestResult: null };
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
      (normalize(c.title || "") === normalizedTitle ||
        (options.allowArticleYearMismatch &&
          (normalize(c.title || "").includes(normalizedTitle) ||
            normalizedTitle.includes(normalize(c.title || ""))))) &&
      (!author ||
        ` ${normalize(c.author || "")} `.includes(` ${normalize(author)} `)),
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

export async function lookupItem(
  item: Zotero.Item,
): Promise<EnrichmentResult | null> {
  if (!isEnrichableItem(item)) return null;
  if (item.itemType !== "book") {
    const existingDOI = String(item.getField("DOI") || "").trim();
    if (existingDOI) return fetchCrossrefWork(existingDOI);
    const title = String(item.getField("title") || "");
    if (!title) return null;
    const author = getFirstAuthor(item);
    const year = getYearFromItem(item);
    const crossref = await searchCrossref(title, author, year);
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
        result = await selectBestCandidate(
          cleaned.title,
          cleaned.author,
          year,
          retry.candidates,
          { allowArticleYearMismatch: true, returnAmbiguous: true },
        );
      }
    }
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
  const open = await searchOpenLibrary(title, author, year);
  let result = await selectBestCandidate(title, author, year, open.candidates, {
    returnAmbiguous: true,
  });
  if (result?.candidates?.length) return result;
  if (!result) {
    await sleep(1100);
    const google = await searchGoogleBooks(title, author);
    result = await selectBestCandidate(title, author, year, google.candidates, {
      returnAmbiguous: true,
    });
    if (result?.candidates?.length) return result;
  }
  if (!result && isLLMAvailable()) {
    const cleaned = await llmCleanupQuery(title, author);
    if (cleaned && (cleaned.title !== title || cleaned.author !== author)) {
      await sleep(1100);
      const retry = await searchOpenLibrary(
        cleaned.title,
        cleaned.author,
        year,
      );
      result = await selectBestCandidate(
        cleaned.title,
        cleaned.author,
        year,
        retry.candidates,
        { returnAmbiguous: true },
      );
    }
  }
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
    proposals: [],
    errors: [],
  };
  for (const [index, item] of items.entries()) {
    if (!isEnrichableItem(item) || pending.has(item.id)) {
      stats.skipped++;
      continue;
    }
    pending.add(item.id);
    try {
      progressCallback?.(
        index + 1,
        items.length,
        String(item.getField("title")),
      );
      const result = await lookupItem(item);
      if (result) {
        stats.proposals.push({ item, result });
        stats.found++;
      } else stats.notFound++;
    } catch (error) {
      stats.notFound++;
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`${String(item.getField("title"))}: ${message}`);
      ztoolkit.log(`Metadata lookup failed: ${message}`);
    } finally {
      pending.delete(item.id);
    }
    await sleep(Math.max(1100, Number(getPref("apiDelayMs")) || 1100));
  }
  if (stats.proposals.length && options.openReview !== false) {
    openEnrichmentReview(stats.proposals);
  }
  return stats;
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
      .createLine({ text: "Looking up metadata…" })
      .show();
    let popupClosed = false;
    try {
      const stats = await enrichItems(items, undefined, { openReview: false });
      if (stats.proposals.length) {
        popup.close();
        popupClosed = true;
        await sleep(0);
        openEnrichmentReview(stats.proposals);
      } else {
        const message = stats.errors.length
          ? `No suggestions found. ${stats.errors[0]}`
          : `No matching metadata found (${stats.notFound} unresolved; ${stats.skipped} skipped).`;
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
