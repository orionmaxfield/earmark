/* Book sources, called only from Earmark's server (never from the browser):
     Open Library              openlibrary.org/search.json           (by title and author, or by ISBN)
     Google Books              www.googleapis.com/books/v1/volumes   (the same)
   Audible's catalog (and Audnexus, which is built from it) is never asked: Audible's Conditions of Use rule out
   collecting its product listings. Neither source has narrators or audiobook lengths, only page counts.
   Each call has a time limit. A source that fails (timeout, 5xx, 429) is skipped for a while, so a source that's down
   or limiting us isn't hammered and searches fall through to the next one. Calls to one source are spaced out a little. */

const UA = "Earmark/0.13 (audiobook listening tracker; book lookups)";
// where each source lives. BOOK_SOURCES_TEST (unset in production) points them at a local stand-in for testing.
const BASE = { openlibrary: "https://openlibrary.org", googlebooks: "https://www.googleapis.com" };
let base = BASE;
export function configure(env) {
  try { base = env && env.BOOK_SOURCES_TEST ? { ...BASE, ...JSON.parse(env.BOOK_SOURCES_TEST) } : BASE; } catch { base = BASE; }
}

// a source that failed is skipped until this time (per worker instance)
const downUntil = {};
export const isDown = src => (downUntil[src] || 0) > Date.now();
function markDown(src, res) {
  const retry = res && +res.headers.get("retry-after");
  downUntil[src] = Date.now() + Math.min(30 * 60, retry > 0 ? retry : res && res.status === 429 ? 10 * 60 : 3 * 60) * 1000;
}
// at most a few calls to one source at once, spaced a little apart
const lanes = {};
async function lane(src, gapMs, fn) {
  const l = lanes[src] || (lanes[src] = { busy: 0, last: 0, queue: [] });
  while (l.busy >= 4) await new Promise(r => l.queue.push(r));
  l.busy++;
  const wait = l.last + gapMs - Date.now();
  l.last = Math.max(Date.now(), l.last + gapMs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  try { return await fn(); } finally { l.busy--; const next = l.queue.shift(); if (next) next(); }
}

export class SourceError extends Error { constructor(src, msg) { super(`${src}: ${msg}`); this.src = src; } }
async function getJSON(src, url, { timeout = 6000, gap = 120 } = {}) {
  if (isDown(src)) throw new SourceError(src, "skipped for now (it failed recently)");
  return lane(src, gap, async () => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    let res;
    try { res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: ctl.signal }); }
    catch (err) { markDown(src); throw new SourceError(src, err.name === "AbortError" ? "timed out" : "unreachable"); }
    finally { clearTimeout(timer); }
    if (res.status === 404) return null;
    if (!res.ok) { if (res.status === 429 || res.status >= 500) markDown(src, res); throw new SourceError(src, `HTTP ${res.status}`); }
    try { return await res.json(); } catch { throw new SourceError(src, "answer wasn't JSON"); }
  });
}

/* ---- one shape for every source ----
   { t, subtitle, author, narrator, series, num, minutes (exact runtime) | pages/words (for an estimate),
     cover, year, subjects, asin, isbn, src, key } */
function fromOpenLibrary(d) {
  if (!d || !d.title) return null;
  return {
    t: d.title, author: (d.author_name || [])[0] || null, year: d.first_publish_year || null, pages: d.number_of_pages_median || null,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null, subjects: d.subject || [], editions: d.edition_count || 0,
    isbn: (d.isbn || [])[0] || null, src: "openlibrary", key: d.key,
  };
}
function fromGoogle(it) {
  const v = (it && it.volumeInfo) || {}, img = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
  if (!v.title) return null;
  const isbn = (v.industryIdentifiers || []).find(x => x.type === "ISBN_13") || (v.industryIdentifiers || [])[0];
  return {
    t: v.title, author: (v.authors || [])[0] || null, year: v.publishedDate ? +String(v.publishedDate).slice(0, 4) || null : null, pages: v.pageCount || null,
    cover: img ? img.replace(/^http:/, "https:").replace("&edge=curl", "") : null, subjects: v.categories || [], isbn: isbn ? isbn.identifier : null,
    src: "googlebooks", key: it.id,
  };
}

/* ---- the calls ---- */
export async function openLibrarySearch(q) {
  const j = await getJSON("openlibrary", `${base.openlibrary}/search.json?q=${encodeURIComponent(q)}&limit=25&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject,edition_count,isbn`);
  return ((j && j.docs) || []).map(fromOpenLibrary).filter(Boolean);
}
export async function googleSearch(q) {
  const j = await getJSON("googlebooks", `${base.googlebooks}/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&printType=books`);
  return ((j && j.items) || []).map(fromGoogle).filter(Boolean);
}
// one book by ISBN (an all-digit Audible ID is the ISBN-10 of that edition)
export async function openLibraryByIsbn(isbn) {
  const j = await getJSON("openlibrary", `${base.openlibrary}/search.json?isbn=${encodeURIComponent(isbn)}&limit=3&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject,edition_count,isbn`);
  return ((j && j.docs) || []).map(fromOpenLibrary).filter(Boolean).map(b => ({ ...b, isbn }));
}
export async function googleByIsbn(isbn) {
  const j = await getJSON("googlebooks", `${base.googlebooks}/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=3`);
  return ((j && j.items) || []).map(fromGoogle).filter(Boolean);
}
