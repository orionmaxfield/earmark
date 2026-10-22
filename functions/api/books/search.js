import { json } from "../_middleware.js";
import { configure, isDown, audibleSearch, audibleByAsins, audnexusBook, openLibrarySearch, googleSearch } from "./_sources.js";
import { relevant, matchKey } from "./_match.js";
import { saveBooks, findInLibrary, findBooks, fromRow } from "./_library.js";
import { cached } from "./_cache.js";

/* GET /api/books/search?q=…  Sources in order: Earmark's own book table, then Audible's catalog (exact runtimes),
   then Open Library, then Google Books (page counts, so the app estimates the length). When the table already has
   plenty of matches, no one else is asked; otherwise the first outside source with relevant results answers, after
   the table's own matches, and what it found is saved to the table. A source
   that's down or limiting us is skipped. Each source's answer to a search is kept for a few days, so the same
   search doesn't reach it again.
   Audnexus has no title search, only books by ASIN, so a keyword search can't find a book only Audnexus knows.
   A search that is an Audible ASIN (the code in a book's Audible link, like B08G9PRS1K) is looked up directly:
   Earmark's table, then Audible's catalog, then Audnexus. */
const CHAIN = [["audible", audibleSearch, 7], ["openlibrary", openLibrarySearch, 3], ["googlebooks", googleSearch, 3]];   // days a search's answer is kept

const ASIN = /^(b0[a-z0-9]{8}|\d{9}[\dx])$/;   // Audible ASINs start B0; older ones look like an ISBN-10
async function byAsin(ctx, asin, tried) {
  const db = ctx.env.DB;
  const row = (await findBooks(db, { asins: [asin] }).catch(() => [])).find(r => r.confirmed && r.asin === asin);
  if (row) { tried.push({ src: "library", results: 1 }); return { book: fromRow(row), src: "library" }; }
  for (const [src, fn] of [["audible", a => audibleByAsins([a])], ["audnexus", audnexusBook]]) {
    if (isDown(src)) { tried.push({ src, skipped: true }); continue; }
    try {
      const got = await cached(ctx, src + "-asin", async a => { const r = await fn(a); return (Array.isArray(r) ? r : r ? [r] : []); }, asin, 7);
      tried.push({ src, results: got.length });
      if (got.length) { ctx.waitUntil(saveBooks(db, got, src).catch(err => console.error("saving looked-up books", err))); return { book: got[0], src }; }
    } catch (err) { tried.push({ src, error: err.message }); }
  }
  return null;
}

export async function onRequestGet(ctx) {
  configure(ctx.env);
  const q = (new URL(ctx.request.url).searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  if (q.length < 2) return json({ results: [], source: null, tried: [] });
  const db = ctx.env.DB, tried = [];
  if (ASIN.test(q)) {
    const hit = await byAsin(ctx, q.toUpperCase(), tried);
    if (hit) return json({ results: [hit.book], source: hit.src, byAsin: true, tried });   // otherwise it's searched like any text (an ISBN-10, say)
  }
  let own = [];
  try { own = await findInLibrary(db, q); tried.push({ src: "library", results: own.length }); } catch (err) { tried.push({ src: "library", error: err.message }); }
  if (own.length >= 8) return json({ results: own.slice(0, 25), source: "library", tried });
  for (const [src, fn, days] of CHAIN) {
    if (isDown(src)) { tried.push({ src, skipped: true }); continue; }
    try {
      const list = relevant(await cached(ctx, src, fn, q, days), q);
      tried.push({ src, results: list.length });
      if (!list.length) continue;
      ctx.waitUntil(saveBooks(db, list, src).catch(err => console.error("saving looked-up books", err)));   // the library grows
      // the table's books first; one the source also found gets anything the table didn't have yet (runtime, cover…)
      const ids = b => [b.asin, b.isbn, matchKey(b.t, b.author)].filter(Boolean), byId = new Map();
      list.forEach(b => ids(b).forEach(k => { if (!byId.has(k)) byId.set(k, b); }));
      const merged = own.map(b => { const x = ids(b).map(k => byId.get(k)).find(Boolean); return x ? { ...x, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v != null && v !== "")), fromLibrary: true } : b; });
      const have = new Set(own.flatMap(ids));
      const more = list.filter(b => !ids(b).some(k => have.has(k)));
      return json({ results: [...merged, ...more].slice(0, 25), source: own.length ? `library+${src}` : src, tried });
    } catch (err) { tried.push({ src, error: err.message }); }
  }
  if (own.length) return json({ results: own, source: "library", tried });
  // nothing anywhere: "no matches" if a source answered, "search isn't working" if none could be reached
  return json({ results: [], source: null, tried, unavailable: tried.filter(t => t.src !== "library").every(t => t.skipped || t.error) });
}
