import { json } from "../_middleware.js";
import { configure, isDown, openLibrarySearch, googleSearch, openLibraryByIsbn, googleByIsbn } from "./_sources.js";
import { relevant, matchKey } from "./_match.js";
import { saveBooks, findInLibrary, findBooks, fromRow } from "./_library.js";
import { cached } from "./_cache.js";

/* GET /api/books/search?q=…  Sources in order: Earmark's own book table, then Open Library, then Google Books
   (page counts, so the app estimates the length). When the table already has plenty of matches, no one else is
   asked; otherwise the first outside source with relevant results answers, after the table's own matches, and what
   it found is saved to the table. A source that's down or limiting us is skipped. Each source's answer to a search
   is kept for a few days, so the same search doesn't reach it again.
   Audible's catalog is never asked (its terms rule out collecting its listings). A search that is an ISBN (an
   all-digit Audible ID is one) is looked up by ISBN; one that is an Audible ID (B0…) can only be answered from
   Earmark's own table, since no free source knows Audible's IDs.
   With covers=1 (the book editor's Find cover) every edition with a cover comes back, each cover once, instead of
   one result per book, so there are several covers to choose from. */
const CHAIN = [["openlibrary", openLibrarySearch, 3], ["googlebooks", googleSearch, 3]];   // days a search's answer is kept
const ASIN = /^b0[a-z0-9]{8}$/, ISBN = /^(\d{9}[\dx]|97[89]\d{10})$/;
async function byId(ctx, q, tried) {
  const db = ctx.env.DB, id = q.toUpperCase(), isbn = ISBN.test(q);
  const row = (await findBooks(db, isbn ? { isbns: [id] } : { asins: [id] }).catch(() => [])).find(r => r.confirmed);
  tried.push({ src: "library", results: row ? 1 : 0 });
  if (row) return { book: fromRow(row), src: "library" };
  if (!isbn) return null;
  for (const [src, fn] of [["openlibrary", openLibraryByIsbn], ["googlebooks", googleByIsbn]]) {
    if (isDown(src)) { tried.push({ src, skipped: true }); continue; }
    try {
      const got = await cached(ctx, src + "-isbn", fn, id, 7);
      tried.push({ src, results: got.length });
      if (got.length) { ctx.waitUntil(saveBooks(db, got, src).catch(err => console.error("saving looked-up books", err))); return { book: got[0], src }; }
    } catch (err) { tried.push({ src, error: err.message }); }
  }
  return null;
}

export async function onRequestGet(ctx) {
  configure(ctx.env);
  const params = new URL(ctx.request.url).searchParams, covers = params.get("covers") === "1";
  const q = (params.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  if (q.length < 2) return json({ results: [], source: null, tried: [] });
  const db = ctx.env.DB, tried = [];
  if (ASIN.test(q) || ISBN.test(q)) {
    const hit = await byId(ctx, q, tried);
    if (hit) return json({ results: [hit.book], source: hit.src, byId: true, tried });
    if (ASIN.test(q)) return json({ results: [], source: null, tried, byId: true });   // text search can't find an Audible ID
  }
  let own = [];
  try { own = await findInLibrary(db, q); tried.push({ src: "library", results: own.length }); } catch (err) { tried.push({ src: "library", error: err.message }); }
  if (own.length >= 8 && !covers) return json({ results: own.slice(0, 25), source: "library", tried });
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
      if (covers) {   // every edition's cover, each once
        const seen = new Set();
        return json({ results: [...merged, ...list].filter(b => b.cover && !seen.has(b.cover) && seen.add(b.cover)).slice(0, 25), source: src, tried });
      }
      return json({ results: [...merged, ...more].slice(0, 25), source: own.length ? `library+${src}` : src, tried });
    } catch (err) { tried.push({ src, error: err.message }); }
  }
  if (own.length) return json({ results: own, source: "library", tried });
  // nothing anywhere: "no matches" if a source answered, "search isn't working" if none could be reached
  return json({ results: [], source: null, tried, unavailable: tried.filter(t => t.src !== "library").every(t => t.skipped || t.error) });
}
