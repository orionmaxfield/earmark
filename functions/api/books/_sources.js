/* Book sources, called only from Earmark's server (never from the browser):
     Audible's public catalog  api.audible.com/1.0/catalog/products  (search by keywords, or up to 50 ASINs at once)
     Audnexus                  api.audnex.us/books/{ASIN}               (one book by ASIN: runtime, narrators, series, cover)
     Open Library              openlibrary.org/search.json
     Google Books              www.googleapis.com/books/v1/volumes
   Each call has a time limit. A source that fails (timeout, 5xx, 429) is skipped for a while, so a source that's down
   or limiting us isn't hammered and searches fall through to the next one. Calls to one source are spaced out a little. */

const UA = "Earmark/0.13 (audiobook listening tracker; book lookups)";
// where each source lives. BOOK_SOURCES_TEST (unset in production) points them at a local stand-in for testing.
const BASE = { audible: "https://api.audible.com", audnexus: "https://api.audnex.us", openlibrary: "https://openlibrary.org", googlebooks: "https://www.googleapis.com" };
let base = BASE;
export function configure(env) {
  try { base = env && env.BOOK_SOURCES_TEST ? { ...BASE, ...JSON.parse(env.BOOK_SOURCES_TEST) } : BASE; } catch { base = BASE; }
}
const AUDIBLE = () => `${base.audible}/1.0/catalog/products`;
const AUDIBLE_GROUPS = "contributors,media,product_attrs,series,category_ladders";

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
const names = list => (list || []).map(x => (x && (x.name || x)) || "").filter(Boolean);
const firstNum = v => { const n = parseFloat(String(v || "").replace(/[^\d.]/g, "")); return isFinite(n) && n > 0 ? n : null; };
const bigCover = url => url ? url.replace(/\._[^.]+_\.(jpg|png)$/i, "._SL500_.$1") : null;

function fromAudible(p) {
  if (!p || !p.asin || !p.title) return null;
  if (/podcast/i.test(p.content_type || "") || /PodcastParent|PodcastEpisode|Periodical/i.test(p.content_delivery_type || "")) return null;
  const s = (p.series || [])[0], img = p.product_images || {};
  return {
    t: p.title, subtitle: p.subtitle || null, author: names(p.authors).join(", ") || null, narrator: names(p.narrators).join(", ") || null,
    series: s ? s.title : null, num: s ? firstNum(s.sequence) : null, minutes: p.runtime_length_min > 0 ? p.runtime_length_min : null,
    cover: img["500"] || bigCover(Object.values(img)[0]) || null, year: p.release_date ? +String(p.release_date).slice(0, 4) || null : null,
    subjects: (p.category_ladders || []).flatMap(l => (l.ladder || []).map(c => c.name)), asin: p.asin, isbn: p.isbn || null, src: "audible", key: p.asin,
  };
}
function fromAudnexus(b) {
  if (!b || !b.asin || !b.title) return null;
  const s = b.seriesPrimary || null;
  return {
    t: b.title, subtitle: b.subtitle || null, author: names(b.authors).join(", ") || null, narrator: names(b.narrators).join(", ") || null,
    series: s ? s.name : null, num: s ? firstNum(s.position) : null, minutes: b.runtimeLengthMin > 0 ? b.runtimeLengthMin : null,
    cover: bigCover(b.image) || null, year: b.releaseDate ? +String(b.releaseDate).slice(0, 4) || null : null,
    subjects: names(b.genres), asin: b.asin, isbn: b.isbn || null, src: "audnexus", key: b.asin,
  };
}
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
export async function audibleSearch(q) {
  const j = await getJSON("audible", `${AUDIBLE()}?keywords=${encodeURIComponent(q)}&num_results=20&products_sort_by=Relevance&response_groups=${AUDIBLE_GROUPS}&image_sizes=500`);
  return ((j && j.products) || []).map(fromAudible).filter(Boolean);
}
export async function audibleByAsins(asins) {   // up to 50 at a time
  if (!asins.length) return [];
  const j = await getJSON("audible", `${AUDIBLE()}?asins=${asins.slice(0, 50).map(encodeURIComponent).join(",")}&response_groups=${AUDIBLE_GROUPS}&image_sizes=500`, { timeout: 9000 });
  return ((j && j.products) || []).map(fromAudible).filter(Boolean);
}
export async function audnexusBook(asin) {
  const j = await getJSON("audnexus", `${base.audnexus}/books/${encodeURIComponent(asin)}?region=us`, { gap: 250 });
  return fromAudnexus(j);
}
export async function openLibrarySearch(q) {
  const j = await getJSON("openlibrary", `${base.openlibrary}/search.json?q=${encodeURIComponent(q)}&limit=25&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject,edition_count,isbn`);
  return ((j && j.docs) || []).map(fromOpenLibrary).filter(Boolean);
}
export async function googleSearch(q) {
  const j = await getJSON("googlebooks", `${base.googlebooks}/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&printType=books`);
  return ((j && j.items) || []).map(fromGoogle).filter(Boolean);
}
